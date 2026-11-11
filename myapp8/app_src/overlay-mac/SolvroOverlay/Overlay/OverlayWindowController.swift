import Cocoa
import SwiftUI

final class OverlayWindowController {

    private(set) var panel: OverlayPanel?
    private(set) var renderer: Renderer?
    private(set) var metalView: MetalView?
    private(set) var hostingView: NSHostingView<OverlayContentView>?
    let viewModel = OverlayViewModel()

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

        let viewFrame = NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight)

        // Base container that holds Metal + SwiftUI layers
        let container = NSView(frame: viewFrame)
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        overlay.contentView = container

        // Metal layer (bottom) — clears to transparent each frame
        if let r = Renderer() {
            self.renderer = r
            let mv = MetalView(frame: viewFrame, renderer: r)
            mv.autoresizingMask = [.width, .height]
            container.addSubview(mv)
            self.metalView = mv
            NSLog("[OverlayWindowController] Metal rendering active")
        }

        // SwiftUI layer (top) — the actual overlay UI
        let contentView = OverlayContentView(viewModel: viewModel)
        let hosting = NSHostingView(rootView: contentView)
        hosting.frame = viewFrame
        hosting.autoresizingMask = [.width, .height]
        container.addSubview(hosting)
        self.hostingView = hosting
        NSLog("[OverlayWindowController] SwiftUI hosting view added")

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
