import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {

    let overlayController = OverlayWindowController()
    var hotkeyManager: HotkeyManager?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        overlayController.createAndShow()

        let hk = HotkeyManager(controller: overlayController)
        hk.start()
        self.hotkeyManager = hk

        NSLog("[SolvroOverlay] overlay is live, hotkeys active")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }
}
