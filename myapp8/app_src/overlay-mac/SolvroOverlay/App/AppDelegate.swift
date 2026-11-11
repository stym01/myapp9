import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {

    let overlayController = OverlayWindowController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // No Dock icon, no menu-bar app — pure background agent
        NSApp.setActivationPolicy(.accessory)

        overlayController.createAndShow()
        NSLog("[SolvroOverlay] overlay is live")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        return true
    }
}
