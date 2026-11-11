import SwiftUI

enum MessageSegment: Identifiable {
    case text(String)
    case code(String, String?) // content, language hint

    var id: String {
        switch self {
        case .text(let s): return "t-\(s.hashValue)"
        case .code(let s, _): return "c-\(s.hashValue)"
        }
    }
}

enum MarkdownParser {

    static func parse(_ raw: String) -> [MessageSegment] {
        var segments: [MessageSegment] = []
        var buffer = ""
        var inCode = false
        var codeLang: String?

        for line in raw.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if !buffer.isEmpty {
                    if inCode {
                        segments.append(.code(buffer, codeLang))
                    } else {
                        segments.append(.text(stripMarkdown(buffer)))
                    }
                    buffer = ""
                }
                if !inCode {
                    let hint = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    codeLang = hint.isEmpty ? nil : hint
                }
                inCode.toggle()
                continue
            }

            buffer += (buffer.isEmpty ? "" : "\n") + line
        }

        if !buffer.isEmpty {
            if inCode {
                segments.append(.code(buffer, codeLang))
            } else {
                segments.append(.text(stripMarkdown(buffer)))
            }
        }

        return segments
    }

    private static func stripMarkdown(_ text: String) -> String {
        var result = ""
        for line in text.components(separatedBy: "\n") {
            var s = line
            while s.hasPrefix("#") { s = String(s.dropFirst()) }
            if s.hasPrefix(" ") { s = String(s.dropFirst()) }
            s = s.replacingOccurrences(of: "**", with: "")
            result += (result.isEmpty ? "" : "\n") + s
        }
        return result
    }
}
