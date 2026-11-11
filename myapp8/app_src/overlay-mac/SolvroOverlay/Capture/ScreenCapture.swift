import Cocoa
import ScreenCaptureKit

final class ScreenCapture {

    static let shared = ScreenCapture()

    private let maxScreenshots = 20
    private(set) var screenshots: [String] = []

    private init() {}

    func captureScreenshot(excludingWindow overlayWindowID: CGWindowID? = nil, completion: @escaping (Bool) -> Void) {
        guard screenshots.count < maxScreenshots else {
            NSLog("[ScreenCapture] max screenshots reached (%d)", maxScreenshots)
            completion(false)
            return
        }

        if #available(macOS 12.3, *) {
            captureWithSCK(excludingWindow: overlayWindowID, completion: completion)
        } else {
            captureWithCGWindow(excludingWindow: overlayWindowID, completion: completion)
        }
    }

    func clearScreenshots() {
        screenshots.removeAll()
    }

    // MARK: - ScreenCaptureKit (macOS 12.3+)

    @available(macOS 12.3, *)
    private func captureWithSCK(excludingWindow overlayWindowID: CGWindowID?, completion: @escaping (Bool) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, error in
            guard let self, let content, error == nil else {
                NSLog("[ScreenCapture] SCShareableContent failed: %@", error?.localizedDescription ?? "unknown")
                DispatchQueue.main.async { completion(false) }
                return
            }

            guard let display = content.displays.first else {
                NSLog("[ScreenCapture] no display found")
                DispatchQueue.main.async { completion(false) }
                return
            }

            var excludedWindows: [SCWindow] = []
            if let overlayID = overlayWindowID {
                for window in content.windows where window.windowID == overlayID {
                    excludedWindows.append(window)
                }
            }

            let filter = SCContentFilter(display: display, excludingWindows: excludedWindows)
            let config = SCStreamConfiguration()
            config.width = min(Int(display.width), 1920)
            config.height = min(Int(display.height), 1080)
            config.showsCursor = false
            config.pixelFormat = kCVPixelFormatType_32BGRA

            if #available(macOS 14.0, *) {
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { [weak self] image, error in
                    guard let self, let image, error == nil else {
                        NSLog("[ScreenCapture] capture failed: %@", error?.localizedDescription ?? "unknown")
                        DispatchQueue.main.async { completion(false) }
                        return
                    }
                    let base64 = self.cgImageToBase64JPEG(image)
                    if let base64, !base64.isEmpty {
                        self.screenshots.append(base64)
                        NSLog("[ScreenCapture] captured (%d total)", self.screenshots.count)
                        DispatchQueue.main.async { completion(true) }
                    } else {
                        DispatchQueue.main.async { completion(false) }
                    }
                }
            } else {
                self.captureWithCGWindow(excludingWindow: overlayWindowID, completion: completion)
            }
        }
    }

    // MARK: - CGWindowListCreateImage fallback

    private func captureWithCGWindow(excludingWindow overlayWindowID: CGWindowID?, completion: @escaping (Bool) -> Void) {
        DispatchQueue.global().async { [weak self] in
            guard let self else {
                DispatchQueue.main.async { completion(false) }
                return
            }

            var windowList: CFArray?
            if let overlayID = overlayWindowID {
                let exclude = [overlayID] as CFArray
                windowList = exclude
            }

            guard let image = CGWindowListCreateImage(
                CGRect.null,
                .optionOnScreenOnly,
                kCGNullWindowID,
                [.boundsIgnoreFraming, .nominalResolution]
            ) else {
                NSLog("[ScreenCapture] CGWindowListCreateImage failed")
                DispatchQueue.main.async { completion(false) }
                return
            }

            if self.isImageBlack(image) {
                NSLog("[ScreenCapture] black screen detected, skipping")
                DispatchQueue.main.async { completion(false) }
                return
            }

            if let base64 = self.cgImageToBase64JPEG(image), !base64.isEmpty {
                self.screenshots.append(base64)
                NSLog("[ScreenCapture] captured via CGWindow (%d total)", self.screenshots.count)
                DispatchQueue.main.async { completion(true) }
            } else {
                DispatchQueue.main.async { completion(false) }
            }
        }
    }

    // MARK: - Helpers

    private func cgImageToBase64JPEG(_ image: CGImage) -> String? {
        let bitmapRep = NSBitmapImageRep(cgImage: image)
        guard let jpegData = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            return nil
        }
        return jpegData.base64EncodedString()
    }

    private func isImageBlack(_ image: CGImage) -> Bool {
        guard let data = image.dataProvider?.data,
              let ptr = CFDataGetBytePtr(data) else { return true }
        let length = CFDataGetLength(data)
        let step = 64
        var i = 0
        while i < length - 2 {
            if ptr[i] > 15 && ptr[i + 1] > 15 && ptr[i + 2] > 15 {
                return false
            }
            i += step
        }
        return true
    }
}
