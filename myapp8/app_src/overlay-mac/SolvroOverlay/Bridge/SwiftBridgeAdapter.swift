import Cocoa

final class SwiftBridgeAdapter {

    private weak var controller: OverlayWindowController?
    private var pollTimer: Timer?
    private let pollInterval: TimeInterval = 1.0 / 30.0 // 30 Hz

    init(controller: OverlayWindowController) {
        self.controller = controller
    }

    func start() {
        pushFullState()
        pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        NSLog("[SwiftBridgeAdapter] polling started at %.0f Hz", 1.0 / pollInterval)
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func tick() {
        pushFullState()
        pollActions()
    }

    // MARK: - Push state from Swift → C++ bridge

    private func pushFullState() {
        guard let vm = controller?.viewModel else { return }

        let session = SessionManager.shared
        let catalog = ModelCatalog.shared
        let capture = ScreenCapture.shared

        let modelName = catalog.currentModel?.displayName ?? ""
        let langName = catalog.currentLanguage.displayName

        ImGuiBridge_UpdateChatState(
            Int32(vm.messages.count),
            vm.isLoading,
            vm.statusText,
            modelName,
            langName,
            session.isLoggedIn,
            session.email,
            Int32(session.userTier),
            Int32(capture.screenshots.count)
        )

        ImGuiBridge_ClearMessages()
        for msg in vm.messages {
            let role: String = msg.role == .user ? "user" : "assistant"
            ImGuiBridge_PushMessage(role, msg.text)
        }
    }

    // MARK: - Poll actions from C++ bridge → Swift

    private func pollActions() {
        guard let vm = controller?.viewModel else { return }

        if ImGuiBridge_ConsumeAction_Send() {
            if let inputPtr = ImGuiBridge_ConsumeInput() {
                let text = String(cString: inputPtr)
                if !text.isEmpty {
                    vm.inputText = text
                }
            }
            vm.sendMessage()
        }

        if ImGuiBridge_ConsumeAction_Reset() {
            vm.resetChat()
        }

        if ImGuiBridge_ConsumeAction_CycleModel() {
            vm.cycleModel()
        }

        if ImGuiBridge_ConsumeAction_CycleLanguage() {
            vm.cycleLanguage()
        }

        if ImGuiBridge_ConsumeAction_Screenshot() {
            let windowID = controller?.panel?.windowNumber ?? 0
            ScreenCapture.shared.captureScreenshot(excludingWindow: CGWindowID(windowID)) { success in
                if success {
                    vm.statusText = "Screenshot captured (\(ScreenCapture.shared.screenshots.count))"
                }
            }
        }

        if ImGuiBridge_ConsumeAction_AutoType() {
            AutoTyper.shared.start()
        }

        if ImGuiBridge_ConsumeAction_CopyLast() {
            copyLastResponse()
        }
    }

    private func copyLastResponse() {
        guard let vm = controller?.viewModel else { return }
        if let last = vm.messages.last(where: { $0.role == .assistant }) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(last.text, forType: .string)
            vm.statusText = "Copied to clipboard"
            NSLog("[SwiftBridgeAdapter] copied last AI response to clipboard")
        }
    }

    deinit {
        stop()
    }
}
