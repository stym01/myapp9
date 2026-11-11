import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {

    let overlayController = OverlayWindowController()
    var hotkeyManager: HotkeyManager?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let session = SessionManager.shared

        session.onTokenChanged = { [weak self] in
            let email = session.email
            self?.overlayController.viewModel.statusText = email.isEmpty ? "Signed in via Solvro." : email
        }

        session.onSignedOut = { [weak self] in
            self?.overlayController.viewModel.statusText = "Please sign in via the Solvro app"
        }

        session.startup()
        session.startTokenPolling()

        if session.isLoggedIn {
            overlayController.viewModel.statusText = session.email.isEmpty ? "Signed in via Solvro." : session.email
        } else {
            overlayController.viewModel.statusText = "Please sign in via the Solvro app"
        }

        overlayController.createAndShow()

        let hk = HotkeyManager(controller: overlayController)
        hk.start()
        self.hotkeyManager = hk

        NSLog("[SolvroOverlay] overlay is live, hotkeys active")
    }

    func applicationWillTerminate(_ notification: Notification) {
        SessionManager.shared.stopTokenPolling()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }
}
