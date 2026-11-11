import Cocoa

/// Manages the lifecycle of the stealth overlay panel: creation, positioning,
/// opacity, visibility toggle, and movement.
final class OverlayWindowController {

    private(set) var panel: OverlayPanel?
    private(set) var renderer: Renderer?
    private(set) var metalView: MetalView?

    // Opacity state — mirrors the Windows Electron app's logic
    private var currentOpacity: CGFloat = 1.0
    private var lastVisibleOpacity: CGFloat = 1.0
    private var isHidden = false
    private let minVisibleOpacity: CGFloat = 0.05

    // MARK: - Lifecycle

    func createAndShow() {
        guard let screen = NSScreen.main else { return }

        let screenFrame = screen.frame
        let panelWidth: CGFloat = 800
        let panelHeight: CGFloat = screenFrame.height
        let panelRect = NSRect(
            x: screenFrame.origin.x,
            y: screenFrame.origin.y,
            width: panelWidth,
            height: panelHeight
        )

        let overlay = OverlayPanel(contentRect: panelRect)

        // Metal rendering surface — clears to transparent each frame so the
        // overlay composites cleanly over the desktop. SwiftUI views will be
        // added as a subview on top in Phase 4.
        let viewFrame = NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight)
        if let r = Renderer() {
            self.renderer = r
            let mv = MetalView(frame: viewFrame, renderer: r)
            mv.autoresizingMask = [.width, .height]
            overlay.contentView = mv
            self.metalView = mv
            NSLog("[OverlayWindowController] Metal rendering active")
        } else {
            // Fallback: plain dark view if Metal is unavailable (e.g. VM)
            let placeholder = NSView(frame: viewFrame)
            placeholder.wantsLayer = true
            placeholder.layer?.backgroundColor = NSColor(red: 0.102, green: 0.102, blue: 0.180, alpha: 0.85).cgColor
            overlay.contentView = placeholder
            NSLog("[OverlayWindowController] Metal unavailable, using fallback view")
        }

        overlay.alphaValue = currentOpacity
        overlay.orderFront(nil)

        self.panel = overlay
        NSLog("[OverlayWindowController] panel created and shown (%gx%g)", panelWidth, panelHeight)
    }

    func close() {
        panel?.close()
        panel = nil
    }

    // MARK: - Visibility toggle (matches Windows Ctrl+Space / ⌘Space)

    func toggleVisibility() {
        guard let panel else { return }

        if isHidden {
            currentOpacity = lastVisibleOpacity
            isHidden = false
            panel.alphaValue = currentOpacity
            NSLog("[OverlayWindowController] restored opacity to %.0f%%", currentOpacity * 100)
        } else {
            lastVisibleOpacity = currentOpacity
            currentOpacity = 0.0
            isHidden = true
            panel.alphaValue = 0.0
            NSLog("[OverlayWindowController] hidden via opacity toggle (saved %.0f%%)", lastVisibleOpacity * 100)
        }
    }

    // MARK: - Opacity control

    /// The opacity the user is currently steering. While hidden, adjustments
    /// target the value that will be restored on the next toggle.
    var targetOpacity: CGFloat {
        isHidden ? lastVisibleOpacity : currentOpacity
    }

    func adjustOpacity(delta: CGFloat) {
        let previous = targetOpacity
        let clamped = max(0.0, min(1.0, previous + delta))

        if isHidden {
            lastVisibleOpacity = max(minVisibleOpacity, clamped)
        } else {
            currentOpacity = clamped
            if currentOpacity > 0 { lastVisibleOpacity = currentOpacity }
            panel?.alphaValue = currentOpacity
        }
    }

    func setOpacity(_ value: CGFloat) {
        let clamped = max(0.0, min(1.0, value))
        if isHidden {
            lastVisibleOpacity = max(minVisibleOpacity, clamped)
        } else {
            currentOpacity = clamped
            if currentOpacity > 0 { lastVisibleOpacity = currentOpacity }
            panel?.alphaValue = currentOpacity
        }
    }

    // MARK: - Click-through toggle (matches Windows ⌘⇧C)

    private var isClickThrough = false

    func toggleClickThrough() {
        guard let panel else { return }
        isClickThrough.toggle()
        panel.ignoresMouseEvents = isClickThrough
        NSLog("[OverlayWindowController] click-through %@", isClickThrough ? "ON" : "OFF")
    }

    // MARK: - Window movement

    func move(dx: CGFloat, dy: CGFloat) {
        guard let panel else { return }
        var frame = panel.frame
        frame.origin.x += dx
        frame.origin.y += dy
        panel.setFrame(frame, display: false)
    }
}
