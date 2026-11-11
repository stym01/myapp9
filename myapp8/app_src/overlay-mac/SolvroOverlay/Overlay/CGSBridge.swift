import Foundation
import CoreGraphics

// Dynamic bridge to CoreGraphics Server (CGS) private APIs.
// These are undocumented but stable across macOS 10.x–15.x. Loaded via dlsym
// so the project compiles against any SDK without a bridging header.

enum CGSBridge {

    // MARK: - Window sharing states

    static let sharingNone: Int32     = 0   // hidden from CGWindowListCopyWindowInfo & ScreenCaptureKit
    static let sharingReadOnly: Int32 = 1
    static let sharingReadWrite: Int32 = 2

    // MARK: - Resolved function pointers (lazy, once)

    private static let handle: UnsafeMutableRawPointer? = dlopen(nil, RTLD_NOW)

    private static let _CGSMainConnectionID: (@convention(c) () -> Int32)? = {
        guard let handle, let sym = dlsym(handle, "CGSMainConnectionID") else { return nil }
        return unsafeBitCast(sym, to: (@convention(c) () -> Int32).self)
    }()

    private static let _CGSSetWindowSharingState: (@convention(c) (Int32, UInt32, Int32) -> Int32)? = {
        guard let handle, let sym = dlsym(handle, "CGSSetWindowSharingState") else { return nil }
        return unsafeBitCast(sym, to: (@convention(c) (Int32, UInt32, Int32) -> Int32).self)
    }()

    private static let _CGSSetWindowLevel: (@convention(c) (Int32, UInt32, Int32) -> Int32)? = {
        guard let handle, let sym = dlsym(handle, "CGSSetWindowLevel") else { return nil }
        return unsafeBitCast(sym, to: (@convention(c) (Int32, UInt32, Int32) -> Int32).self)
    }()

    // MARK: - Public API

    static var connectionID: Int32 {
        _CGSMainConnectionID?() ?? 0
    }

    /// Hide a window from CGWindowListCopyWindowInfo, ScreenCaptureKit, and
    /// screenshot utilities. Pass `sharingNone` to hide, `sharingReadOnly` to
    /// make it visible again.
    @discardableResult
    static func setWindowSharingState(windowNumber: UInt32, state: Int32) -> Bool {
        guard let fn = _CGSSetWindowSharingState else {
            NSLog("[CGSBridge] CGSSetWindowSharingState not available")
            return false
        }
        let cid = connectionID
        guard cid != 0 else {
            NSLog("[CGSBridge] CGSMainConnectionID returned 0")
            return false
        }
        let err = fn(cid, windowNumber, state)
        if err != 0 {
            NSLog("[CGSBridge] CGSSetWindowSharingState(%d, %u, %d) = %d", cid, windowNumber, state, err)
        }
        return err == 0
    }

    /// Place a window at an arbitrary window-server level. Levels above
    /// CGWindowLevelForKey(.maximumWindow) float over kiosk / fullscreen apps.
    @discardableResult
    static func setWindowLevel(windowNumber: UInt32, level: Int32) -> Bool {
        guard let fn = _CGSSetWindowLevel else {
            NSLog("[CGSBridge] CGSSetWindowLevel not available")
            return false
        }
        let cid = connectionID
        guard cid != 0 else { return false }
        let err = fn(cid, windowNumber, level)
        if err != 0 {
            NSLog("[CGSBridge] CGSSetWindowLevel(%d, %u, %d) = %d", cid, windowNumber, level, err)
        }
        return err == 0
    }
}
