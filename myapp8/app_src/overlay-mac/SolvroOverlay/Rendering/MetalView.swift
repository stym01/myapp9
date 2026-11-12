import Cocoa
import Metal
import QuartzCore

/// An NSView backed by a `CAMetalLayer`, driven by a `CVDisplayLink` for
/// vsync-paced rendering.  Hosts Dear ImGui via the Metal backend.
final class MetalView: NSView {

    private(set) var metalLayer: CAMetalLayer!
    let device: MTLDevice
    let commandQueue: MTLCommandQueue
    private var displayLink: CVDisplayLink?
    private var isRendering = false
    private var imguiReady = false

    // MARK: - Init

    init(frame: NSRect, device: MTLDevice, commandQueue: MTLCommandQueue) {
        self.device = device
        self.commandQueue = commandQueue
        super.init(frame: frame)
        wantsLayer = true
        setupMetalLayer()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        stopDisplayLink()
        ImGuiBridge_Shutdown()
    }

    // MARK: - ImGui lifecycle

    func initImGui() {
        guard !imguiReady else { return }
        ImGuiBridge_Init(device, self)
        imguiReady = true
        startDisplayLink()
    }

    // MARK: - Layer setup

    override func makeBackingLayer() -> CALayer {
        let layer = CAMetalLayer()
        layer.device = device
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
        metalLayer.device = device
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
            view.displayLinkFired()
            return kCVReturnSuccess
        }, this)

        CVDisplayLinkStart(link)
        self.displayLink = link
        NSLog("[MetalView] display link started (ImGui mode)")
    }

    private func stopDisplayLink() {
        guard let link = displayLink else { return }
        CVDisplayLinkStop(link)
        displayLink = nil
    }

    private func displayLinkFired() {
        guard !isRendering else { return }
        isRendering = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            defer { self.isRendering = false }
            self.renderFrame()
        }
    }

    private func renderFrame() {
        guard let metalLayer, imguiReady else { return }
        ImGuiBridge_RenderFrame(metalLayer, commandQueue)
    }

    // MARK: - Event handling (forward to ImGui via responder chain)

    override var acceptsFirstResponder: Bool { true }
}
