import Cocoa

final class WindowManager {

    static let shared = WindowManager()

    private let config = AppConfig.shared

    private init() {}

    func restoreWindowPosition(_ panel: NSPanel) {
        let savedX = config.windowX
        let savedY = config.windowY
        let savedWidth = config.windowWidth

        if savedWidth > 0 {
            var frame = panel.frame
            frame.origin.x = savedX
            frame.origin.y = savedY
            frame.size.width = savedWidth
            panel.setFrame(frame, display: false)
            NSLog("[WindowManager] restored position (%.0f, %.0f) width=%.0f", savedX, savedY, savedWidth)
        }

        let savedOpacity = config.windowOpacity
        if savedOpacity > 0 {
            panel.alphaValue = savedOpacity
        }
    }

    func saveWindowPosition(_ panel: NSPanel) {
        let frame = panel.frame
        config.windowX = frame.origin.x
        config.windowY = frame.origin.y
        config.windowWidth = frame.size.width
        config.windowOpacity = panel.alphaValue
        NSLog("[WindowManager] saved position (%.0f, %.0f) width=%.0f opacity=%.2f",
              frame.origin.x, frame.origin.y, frame.size.width, panel.alphaValue)
    }

    func moveToScreen(_ panel: NSPanel, screen: NSScreen) {
        var frame = panel.frame
        let screenFrame = screen.frame
        frame.origin.x = screenFrame.origin.x
        frame.origin.y = screenFrame.origin.y
        frame.size.height = screenFrame.height
        panel.setFrame(frame, display: true)
        NSLog("[WindowManager] moved to screen: %@", screen.localizedName)
    }

    func cycleScreen(_ panel: NSPanel) {
        let screens = NSScreen.screens
        guard screens.count > 1 else { return }

        let currentScreen = panel.screen ?? NSScreen.main ?? screens[0]
        guard let currentIndex = screens.firstIndex(of: currentScreen) else { return }

        let nextIndex = (currentIndex + 1) % screens.count
        moveToScreen(panel, screen: screens[nextIndex])
    }
}
