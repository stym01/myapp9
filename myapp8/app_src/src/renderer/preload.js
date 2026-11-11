const { contextBridge, ipcRenderer } = require('electron');

// In-window tooltips + fixed cursor so hover feedback isn't visible in captures.
require('./stealthUi').installStealthUi({
  edges: ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
});

// Lazy-load markdown and highlight libraries to reduce startup cost
let _marked = null;
let _hljs = null;

function getHljs() {
  if (!_hljs) {
    _hljs = require('highlight.js');
  }
  return _hljs;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMath(tex, displayMode) {
  try {
    return require('katex').renderToString(tex.trim(), { displayMode, throwOnError: false, output: 'html' });
  } catch (err) {
    console.error('KaTeX error:', err);
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

// $$...$$ on its own line(s)
const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const match = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src);
    if (match) return { type: 'blockMath', raw: match[0], text: match[1] };
  },
  renderer(token) { return `<div class="math-block">${renderMath(token.text, true)}</div>\n`; }
};

// $$...$$ or $...$ inside a line. Inline $ must hug its content and not be followed by a digit,
// so prices like "$5 and $10" stay plain text.
const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    let match = /^\$\$([^$]+?)\$\$/.exec(src);
    if (match) return { type: 'inlineMath', raw: match[0], text: match[1], display: true };
    match = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src);
    if (match) return { type: 'inlineMath', raw: match[0], text: match[1], display: false };
  },
  renderer(token) { return renderMath(token.text, token.display); }
};

function getMarked() {
  if (!_marked) {
    // Keep marked pinned to v15: v16+ is ESM-only and Electron 31's Node can't require() it
    // (the require threw, so every reply silently fell back to renderer.js's regex formatter)
    const mod = require('marked');
    _marked = mod.marked || mod;
    const hljs = getHljs();
    _marked.use({
      breaks: true,
      gfm: true,
      extensions: [blockMath, inlineMath],
      renderer: {
        // marked >= 5 dropped the `highlight` option — highlight through the code renderer instead
        code({ text, lang }) {
          const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
          let highlighted;
          try {
            highlighted = language && hljs.getLanguage(language)
              ? hljs.highlight(text, { language }).value
              : hljs.highlightAuto(text).value;
          } catch (err) {
            console.error('Highlight.js error:', err);
            highlighted = escapeHtml(text);
          }
          return `<pre><code class="hljs language-${escapeHtml(language || 'plaintext')}">${highlighted}</code></pre>\n`;
        }
      }
    });
  }
  return _marked;
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Auth
  checkAuth: () => ipcRenderer.invoke('check-auth'),
  // Main fires this after a reinstall re-adopts a session token into userData,
  // so the renderer can clear the login overlay without a restart.
  onAuthRefresh: (callback) => ipcRenderer.on('auth-refresh', callback),
  // Main (or the interview view) hit an action that needs an account.
  onAuthRequired: (callback) => ipcRenderer.on('auth-required', callback),
  startLogin: (opts) => ipcRenderer.invoke('start-login', opts),
  emailPasswordLogin: (email, password) => ipcRenderer.invoke('email-password-login', { email, password }),
  logout: () => ipcRenderer.invoke('logout'),
  getCachedUserProfile: () => ipcRenderer.invoke('get-cached-profile'),
  getUserProfile: () => ipcRenderer.invoke('get-user-profile'),
  fetchUserSettings: () => ipcRenderer.invoke('fetch-user-settings'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Listen for trigger-resize-to-content from main process
  onTriggerResizeToContent: (callback) => ipcRenderer.on('trigger-resize-to-content', callback),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  launchOverlayMode: () => ipcRenderer.invoke('launch-overlay-mode'),
  toggleStealth: () => ipcRenderer.invoke('toggle-stealth'),
  getCurrentMode: () => ipcRenderer.invoke('get-current-mode'),
  switchMode: () => ipcRenderer.invoke('switch-mode'),
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', deltaX, deltaY),
  resizeWindowToContent: (contentHeight) => ipcRenderer.invoke('resize-window-to-content', contentHeight),
  maximizeHeight: () => ipcRenderer.invoke('maximize-height'),
  // Title-bar double-click maximize (used by the renderer on macOS/Linux).
  toggleMaximize: () => ipcRenderer.invoke('toggle-maximize'),
  platform: process.platform,
  setOverlayMask: (isOpen) => ipcRenderer.invoke('set-overlay-mask', isOpen),

  // Audio Capture
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  getDeepgramKey: () => ipcRenderer.invoke('get-deepgram-key'),
  // Full STT session: credential plus the exact WebSocket URL to open, both
  // decided server-side so the vendor/model/params can change without a release.
  getSttSession: (profile) => ipcRenderer.invoke('get-stt-session', profile),
  onToggleAudioCapture: (callback) => ipcRenderer.on('toggle-audio-capture', callback),
  onToggleMicMute: (callback) => ipcRenderer.on('toggle-mic-mute', callback),
  onForceAnswerTrigger: (callback) => ipcRenderer.on('force-answer-trigger', callback),

  // New queue functionality
  sendQueue: (additionalText) => ipcRenderer.invoke('send-queue', additionalText),
  // Query-mode dictation: { data: base64, mimeType } → { success, text, error }.
  // Free — the server doesn't count it against the response quota.
  transcribeAudio: (audio) => ipcRenderer.invoke('transcribe-audio', audio),
  onToggleVoiceInput: (callback) => ipcRenderer.on('toggle-voice-input', callback),
  resetConversation: () => ipcRenderer.invoke('reset-conversation'),
  getQueue: () => ipcRenderer.invoke('get-queue'),
  removeFromQueue: (id) => ipcRenderer.invoke('remove-from-queue', id),
  getConversationHistory: () => ipcRenderer.invoke('get-conversation-history'),
  setInterviewContext: (context) => ipcRenderer.invoke('set-interview-context', context),
  onStreamChunk: (callback) => ipcRenderer.on('ai-stream-chunk', callback),
  onStreamEnd: (callback) => ipcRenderer.on('ai-stream-end', callback),

  // Listen for screenshot events
  onScreenshotProcessing: (callback) => ipcRenderer.on('screenshot-processing', callback),
  onScreenshotAnalysis: (callback) => ipcRenderer.on('screenshot-analysis', callback),
  onScreenshotError: (callback) => ipcRenderer.on('screenshot-error', callback),
  onScreenshotTextExtraction: (callback) => ipcRenderer.on('screenshot-text-extraction', callback),

  // Listen for global key capture events
  onGlobalKeyCaptured: (callback) => ipcRenderer.on('global-key-captured', callback),

  // Listen for queue events
  onScreenshotCapturing: (callback) => ipcRenderer.on('screenshot-capturing', callback),
  onScreenshotQueued: (callback) => ipcRenderer.on('screenshot-queued', callback),
  onScreenshotLimitReached: (callback) => ipcRenderer.on('screenshot-limit-reached', callback),
  onQueueProcessing: (callback) => ipcRenderer.on('queue-processing', callback),
  onQueueAnalysis: (callback) => ipcRenderer.on('queue-analysis', callback),
  onQueueError: (callback) => ipcRenderer.on('queue-error', callback),
  onConversationReset: (callback) => ipcRenderer.on('conversation-reset', callback),
  onScreenshotQueueCleared: (callback) => ipcRenderer.on('screenshot-queue-cleared', callback),
  onSessionSaved: (callback) => ipcRenderer.on('session-saved', callback),

  // Listen for extraction events
  onExtractionStarted: (callback) => ipcRenderer.on('extraction-started', callback),
  onExtractionProgress: (callback) => ipcRenderer.on('extraction-progress', callback),
  onExtractionCompleted: (callback) => ipcRenderer.on('extraction-completed', callback),

  // Listen for mode change events
  onModeChanged: (callback) => ipcRenderer.on('mode-changed', callback),

  // Language functionality
  getCurrentLanguage: () => ipcRenderer.invoke('get-current-language'),
  cycleLanguage: () => ipcRenderer.invoke('cycle-language'),
  onLanguageChanged: (callback) => ipcRenderer.on('language-changed', callback),

  // Model functionality
  getCurrentModel: () => ipcRenderer.invoke('get-current-model'),
  cycleModel: () => ipcRenderer.invoke('cycle-model'),
  onModelChanged: (callback) => ipcRenderer.on('model-changed', callback),

  // Dropdown selectors — full option lists plus direct selection
  getSelectorOptions: () => ipcRenderer.invoke('get-selector-options'),
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
  setLanguage: (language) => ipcRenderer.invoke('set-language', language),
  setModel: (model) => ipcRenderer.invoke('set-model', model),

  // Listen for keyboard shortcuts from main process
  onSendQueueShortcut: (callback) => ipcRenderer.on('send-queue-shortcut', callback),

  // Code handling for auto-typing feature
  getGeneratedCode: () => ipcRenderer.invoke('get-generated-code'),
  autoTypeCode: () => ipcRenderer.invoke('auto-type-code'),
  resumeAutoType: () => ipcRenderer.invoke('resume-auto-type'),
  onCodeCopiedForTyping: (callback) => ipcRenderer.on('code-copied-for-typing', callback),

  // User key handling
  submitUserKey: (userKey) => ipcRenderer.invoke('submit-user-key', userKey),
  onShowUserKeyInput: (callback) => ipcRenderer.on('show-user-key-input', callback),
  onUserKeySuccess: (callback) => ipcRenderer.on('user-key-success', callback),
  onUserKeyError: (callback) => ipcRenderer.on('user-key-error', callback),

  // Transparency/Opacity controls
  setOpacity: (opacity) => ipcRenderer.invoke('set-opacity', opacity),
  getCurrentOpacity: () => ipcRenderer.invoke('get-current-opacity'),
  onOpacityChanged: (callback) => ipcRenderer.on('opacity-changed', callback),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // Auto-updater
  installUpdate: () => ipcRenderer.invoke('install-update'),
  dismissUpdate: () => ipcRenderer.invoke('dismiss-update'),
  getPendingUpdate: () => ipcRenderer.invoke('get-pending-update'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  onUpdateError: (callback) => ipcRenderer.on('update-error', callback),

  // Interview BrowserView events
  onInterviewViewShown: (callback) => ipcRenderer.on('interview-view-shown', callback),
  onInterviewViewHidden: (callback) => ipcRenderer.on('interview-view-hidden', callback),
  onInterviewViewError: (callback) => ipcRenderer.on('interview-view-error', callback),
  // Shortcuts
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  saveShortcut: (id, keys) => ipcRenderer.invoke('save-shortcut', { id, keys }),
  startShortcutCapture: () => ipcRenderer.invoke('start-shortcut-capture'),
  stopShortcutCapture: () => ipcRenderer.invoke('stop-shortcut-capture'),
  resetAllShortcuts: () => ipcRenderer.invoke('reset-all-shortcuts'),
  onShortcutsChanged: (callback) => ipcRenderer.on('shortcuts-changed', callback),

  hideInterviewView: () => ipcRenderer.invoke('hide-interview-view'),
  showInterviewView: () => ipcRenderer.invoke('show-interview-view'),

  // Theme — forwarded to the interview BrowserView, which can't see this
  // window's own `body.light-mode` class (separate web contents).
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),

  // The global toggle-theme shortcut, handled in the renderer so it shares the
  // same code path as the header toggle button.
  onToggleTheme: (callback) => ipcRenderer.on('toggle-theme', callback),

  // Pushes the interview BrowserView down to `bottomY` (px) so an open dropdown
  // menu in this page shows above it; 0 restores the view to full size.
  setInterviewMenuClear: (bottomY) => ipcRenderer.send('set-interview-menu-clear', bottomY),

  // Reports the measured bottom of the host top bar (px) so the interview view
  // starts right below it and adjusts if the top bar grows (e.g. pills wrap).
  setInterviewContentTop: (y) => ipcRenderer.send('set-interview-content-top', y)
});

// Expose markdown library through context bridge
contextBridge.exposeInMainWorld('marked', {
  parse: (markdown) => getMarked().parse(markdown)
});

// Expose highlight.js for manual syntax highlighting
contextBridge.exposeInMainWorld('hljs', {
  highlightAll: () => getHljs().highlightAll(),
  highlightElement: (element) => getHljs().highlightElement(element),
  highlight: (code, options) => getHljs().highlight(code, options),
  highlightAuto: (code) => getHljs().highlightAuto(code)
});
