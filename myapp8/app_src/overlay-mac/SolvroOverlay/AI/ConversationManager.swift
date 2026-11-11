import Foundation

final class ConversationManager {

    static let shared = ConversationManager()

    struct Message {
        let role: String // "user", "model", "system"
        let text: String
        let hasImage: Bool
        let isPreview: Bool
    }

    private(set) var history: [Message] = []
    private(set) var messageCount: Int = 0

    private let maxPairs = 12

    private init() {}

    func addUserMessage(_ text: String, hasImage: Bool = false) {
        history.append(Message(role: "user", text: text, hasImage: hasImage, isPreview: false))
        messageCount += 1
        trimHistory()
    }

    func addAssistantMessage(_ text: String) {
        history.append(Message(role: "model", text: text, hasImage: false, isPreview: false))
        trimHistory()
    }

    func reset() {
        history.removeAll()
        messageCount = 0
    }

    private func trimHistory() {
        let maxMessages = maxPairs * 2
        if history.count > maxMessages {
            history = Array(history.suffix(maxMessages))
        }
    }

    func buildHistoryForAPI() -> [[String: String]] {
        var result: [[String: String]] = []
        for msg in history {
            if msg.isPreview || msg.role == "system" { continue }
            let role = msg.role == "model" ? "assistant" : msg.role
            result.append(["role": role, "content": msg.text])
        }
        return result
    }
}
