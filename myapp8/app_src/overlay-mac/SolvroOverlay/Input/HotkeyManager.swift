import Cocoa

final class HotkeyManager {

    private weak var controller: OverlayWindowController?
    private var globalMonitor: Any?
    private var localMonitor: Any?

    init(controller: OverlayWindowController) {
        self.controller = controller
    }

    func start() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleKey(event)
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleKey(event)
            return event
        }
        NSLog("[HotkeyManager] monitoring started")
    }

    func stop() {
        if let m = globalMonitor { NSEvent.removeMonitor(m) }
        if let m = localMonitor { NSEvent.removeMonitor(m) }
        globalMonitor = nil
        localMonitor = nil
    }

    private func handleKey(_ event: NSEvent) {
        guard let controller else { return }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let cmd = flags.contains(.command)
        let shift = flags.contains(.shift)
        let key = event.keyCode

        // ⌘Space (keyCode 49) — toggle visibility
        if cmd && !shift && key == 49 {
            controller.toggleVisibility()
            return
        }

        // ⌘↑ (keyCode 126) — increase opacity
        if cmd && !shift && key == 126 {
            controller.adjustOpacity(delta: 0.1)
            return
        }

        // ⌘↓ (keyCode 125) — decrease opacity
        if cmd && !shift && key == 125 {
            controller.adjustOpacity(delta: -0.1)
            return
        }

        // ⌘⇧C (keyCode 8) — toggle click-through
        if cmd && shift && key == 8 {
            controller.toggleClickThrough()
            return
        }

        // ⌘⇧Arrow keys — move window by 50px
        let moveStep: CGFloat = 50
        if cmd && shift {
            switch key {
            case 123: controller.move(dx: -moveStep, dy: 0)   // ←
            case 124: controller.move(dx: moveStep, dy: 0)    // →
            case 126: controller.move(dx: 0, dy: moveStep)    // ↑
            case 125: controller.move(dx: 0, dy: -moveStep)   // ↓
            default: break
            }
        }

        // ⌘⇧Q (keyCode 12) — quit overlay
        if cmd && shift && key == 12 {
            NSLog("[HotkeyManager] quit requested")
            NSApp.terminate(nil)
            return
        }
    }

    deinit {
        stop()
    }
}
