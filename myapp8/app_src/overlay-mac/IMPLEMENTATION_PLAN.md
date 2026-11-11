# Solvro macOS Native Overlay — Implementation Plan

## Architecture

- **Electron app** (`myapp8/app_src/`) = main UI with login, AI chat, settings, interview mode — already cross-platform
- **Native overlay** = stealth binary that floats above proctoring apps, hidden from screen capture
  - Windows: `hope.exe` (C++/DirectX11/ImGui) — already working
  - macOS: `solvro-overlay.app` (Swift/Metal/AppKit) — THIS is what we're building
- Electron's `launch-overlay-mode` IPC handler (`main.js:3442`) currently returns "Overlay mode is only available on Windows" on Mac — the gap to fill
- Overlay binary lives in `overlay-mac-bin/solvro-overlay.app` as Electron `extraResources`

## Key Technologies

- **CGS Private APIs** via `dlsym`: `CGSSetWindowSharingState` (hide from screen capture), `CGSSetWindowLevel` (float above kiosk)
- **NSPanel** with `.borderless`, `.nonactivatingPanel`, `.screenSaver` level, `canJoinAllSpaces`, `fullScreenAuxiliary`
- **Metal**: `CAMetalLayer` + `CVDisplayLink` for vsync, clear-to-transparent render pass
- **SwiftUI** hosted via `NSHostingView` on top of Metal layer
- **Universal binary**: x86_64 + arm64 via `xcodebuild -arch x86_64 -arch arm64 ONLY_ACTIVE_ARCH=NO`
- **Ad-hoc code signing**: `CODE_SIGN_IDENTITY="-"` (no Apple Developer ID yet)
- **GitHub Actions**: `macos-latest` runners, public repo = unlimited free macOS minutes
- **Solvro backend**: `solvro.in` API for auth, AI queries, STT, usage tracking, remote config
- **Session token**: stored at `~/Library/Application Support/Solvro/solvro-token.txt`

---

## Phases

### Phase 1 — App Scaffold ✅
- `SolvroOverlay/App/main.swift` — entry point, `NSApplication.shared.run()`
- `SolvroOverlay/App/AppDelegate.swift` — sets activation policy to `.accessory` (no dock icon), creates overlay
- `SolvroOverlay.xcodeproj` — Xcode project, deployment target macOS 12.0, ad-hoc signed
- `SolvroOverlay.xcscheme` — shared build scheme
- `Info.plist` — bundle ID `com.solvro.overlay`, `LSUIElement: true`

### Phase 2 — Stealth Window & CGS Private APIs ✅
- `SolvroOverlay/Overlay/CGSBridge.swift` — loads `CGSMainConnectionID`, `CGSSetWindowSharingState`, `CGSSetWindowLevel` via `dlsym`; `sharingNone = 0` hides from capture; window level `2_147_483_630`
- `SolvroOverlay/Overlay/OverlayPanel.swift` — NSPanel subclass: borderless, nonactivating, `.screenSaver` level, `canJoinAllSpaces`, `fullScreenAuxiliary`, `sharingType = .none`, `isOpaque = false`, `backgroundColor = .clear`; `applyStealth()` on every `orderFront`
- `SolvroOverlay/Overlay/OverlayWindowController.swift` — window lifecycle, opacity state machine (`currentOpacity`, `lastVisibleOpacity`, `isHidden`), `toggleVisibility()`, `adjustOpacity(delta:)`, `setOpacity(_:)`, `toggleClickThrough()`, `move(dx:dy:)`

### Phase 3 — Metal Rendering Pipeline ✅
- `SolvroOverlay/Rendering/Renderer.swift` — `MTLDevice`, `MTLCommandQueue`, per-frame clear-to-transparent render pass
- `SolvroOverlay/Rendering/MetalView.swift` — `NSView` with `CAMetalLayer`, `CVDisplayLink` vsync callback, Retina `contentsScale` handling, `updateDrawableSize()` on resize
- `OverlayWindowController` updated to use `MetalView` as content view with VM fallback
- `project.pbxproj` — `Metal.framework`, `QuartzCore.framework` linked, Frameworks build phase

### Phase 4 — SwiftUI UI Layer ✅
- `SolvroOverlay/UI/OverlayContentView.swift` — chat-style UI: dark header ("Solvro" + status), scrollable message area with user/assistant bubbles, text input bar with send button, auto-scroll
- `SolvroOverlay/UI/OverlayViewModel.swift` — `ObservableObject`: `@Published messages`, `inputText`, `isLoading`, `statusText`; `sendMessage()` placeholder; `clearMessages()`
- `OverlayWindowController` updated: container `NSView` holds `MetalView` (bottom) + `NSHostingView<OverlayContentView>` (top)

### Phase 5 — Global Hotkey Manager
- `SolvroOverlay/Input/HotkeyManager.swift` — register global hotkeys via `NSEvent.addGlobalMonitorForEvents` and `addLocalMonitorForEvents`
- Hotkey map (matching Windows overlay):
  - `⌘Space` — toggle visibility
  - `⌘↑` / `⌘↓` — adjust opacity ±10%
  - `⌘⇧C` — toggle click-through
  - `⌘⇧←→↑↓` — move window by 50px
  - `⌘⇧Q` — quit overlay
- Wire hotkeys to `OverlayWindowController` methods

### Phase 6 — IPC / stdin Protocol
- `SolvroOverlay/IPC/StdinReader.swift` — read JSON commands from stdin (Electron spawns overlay as child process)
- `SolvroOverlay/IPC/IPCProtocol.swift` — define command types: `show`, `hide`, `setOpacity`, `sendQuery`, `quit`, `setToken`
- `SolvroOverlay/IPC/StdoutWriter.swift` — write JSON responses to stdout (status, errors, AI responses)
- Wire IPC commands to `OverlayWindowController` and `OverlayViewModel`

### Phase 7 — Session Token & Auth
- `SolvroOverlay/Network/TokenStore.swift` — read session token from `~/Library/Application Support/Solvro/solvro-token.txt` or receive via IPC
- `SolvroOverlay/Network/AuthService.swift` — validate token with `solvro.in/api/auth/validate`, refresh if expired
- Token refresh every 24h (matches Electron's `readSessionToken`/`writeSessionToken` flow)

### Phase 8 — AI Service Integration
- `SolvroOverlay/Network/AIService.swift` — POST to `solvro.in/api/ai/query` with session token
- Wire `OverlayViewModel.sendMessage()` to real API calls
- Streaming response support (SSE / chunked transfer)
- Remote model config from `solvro.in/api/config`
- Error handling: auth failures, rate limits, network errors

### Phase 9 — Speech-to-Text
- `SolvroOverlay/Audio/AudioCaptureService.swift` — `AVAudioEngine` microphone capture
- `SolvroOverlay/Audio/STTService.swift` — send audio buffers to `solvro.in/api/stt` or local Moonshine
- `SolvroOverlay/UI/AudioIndicatorView.swift` — recording indicator in the UI
- Hotkey: `⌘⇧M` — toggle microphone / start STT session

### Phase 10 — Screenshot Capture
- `SolvroOverlay/Capture/ScreenshotService.swift` — `CGWindowListCreateImage` excluding overlay's own window
- Capture visible screen, encode as JPEG, send to AI service for vision queries
- Hotkey: `⌘⇧S` — take screenshot and send to AI
- Max 1920px edge (matches Electron's `screenshot.js`)

### Phase 11 — Remote Config
- `SolvroOverlay/Network/RemoteConfigService.swift` — fetch `solvro.in/api/config` on launch and periodically
- Feature flags, model catalog, endpoint URLs, rate limit parameters
- Cache config locally at `~/Library/Application Support/Solvro/config.json`

### Phase 12 — Multi-Monitor & Resize
- Screen change observer (`NSApplication.didChangeScreenParametersNotification`)
- Move overlay to primary screen on display reconfiguration
- User resize via drag edges (optional, panel defaults to left-docked full height)
- `⌘⇧R` — reset position/size to default

### Phase 13 — Auto-Update
- `SolvroOverlay/Update/UpdateChecker.swift` — check GitHub releases API for newer `solvro-overlay-mac` artifact
- Download and replace binary, prompt user or auto-restart
- Version comparison using `MARKETING_VERSION` from Info.plist

### Phase 14 — Drag Handle & Window Chrome
- Custom drag region at top of overlay (since panel is borderless)
- Subtle grab handle indicator
- Optional resize handle at right edge

### Phase 15 — Animations & Transitions
- Fade in/out on visibility toggle (animate `alphaValue`)
- Smooth opacity transitions on `adjustOpacity`
- Message bubble entry animations in SwiftUI

### Phase 16 — Error Handling & Logging
- Structured logging with OSLog subsystem `com.solvro.overlay`
- Crash-safe: catch uncaught exceptions, write crash log
- Network error recovery with exponential backoff
- User-facing error messages in the chat area

### Phase 17 — Settings Persistence
- `SolvroOverlay/Settings/SettingsStore.swift` — UserDefaults or JSON file at `~/Library/Application Support/Solvro/overlay-settings.json`
- Persist: last opacity, window position, click-through state, hotkey customization
- Restore on launch

### Phase 18 — Markdown Rendering
- Rich text rendering for AI responses (code blocks, bold, italic, lists)
- Syntax highlighting for code blocks
- Copy code block button

### Phase 19 — Electron Integration (main.js)
- Modify `main.js` `launch-overlay-mode` IPC handler (line 3442):
  - Remove `if (process.platform !== 'win32') return ...` guard
  - Add macOS branch: spawn `overlay-mac-bin/solvro-overlay.app/Contents/MacOS/solvro-overlay`
  - Pass session token via stdin IPC
  - Monitor child process health
- Platform-specific overlay binary path resolution

### Phase 20 — electron-builder extraResources
- `package.json` already has `overlay-mac-bin` in `extraResources` for mac
- Verify `solvro-overlay.app` bundle is included in DMG/zip
- Test that resource path resolves correctly at runtime

### Phase 21 — CI: Universal Binary Artifact
- `.github/workflows/build-overlay-mac.yml` (already working) — builds universal binary, uploads artifact
- Verify artifact contains both x86_64 + arm64 slices
- Artifact name: `solvro-overlay-mac`

### Phase 22 — Release Workflow Integration
- `myapp8/.github/workflows/release.yml` has `mac-overlay` job
- Downloads `solvro-overlay-mac` artifact into `app_src/overlay-mac-bin/`
- Electron build picks it up as extraResource
- Full release: Windows + Mac Electron apps with embedded native overlays

### Phase 23 — End-to-End Testing
- Test overlay launch from Electron on macOS
- Test IPC command/response cycle
- Test stealth: verify overlay is not visible in screen recordings
- Test hotkeys in various app contexts (fullscreen, Spaces, kiosk apps)

### Phase 24 — Performance Optimization
- Metal render pass: skip frames when no UI changes (reduce GPU usage)
- CVDisplayLink: drop to lower refresh rate when idle
- Memory profiling: ensure no leaks in long-running sessions
- Launch time optimization

### Phase 25 — Polish & Final QA
- Visual polish: match Windows overlay appearance closely
- Edge cases: lid close/open, sleep/wake, multiple users
- Accessibility: VoiceOver hints (without exposing overlay to screen readers used by proctoring)
- Final review of stealth properties across macOS versions (12-15)
- Documentation for building and testing

---

## File Structure

```
overlay-mac/
├── SolvroOverlay.xcodeproj/
│   ├── project.pbxproj
│   └── xcshareddata/xcschemes/SolvroOverlay.xcscheme
└── SolvroOverlay/
    ├── Info.plist
    ├── App/
    │   ├── main.swift
    │   └── AppDelegate.swift
    ├── Overlay/
    │   ├── CGSBridge.swift
    │   ├── OverlayPanel.swift
    │   └── OverlayWindowController.swift
    ├── Rendering/
    │   ├── Renderer.swift
    │   └── MetalView.swift
    ├── UI/
    │   ├── OverlayContentView.swift
    │   └── OverlayViewModel.swift
    ├── Input/          (Phase 5)
    │   └── HotkeyManager.swift
    ├── IPC/            (Phase 6)
    │   ├── StdinReader.swift
    │   ├── IPCProtocol.swift
    │   └── StdoutWriter.swift
    ├── Network/        (Phase 7-8, 11)
    │   ├── TokenStore.swift
    │   ├── AuthService.swift
    │   ├── AIService.swift
    │   └── RemoteConfigService.swift
    ├── Audio/          (Phase 9)
    │   ├── AudioCaptureService.swift
    │   └── STTService.swift
    ├── Capture/        (Phase 10)
    │   └── ScreenshotService.swift
    ├── Settings/       (Phase 17)
    │   └── SettingsStore.swift
    ├── Update/         (Phase 13)
    │   └── UpdateChecker.swift
    └── Resources/
```

## CI Workflows

- `.github/workflows/ci.yml` — builds overlay on every push (root-level, triggers on this repo)
- `.github/workflows/build-overlay-mac.yml` — standalone build + artifact upload
- `myapp8/.github/workflows/release.yml` — full release with `mac-overlay` job

## Key Integration Points

- **Electron → Overlay**: `main.js` spawns overlay binary, communicates via stdin/stdout JSON
- **Session token**: Electron writes to `~/Library/Application Support/Solvro/solvro-token.txt`, overlay reads it
- **Backend API**: `solvro.in/api/ai/query`, `solvro.in/api/auth/validate`, `solvro.in/api/config`, `solvro.in/api/stt`
- **extraResources**: `overlay-mac-bin/solvro-overlay.app` bundled in Electron DMG
