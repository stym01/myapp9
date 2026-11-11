import SwiftUI

struct OverlayContentView: View {

    @ObservedObject var viewModel: OverlayViewModel
    @State private var showSettings = false

    var body: some View {
        ZStack {
            if showSettings {
                SettingsView(viewModel: viewModel, isPresented: $showSettings)
            } else {
                VStack(spacing: 0) {
                    headerBar
                    Divider().background(Color.white.opacity(0.15))
                    chatArea
                    Divider().background(Color.white.opacity(0.15))
                    inputBar
                }
            }
        }
        .background(Color(nsColor: NSColor(red: 0.08, green: 0.08, blue: 0.14, alpha: 0.92)))
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack {
            Text("Solvro")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.white)

            if !viewModel.modelName.isEmpty {
                Text(viewModel.modelName)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.white.opacity(0.4))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.white.opacity(0.08))
                    .cornerRadius(4)
            }

            if !viewModel.languageName.isEmpty {
                Text(viewModel.languageName)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.white.opacity(0.4))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.white.opacity(0.08))
                    .cornerRadius(4)
            }

            Spacer()

            Text(viewModel.statusText)
                .font(.system(size: 11))
                .foregroundColor(.white.opacity(0.5))
                .lineLimit(1)

            Button(action: { showSettings.toggle() }) {
                Image(systemName: "gearshape.fill")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.4))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Chat area

    private var chatArea: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if viewModel.messages.isEmpty {
                        emptyState
                    }
                    ForEach(viewModel.messages) { msg in
                        messageBubble(msg)
                            .id(msg.id)
                    }
                    if viewModel.isLoading {
                        loadingIndicator
                    }
                }
                .padding(14)
            }
            .onChange(of: viewModel.messages.count) { _ in
                if let last = viewModel.messages.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Text("Solvro Overlay")
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(.white.opacity(0.6))
            Text("Type a question below to get started.")
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.35))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 60)
    }

    private func messageBubble(_ msg: OverlayViewModel.ChatMessage) -> some View {
        HStack {
            if msg.role == .user { Spacer(minLength: 60) }

            if msg.role == .user {
                Text(msg.text)
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.9))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Color(nsColor: NSColor(red: 0.20, green: 0.36, blue: 0.85, alpha: 0.7)))
                    )
                    .textSelection(.enabled)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(MarkdownParser.parse(msg.text)) { segment in
                        switch segment {
                        case .text(let content):
                            Text(content)
                                .font(.system(size: 13))
                                .foregroundColor(.white.opacity(0.9))
                        case .code(let content, _):
                            Text(content)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundColor(Color(nsColor: NSColor(red: 0.6, green: 0.9, blue: 0.6, alpha: 1.0)))
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(
                                    RoundedRectangle(cornerRadius: 6)
                                        .fill(Color(nsColor: NSColor(red: 0.05, green: 0.05, blue: 0.1, alpha: 0.9)))
                                )
                                .textSelection(.enabled)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color.white.opacity(0.08))
                )
                .textSelection(.enabled)
            }

            if msg.role == .assistant { Spacer(minLength: 60) }
        }
    }

    private var loadingIndicator: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(Color.white.opacity(0.4))
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.white.opacity(0.08))
        )
    }

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Ask something...", text: $viewModel.inputText)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundColor(.white)
                .padding(8)
                .background(Color.white.opacity(0.06))
                .cornerRadius(8)
                .onSubmit { viewModel.sendMessage() }

            Button(action: { viewModel.sendMessage() }) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22))
                    .foregroundColor(viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty
                                     ? .white.opacity(0.2) : .white.opacity(0.8))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
