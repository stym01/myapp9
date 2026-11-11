import SwiftUI

struct OverlayContentView: View {

    @ObservedObject var viewModel: OverlayViewModel

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().background(Color.white.opacity(0.15))
            chatArea
            Divider().background(Color.white.opacity(0.15))
            inputBar
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
            Text(msg.text)
                .font(.system(size: 13))
                .foregroundColor(.white.opacity(0.9))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(msg.role == .user
                              ? Color(nsColor: NSColor(red: 0.20, green: 0.36, blue: 0.85, alpha: 0.7))
                              : Color.white.opacity(0.08))
                )
                .textSelection(.enabled)
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
