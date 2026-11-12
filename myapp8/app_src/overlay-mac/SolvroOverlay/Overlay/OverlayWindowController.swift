import Cocoa

final class OverlayWindowController {

    private(set) var panel: OverlayPanel?
    private(set) var metalView: MetalView?
    let viewModel = OverlayViewModel()

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

        let container = NSView(frame: viewFrame)
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        overlay.contentView = container

        guard let device = MTLCreateSystemDefaultDevice(),
              let commandQueue = device.makeCommandQueue() else {
            NSLog("[OverlayWindowController] Metal not available")
            return
        }

        let mv = MetalView(frame: viewFrame, device: device, commandQueue: commandQueue)
        mv.autoresizingMask = [.width, .height]
        container.addSubview(mv)
        self.metalView = mv
        NSLog("[OverlayWindowController] MetalView added (ImGui mode)")

        overlay.alphaValue = currentOpacity
        overlay.orderFront(nil)

        self.panel = overlay

        mv.initImGui()

        NSLog("[OverlayWindowController] panel created (%gx%g), ImGui active",
              panelWidth, panelHeight)
    }

    func close() {
        panel?.close()
        panel = nil
    }

    // MARK: - Visibility toggle

    func toggleVisibility() {
        guard let panel else { return }

        if isHidden {
            currentOpacity = lastVisibleOpacity
            isHidden = false
            panel.alphaValue = currentOpacity
        } else {
            lastVisibleOpacity = currentOpacity
            currentOpacity = 0.0
            isHidden = true
            panel.alphaValue = 0.0
        }
    }

    // MARK: - Opacity control

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

    // MARK: - Click-through toggle

    private var isClickThrough = false

    func toggleClickThrough() {
        guard let panel else { return }
        isClickThrough.toggle()
        panel.ignoresMouseEvents = isClickThrough
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
