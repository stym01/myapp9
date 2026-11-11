import Foundation

final class ChatHistory {

    static let shared = ChatHistory()

    var enabled = false
    private var counter = 0
    private var currentDate = ""

    private init() {}

    func saveEntry(question: String, response: String, screenshots: [String] = []) {
        guard enabled else { return }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())

        if today != currentDate {
            currentDate = today
            counter = 0
        }

        let fm = FileManager.default
        let desktop = fm.urls(for: .desktopDirectory, in: .userDomainMask).first!
        let basePath = desktop.appendingPathComponent("Solvro-chat-history").appendingPathComponent(currentDate)

        do {
            try fm.createDirectory(at: basePath, withIntermediateDirectories: true)
        } catch {
            NSLog("[ChatHistory] failed to create folder: %@", error.localizedDescription)
            return
        }

        let qFile = basePath.appendingPathComponent("\(counter)_question.txt")
        let rFile = basePath.appendingPathComponent("\(counter)_response.txt")

        do {
            try question.write(to: qFile, atomically: true, encoding: .utf8)
            try response.write(to: rFile, atomically: true, encoding: .utf8)
        } catch {
            NSLog("[ChatHistory] write error: %@", error.localizedDescription)
        }

        for (i, base64) in screenshots.enumerated() {
            if let data = Data(base64Encoded: base64) {
                let imgFile = basePath.appendingPathComponent("\(counter)_screenshot_\(i).png")
                try? data.write(to: imgFile)
            }
        }

        counter += 1
        NSLog("[ChatHistory] saved entry %d for %@", counter - 1, today)
    }
}
