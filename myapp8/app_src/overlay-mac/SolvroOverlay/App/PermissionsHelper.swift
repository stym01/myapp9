import Cocoa
import AVFoundation

enum PermissionsHelper {

    static func checkAccessibility() -> Bool {
        let trusted = AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        )
        NSLog("[Permissions] accessibility: %@", trusted ? "granted" : "not granted")
        return trusted
    }

    static func checkScreenRecording() -> Bool {
        let stream = CGDisplayStream(
            dispatchQueueDisplay: CGMainDisplayID(),
            outputWidth: 1, outputHeight: 1,
            pixelFormat: Int32(kCVPixelFormatType_32BGRA),
            properties: nil,
            queue: DispatchQueue.global(),
            handler: { _, _, _, _ in }
        )
        let granted = stream != nil
        NSLog("[Permissions] screen recording: %@", granted ? "granted" : "not granted")
        return granted
    }

    static func checkMicrophone(completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            NSLog("[Permissions] microphone: authorized")
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                NSLog("[Permissions] microphone: %@", granted ? "granted" : "denied")
                completion(granted)
            }
        default:
            NSLog("[Permissions] microphone: denied")
            completion(false)
        }
    }

    static func preventSleep() {
        var assertionID: IOPMAssertionID = 0
        let result = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            "Solvro Overlay Active" as CFString,
            &assertionID
        )
        if result == kIOReturnSuccess {
            NSLog("[Permissions] sleep prevention assertion created (id=%d)", assertionID)
        }
    }
}
