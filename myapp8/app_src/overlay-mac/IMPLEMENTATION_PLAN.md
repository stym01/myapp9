# Solvro macOS Native Overlay — Implementation Plan

## Architecture

```
Electron App (app_src/) — already cross-platform
    │
    ├── Windows: launches hope.exe (C++/DX11/ImGui)
    │
    └── macOS: launches solvro-overlay (Swift/Metal/AppKit) ← THIS
```

The Electron app handles: auth, AI chat, settings, interview mode, auto-update.
The native overlay handles: stealth window, screen-capture hiding, kiosk bypass, hotkeys, AI queries, autotype.

## Key Integration Points

- **Electron → Overlay**: `main.js` spawns overlay binary, communicates via stdin/stdout JSON
- **Session token**: `~/Library/Application Support/Solvro/solvro-token.txt`
- **Backend API**: `solvro.in` — `/api/ai/query`, `/api/auth/desktop-refresh`, `/api/config`, `/api/ai/transcribe`
- **extraResources**: `overlay-mac-bin/solvro-overlay.app` bundled in Electron DMG
- **main.js line 3442**: currently blocks Mac with "Overlay mode is only available on Windows"

---

## Implementation Status

- Phase 1: ✅ DONE
- Phase 2: ✅ DONE
- Phase 3: ✅ DONE
- Phase 4: ✅ DONE (simplified — basic chat UI, not full TitleBar/ChatView/ComposerView yet)
- Phase 5: ⏳ NOT DONE (Markdown & Code Highlighting — skipped, implemented hotkeys instead)
- Phase 6: ⏳ IN PROGRESS
- Phase 9: ✅ DONE (Global Hotkeys — implemented early as "Phase 5")

**Note**: Phases 1-4 and 9 are done. Phase 5 (Markdown) was skipped — we implemented hotkeys (Phase 9) early. Continuing from Phase 6 onward.

---

## Phase 1: Xcode Project Scaffold & GitHub Actions CI ✅

**Goal**: Empty Swift app that compiles as a universal binary on GitHub Actions.

- `SolvroOverlay/App/main.swift` — entry point, `NSApplication.shared.run()`
- `SolvroOverlay/App/AppDelegate.swift` — `LSUIElement=true`, no Dock icon
- `SolvroOverlay.xcodeproj` — deployment target macOS 12.0, universal binary (x86_64 + arm64)
- `SolvroOverlay.xcscheme` — shared build scheme
- `Info.plist` — bundle ID `com.solvro.overlay`, `LSUIElement: true`, `NSScreenCaptureUsageDescription`
- GitHub Actions: `build-overlay-mac.yml` + `ci.yml` at repo root

**Deliverable**: `solvro-overlay.app` universal binary that launches and immediately quits

## Phase 2: Stealth Overlay Window (NSPanel + CGS Private APIs) ✅

**Goal**: A floating, borderless panel hidden from screen capture.

- `SolvroOverlay/Overlay/OverlayPanel.swift` — custom NSPanel subclass:
  - styleMask: `[.borderless, .nonactivatingPanel]`
  - level: `.screenSaver` (floats above fullscreen apps)
  - collectionBehavior: `[.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]`
  - `isOpaque: false`, `backgroundColor: .clear`, `sharingType = .none`
  - `applyStealth()` called on every `orderFront`/`makeKeyAndOrderFront`
- `SolvroOverlay/Overlay/CGSBridge.swift` — CGS private API via `dlsym`:
  - `CGSSetWindowSharingState(connection, windowNumber, kCGSWindowSharingNone)` — hides from capture
  - `CGSSetWindowLevel(connection, windowNumber, 2_147_483_630)` — above kiosk windows
  - `CGSMainConnectionID()` — connection handle
- `SolvroOverlay/Overlay/OverlayWindowController.swift` — lifecycle, positioning, opacity state machine

**Deliverable**: Transparent panel floating above all windows, invisible to screenshots/screen recording

## Phase 3: Metal Rendering Pipeline ✅

**Goal**: Hardware-accelerated rendering surface inside the overlay panel.

- `SolvroOverlay/Rendering/Renderer.swift` — Metal device, command queue, clear-to-transparent render pass
- `SolvroOverlay/Rendering/MetalView.swift` — NSView backed by CAMetalLayer, CVDisplayLink vsync, Retina scaling
- `OverlayWindowController` updated to use MetalView with VM fallback

**Deliverable**: Overlay panel with a Metal surface that clears to transparent each frame

## Phase 4: SwiftUI View Hierarchy & App Chrome ✅ (simplified)

**Goal**: Main UI layout matching the Windows version.

**Done so far**:
- `SolvroOverlay/UI/OverlayContentView.swift` — basic chat-style UI (header, message area, input bar)
- `SolvroOverlay/UI/OverlayViewModel.swift` — ObservableObject with messages, input, loading state
- `OverlayWindowController` hosts SwiftUI via NSHostingView on top of MetalView

**Still needed for full Phase 4**:
- `Views/TitleBar.swift` — draggable title bar with model selector, language selector, mode toggle, settings gear, minimize/close
- `Views/ChatView.swift` — scrollable message transcript with markdown, code blocks, copy button
- `Views/ComposerView.swift` — multi-line text field, send button, screenshot attach, voice input button
- Dark theme matching Windows: `#1a1a2e` background, `#16213e` panels, accent colors

## Phase 5: Markdown & Code Highlighting ⏳

**Goal**: Rich rendering of AI responses with syntax highlighting.

- `Views/MarkdownRenderer.swift` — parse markdown to attributed strings: headers, bold, italic, lists, links, inline code
- `Views/CodeBlockView.swift` — fenced code blocks:
  - Load `highlight.min.js` via JavaScriptCore
  - Language detection from fence info string
  - Copy-to-clipboard button, line numbers
- Bundle `Resources/highlight.min.js`

**Deliverable**: AI responses render with formatted markdown and syntax-highlighted code

## Phase 6: Supabase Auth & Session Management ⏳

**Goal**: Login flow reading the Electron app's session token.

- `Auth/SessionManager.swift` — read session token from:
  - `~/Library/Application Support/Solvro/solvro-token.txt` (Electron's userData)
  - Fall back to `$TMPDIR/solvro-token.txt`
- `Auth/AuthService.swift`:
  - `GET /api/user/me` with session cookie → user profile
  - `POST /api/auth/desktop-refresh` → token renewal
  - `GET /api/user/settings` → remote settings (models, quotas)
  - `GET /api/user/usage` → usage data
- `Views/LoginView.swift` — shown when no valid token:
  - "Open Solvro to log in" button (launches Electron app)
  - Or standalone email/password form calling `/api/auth/desktop-login`
- Session keep-alive timer (24h refresh)

**Deliverable**: Overlay reads Electron's auth token, displays user profile, handles token refresh

## Phase 7: AI Provider HTTP Client (Streaming)

**Goal**: Send queries to the Solvro backend and stream responses.

- `AI/AIClient.swift`:
  - `POST /api/ai/query` — main AI endpoint
  - SSE streaming via URLSession with httpBodyStream
  - Request body: `{ model, language, messages[], screenshot?, timezone }`
  - Headers: session cookie, `X-Client-Version`, `X-Client-Platform: macos`
- `AI/ConversationManager.swift`:
  - Message history (capped at 12 pairs, matching Windows)
  - System prompt injection, context management
- `AI/ModelCatalog.swift`:
  - Fetch model list from `/api/config`
  - Fallback hardcoded models, per-mode model pinning

**Deliverable**: User can type a question, get a streaming AI response

## Phase 8: Screenshot Capture (ScreenCaptureKit)

**Goal**: Capture the screen beneath the overlay for AI context.

- `Capture/ScreenCapture.swift`:
  - `SCShareableContent` to enumerate displays
  - `SCContentFilter` excluding the overlay window
  - `SCStreamConfiguration` with max 1920px edge
  - Single-frame capture → CGImage → PNG → base64
- `NSScreenCaptureUsageDescription` in Info.plist
- Permission request UI when first triggered

**Deliverable**: Screenshot hotkey captures screen (excluding overlay) and attaches to AI query

## Phase 9: Global Hotkeys (Carbon Events) ✅

**Goal**: System-wide keyboard shortcuts matching Windows behavior.

- `Input/HotkeyManager.swift` — NSEvent global + local monitors:
  - `⌘Space` — toggle overlay visibility
  - `⌘↑/↓` — adjust opacity ±10%
  - `⌘⇧C` — toggle click-through
  - `⌘⇧Arrow keys` — move window 50px
  - `⌘⇧Q` — quit overlay
- Wired into `AppDelegate` on launch

**Still needed**:
- Carbon `RegisterEventHotKey` API for true global hotkeys
- `Input/KeyCaptureMonitor.swift` — CGEvent tap for global key capture mode
- Read/write hotkey config to `~/Library/Application Support/Solvro/hotkeys.json`
- Additional bindings: `⌘⏎` send query, `⌘⇧T` start auto-type, `⌘⇧S` screenshot

## Phase 10: Remote Config & Model Sync

**Goal**: Dynamic configuration from the Solvro backend.

- `Config/RemoteConfig.swift`:
  - `GET /api/config` → model catalog, feature flags, force-update threshold
  - Local cache with TTL
  - `onChange` callback pattern
- `Config/AppConfig.swift`:
  - Local settings persistence (UserDefaults or JSON)
  - Theme, default mode, language, opacity, window position

## Phase 11: Settings Panel

**Goal**: In-overlay settings UI matching Windows.

- `Views/SettingsView.swift`:
  - Account info (email, plan, usage)
  - Model selection, language selection (14 languages)
  - Theme toggle, opacity slider
  - Keyboard shortcuts editor
  - Auto-type settings (CPS, jitter, delays)
  - About/version info, logout button
- `Views/ShortcutsEditor.swift`:
  - Capture mode for recording new key combinations
  - Conflict detection, reset to defaults

## Phase 12: Auto-Type (CGEvent Keyboard Simulation)

**Goal**: Type AI-generated code into other apps with human-like timing.

- `AutoType/AutoTyper.swift`:
  - CGEvent posting for keystroke simulation
  - Configurable CPS (default 14), 45% jitter variance
  - Think pauses between lines (45ms), line pauses (120ms)
  - Start delay (1000ms countdown)
- `AutoType/TypoSimulator.swift`:
  - Random typo injection + backspace correction
  - Smart indent handling, tab/space detection
  - Pause/resume via hotkey (F8/Escape to stop, `⌘⇧Y` to resume)
  - Progress indicator in overlay UI

## Phase 13: Voice Input & Audio Capture

**Goal**: Microphone input for voice queries and interview transcription.

- `Audio/AudioCapture.swift`:
  - AVCaptureSession for microphone input
  - WAV encoding for transcription endpoint
  - `POST /api/ai/transcribe` (Gemini Flash)
- `Audio/SystemAudioCapture.swift`:
  - System audio loopback via AVAudioEngine tap
  - For interview mode: capture interviewer's audio
- Permission handling for `NSMicrophoneUsageDescription`

## Phase 14: Interview Mode

**Goal**: Real-time interview assistance with dual-audio transcription.

- `Interview/InterviewManager.swift`:
  - Deepgram WebSocket via `GET /api/keys/deepgram?profile=dual`
  - Dual-socket mode: separate mic + system audio streams
  - Real-time transcript display
- `Views/InterviewView.swift`:
  - Split view: transcript left, AI suggestions right
  - Speaker identification (You vs Interviewer)
  - "Assist" / "Force Answer" / "New Question" / "New Conversation" buttons
  - Recording controls
- `Interview/SttSession.swift`:
  - WebSocket management with reconnection

## Phase 15: Kiosk Bypass — ProctorInjector & GenericKioskBlocker

**Goal**: Bypass proctoring software lockdown on macOS.

- `Stealth/ProctorInjector.swift`:
  - Monitor for proctoring app launch via `NSWorkspace.shared.runningApplications`
  - `task_for_pid` + `mach_vm_*` for dylib injection
  - Swizzle `-[NSApplication setPresentationOptions:]` → no-op
  - Swizzle `-[NSWindow setLevel:]` → clamped
- `Stealth/GenericKioskBlocker.m` (Objective-C):
  - `method_exchangeImplementations` runtime swizzling
  - Block `NSRunningApplication.terminate` / kill
  - Block `NSTask` launching security processes
- `Stealth/helper.dylib` target — separate Mach-O

## Phase 16: Anti-Detection & Process Hiding

**Goal**: Make the overlay undetectable to monitoring software.

- `Stealth/ProcessHider.swift`:
  - Executable named `uiserviced` (looks like system daemon)
  - `setpriority`/`sched_setscheduler` to lower visibility
  - Clear `argv[0]` to disguise in `ps` output
- `Stealth/WindowHider.swift`:
  - CGSSetWindowSharingState (Phase 2), randomized window server ID
  - Hide from Accessibility API: `AXUIElementSetAttributeValue`
- `Stealth/NetworkObfuscation.swift`:
  - Route through Solvro backend (no direct OpenAI calls)
  - User-Agent mimicking Safari/system processes

## Phase 17: Opacity & Window Management

**Goal**: Full window control matching Windows behavior.

- `Overlay/WindowManager.swift`:
  - Opacity slider (0.0–1.0) + hotkey ±10%
  - Hide/show toggle, click-through toggle with forward
  - Window movement via hotkeys, resize via edge drag strips
  - Remember position/size across sessions
  - Multi-display support

## Phase 18: Version Check & Auto-Update

**Goal**: Self-updating overlay binary.

- `Update/UpdateManager.swift`:
  - Check `GET /api/config` for `macOverlayVersion` and `forceUpdateBelow`
  - Compare against `CFBundleShortVersionString`
  - Download and replace app bundle
- Optional Sparkle framework integration
- Force-update support: block usage if version too old

## Phase 19: Electron Integration — Mac Overlay Launch

**Goal**: Wire the Electron app to launch the native Mac overlay.

- Update `main.js` `launch-overlay-mode` (line 3442):
  - Remove `if (process.platform !== 'win32')` guard
  - Add macOS path: find `solvro-overlay` in `process.resourcesPath`
  - Launch via `spawn` with `detached: true`
  - Verify process is alive, then quit Electron
- Update `package.json`: macOS `extraResources`
- Update `build-overlay-mac.yml`: produce artifact
- Update `release.yml`: download overlay artifact
- Update `afterPack.js`: sign overlay alongside Electron

## Phase 20: Installer & Distribution

**Goal**: Complete macOS distribution.

- `install.sh` update: download DMG, mount, copy to /Applications, permissions, clear quarantine
- DMG customization: Solvro branding, drag-to-Applications
- Gatekeeper: ad-hoc signing, `xattr -cr`, future Apple Developer ID + notarization

## Phase 21: Chat History & Local Storage

**Goal**: Persistent conversation history across sessions.

- `Storage/ChatStorage.swift`:
  - SQLite at `~/Library/Application Support/Solvro/chat.db`
  - Tables: conversations, messages, screenshots
  - Export/import
- `Storage/SettingsStorage.swift`:
  - JSON settings file, migration from Electron format

## Phase 22: Theme System & UI Polish

**Goal**: Pixel-perfect UI matching Windows version.

- `Theme/ThemeManager.swift`:
  - Dark theme: `#1a1a2e` background, `#16213e` panels
  - Light theme, system theme following
- Font matching: SF Pro for UI, SF Mono for code
- Animations: message appear, streaming text, opacity transitions, panel slide
- Scrollbar styling

## Phase 23: Edge Cases & Platform Parity

**Goal**: Handle all Mac-specific edge cases.

- `Platform/PermissionManager.swift`:
  - Screen Recording, Accessibility, Microphone, Automation permissions
- `Platform/PowerManager.swift`:
  - Prevent App Nap, sudden termination, handle sleep/wake
- Mission Control / Spaces behavior
- Retina display handling

## Phase 24: Comprehensive Testing

**Goal**: Verify feature parity with Windows.

- Unit tests: auth, AI client, hotkey conflicts, auto-type timing, markdown
- Integration tests: backend API, WebSocket STT, screenshot quality
- Manual test matrix:
  - macOS 12-15, Intel + Apple Silicon
  - Proctoring software: Safe Exam Browser, Respondus LockDown, Proctorio, ProctorU, Honorlock
  - Multi-display, Retina/non-Retina

## Phase 25: Release Pipeline & Launch

**Goal**: End-to-end release automation.

- Final `release.yml`: tag → test → build overlay → build Electron → publish
- Remove "Mac version coming soon" messaging
- Backend: `GET /api/config` returns `macOverlayVersion`
- Documentation: installation guide, troubleshooting

---

## File Structure (Final)

```
overlay-mac/
├── SolvroOverlay.xcodeproj/
├── IMPLEMENTATION_PLAN.md
└── SolvroOverlay/
    ├── Info.plist
    ├── App/
    │   ├── main.swift
    │   └── AppDelegate.swift
    ├── Overlay/
    │   ├── CGSBridge.swift
    │   ├── OverlayPanel.swift
    │   ├── OverlayWindowController.swift
    │   └── WindowManager.swift          (Phase 17)
    ├── Rendering/
    │   ├── Renderer.swift
    │   └── MetalView.swift
    ├── UI/
    │   ├── OverlayContentView.swift
    │   └── OverlayViewModel.swift
    ├── Views/                           (Phase 4 full, 5, 11)
    │   ├── TitleBar.swift
    │   ├── ChatView.swift
    │   ├── ComposerView.swift
    │   ├── MarkdownRenderer.swift
    │   ├── CodeBlockView.swift
    │   ├── LoginView.swift
    │   ├── SettingsView.swift
    │   ├── ShortcutsEditor.swift
    │   └── InterviewView.swift
    ├── Input/
    │   ├── HotkeyManager.swift
    │   └── KeyCaptureMonitor.swift      (Phase 9 full)
    ├── Auth/                            (Phase 6)
    │   ├── SessionManager.swift
    │   └── AuthService.swift
    ├── AI/                              (Phase 7)
    │   ├── AIClient.swift
    │   ├── ConversationManager.swift
    │   └── ModelCatalog.swift
    ├── Capture/                         (Phase 8)
    │   └── ScreenCapture.swift
    ├── Config/                          (Phase 10)
    │   ├── RemoteConfig.swift
    │   └── AppConfig.swift
    ├── AutoType/                        (Phase 12)
    │   ├── AutoTyper.swift
    │   └── TypoSimulator.swift
    ├── Audio/                           (Phase 13)
    │   ├── AudioCapture.swift
    │   └── SystemAudioCapture.swift
    ├── Interview/                       (Phase 14)
    │   ├── InterviewManager.swift
    │   └── SttSession.swift
    ├── Stealth/                         (Phase 15-16)
    │   ├── ProctorInjector.swift
    │   ├── GenericKioskBlocker.m
    │   ├── ProcessHider.swift
    │   ├── WindowHider.swift
    │   └── NetworkObfuscation.swift
    ├── Update/                          (Phase 18)
    │   └── UpdateManager.swift
    ├── Storage/                         (Phase 21)
    │   ├── ChatStorage.swift
    │   └── SettingsStorage.swift
    ├── Theme/                           (Phase 22)
    │   └── ThemeManager.swift
    ├── Platform/                        (Phase 23)
    │   ├── PermissionManager.swift
    │   └── PowerManager.swift
    └── Resources/
        └── highlight.min.js             (Phase 5)
```
