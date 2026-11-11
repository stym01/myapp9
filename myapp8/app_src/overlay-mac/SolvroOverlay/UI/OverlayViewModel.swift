import Cocoa
import Combine

final class OverlayViewModel: ObservableObject {

    @Published var messages: [ChatMessage] = []
    @Published var inputText: String = ""
    @Published var isLoading: Bool = false
    @Published var statusText: String = "Ready"
    @Published var modelName: String = ""
    @Published var languageName: String = ""

    struct ChatMessage: Identifiable {
        let id = UUID()
        let role: Role
        let text: String
        let timestamp: Date

        enum Role {
            case user
            case assistant
        }
    }

    func sendMessage() {
        let trimmed = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        guard SessionManager.shared.isLoggedIn else {
            statusText = "Please sign in via the Solvro app"
            return
        }

        let userMsg = ChatMessage(role: .user, text: trimmed, timestamp: Date())
        messages.append(userMsg)
        inputText = ""
        isLoading = true
        statusText = "Thinking..."

        let screenshots = ScreenCapture.shared.screenshots
        let hasImages = !screenshots.isEmpty
        ConversationManager.shared.addUserMessage(trimmed, hasImage: hasImages)
        ScreenCapture.shared.clearScreenshots()

        AIClient.shared.sendToAI(userPrompt: trimmed, screenshots: screenshots) { [weak self] response in
            guard let self else { return }
            ConversationManager.shared.addAssistantMessage(response)
            let assistantMsg = ChatMessage(role: .assistant, text: response, timestamp: Date())
            self.messages.append(assistantMsg)
            self.isLoading = false
            self.statusText = ModelCatalog.shared.currentModel?.displayName ?? "Ready"
            ChatHistory.shared.saveEntry(question: trimmed, response: response, screenshots: screenshots)
        }
    }

    func resetChat() {
        messages.removeAll()
        inputText = ""
        isLoading = false
        statusText = "Ready"
        NSLog("[OverlayViewModel] chat reset")
    }

    func cycleModel() {
        let catalog = ModelCatalog.shared
        catalog.cycleModel()
        let name = catalog.currentModel?.displayName ?? "Unknown"
        modelName = name
        statusText = "Model: \(name)"
        AppConfig.shared.selectedModelIndex = catalog.selectedModelIndex
        NSLog("[OverlayViewModel] model → %@", name)
    }

    func cycleLanguage() {
        let catalog = ModelCatalog.shared
        catalog.cycleLanguage()
        let lang = catalog.currentLanguage.displayName
        languageName = lang
        statusText = "Language: \(lang)"
        AppConfig.shared.selectedLanguageIndex = catalog.selectedLanguageIndex
        NSLog("[OverlayViewModel] language → %@", lang)
    }

    func clearMessages() {
        messages.removeAll()
    }
}
