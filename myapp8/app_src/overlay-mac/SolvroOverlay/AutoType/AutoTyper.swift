import Cocoa

final class AutoTyper {

    static let shared = AutoTyper()

    enum State {
        case idle
        case countdown
        case typing
        case paused
        case completed
        case error
    }

    private(set) var state: State = .idle
    private(set) var code: String = ""
    private(set) var resumeIndex: Int = 0
    private(set) var statusMessage: String = ""
    private(set) var language: String = ""

    private var shouldStop = false
    private var typeThread: Thread?

    var onProgress: ((State, String) -> Void)?

    private init() {}

    func setCode(_ newCode: String, language: String = "") {
        self.code = normalizeCode(newCode, language: language)
        self.language = language
        self.resumeIndex = 0
        NSLog("[AutoTyper] code set (%d chars, lang=%@)", self.code.count, language)
    }

    func start() {
        guard !code.isEmpty else {
            notifyProgress(.error, "No code to type.")
            return
        }
        guard state == .idle || state == .completed || state == .error else { return }

        shouldStop = false
        resumeIndex = 0
        startTypingThread(fromIndex: 0)
    }

    func resume() {
        guard state == .paused else { return }
        guard resumeIndex < code.count else {
            notifyProgress(.completed, "Nothing to resume.")
            return
        }

        shouldStop = false
        startTypingThread(fromIndex: resumeIndex)
    }

    func stop() {
        shouldStop = true
    }

    // MARK: - Typing thread (matches myapp5's TypeThread)

    private func startTypingThread(fromIndex: Int) {
        typeThread = Thread { [weak self] in
            self?.typeLoop(startIndex: fromIndex)
        }
        typeThread?.start()
    }

    private func typeLoop(startIndex: Int) {
        let text = code
        guard startIndex < text.count else {
            notifyProgress(.error, "No code to type.")
            return
        }

        notifyProgress(.countdown, "Auto-typing in 1s...")

        for _ in 0..<20 {
            if shouldStop {
                notifyProgress(.paused, "Cancelled during countdown.")
                return
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        if shouldStop {
            notifyProgress(.paused, "Cancelled before typing.")
            return
        }

        notifyProgress(.typing, "Typing...")

        let chars = Array(text)
        var i = startIndex
        let rng = SystemRandomNumberGenerator()
        var gen = rng

        while i < chars.count {
            if shouldStop {
                resumeIndex = i
                let remaining = chars.count - i
                notifyProgress(.paused, "Paused (\(remaining) chars remaining).")
                return
            }

            let ch = chars[i]

            if ch == "\n" {
                postKeyEvent(keyCode: 36, keyDown: true)
                postKeyEvent(keyCode: 36, keyDown: false)
                let lineDelay = Double(Int.random(in: 80...200, using: &gen)) / 1000.0
                Thread.sleep(forTimeInterval: lineDelay)
            } else if ch == "\t" {
                postKeyEvent(keyCode: 48, keyDown: true)
                postKeyEvent(keyCode: 48, keyDown: false)
                Thread.sleep(forTimeInterval: 0.04)
            } else {
                postCharacterEvent(ch)
                let charDelay = Double(Int.random(in: 35...110, using: &gen)) / 1000.0
                Thread.sleep(forTimeInterval: charDelay)
            }

            if Int.random(in: 1...30, using: &gen) == 1 {
                let pause = Double(Int.random(in: 200...500, using: &gen)) / 1000.0
                Thread.sleep(forTimeInterval: pause)
            }

            i += 1
        }

        resumeIndex = i
        notifyProgress(.completed, "Auto-type completed.")
    }

    // MARK: - CGEvent keyboard simulation

    private func postKeyEvent(keyCode: CGKeyCode, keyDown: Bool) {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else { return }
        event.post(tap: .cghidEventTap)
    }

    private func postCharacterEvent(_ char: Character) {
        let str = String(char)
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { return }
        let utf16 = Array(str.utf16)
        event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        event.post(tap: .cghidEventTap)

        guard let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
        upEvent.post(tap: .cghidEventTap)
    }

    // MARK: - Code normalization (matches myapp5)

    private func normalizeCode(_ raw: String, language: String) -> String {
        var lines = raw.components(separatedBy: "\n")

        if language == "python" {
            lines = lines.map { line in
                var l = line.replacingOccurrences(of: "\t", with: "    ")
                while l.hasSuffix(" ") || l.hasSuffix("\t") { l = String(l.dropLast()) }
                return l
            }
            let minIndent = lines.filter { !$0.isEmpty }.map { line -> Int in
                var spaces = 0
                for ch in line { if ch == " " { spaces += 1 } else { break } }
                return spaces
            }.min() ?? 0

            if minIndent > 0 {
                lines = lines.map { line in
                    if line.isEmpty { return line }
                    return String(line.dropFirst(min(minIndent, line.count)))
                }
            }
        } else {
            lines = lines.map { line in
                var l = line.replacingOccurrences(of: "\t", with: "")
                l = l.trimmingCharacters(in: .init(charactersIn: " "))
                while l.hasSuffix(" ") || l.hasSuffix("\t") { l = String(l.dropLast()) }
                return l
            }
        }

        return lines.joined(separator: "\n")
    }

    private func notifyProgress(_ newState: State, _ message: String) {
        state = newState
        statusMessage = message
        NSLog("[AutoTyper] %@: %@", "\(newState)", message)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.onProgress?(self.state, self.statusMessage)
        }
    }
}
