import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {

    let overlayController = OverlayWindowController()
    var hotkeyManager: HotkeyManager?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        // Auth: load token from disk, start 24h refresh timer
        let session = SessionManager.shared
        if session.loadToken() {
            session.startRefreshTimer()
            session.fetchProfile { profile in
                if let p = profile {
                    NSLog("[SolvroOverlay] logged in as %@", p.email)
                    self.overlayController.viewModel.statusText = p.email
                } else {
                    self.overlayController.viewModel.statusText = "Not logged in"
                }
            }
        } else {
            NSLog("[SolvroOverlay] no session token — user needs to log in via Electron")
        }

        overlayController.createAndShow()

        let hk = HotkeyManager(controller: overlayController)
        hk.start()
        self.hotkeyManager = hk

        NSLog("[SolvroOverlay] overlay is live, hotkeys active")
    }

    func applicationWillTerminate(_ notification: Notification) {
        SessionManager.shared.stopRefreshTimer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }
}
