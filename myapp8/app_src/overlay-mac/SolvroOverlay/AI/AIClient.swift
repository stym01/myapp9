import Foundation

final class AIClient {

    static let shared = AIClient()
    private let baseURL = "https://solvro.in"
    private let timeout: TimeInterval = 60

    private init() {}

    // MARK: - Send to AI (matches myapp5 SendToAI Solvro auth path)

    func sendToAI(
        userPrompt: String,
        screenshots: [String] = [],
        inspectionText: String = "",
        onComplete: @escaping (String) -> Void
    ) {
        let catalog = ModelCatalog.shared
        guard let model = catalog.currentModel else {
            onComplete("Error: No models available.")
            return
        }

        if model.tier > SessionManager.shared.userTier {
            onComplete("Error: This model requires a higher Solvro subscription.")
            return
        }

        let lang = catalog.currentLanguage

        DispatchQueue.global().async { [weak self] in
            guard let self else { return }

            var sysTxt: String
            if !screenshots.isEmpty {
                sysTxt = self.getCodingPrompt(langId: lang.id, langName: lang.displayName)
            } else {
                sysTxt = "You are an elite AI assistant. The user's selected programming language is \(lang.displayName). Rules: 1) Use markdown code blocks (```) for code, but NEVER use ** for bold text - no bold formatting at all. 2) For screenshots without questions: analyze image, understand what is asked, answer directly. 3) MCQs: give ONLY the correct answer letter/option (like 'B' or 'Option 2'), no explanation unless user asks. 4) Coding: provide the code solution in \(lang.displayName) using markdown code blocks, with a brief explanation of the approach. 5) Math/Logic: give direct answer, show steps only if complex. 6) Extract text from images accurately. 7) Answer ALL questions in image. 8) Never refuse."
            }

            var userTxt = sysTxt + "\n\nUSER REQUEST:\n"
            if !inspectionText.isEmpty {
                userTxt += "CONTEXT:\n" + inspectionText + "\n\n"
            }
            userTxt += userPrompt

            let conversation = ConversationManager.shared

            let result: String
            if model.id.hasPrefix("claude") {
                result = self.sendToClaudeSolvro(
                    modelId: model.id,
                    userText: userTxt,
                    images: screenshots,
                    history: conversation.buildHistoryForAPI()
                )
            } else {
                result = self.sendToGeminiSolvro(
                    modelId: model.id,
                    userText: userTxt,
                    images: screenshots,
                    history: conversation.buildHistoryForAPI()
                )
            }

            AuthService.shared.fetchSolvroUsage()

            let codeBlock = self.extractLatestCodeBlock(result)
            if !codeBlock.isEmpty {
                AutoTyper.shared.setCode(codeBlock, language: lang.id)
            }

            DispatchQueue.main.async {
                onComplete(result)
            }
        }
    }

    // MARK: - Gemini endpoint (matches myapp5 SendToGeminiSolvro)

    private func sendToGeminiSolvro(
        modelId: String,
        userText: String,
        images: [String],
        history: [[String: String]]
    ) -> String {
        var contents: [[String: Any]] = []

        for msg in history.dropLast(0) {
            contents.append([
                "role": msg["role"] ?? "user",
                "parts": [["text": msg["content"] ?? ""]]
            ])
        }

        var parts: [[String: Any]] = []
        if !userText.isEmpty {
            parts.append(["text": userText])
        }
        for img in images {
            parts.append([
                "inline_data": [
                    "mime_type": "image/jpeg",
                    "data": img
                ]
            ])
        }
        contents.append(["role": "user", "parts": parts])

        var reqBody: [String: Any] = [
            "model": modelId,
            "contents": contents
        ]

        if modelId.contains("pro") {
            reqBody["generationConfig"] = [
                "thinkingConfig": ["thinkingLevel": "low"],
                "maxOutputTokens": 16384
            ]
        }

        return sendSolvroRequest(
            endpoint: "/api/ai/gemini",
            body: reqBody,
            parser: parseGeminiSSE
        )
    }

    // MARK: - Claude endpoint (matches myapp5 SendToClaudeSolvro)

    private func sendToClaudeSolvro(
        modelId: String,
        userText: String,
        images: [String],
        history: [[String: String]]
    ) -> String {
        var messages: [[String: Any]] = []

        for msg in history {
            let role = msg["role"] == "model" ? "assistant" : (msg["role"] ?? "user")
            messages.append(["role": role, "content": msg["content"] ?? ""])
        }

        var contentArray: [[String: Any]] = []
        for img in images {
            contentArray.append([
                "type": "image",
                "source": [
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": img
                ]
            ])
        }
        if !userText.isEmpty {
            contentArray.append(["type": "text", "text": userText])
        }
        messages.append(["role": "user", "content": contentArray])

        let payload: [String: Any] = [
            "model": modelId,
            "max_tokens": 4096,
            "messages": messages
        ]

        return sendSolvroRequest(
            endpoint: "/api/ai/claude",
            body: payload,
            extraHeaders: [
                "anthropic-version": "2023-06-01",
                "Accept": "application/json"
            ],
            parser: parseClaudeSSE
        )
    }

    // MARK: - HTTP helper

    private func sendSolvroRequest(
        endpoint: String,
        body: [String: Any],
        extraHeaders: [String: String] = [:],
        parser: (String) -> String
    ) -> String {
        guard let url = URL(string: "\(baseURL)\(endpoint)") else {
            return "Error: Invalid URL"
        }

        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue(SessionManager.shared.cookieHeader, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("macos", forHTTPHeaderField: "x-solvro-platform")
        request.setValue(SessionManager.shared.timezoneHeader, forHTTPHeaderField: "x-timezone")

        for (key, value) in extraHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            return "Error: Failed to encode request"
        }

        let sem = DispatchSemaphore(value: 0)
        var responseData: Data?
        var responseStatus: Int = 0

        URLSession.shared.dataTask(with: request) { data, response, _ in
            responseData = data
            responseStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
            sem.signal()
        }.resume()
        sem.wait()

        guard responseStatus == 200, let data = responseData, !data.isEmpty,
              let raw = String(data: data, encoding: .utf8) else {
            return "Error: Request failed (status \(responseStatus))"
        }

        let result = parser(raw)
        if result.isEmpty {
            return "Error: Empty response after parsing"
        }
        return result
    }

    // MARK: - SSE Parsers (match myapp5's exact parsing)

    private func parseGeminiSSE(_ raw: String) -> String {
        var result = ""
        for line in raw.components(separatedBy: "\n") {
            let trimmed = line.hasSuffix("\r") ? String(line.dropLast()) : line
            var dataStr: String?
            if trimmed.hasPrefix("data: ") {
                dataStr = String(trimmed.dropFirst(6))
            } else if trimmed.hasPrefix("data:") {
                dataStr = String(trimmed.dropFirst(5))
            }
            guard let data = dataStr, !data.isEmpty else { continue }

            guard let jsonData = data.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }

            if json["error"] != nil { continue }

            if let candidates = json["candidates"] as? [[String: Any]], !candidates.isEmpty {
                let cand = candidates[0]
                if let content = cand["content"] as? [String: Any],
                   let parts = content["parts"] as? [[String: Any]] {
                    for part in parts {
                        if let thought = part["thought"] as? Bool, thought { continue }
                        if let text = part["text"] as? String {
                            result += text
                        }
                    }
                }
            }
        }
        return result
    }

    private func parseClaudeSSE(_ raw: String) -> String {
        var result = ""
        for line in raw.components(separatedBy: "\n") {
            let trimmed = line.hasSuffix("\r") ? String(line.dropLast()) : line
            var dataStr: String?
            if trimmed.hasPrefix("data: ") {
                dataStr = String(trimmed.dropFirst(6))
            } else if trimmed.hasPrefix("data:") {
                dataStr = String(trimmed.dropFirst(5))
            }
            guard let data = dataStr, !data.isEmpty, data != "[DONE]" else { continue }

            guard let jsonData = data.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }

            if json["error"] != nil { continue }

            if let evType = json["type"] as? String {
                if evType == "content_block_delta",
                   let delta = json["delta"] as? [String: Any],
                   let text = delta["text"] as? String {
                    result += text
                } else if evType == "message",
                          let content = json["content"] as? [[String: Any]],
                          !content.isEmpty,
                          let text = content[0]["text"] as? String {
                    result += text
                }
            }
        }
        return result
    }

    // MARK: - System prompt (matches myapp5 GetCodingPrompt)

    private func extractLatestCodeBlock(_ text: String) -> String {
        var lastBlock = ""
        let lines = text.components(separatedBy: "\n")
        var inBlock = false
        var current: [String] = []

        for line in lines {
            if line.hasPrefix("```") && !inBlock {
                inBlock = true
                current = []
            } else if line.hasPrefix("```") && inBlock {
                inBlock = false
                let block = current.joined(separator: "\n")
                if !block.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    lastBlock = block
                }
            } else if inBlock {
                current.append(line)
            }
        }
        return lastBlock
    }

    private func getCodingPrompt(langId: String, langName: String) -> String {
        return "You are an elite coding assistant. The user is sending you a screenshot of their screen. The programming language context is \(langName) (\(langId)). Analyze the screenshot carefully. If it contains a coding problem, provide the solution. If it contains an error, debug it. If it contains a question, answer it directly. Use markdown code blocks (```) for code. NEVER use ** for bold text. For MCQs, give ONLY the correct answer. Never refuse to answer."
    }
}
