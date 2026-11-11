import Cocoa

final class WindowHider {

    static let shared = WindowHider()

    private init() {}

    func hideFromAccessibility(_ window: NSWindow) {
        window.setAccessibilityElement(false)
        window.setAccessibilityRole(.unknown)
        window.setAccessibilityRoleDescription("")
        window.setAccessibilityTitle("")
        NSLog("[WindowHider] accessibility hidden")
    }

    func applyStealth(_ window: NSWindow) {
        window.sharingType = .none
        let wn = UInt32(window.windowNumber)
        CGSBridge.setWindowSharingState(windowNumber: wn, state: CGSBridge.sharingNone)
        CGSBridge.setWindowLevel(windowNumber: wn, level: Int32(CGWindowLevelForKey(.maximumWindow)) + 1)

        hideFromAccessibility(window)

        window.isExcludedFromWindowsMenu = true
        window.hidesOnDeactivate = false

        NSLog("[WindowHider] full stealth applied to window %d", window.windowNumber)
    }

    func disguiseUserAgent() {
        let agents = [
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ]
        UserDefaults.standard.register(defaults: ["UserAgent": agents.randomElement() ?? agents[0]])
    }
}
