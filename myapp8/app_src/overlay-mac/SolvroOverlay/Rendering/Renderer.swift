import Metal
import QuartzCore

/// Manages the Metal device, command queue, and per-frame render passes.
/// Clears to transparent each frame so only drawn UI is visible through
/// the overlay panel's borderless, non-opaque surface.
final class Renderer {

    let device: MTLDevice
    let commandQueue: MTLCommandQueue

    init?() {
        guard let device = MTLCreateSystemDefaultDevice() else {
            NSLog("[Renderer] Metal is not available on this machine")
            return nil
        }
        guard let queue = device.makeCommandQueue() else {
            NSLog("[Renderer] failed to create command queue")
            return nil
        }
        self.device = device
        self.commandQueue = queue
        NSLog("[Renderer] Metal device: %@", device.name)
    }

    /// Draw one frame into `drawable`, clearing to fully transparent.
    /// Returns `true` if the frame was submitted successfully.
    @discardableResult
    func draw(in layer: CAMetalLayer) -> Bool {
        guard let drawable = layer.nextDrawable() else { return false }
        guard let buffer = commandQueue.makeCommandBuffer() else { return false }

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)

        guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return false }
        // Phase 3: clear-only pass. Later phases add geometry here.
        encoder.endEncoding()

        buffer.present(drawable)
        buffer.commit()
        return true
    }
}
