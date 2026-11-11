import Cocoa

/// Borderless, transparent panel that floats above everything — including
/// fullscreen and kiosk-mode apps — while staying hidden from screen capture,
/// ScreenCaptureKit, and CGWindowListCopyWindowInfo.
///
/// This is the macOS equivalent of the Windows overlay's
/// `SetWindowDisplayAffinity(0x11)` + `WS_EX_TOPMOST` + `WS_EX_NOACTIVATE`.
final class OverlayPanel: NSPanel {

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configurePanel()
    }

    // MARK: - Panel configuration

    private func configurePanel() {
        // Transparent, borderless chrome
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true

        // Float above everything: .screenSaver is the highest documented level
        level = .screenSaver
        collectionBehavior = [
            .canJoinAllSpaces,        // visible on all Spaces / Desktops
            .fullScreenAuxiliary,     // stays above fullscreen apps
            .stationary,              // doesn't move with Exposé / Mission Control
            .ignoresCycle             // ⌘` doesn't cycle to this window
        ]

        // Interactive by default; toggled by the click-through shortcut later
        ignoresMouseEvents = false
        acceptsMouseMovedEvents = true
        isMovableByWindowBackground = true

        // Prevent the panel from becoming the key/main window of another app's
        // activation cycle, but still accept keyboard input when clicked.
        hidesOnDeactivate = false
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true

        // Electron uses setContentProtection(true) which maps to
        // CGSSetWindowSharingState = sharingNone under the hood. We call the
        // CGS function directly in applyStealth() for finer control, but also
        // set the public API as a belt-and-suspenders measure.
        sharingType = .none

        isReleasedWhenClosed = false
    }

    // MARK: - Stealth

    /// Apply CGS private-API stealth after the window has a windowNumber.
    /// Call this once in `orderFront` / `makeKeyAndOrderFront` — the
    /// windowNumber is only valid after the window server has registered it.
    func applyStealth() {
        guard windowNumber > 0 else { return }
        let wn = UInt32(windowNumber)

        // Hide from all window-list queries and ScreenCaptureKit
        CGSBridge.setWindowSharingState(windowNumber: wn, state: CGSBridge.sharingNone)

        // Place above the maximum documented level so kiosk-mode apps (which
        // set their windows to .mainMenu or .screenSaver) can't cover us.
        // 2147483630 is just under Int32.max — same value the cofounder's
        // binary uses (kCGSMaximumWindowLevel).
        let kAboveKiosk: Int32 = 2_147_483_630
        CGSBridge.setWindowLevel(windowNumber: wn, level: kAboveKiosk)

        NSLog("[OverlayPanel] stealth applied to window %d", windowNumber)
    }

    // MARK: - NSWindow overrides

    // A borderless panel normally can't become key. Override so the overlay
    // can receive keyboard input (for the query composer).
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // Re-apply stealth every time the window is ordered front — macOS can
    // reset the sharing state when a window is re-shown.
    override func orderFront(_ sender: Any?) {
        super.orderFront(sender)
        applyStealth()
    }

    override func makeKeyAndOrderFront(_ sender: Any?) {
        super.makeKeyAndOrderFront(sender)
        applyStealth()
    }
}
