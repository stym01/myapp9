import Cocoa
import Combine

final class OverlayViewModel: ObservableObject {

    @Published var messages: [ChatMessage] = []
    @Published var inputText: String = ""
    @Published var isLoading: Bool = false
    @Published var statusText: String = "Ready"

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

        let userMsg = ChatMessage(role: .user, text: trimmed, timestamp: Date())
        messages.append(userMsg)
        inputText = ""
        isLoading = true
        statusText = "Thinking..."

        // Placeholder — Phase 8+ wires this to solvro.in/api/ai
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            self.isLoading = false
            self.statusText = "Ready"
        }
    }

    func resetChat() {
        messages.removeAll()
        inputText = ""
        isLoading = false
        statusText = "Ready"
        NSLog("[OverlayViewModel] chat reset")
    }

    func clearMessages() {
        messages.removeAll()
    }
}
