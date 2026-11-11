import Cocoa
import Metal
import QuartzCore

/// An NSView backed by a `CAMetalLayer`, driven by a `CVDisplayLink` for
/// vsync-paced rendering. The layer is configured as non-opaque with
/// premultiplied-alpha so transparent regions of the overlay show the
/// desktop beneath.
///
/// In Phase 4+ this view sits behind an NSHostingView (SwiftUI) so the
/// Metal layer can composite custom effects underneath the UI.
final class MetalView: NSView {

    private(set) var metalLayer: CAMetalLayer!
    private var renderer: Renderer?
    private var displayLink: CVDisplayLink?

    // MARK: - Init

    init(frame: NSRect, renderer: Renderer) {
        self.renderer = renderer
        super.init(frame: frame)
        wantsLayer = true
        setupMetalLayer()
        startDisplayLink()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        stopDisplayLink()
    }

    // MARK: - Layer setup

    override func makeBackingLayer() -> CALayer {
        let layer = CAMetalLayer()
        layer.device = renderer?.device
        layer.pixelFormat = .bgra8Unorm
        layer.isOpaque = false
        layer.framebufferOnly = false
        layer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2.0
        layer.allowsNextDrawableTimeout = true
        self.metalLayer = layer
        return layer
    }

    private func setupMetalLayer() {
        guard let metalLayer else { return }
        metalLayer.device = renderer?.device
        updateDrawableSize()
    }

    // MARK: - Resize

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateDrawableSize()
    }

    override func setBoundsSize(_ newSize: NSSize) {
        super.setBoundsSize(newSize)
        updateDrawableSize()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        guard let metalLayer else { return }
        metalLayer.contentsScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
        updateDrawableSize()
    }

    private func updateDrawableSize() {
        guard let metalLayer else { return }
        let scale = metalLayer.contentsScale
        let size = bounds.size
        let w = max(1, size.width * scale)
        let h = max(1, size.height * scale)
        if metalLayer.drawableSize.width != w || metalLayer.drawableSize.height != h {
            metalLayer.drawableSize = CGSize(width: w, height: h)
        }
    }

    // MARK: - Display link (vsync-paced rendering)

    private func startDisplayLink() {
        guard displayLink == nil else { return }

        var link: CVDisplayLink?
        CVDisplayLinkCreateWithActiveCGDisplays(&link)
        guard let link else { return }

        let this = Unmanaged.passUnretained(self).toOpaque()
        CVDisplayLinkSetOutputCallback(link, { (_, _, _, _, _, userInfo) -> CVReturn in
            let view = Unmanaged<MetalView>.fromOpaque(userInfo!).takeUnretainedValue()
            view.renderFrame()
            return kCVReturnSuccess
        }, this)

        CVDisplayLinkStart(link)
        self.displayLink = link
        NSLog("[MetalView] display link started")
    }

    private func stopDisplayLink() {
        guard let link = displayLink else { return }
        CVDisplayLinkStop(link)
        displayLink = nil
    }

    private func renderFrame() {
        guard let metalLayer, let renderer else { return }
        renderer.draw(in: metalLayer)
    }
}
