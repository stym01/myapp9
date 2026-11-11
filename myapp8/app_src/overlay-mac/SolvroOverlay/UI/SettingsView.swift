import SwiftUI

struct SettingsView: View {

    @ObservedObject var viewModel: OverlayViewModel
    @Binding var isPresented: Bool

    @State private var opacity: Double = AppConfig.shared.windowOpacity
    @State private var chatHistoryEnabled: Bool = ChatHistory.shared.enabled

    var body: some View {
        VStack(spacing: 0) {
            settingsHeader
            Divider().background(Color.white.opacity(0.15))

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    shortcutsSection
                    Divider().background(Color.white.opacity(0.1))
                    appearanceSection
                    Divider().background(Color.white.opacity(0.1))
                    chatHistorySection
                    Divider().background(Color.white.opacity(0.1))
                    aboutSection
                }
                .padding(14)
            }

            Divider().background(Color.white.opacity(0.15))
            backButton
        }
        .background(Color(nsColor: NSColor(red: 0.08, green: 0.08, blue: 0.14, alpha: 0.95)))
    }

    private var settingsHeader: some View {
        HStack {
            Text("SETTINGS")
                .font(.system(size: 14, weight: .bold))
                .foregroundColor(Color(nsColor: NSColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 1.0)))
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var shortcutsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("KEYBOARD SHORTCUTS")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Color(nsColor: NSColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 0.8)))

            shortcutRow("Toggle Visibility", "⌘ Space")
            shortcutRow("Send Message", "⌘ Enter")
            shortcutRow("Take Screenshot", "⌘⇧ S")
            shortcutRow("Reset Chat", "⌘ R")
            shortcutRow("Cycle Model", "⌘⇧ M")
            shortcutRow("Cycle Language", "⌘⇧ L")
            shortcutRow("Decrease Opacity", "⌘⇧ [")
            shortcutRow("Increase Opacity", "⌘⇧ ]")
            shortcutRow("Move Window", "⌘⇧ Arrows")
            shortcutRow("Start Auto-Type", "⌘⇧ T")
            shortcutRow("Resume Auto-Type", "⌘⇧ Y")
            shortcutRow("Stop Auto-Type", "F8")
            shortcutRow("Quit", "⌘⇧ Q")
        }
    }

    private func shortcutRow(_ label: String, _ keys: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.7))
            Spacer()
            Text(keys)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.white.opacity(0.4))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.white.opacity(0.06))
                .cornerRadius(4)
        }
    }

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("APPEARANCE")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Color(nsColor: NSColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 0.8)))

            HStack {
                Text("Window Opacity")
                    .font(.system(size: 12))
                    .foregroundColor(.white.opacity(0.7))
                Spacer()
                Text("\(Int(opacity * 100))%")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.white.opacity(0.4))
                    .frame(width: 40)
            }
            Slider(value: $opacity, in: 0...1, step: 0.05)
                .onChange(of: opacity) { newVal in
                    AppConfig.shared.windowOpacity = newVal
                    if let panel = NSApp.windows.first(where: { $0 is OverlayPanel }) {
                        panel.alphaValue = newVal
                    }
                }
        }
    }

    private var chatHistorySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CHAT HISTORY")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Color(nsColor: NSColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 0.8)))

            Toggle(isOn: $chatHistoryEnabled) {
                Text("Save chat history to Desktop")
                    .font(.system(size: 12))
                    .foregroundColor(.white.opacity(0.7))
            }
            .toggleStyle(.switch)
            .onChange(of: chatHistoryEnabled) { newVal in
                ChatHistory.shared.enabled = newVal
            }

            Text("Saves questions and responses to ~/Desktop/Solvro-chat-history/")
                .font(.system(size: 10))
                .foregroundColor(.white.opacity(0.3))
        }
    }

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ABOUT")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Color(nsColor: NSColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 0.8)))

            let session = SessionManager.shared
            if session.isLoggedIn {
                if !session.email.isEmpty {
                    infoRow("Email", session.email)
                }
                infoRow("Tier", session.userTier == 0 ? "Free" : session.userTier == 1 ? "Pro" : "Pro+")
            } else {
                Text("Not signed in")
                    .font(.system(size: 12))
                    .foregroundColor(.white.opacity(0.5))
            }

            infoRow("Version", kOverlayVersion)
            infoRow("Platform", "macOS (Metal/SwiftUI)")
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.5))
            Spacer()
            Text(value)
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.7))
        }
    }

    private var backButton: some View {
        Button(action: { isPresented = false }) {
            Text("BACK TO CHAT")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.white.opacity(0.8))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .background(Color.white.opacity(0.06))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
