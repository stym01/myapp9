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

        // ⌘Space (keyCode 49) — toggle visibility (myapp5: Ctrl+Space)
        if cmd && !shift && key == 49 {
            controller.toggleVisibility()
            return
        }

        // ⌘Enter (keyCode 36) — send message (myapp5: Ctrl+Enter)
        if cmd && !shift && key == 36 {
            controller.viewModel.sendMessage()
            return
        }

        // ⌘R (keyCode 15) — reset chat (myapp5: Ctrl+R)
        if cmd && !shift && key == 15 {
            controller.viewModel.resetChat()
            return
        }

        // ⌘⇧[ (keyCode 33) — decrease opacity (myapp5: Ctrl+Shift+[)
        if cmd && shift && key == 33 {
            controller.adjustOpacity(delta: -0.1)
            return
        }

        // ⌘⇧] (keyCode 30) — increase opacity (myapp5: Ctrl+Shift+])
        if cmd && shift && key == 30 {
            controller.adjustOpacity(delta: 0.1)
            return
        }

        // ⌘⇧Arrow keys — move window by 50px (myapp5: Ctrl+Shift+Arrows)
        let moveStep: CGFloat = 50
        if cmd && shift {
            switch key {
            case 123: controller.move(dx: -moveStep, dy: 0); return
            case 124: controller.move(dx: moveStep, dy: 0); return
            case 126: controller.move(dx: 0, dy: moveStep); return
            case 125: controller.move(dx: 0, dy: -moveStep); return
            default: break
            }
        }

        // ⌘⇧S (keyCode 1) — screenshot (myapp5: Ctrl+Shift+S)
        if cmd && shift && key == 1 {
            let windowID = controller.panel?.windowNumber ?? 0
            ScreenCapture.shared.captureScreenshot(excludingWindow: CGWindowID(windowID)) { success in
                if success {
                    controller.viewModel.statusText = "Screenshot captured"
                }
            }
            return
        }

        // ⌘⇧L (keyCode 37) — cycle language (myapp5: Ctrl+Shift+L)
        if cmd && shift && key == 37 {
            NSLog("[HotkeyManager] cycle language (not yet implemented)")
            return
        }

        // ⌘⇧M (keyCode 46) — cycle model (myapp5: Ctrl+Shift+M)
        if cmd && shift && key == 46 {
            NSLog("[HotkeyManager] cycle model (not yet implemented)")
            return
        }

        // ⌘⇧Q (keyCode 12) — quit overlay (myapp5: Ctrl+Shift+Q)
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
