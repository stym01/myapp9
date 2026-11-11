import Cocoa

final class ProctorMonitor {

    static let shared = ProctorMonitor()

    private var timer: Timer?
    private var knownProctorBundles: Set<String> = [
        "org.safeexambrowser.SafeExamBrowser",
        "com.respondus.lockdownbrowser",
        "com.proctorio.proctorioextension",
        "com.honorlock.honorlock",
        "com.proctoru.proctorulive",
        "com.examity.examity",
    ]

    private init() {}

    func startMonitoring() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.checkRunningApps()
        }
        NSLog("[ProctorMonitor] started monitoring for proctoring apps")
    }

    func stopMonitoring() {
        timer?.invalidate()
        timer = nil
    }

    private func checkRunningApps() {
        let apps = NSWorkspace.shared.runningApplications
        for app in apps {
            guard let bundleId = app.bundleIdentifier else { continue }
            if knownProctorBundles.contains(bundleId) {
                NSLog("[ProctorMonitor] detected proctoring app: %@", bundleId)
                SEBLogCleaner.shared.cleanupSEBLogs()
            }
        }
    }
}
