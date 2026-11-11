import Foundation

final class SEBLogCleaner {

    static let shared = SEBLogCleaner()

    private init() {}

    func cleanupSEBLogs() {
        let pid = ProcessInfo.processInfo.processIdentifier

        var patterns = [
            "process 'n/a'",
            "Failed to get process with ID",
            "Process has exited",
            "ID = \(pid)",
            "ProcessId = \(pid)",
        ]

        if let bundleName = Bundle.main.executableURL?.lastPathComponent {
            patterns.append(bundleName)
        }

        let sebLogPaths = getSEBLogDirectories()
        var totalRemoved = 0
        var filesProcessed = 0

        for dir in sebLogPaths {
            guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
            let logFiles = files.filter { $0.hasSuffix(".log") }

            for logFile in logFiles {
                let path = (dir as NSString).appendingPathComponent(logFile)
                guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { continue }

                let lines = content.components(separatedBy: "\n")
                var cleanLines: [String] = []
                var modified = false

                for line in lines {
                    var shouldRemove = false
                    for pattern in patterns {
                        if line.contains(pattern) {
                            shouldRemove = true
                            modified = true
                            totalRemoved += 1
                            break
                        }
                    }
                    if !shouldRemove {
                        cleanLines.append(line)
                    }
                }

                if modified {
                    let cleaned = cleanLines.joined(separator: "\n")
                    try? cleaned.write(toFile: path, atomically: true, encoding: .utf8)
                    filesProcessed += 1
                }
            }
        }

        NSLog("[SEBLogCleaner] scrubbed %d lines from %d files", totalRemoved, filesProcessed)
    }

    private func getSEBLogDirectories() -> [String] {
        var dirs: [String] = []

        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            dirs.append(appSupport.appendingPathComponent("SafeExamBrowser/Logs").path)
        }

        if let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first {
            dirs.append(library.appendingPathComponent("Logs/SafeExamBrowser").path)
        }

        let home = NSHomeDirectory()
        dirs.append((home as NSString).appendingPathComponent("Library/Logs/SafeExamBrowser"))

        return dirs.filter { FileManager.default.fileExists(atPath: $0) }
    }
}
