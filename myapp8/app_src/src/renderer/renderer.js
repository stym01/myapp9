// ========================================
// TranscriptManager — Structured turn-based transcript storage
// ========================================
class TranscriptManager {
  constructor() {
    this.turns = []; // Array of { speaker: string, text: string, timestamp: number }
    this.maxTurns = 100;
    this.mergeWindowMs = 8000; // Merge turns from same speaker within 8 seconds
  }

  /** Add a turn, merging with previous if same speaker and recent */
  addTurn(speaker, text) {
    if (!text || !text.trim()) return;
    const now = Date.now();
    const lastTurn = this.turns[this.turns.length - 1];

    if (lastTurn && lastTurn.speaker === speaker && (now - lastTurn.timestamp) < this.mergeWindowMs) {
      lastTurn.text += ' ' + text.trim();
      lastTurn.timestamp = now;
    } else {
      this.turns.push({ speaker, text: text.trim(), timestamp: now });
    }

    if (this.turns.length > this.maxTurns) {
      this.turns = this.turns.slice(-this.maxTurns);
    }
  }

  /** Get recent transcript as formatted string (last N seconds, default 3 min) */
  getRecentTranscript(lastNSeconds = 180) {
    const cutoff = Date.now() - lastNSeconds * 1000;
    return this.turns
      .filter(t => t.timestamp > cutoff)
      .map(t => `[${t.speaker}]: ${t.text}`)
      .join('\n');
  }

  /** Get the full transcript as formatted string */
  getFullTranscript() {
    return this.turns
      .map(t => `[${t.speaker}]: ${t.text}`)
      .join('\n');
  }

  /** Get the last consecutive interviewer text (combines back-to-back interviewer turns) */
  getLastInterviewerText() {
    const lines = [];
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].speaker === 'Interviewer') {
        lines.unshift(this.turns[i].text);
      } else if (lines.length > 0) {
        break;
      }
    }
    if (lines.length > 0) {
      const combined = lines.join(' ').trim();
      return combined.length > 300 ? combined.slice(-300) : combined;
    }
    return null;
  }

  /** Get turn count */
  get length() { return this.turns.length; }

  /** Check if empty */
  isEmpty() { return this.turns.length === 0; }

  /** Reset all turns */
  reset() { this.turns = []; }
}

// ========================================
// Shortcut display helpers
// Single source of truth for how a shortcut is spelled in the UI. Every label,
// tooltip and <kbd> goes through here so they all follow the user's custom keys.
// ========================================

// Mirrors defaultShortcuts in src/utils/shortcutManager.js — only used until the
// real list arrives over IPC (and as a guard if an id ever goes missing).
const DEFAULT_SHORTCUT_KEYS = {
  screenshot: 'CommandOrControl+Shift+S',
  sendQueue: 'CommandOrControl+Return',
  resetConversation: 'CommandOrControl+R',
  toggleWindow: 'CommandOrControl+Space',
  transparencyIncrease: 'CommandOrControl+Shift+]',
  transparencyDecrease: 'CommandOrControl+Shift+[',
  scrollUp: 'CommandOrControl+Up',
  scrollDown: 'CommandOrControl+Down',
  stopAutotyping: 'F8',
  startAutotyping: 'CommandOrControl+Shift+T',
  resumeAutotyping: 'CommandOrControl+Shift+Y',
  moveUp: 'CommandOrControl+Shift+Up',
  moveDown: 'CommandOrControl+Shift+Down',
  moveLeft: 'CommandOrControl+Shift+Left',
  moveRight: 'CommandOrControl+Shift+Right',
  languageSwitch: 'CommandOrControl+Shift+L',
  modelSwitch: 'CommandOrControl+Shift+M',
  modeSwitch: 'CommandOrControl+Shift+Space',
  toggleTheme: 'CommandOrControl+Shift+D',
  quit: 'CommandOrControl+Shift+Q',
  startInterview: 'CommandOrControl+Shift+A',
  newQuestion: 'CommandOrControl+Shift+N'
};

// Query-mode voice input: 16 kHz mono WAV is ~32 KB/s, so a minute stays
// comfortably inside the transcribe route's body limit once base64-encoded.
const VOICE_SAMPLE_RATE = 16000;
const VOICE_MAX_SECONDS = 60;

// Registered by main but not user-configurable (RESERVED_SHORTCUTS in main.js),
// so they are fixed strings the UI can still display the same way.
const RESERVED_SHORTCUT_KEYS = {
  toggleClickThrough: 'CommandOrControl+Shift+C',
  toggleMicrophoneMute: 'CommandOrControl+Shift+V',
  forceAnswer: 'CommandOrControl+Shift+Return'
};

// True on macOS. Shortcuts are stored as cross-platform `CommandOrControl`
// accelerators (Electron binds that to ⌘ on Mac, Ctrl on Windows), so only the
// human-readable display and the in-app shortcut editor need to know the OS:
// a Mac user must see "Cmd" and must be able to record a shortcut with ⌘.
const IS_MAC = (() => {
  try {
    if (window.electronAPI && window.electronAPI.platform) {
      return window.electronAPI.platform === 'darwin';
    }
  } catch (_) { }
  return /mac/i.test((navigator && (navigator.platform || navigator.userAgent)) || '');
})();

// What the primary (CommandOrControl) modifier is called on this OS.
const PRIMARY_MOD_LABEL = IS_MAC ? 'Cmd' : 'Ctrl';

// How each accelerator token is spelled for humans. CommandOrControl follows the
// OS; a literal Control token stays "Ctrl" on every platform (on Mac that's ⌃).
const KEY_DISPLAY_MAP = {
  commandorcontrol: PRIMARY_MOD_LABEL, cmdorctrl: PRIMARY_MOD_LABEL, control: 'Ctrl', ctrl: 'Ctrl',
  command: 'Cmd', cmd: 'Cmd', meta: 'Cmd', super: 'Win',
  alt: 'Alt', option: 'Alt', altgr: 'AltGr', shift: 'Shift',
  return: 'Enter', enter: 'Enter', escape: 'Esc', esc: 'Esc',
  up: '↑', down: '↓', left: '←', right: '→',
  plus: '+', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Del',
  pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End', insert: 'Ins',
  numadd: 'Num+', numsub: 'Num-', nummult: 'Num*', numdiv: 'Num/', numdec: 'Num.'
};

class AppRenderer {
  constructor() {
    this.analysisContainer = document.getElementById('analysis-container');
    this.analysisText = document.getElementById('analysis-text');
    this.statusElement = document.getElementById('status');
    this.modelSelector = document.getElementById('model-selector');
    this.languageSelector = document.getElementById('language-selector');
    this.closeButton = document.getElementById('close-btn');
    this.modeIndicator = document.getElementById('mode-indicator');

    // Dropdown menus for the three control pills
    this.languageMenu = document.getElementById('language-menu');
    this.modeMenu = document.getElementById('mode-menu');
    this.modelMenu = document.getElementById('model-menu');
    this._openSelector = null;   // 'language' | 'mode' | 'model' | null
    this._selectorOptions = null; // last option lists fetched from main
    this.opacitySlider = document.getElementById('opacity-slider');
    this.opacityValue = document.getElementById('opacity-value');

    this.currentMode = null;
    this.currentLanguage = null;
    this.currentModel = null;
    this.screenshotQueue = [];
    this.conversationHistory = [];
    this.additionalTextInput = null;
    this._userProfile = null;

    // Live Audio Interview State
    this.isAudioActive = false;
    this.isMicMuted = false;
    this.transcriptManager = new TranscriptManager();
    this.transcriptBuffer = '';           // Legacy buffer (kept for non-interview modes)
    this.transcriptLines = [];
    this.deepgramSocketInterviewer = null; // System audio → Deepgram (interviewer channel)
    this.deepgramSocketCandidate = null;   // Mic audio → Deepgram (candidate channel)
    this.deepgramSocket = null;            // Legacy reference
    this.audioContext = null;
    this.interviewerProcessor = null;      // ScriptProcessor for system audio
    this.candidateProcessor = null;        // ScriptProcessor for mic audio
    this.micGainNode = null;
    this.pauseTimeout = null;
    this.candidateSpeaking = false;        // Is candidate currently talking?
    this._candidateSilenceTimeout = null;  // Timer to detect candidate stopped speaking
    this.offlineQueue = [];
    this.autoScrollEnabled = true;

    // Query mode chat state
    this.chatMessages = [];      // { role: 'user'|'assistant', text, images, time, error }
    this._chatBusy = false;
    this._chatStreamEl = null;   // Bubble currently receiving streamed chunks

    // Live Coach HUD state
    this._coachSessionActive = false;
    this._coachHasShownReady = false;
    this._recordingStartTime = null;
    this._recordingTimerInterval = null;
    this._audioWaveRAF = null;

    this._setupToastContainer();
    this.init();
  }

  _setupToastContainer() {
    if (!document.getElementById('toast-container')) {
      const container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
  }

  // Flips dark/light, persists it, syncs the header switch, and forwards the new
  // theme to the interview BrowserView. Shared by the header button and the
  // toggleTheme shortcut.
  _toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    window.localStorage.setItem('solvro_theme', isLight ? 'light' : 'dark');
    const themeInput = document.getElementById('theme-toggle-input');
    if (themeInput) themeInput.checked = isLight;
    if (window.electronAPI?.setTheme) window.electronAPI.setTheme(isLight ? 'light' : 'dark');
  }

  async init() {
    this.currentShortcuts = await window.electronAPI.getShortcuts();
    this._applyShortcutHints();

    // Initialize theme from localStorage (default: dark mode)
    const savedTheme = window.localStorage.getItem('solvro_theme') || 'dark';
    window.localStorage.setItem('solvro_theme', savedTheme); // Persist default if not set
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
    }
    const themeInput = document.getElementById('theme-toggle-input');
    if (themeInput) {
      themeInput.checked = (savedTheme === 'light');
    }
    // The interview BrowserView can't see this window's own theme class, so
    // main caches it and forwards it there (now, and whenever it's toggled).
    if (window.electronAPI?.setTheme) window.electronAPI.setTheme(savedTheme);
    this.setupCrashGuards();
    this.setupEventListeners();
    this.setupIPCListeners();
    this.setupNetworkListeners();
    this.setupRecordingPill();
    this._renderLoginCard();
    await this.checkAuthentication();
    await this.loadCurrentMode();
    await this.loadCurrentLanguage();
    await this.loadCurrentModel();
    await this.refreshSelectorOptions();
    await this.initializeTransparencyControls();
    this.initShortcutsModal();
    this.initUsageModal();
    this.showWelcomeMessage();
  }

  /** Splits an accelerator into display-ready tokens, e.g. 'CommandOrControl+Up' -> ['Ctrl', '↑'] */
  _formatKeyParts(keys) {
    if (!keys) return [];
    return String(keys).split('+').map(part => {
      const token = part.trim();
      if (!token) return '+'; // the literal '+' key, written as 'CommandOrControl++'
      const mapped = KEY_DISPLAY_MAP[token.toLowerCase()];
      if (mapped) return mapped;
      if (/^num[0-9]$/i.test(token)) return 'Num ' + token.slice(3);
      if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
      return token.length === 1 ? token.toUpperCase() : token;
    });
  }

  /** Human-readable form of an accelerator string, e.g. 'Ctrl+Enter' */
  _formatKey(keys) {
    return this._formatKeyParts(keys).join('+');
  }

  /** Raw accelerator currently bound to a shortcut id (custom if set, else the default) */
  _shortcutKeys(id) {
    const entry = this.currentShortcuts && this.currentShortcuts[id];
    const keys = (typeof entry === 'string' ? entry : entry && entry.keys) || '';
    return keys || DEFAULT_SHORTCUT_KEYS[id] || RESERVED_SHORTCUT_KEYS[id] || '';
  }

  /** Display string for a shortcut id — the one call every label/tooltip should use */
  _sc(id) {
    return this._formatKey(this._shortcutKeys(id));
  }

  /**
   * Collapses a set of related shortcuts into one label. Arrow-key groups that still
   * share a modifier prefix render as 'Ctrl+Shift+Arrows'; anything the user has pulled
   * apart falls back to listing each binding.
   */
  _scGroup(ids, joiner = ' / ') {
    const keys = ids.map(id => this._shortcutKeys(id)).filter(Boolean);
    if (keys.length !== ids.length) return keys.map(k => this._formatKey(k)).join(joiner);

    const split = keys.map(k => k.split('+'));
    const prefix = split[0].slice(0, -1).join('+');
    const lastKeys = split.map(p => p[p.length - 1].toLowerCase());
    const ARROWS = ['up', 'down', 'left', 'right'];
    const samePrefix = split.every(p => p.slice(0, -1).join('+') === prefix);
    const allArrows = lastKeys.length === 4 && ARROWS.every(a => lastKeys.includes(a));
    if (samePrefix && allArrows) {
      return prefix ? `${this._formatKey(prefix)}+Arrows` : 'Arrows';
    }
    return keys.map(k => this._formatKey(k)).join(joiner);
  }

  /** Expands {shortcutId} tokens in a template string, e.g. 'Analyze ({sendQueue})' */
  _fillShortcutTemplate(template) {
    return String(template).replace(/\{([a-zA-Z]+)(?:\|([a-zA-Z,]+))?\}/g, (_m, id, group) => {
      if (group) return this._scGroup([id, ...group.split(',')].filter(Boolean));
      return this._sc(id);
    });
  }

  /**
   * Re-applies every declarative shortcut hint in the DOM. Elements opt in with
   * data-sc-title (tooltip) or data-sc-text (visible text); both hold a template
   * such as 'Adjust transparency ({transparencyDecrease} / {transparencyIncrease})'.
   */
  _applyShortcutHints(root = document) {
    root.querySelectorAll('[data-sc-title]').forEach(el => {
      el.title = this._fillShortcutTemplate(el.getAttribute('data-sc-title'));
    });
    root.querySelectorAll('[data-sc-text]').forEach(el => {
      el.textContent = this._fillShortcutTemplate(el.getAttribute('data-sc-text'));
    });
  }

  /**
   * Builds an element whose text comes from a shortcut template and tags it with
   * data-sc-text, so _applyShortcutHints() can refresh it after a rebind without
   * re-rendering (and losing) the surrounding view.
   */
  _scText(tag, template, attrs = '') {
    const escaped = template.replace(/"/g, '&quot;');
    return `<${tag}${attrs ? ' ' + attrs : ''} data-sc-text="${escaped}">${this._fillShortcutTemplate(template)}</${tag}>`;
  }

  /** Sets an element's text from a shortcut template, keeping it refreshable on rebind */
  _setScText(el, template) {
    if (!el) return;
    el.setAttribute('data-sc-text', template);
    el.textContent = this._fillShortcutTemplate(template);
  }

  /** Sets transient text (e.g. 'Processing…') that a shortcut refresh must not overwrite */
  _setPlainText(el, text) {
    if (!el) return;
    el.removeAttribute('data-sc-text');
    el.textContent = text;
  }

  async checkAuthentication() {
    if (!window.electronAPI.checkAuth) return false;
    const isAuthenticated = await window.electronAPI.checkAuth();
    this._isSignedIn = isAuthenticated;
    const avatarBtn = document.getElementById('profile-avatar-btn');
    // The avatar is the way in to the account either way: signed out, its
    // panel offers Sign in instead of the account details.
    if (avatarBtn) {
      avatarBtn.style.display = 'flex';
      avatarBtn.classList.toggle('signed-out', !isAuthenticated);
      avatarBtn.title = isAuthenticated ? 'Profile & Account' : 'Sign in';
    }
    const initials = document.getElementById('avatar-initials');

    if (isAuthenticated) {
      this._hideLoginOverlay();
      this._closeSignInPrompt();
      if (initials && initials.textContent === '?') initials.textContent = '';
      // Load profile in background — don't block startup
      this._loadAndRenderProfile();
      this.fetchAndSetInterviewContext();

      // Finish what the user was doing when we asked them to sign in (e.g. the
      // Ctrl+Enter that was blocked) so they get their answer without redoing it.
      const pending = this._pendingAuthAction;
      this._pendingAuthAction = null;
      if (pending) setTimeout(() => { try { pending(); } catch (err) { console.error(err); } }, 0);
    } else {
      // Signed out is a normal state: the app stays fully explorable (modes,
      // shortcuts, screenshots) and only asks for an account when the user
      // requests an AI answer or starts an interview.
      this._userProfile = null;
      if (initials) initials.textContent = '';
    }
    return isAuthenticated;
  }

  /**
   * Gate for anything that needs an account (AI answers, interview). Returns
   * true when signed in. Otherwise shows the sign-in prompt and remembers
   * `retry`, which runs once the user signs in.
   */
  async _requireSignIn(reason, retry = null) {
    const isAuthenticated = window.electronAPI.checkAuth ? await window.electronAPI.checkAuth() : true;
    if (isAuthenticated) return true;
    this._pendingAuthAction = retry;
    this._showSignInPrompt(reason);
    return false;
  }

  _showSignInPrompt(reason = 'answer') {
    const copy = {
      answer: {
        title: 'Sign in to get your answer',
        body: 'Your screenshots and text are still here. Sign in and Solvro will answer right away.',
      },
      interview: {
        title: 'Sign in to start the interview',
        body: 'Interview mode listens and answers live, so it needs an account. It only takes a moment.',
      },
      dictation: {
        title: 'Sign in to use voice input',
        body: 'Voice input is transcribed by Solvro, so it needs an account.',
      },
    }[reason] || { title: 'Sign in to continue', body: 'This feature needs a Solvro account.' };

    let prompt = document.getElementById('signin-prompt');
    if (!prompt) {
      prompt = document.createElement('div');
      prompt.id = 'signin-prompt';
      prompt.className = 'signin-prompt';
      document.body.appendChild(prompt);
    }
    prompt.innerHTML = `
      <div class="signin-prompt-backdrop" data-signin-dismiss></div>
      <div class="signin-prompt-card" role="dialog" aria-modal="true" aria-labelledby="signin-prompt-title">
        <div class="signin-prompt-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        </div>
        <h3 id="signin-prompt-title">${copy.title}</h3>
        <p>${copy.body}</p>
        <div class="signin-prompt-actions">
          <button type="button" class="signin-prompt-secondary" data-signin-dismiss>Not now</button>
          <button type="button" class="signin-prompt-primary" id="signin-prompt-go">Sign in</button>
        </div>
      </div>
    `;
    prompt.style.display = 'flex';
    this._setOverlayMask('signin-prompt', true);
    const go = document.getElementById('signin-prompt-go');
    if (go) go.focus();
  }

  _closeSignInPrompt() {
    const prompt = document.getElementById('signin-prompt');
    if (prompt) prompt.style.display = 'none';
    this._setOverlayMask('signin-prompt', false);
  }

  _showLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    this._closeSignInPrompt();
    this._closeProfilePanel();
    this._renderLoginCard();
    overlay.style.display = 'flex';
    this._setOverlayMask('login-overlay', true);
  }

  _hideLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.style.display = 'none';
    this._setOverlayMask('login-overlay', false);
  }

  // ─── Crash guards ──────────────────────────────────────────
  //
  // The UI gates work behind `_isGenerating` / `_chatBusy`. Those are cleared in
  // the success and catch paths, but an error thrown OUTSIDE them — a rendering
  // bug, a DOM node pulled out mid-update, an IPC listener that throws — leaves
  // the flag stuck on. From then on the Answer/Send buttons silently do nothing
  // and the app looks hung, with only a restart to fix it. These guards make
  // that state self-healing.
  setupCrashGuards() {
    const GENERATION_WATCHDOG_MS = 180000; // 3 min — longer than any real request

    // An uncaught error does NOT release the lock straight away: the request it
    // interrupted may still be in flight, and freeing the button would let the
    // user fire a second one and pay for it twice. Arm a short recovery instead
    // — if the normal path finishes first the lock is already clear and this is
    // a no-op.
    const armRecovery = (reason) => {
      if (!(this._isGenerating || this._chatBusy)) return;
      if (this._recoveryTimer) return;
      this._recoveryTimer = setTimeout(() => {
        this._recoveryTimer = null;
        if (this._isGenerating || this._chatBusy) this._recoverFromStuckState(reason);
      }, 30000);
    };

    window.addEventListener('error', (event) => {
      console.error('Uncaught renderer error:', event.error || event.message);
      armRecovery('uncaught error');
    });

    window.addEventListener('unhandledrejection', (event) => {
      console.error('Unhandled rejection in renderer:', event.reason);
      armRecovery('unhandled rejection');
    });

    // Backstop for a lock that was never released and never threw either — e.g.
    // a stream that stops arriving because the connection died silently.
    this._generatingSince = 0;
    setInterval(() => {
      const busy = this._isGenerating || this._chatBusy;
      if (!busy) {
        this._generatingSince = 0;
        return;
      }
      if (!this._generatingSince) {
        this._generatingSince = Date.now();
        return;
      }
      if (Date.now() - this._generatingSince > GENERATION_WATCHDOG_MS) {
        console.warn('Generation watchdog fired — releasing stuck busy lock');
        this._recoverFromStuckState('watchdog');
      }
    }, 15000);
  }

  /** Releases the busy locks and re-enables the controls they disable. */
  _recoverFromStuckState(reason) {
    try {
      this._isGenerating = false;
      this._chatBusy = false;
      this._generatingSince = 0;
      this.cancelStreamRender();

      const forceBtn = document.getElementById('force-answer-btn');
      if (forceBtn) {
        forceBtn.disabled = false;
        forceBtn.innerHTML = '<span class="icon">⚡</span> Answer';
      }
      // In chat mode this id belongs to an icon-only button — re-enable it but
      // leave its markup alone. Elsewhere it carries a shortcut-aware label, so
      // restore that template rather than inventing a caption.
      const sendBtn = document.getElementById('send-queue-btn');
      if (sendBtn) {
        sendBtn.disabled = false;
        if (!this._isChatMode()) {
          this._setScText(sendBtn, '🔍 Extract & Analyze ({sendQueue})');
        }
      }

      console.warn(`Recovered UI state after: ${reason}`);
    } catch (err) {
      console.error('Recovery failed:', err);
    }
  }

  setupNetworkListeners() {
    this.updateOnlineStatus = this.updateOnlineStatus.bind(this);
    window.addEventListener('online', this.updateOnlineStatus);
    window.addEventListener('offline', this.updateOnlineStatus);
    this.updateOnlineStatus();
  }

  updateOnlineStatus() {
    const isOnline = navigator.onLine;
    const dot = document.querySelector('.network-dot');
    const statusContainer = document.getElementById('network-status');

    if (dot) {
      if (isOnline) {
        dot.className = 'network-dot online';
        if (statusContainer) statusContainer.title = 'Network Online';

        // Process offline queue if there's anything
        if (this.offlineQueue && this.offlineQueue.length > 0) {
          this.showToast(`Back online! Processing ${this.offlineQueue.length} queued request(s)...`, 'success');
          this.processOfflineQueue();
        }
      } else {
        dot.className = 'network-dot offline';
        if (statusContainer) statusContainer.title = 'Network Offline - Requests will be queued';
        this.showToast('You are offline. Requests will be queued.', 'warning');
      }
    }
  }

  async processOfflineQueue() {
    while (this.offlineQueue && this.offlineQueue.length > 0 && navigator.onLine) {
      const item = this.offlineQueue.shift();
      if (this.additionalTextInput) this.additionalTextInput.value = item.text;
      const currentQueue = [...this.screenshotQueue];
      this.screenshotQueue = item.queue;
      await this.sendQueue();
      this.screenshotQueue = currentQueue;
    }
  }

  setupEventListeners() {
    // Control pills open a dropdown of every option; the keyboard shortcuts
    // still step through them one at a time.
    this._setupSelectorDropdowns();

    // Close button
    this.closeButton.addEventListener('click', async () => {
      try {
        await window.electronAPI.quitApp();
      } catch (error) {
        try { await window.electronAPI.hideWindow(); } catch (_) { }
      }
    });

    // Overlay mode button — red omnitrix with bypass popup
    const overlayBtn = document.getElementById('overlay-mode-btn');
    const bypassLabel = document.getElementById('bypass-label');
    const isWin = window.electronAPI.platform === 'win32';
    if (overlayBtn) {
      overlayBtn.style.display = 'flex';
      if (bypassLabel) bypassLabel.style.display = 'inline';
      overlayBtn.addEventListener('click', () => {
        const modal = document.getElementById('bypass-modal-overlay');
        const desc = document.getElementById('bypass-modal-desc');
        const bypassList = document.getElementById('bypass-list');
        const launchBtn = document.getElementById('bypass-launch-btn');
        if (!modal) return;
        if (desc) desc.textContent = 'Launch Ultimate Solvro — a stealth overlay that bypasses any desktop-app-based proctoring or browser lockdown.';
        if (bypassList) bypassList.style.display = 'flex';
        if (launchBtn) launchBtn.style.display = 'flex';
        modal.style.display = 'flex';
      });
    }
    // Bypass popup close button
    const bypassClose = document.getElementById('bypass-modal-close');
    if (bypassClose) {
      bypassClose.addEventListener('click', () => {
        const modal = document.getElementById('bypass-modal-overlay');
        if (modal) modal.style.display = 'none';
      });
    }
    // Bypass popup overlay click to close
    const bypassOverlay = document.getElementById('bypass-modal-overlay');
    if (bypassOverlay) {
      bypassOverlay.addEventListener('click', (e) => {
        if (e.target === bypassOverlay) bypassOverlay.style.display = 'none';
      });
    }
    // Bypass launch button
    const bypassLaunch = document.getElementById('bypass-launch-btn');
    if (bypassLaunch) {
      bypassLaunch.addEventListener('click', async () => {
        const modal = document.getElementById('bypass-modal-overlay');
        if (modal) modal.style.display = 'none';

        let loadingOverlay = document.getElementById('overlay-loading-screen');
        if (!loadingOverlay) {
          loadingOverlay = document.createElement('div');
          loadingOverlay.id = 'overlay-loading-screen';
          loadingOverlay.innerHTML = `
            <div class="overlay-loading-spinner"></div>
            <div class="overlay-loading-text">Launching Ultimate Solvro</div>
          `;
          document.body.appendChild(loadingOverlay);
        }
        loadingOverlay.style.display = 'flex';

        try {
          const result = await window.electronAPI.launchOverlayMode();
          if (result && !result.success) {
            loadingOverlay.style.display = 'none';
            this.statusElement.textContent = result.error || 'Failed to launch overlay mode';
          }
        } catch (err) {
          loadingOverlay.style.display = 'none';
          this.statusElement.textContent = 'Ready';
        }
      });
    }


    // Scroll logic
    const scrollBtn = document.getElementById('scroll-to-bottom-btn');
    if (this.analysisContainer) {
      this.analysisContainer.addEventListener('scroll', () => {
        // Check if user scrolled up significantly
        const isAtBottom = this.analysisContainer.scrollHeight - this.analysisContainer.scrollTop - this.analysisContainer.clientHeight < 50;
        this.autoScrollEnabled = isAtBottom;

        if (scrollBtn) {
          const isInterview = this.currentMode && this.currentMode.mode === 'interview';
          scrollBtn.style.display = (isInterview && !isAtBottom) ? 'block' : 'none';
        }
      });
    }

    if (scrollBtn) {
      scrollBtn.addEventListener('click', () => {
        this.autoScrollEnabled = true;
        this.scrollToBottomIfEnabled();
      });
    }

    // Keyboard scrolling is driven by the configurable scrollUp/scrollDown global shortcuts in main.js

    // Profile avatar button — open panel
    const profileAvatarBtn = document.getElementById('profile-avatar-btn');
    if (profileAvatarBtn) {
      profileAvatarBtn.addEventListener('click', () => this._openProfilePanel());
    }

    // Profile panel backdrop + close/dashboard/logout — use closest() so SVG children don't miss
    document.addEventListener('click', (e) => {
      if (e.target.id === 'profile-panel-backdrop') {
        this._closeProfilePanel();
        return;
      }
      if (e.target.closest('#profile-panel-close')) {
        this._closeProfilePanel();
        return;
      }
      if (e.target.closest('#profile-dashboard-btn')) {
        this._closeProfilePanel();
        if (window.electronAPI.openExternal) {
          window.electronAPI.openExternal('https://solvro.in/dashboard');
        }
        return;
      }
      if (e.target.closest('#profile-logout-btn')) {
        this._closeProfilePanel();
        this._doLogout();
        return;
      }
      if (e.target.closest('#profile-signin-btn') || e.target.closest('#signin-prompt-go')) {
        this._showLoginOverlay();
        return;
      }
      if (e.target.closest('[data-signin-dismiss]')) {
        // "Not now" — drop the blocked request; the user can retry any time.
        this._pendingAuthAction = null;
        this._closeSignInPrompt();
        return;
      }
      if (e.target.closest('#login-cancel-btn')) {
        this._pendingAuthAction = null;
        this._hideLoginOverlay();
        return;
      }
      if (e.target.closest('#header-theme-btn')) {
        e.preventDefault(); // Prevent default label click behavior if triggered by label
        this._toggleTheme();
        return;
      }
    });

    // Legacy login btn (now inside rendered card)
    document.addEventListener('click', async (e) => {
      // Legacy login btn (now inside rendered card)
      // Both open the website in the browser; sign-up just lands on its
      // Create account tab (Google or email), then hands the session back here.
      const googleBtn = e.target && e.target.closest && e.target.closest('#login-btn, #login-signup-btn');
      if (googleBtn) {
        const btn = googleBtn;
        if (btn.disabled) return;
        const isSignup = btn.id === 'login-signup-btn';
        btn.disabled = true;
        btn.innerHTML = '<span class="login-spinner"></span>Waiting for browser…';
        try {
          const success = await window.electronAPI.startLogin(isSignup ? { mode: 'signup' } : undefined);
          if (success) {
            await this.checkAuthentication();
          } else {
            this._renderLoginCard(); // Reset button state
          }
        } catch (err) {
          this._renderLoginCard(); // Reset button state
        }
      }

      // Show/hide password on login
      const pwToggle = e.target.closest && e.target.closest('#login-pw-toggle');
      if (pwToggle) {
        const pwInput = document.getElementById('login-password');
        if (pwInput) {
          const show = pwInput.type === 'password';
          pwInput.type = show ? 'text' : 'password';
          pwToggle.classList.toggle('is-active', show);
          pwToggle.title = show ? 'Hide password' : 'Show password';
          pwToggle.setAttribute('aria-label', pwToggle.title);
        }
      }
    });

    // Email/password login form
    document.addEventListener('submit', async (e) => {
      if (e.target && e.target.id === 'email-login-form') {
        e.preventDefault();
        const emailInput = document.getElementById('login-email');
        const passInput = document.getElementById('login-password');
        const btn = document.getElementById('email-login-btn');
        const errorDiv = document.getElementById('login-error');

        const email = emailInput.value.trim();
        const password = passInput.value;

        if (!email || !password) return;

        btn.innerHTML = '<span class="login-spinner"></span>Signing in…';
        btn.disabled = true;
        errorDiv.style.display = 'none';

        const result = await window.electronAPI.emailPasswordLogin(email, password);
        if (result.success) {
          await this.checkAuthentication();
        } else {
          errorDiv.textContent = result.error || 'Login failed';
          errorDiv.style.display = 'block';
          btn.textContent = 'Sign In';
          btn.disabled = false;
        }
      }
    });

    // Transparency controls
    if (this.opacitySlider) {
      this.opacitySlider.addEventListener('input', (e) => {
        this.setWindowOpacity(parseFloat(e.target.value) / 100);
      });
      this.opacitySlider.addEventListener('change', (e) => {
        this.setWindowOpacity(parseFloat(e.target.value) / 100);
      });
    }

    // Audio Controls
    const toggleAudioBtn = document.getElementById('toggle-audio-btn');
    if (toggleAudioBtn) {
      toggleAudioBtn.addEventListener('click', () => this.toggleAudioCapture());
    }

    const muteMicBtn = document.getElementById('mute-mic-btn');
    if (muteMicBtn) {
      muteMicBtn.addEventListener('click', () => this.toggleMicMute());
    }

    const forceAnswerBtn = document.getElementById('force-answer-btn');
    if (forceAnswerBtn) {
      forceAnswerBtn.addEventListener('click', () => this.triggerLiveAnswer());
    }

    // Interview specific bottom buttons
    const interviewScreenshotBtn = document.getElementById('screenshot-btn-interview');
    if (interviewScreenshotBtn) {
      interviewScreenshotBtn.addEventListener('click', () => this.takeScreenshot());
    }

    const interviewForceAnswerBtn = document.getElementById('force-answer-btn-interview');
    if (interviewForceAnswerBtn) {
      interviewForceAnswerBtn.addEventListener('click', () => this.triggerLiveAnswer());
    }

    // New Question button — clears conversation for a fresh start
    const newQuestionBtn = document.getElementById('new-question-btn-interview');
    if (newQuestionBtn) {
      newQuestionBtn.addEventListener('click', () => this.resetConversation());
    }

    // Collapse Transcription Panel button
    const collapseBtn = document.getElementById('transcript-collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        const panel = document.getElementById('transcript-content');
        if (panel) {
          const isCollapsed = panel.classList.contains('collapsed');
          if (isCollapsed) {
            panel.classList.remove('collapsed');
            collapseBtn.classList.remove('collapsed');
          } else {
            panel.classList.add('collapsed');
            collapseBtn.classList.add('collapsed');
          }
          this.resizeWindowToContent();
        }
      });
    }

    // Interview chat input
    const interviewChatSubmit = document.getElementById('interview-chat-submit');
    const interviewChatInput = document.getElementById('interview-chat-input');

    if (interviewChatSubmit && interviewChatInput) {
      interviewChatSubmit.addEventListener('click', () => {
        const text = interviewChatInput.value.trim();
        if (text) {
          // Show user bubble in chat
          this._showInterviewUserBubble(text);
          this.appendTranscript(text, 'me');
          interviewChatInput.value = '';
          // Trigger AI answer with the typed question
          this.triggerLiveAnswer(text);
        }
      });
      interviewChatInput.addEventListener('keydown', (e) => {
        e.stopPropagation(); // Stop global key listener from interfering
        if (e.key === 'Enter') {
          e.preventDefault();
          interviewChatSubmit.click();
        }
      });
    }


    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Space is swallowed to stop the page scrolling when nothing is focused —
      // but NOT while typing in a field, or the space never reaches the box
      // (this is why the Additional-context textarea wouldn't accept spaces).
      const t = e.target;
      const isEditable = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
      if ((e.key === ' ' || e.key === 'Spacebar') && !isEditable) e.preventDefault();


      if (e.ctrlKey && !e.shiftKey) {
        const moveDistance = 20;
        let handled = false;
        switch (e.key) {
          case 'ArrowUp': e.preventDefault(); window.electronAPI.moveWindow(0, -moveDistance); handled = true; break;
          case 'ArrowDown': e.preventDefault(); window.electronAPI.moveWindow(0, moveDistance); handled = true; break;
          case 'ArrowLeft': e.preventDefault(); window.electronAPI.moveWindow(-moveDistance, 0); handled = true; break;
          case 'ArrowRight':
            if (!e.shiftKey) { e.preventDefault(); window.electronAPI.moveWindow(moveDistance, 0); handled = true; }
            break;
        }
        if (handled) {
          this.statusElement.textContent = `Window moved ${e.key.replace('Arrow', '').toLowerCase()}`;
          setTimeout(() => this.updateStatus(), 1000);
        }
      }

      if (e.key === 'Escape') {
        const panel = document.getElementById('profile-panel');
        if (panel && panel.style.display !== 'none') {
          this._closeProfilePanel();
        }
      }
    });

    window.addEventListener('focus', () => { });
    document.addEventListener('click', () => { window.focus(); });
  }

  setupIPCListeners() {
    // Legacy screenshot events (for backward compatibility)
    window.electronAPI.onScreenshotProcessing(() => {
      this.showProcessing();
    });

    window.electronAPI.onScreenshotAnalysis((event, analysis) => {
      this.showAnalysis(analysis);
    });

    window.electronAPI.onScreenshotError((event, error) => {
      this._clearCapturingPlaceholder();
      this.showError(error);
    });

    // New text extraction event
    window.electronAPI.onScreenshotTextExtraction((event, data) => {
      this.showTextExtraction(data);
    });

    // AI Streaming chunks
    window.electronAPI.onStreamChunk((event, chunk) => {
      this.handleStreamChunk(chunk);
    });

    // New queue-based events
    if (window.electronAPI.onScreenshotCapturing) {
      window.electronAPI.onScreenshotCapturing(() => {
        this.handleScreenshotCapturing();
      });
    }
    window.electronAPI.onScreenshotQueued((event, data) => {
      this.handleScreenshotQueued(data);
    });

    window.electronAPI.onScreenshotLimitReached((event, data) => {
      this._clearCapturingPlaceholder();
      this.maxScreenshots = data.max;
      this.showToast(
        `Screenshot limit reached (${data.queueSize}/${data.max}). ${this._fillShortcutTemplate('Send with {sendQueue} or clear with {resetConversation}.')}`,
        'warning',
        4000
      );
    });

    window.electronAPI.onQueueProcessing((event, data) => {
      // Skip the "Analyzing X screenshots" card in interview mode — we have our own Generating Answer indicator
      // Query mode renders its own chat bubbles in sendChatMessage
      if (this.currentMode && ['interview', 'query'].includes(this.currentMode.mode)) return;
      this.showQueueProcessing(data);
    });

    window.electronAPI.onQueueAnalysis((event, data) => {
      // Skip in interview mode — responses are handled by triggerLiveAnswer
      if (this.currentMode && this.currentMode.mode === 'interview') return;
      if (this._isChatMode()) {
        this.conversationHistory = data.history;
        return;
      }
      this.showQueueAnalysis(data);
    });

    window.electronAPI.onQueueError((event, error) => {
      // Skip in interview mode — errors are handled by triggerLiveAnswer
      if (this.currentMode && ['interview', 'query'].includes(this.currentMode.mode)) return;
      this.showError(error);
    });

    // New extraction events
    window.electronAPI.onExtractionStarted((event, data) => {
      // Skip in interview mode — triggerLiveAnswer handles the UI
      if (this.currentMode && this.currentMode.mode === 'interview') return;
      this.showExtractionStarted(data);
    });

    window.electronAPI.onExtractionProgress((event, progress) => {
      // Skip in interview mode
      if (this.currentMode && this.currentMode.mode === 'interview') return;
      this.showExtractionProgress(progress);
    });

    window.electronAPI.onExtractionCompleted((event, data) => {
      // Skip in interview mode
      if (this.currentMode && this.currentMode.mode === 'interview') return;
      this.showExtractionCompleted(data);
    });

    window.electronAPI.onConversationReset(() => {
      this.handleConversationReset();
    });

    // A reinstall handed the already-running instance a fresh session token;
    // re-check auth so the login overlay clears without a manual restart.
    if (window.electronAPI.onAuthRefresh) {
      window.electronAPI.onAuthRefresh(() => {
        this.checkAuthentication();
      });
    }

    // The interview view (or main) refused something because nobody is signed in.
    if (window.electronAPI.onAuthRequired) {
      window.electronAPI.onAuthRequired((event, data) => {
        const reason = (data && data.reason) || 'answer';
        // Don't stack the prompt on top of the sign-in page itself.
        const overlay = document.getElementById('login-overlay');
        if (overlay && overlay.style.display !== 'none') return;
        this._pendingAuthAction = null;
        this._showSignInPrompt(reason);
      });
    }

    // Main dropped the queue (e.g. the mode changed) — drop our copy too so the
    // attachment chips can't outlive the screenshots they point at.
    if (window.electronAPI.onScreenshotQueueCleared) {
      window.electronAPI.onScreenshotQueueCleared((event, data) => {
        this.handleScreenshotQueueCleared(data);
      });
    }

    // Global toggle-theme shortcut
    if (window.electronAPI.onToggleTheme) {
      window.electronAPI.onToggleTheme(() => this._toggleTheme());
    }

    // Handle keyboard shortcuts from main process
    window.electronAPI.onSendQueueShortcut(() => {
      if (this.currentMode && this.currentMode.mode === 'interview') {
        this.triggerLiveAnswer();
      } else {
        this.sendQueue();
      }
    });

    // Listen for shortcuts changed from main process (instant update)
    window.electronAPI.onShortcutsChanged((event, updatedShortcuts) => {
      this.currentShortcuts = updatedShortcuts;
      this._updateShortcutTextsInPlace();
    });

    // Mode change events
    window.electronAPI.onModeChanged((event, modeData) => {
      this.currentMode = modeData; // Update current mode
      this.updateModeDisplay(modeData);
      // The language pill's click behaviour and tooltip differ in interview
      // mode (click-to-cycle vs dropdown) — refresh it for the new mode.
      this.updateLanguageDisplay(this.currentLanguage);
      // Each mode offers a different set of models — reload the dropdown lists
      this.refreshSelectorOptions();

      // Toggle interview-mode class on analysis container for scoped CSS
      if (this.analysisContainer) {
        if (modeData && modeData.mode === 'interview') {
          this.analysisContainer.classList.add('interview-mode');
        } else {
          this.analysisContainer.classList.remove('interview-mode');
        }
      }

      // Handle interview mode UI transition
      const bottomWidget = document.getElementById('interview-bottom-widget');
      const recordingPill = document.getElementById('recording-pill');

      if (modeData && modeData.mode === 'interview') {
        this.fetchAndSetInterviewContext();
        if (!this._isFeatureAllowed('interview')) {
          if (window.electronAPI.hideInterviewView) window.electronAPI.hideInterviewView();
          document.body.classList.remove('interview-active');
        } else {
          if (window.electronAPI.showInterviewView) window.electronAPI.showInterviewView();
          // The companion BrowserView handles interview UI.
          // Hide Solvro's interview-specific elements (they're replaced by BrowserView).
          document.body.classList.add('interview-active');
        }
      } else {
        // Clean up — hide interview UI, restore normal mode
        if (recordingPill) recordingPill.style.display = 'none';
        if (bottomWidget) bottomWidget.style.display = 'none';
        document.body.classList.remove('interview-active');

        // Clean up old HUD (in case it was ever initialized)
        this._coachSessionActive = false;
        this.setLiveCoachPanelVisible(false);
        const miniStrip = document.getElementById('mini-caption-strip');
        if (miniStrip) miniStrip.classList.add('hidden');
        this.updateHudStackVisibility();
        this.resetLiveCoachUI();

        if (this.isAudioActive) this.stopAudioCapture();
      }

      // Refresh the view to reflect the new mode
      if (!(modeData && modeData.mode === 'interview')) {
        this.showWelcomeMessage();
      }
    });

    // Language change events
    window.electronAPI.onLanguageChanged((event, languageData) => {
      this.currentLanguage = languageData; // Update current language
      this.updateLanguageDisplay(languageData);
    });

    // Model change events
    window.electronAPI.onModelChanged((event, modelData) => {
      this.currentModel = modelData;
      this.updateModelDisplay(modelData);
    });

    // Interview BrowserView events
    if (window.electronAPI.onInterviewViewShown) {
      window.electronAPI.onInterviewViewShown(() => {
        // Hide Solvro's own UI when interview BrowserView is active
        if (this.analysisContainer) this.analysisContainer.style.display = 'none';
        const topBar = document.getElementById('top-bar');
        if (topBar) topBar.style.display = 'none';
        const bottomWidget2 = document.getElementById('interview-bottom-widget');
        if (bottomWidget2) bottomWidget2.style.display = 'none';
        const recordingPill2 = document.getElementById('recording-pill');
        if (recordingPill2) recordingPill2.style.display = 'none';
      });
    }

    if (window.electronAPI.onInterviewViewHidden) {
      window.electronAPI.onInterviewViewHidden(() => {
        // Restore Solvro's UI when leaving interview mode
        if (this.analysisContainer) this.analysisContainer.style.display = '';
        const topBar = document.getElementById('top-bar');
        if (topBar) topBar.style.display = '';
      });
    }

    // Interview BrowserView events
    if (window.electronAPI.onInterviewViewShown) {
      window.electronAPI.onInterviewViewShown(() => {
        if (this.analysisContainer) this.analysisContainer.style.display = 'none';
        const topBar = document.getElementById('top-bar');
        if (topBar) topBar.style.display = 'none';
        const bw = document.getElementById('interview-bottom-widget');
        if (bw) bw.style.display = 'none';
        const rp = document.getElementById('recording-pill');
        if (rp) rp.style.display = 'none';
        // Align the view to the real top-bar height now its UI is settled.
        this._reportInterviewContentTop();
      });
    }
    if (window.electronAPI.onInterviewViewHidden) {
      window.electronAPI.onInterviewViewHidden(() => {
        if (this.analysisContainer) this.analysisContainer.style.display = '';
        const topBar = document.getElementById('top-bar');
        if (topBar) topBar.style.display = '';
      });
    }

    // Code copied for typing event
    window.electronAPI.onCodeCopiedForTyping((event, data) => {
      this.showCodeCopiedMessage(data);
    });

    // User key events
    window.electronAPI.onShowUserKeyInput(() => {
      this.showUserKeyDialog();
    });

    window.electronAPI.onUserKeySuccess((event, message) => {
      this.hideUserKeyDialog();
      this.showMessage(message, 'success');
    });

    window.electronAPI.onUserKeyError((event, error) => {
      this.showUserKeyError(error);
    });

    // Opacity/transparency events
    window.electronAPI.onOpacityChanged((event, opacity) => {
      this.updateOpacityDisplay(opacity);
    });

    this._wireUpdateEvents();

    // Session saved notification
    window.electronAPI.onSessionSaved((event, data) => {
      this.showSessionSaved(data);
    });

    // Handle global key capture events from main process
    window.electronAPI.onGlobalKeyCaptured((event, data) => {
      this.handleGlobalKeyCaptured(data);
    });

    // Audio Capture IPC events
    if (window.electronAPI.onToggleAudioCapture) {
      window.electronAPI.onToggleAudioCapture(() => this.toggleAudioCapture());
    }
    if (window.electronAPI.onToggleMicMute) {
      window.electronAPI.onToggleMicMute(() => this.toggleMicMute());
    }
    if (window.electronAPI.onToggleVoiceInput) {
      // Ctrl+Shift+A in query mode (main only sends this while in query mode)
      window.electronAPI.onToggleVoiceInput(() => {
        if (this._isChatMode()) this.toggleVoiceRecording();
      });
    }
    if (window.electronAPI.onForceAnswerTrigger) {
      window.electronAPI.onForceAnswerTrigger(() => this.triggerLiveAnswer());
    }
  }


  // Which plan tier the signed-in user is on: 0 = Free Trial, 1 = Pro,
  // 2 = Pro+. Mirrors the server's own plan matching in aiLimits.
  _planTier() {
    const plan = (this._userProfile?.subscription?.plan || 'Free Trial').toLowerCase().replace(/_/g, ' ');
    const isLegacyProPlus = ['1 month', '3 months', '6 months', '12 months', 'test 7days'].includes(plan);
    if (plan.includes('pro+') || plan.includes('pro plus') || plan.includes('sprint') || plan.includes('eternal') || isLegacyProPlus) return 2;
    if (plan.includes('pro')) return 1;
    return 0;
  }

  _isFeatureAllowed(feature) {
    if (!feature) return true;
    const tier = this._planTier();
    if (tier === 2) return true;

    // Models are gated by the tier the server publishes for them, so a model
    // added or re-priced on the website is gated correctly here without the
    // app knowing anything about it.
    const modelTier = this._selectorOptions?.modelTiers?.[feature];
    if (modelTier !== undefined) return modelTier <= tier;

    // The tier map has not arrived yet (first paint, or an offline launch).
    // Fall back to the name-matching this used to do, so the UI never briefly
    // locks something the user is entitled to.
    const looksLikeTier2Model = /claude|sonnet|opus|fable/.test(feature);

    if (tier === 1) {
      // Pro gets everything except the Pro+ models. Interview mode is unlimited.
      return !looksLikeTier2Model;
    }
    // Free Trial: every mode, on the free model. The server meters the trial
    // (10 responses / 10 interview minutes), so locking modes here only hid a
    // trial the account was entitled to.
    return ['coding', 'mcq', 'query', 'interview'].includes(feature) || feature === 'gemini-3.7-flash';
  }

  // ─── Selector Dropdowns ──────────────────────────────────

  /**
   * Each control pill (language / mode / model) opens a menu listing every
   * option, so a value 12 entries down is one click away instead of twelve.
   * The cycle shortcuts are untouched and keep stepping one at a time.
   */
  _setupSelectorDropdowns() {
    this._selectorDefs().forEach(({ kind, pill, menu }) => {
      if (!pill || !menu) return;

      pill.addEventListener('click', () => this.toggleSelectorMenu(kind));
      pill.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggleSelectorMenu(kind);
        }
      });

      menu.addEventListener('click', (e) => {
        const option = e.target.closest('.selector-option');
        if (option) this._applySelectorChoice(kind, option.dataset.value);
      });
    });

    // A click anywhere outside the pills closes whatever menu is open
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.selector-wrap')) this.closeSelectorMenus();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._openSelector) {
        e.stopPropagation();
        this.closeSelectorMenus();
      }
    });

    window.addEventListener('blur', () => this.closeSelectorMenus());

    // Keep the interview view aligned below the top bar when the window resizes
    // (a narrower window can wrap the pills, making the top bar taller).
    window.addEventListener('resize', () => {
      if (this._contentTopResizeTimer) clearTimeout(this._contentTopResizeTimer);
      this._contentTopResizeTimer = setTimeout(() => this._reportInterviewContentTop(), 120);
    });
  }

  _selectorDefs() {
    return [
      { kind: 'language', pill: this.languageSelector, menu: this.languageMenu },
      { kind: 'mode', pill: this.modeIndicator, menu: this.modeMenu },
      { kind: 'model', pill: this.modelSelector, menu: this.modelMenu }
    ];
  }

  /** Pulls the option lists from main and repaints any menu that's open. */
  async refreshSelectorOptions() {
    try {
      const options = await window.electronAPI.getSelectorOptions();
      if (!options) return;
      this._selectorOptions = options;
      this._selectorDefs().forEach(({ kind }) => this._renderSelectorMenu(kind));
    } catch (error) {
      console.error('Error loading selector options:', error);
    }
  }

  _selectorItems(kind) {
    const options = this._selectorOptions;
    if (!options) return [];
    if (kind === 'language') return options.languages || [];
    if (kind === 'mode') return options.modes || [];
    return options.models || [];
  }

  /** The id currently selected for a list, taken from live state when available. */
  _selectorCurrentId(kind) {
    if (kind === 'language') return this.currentLanguage && this.currentLanguage.language;
    if (kind === 'mode') return this.currentMode && this.currentMode.mode;
    return this.currentModel && this.currentModel.model;
  }

  _renderSelectorMenu(kind) {
    const def = this._selectorDefs().find(d => d.kind === kind);
    if (!def || !def.menu) return;

    const items = this._selectorItems(kind);
    if (!items.length) {
      def.menu.innerHTML = '<div class="selector-menu-empty">No options available</div>';
      return;
    }

    const selectedItem = items.find(i => i.current);
    const currentId = this._selectorCurrentId(kind) || (selectedItem && selectedItem.id);

    def.menu.innerHTML = items.map(item => {
      // Languages are never plan-gated; modes and models can be
      const isAllowed = kind === 'language' ? true : this._isFeatureAllowed(item.id);
      const isSelected = item.id === currentId;
      const classes = ['selector-option'];
      if (isSelected) classes.push('selected');
      if (!isAllowed) classes.push('locked');
      const title = isAllowed ? item.name : `${item.name} requires an upgraded subscription`;
      return `
        <div class="${classes.join(' ')}" data-value="${this._escapeHtml(item.id)}" role="option"
          aria-selected="${isSelected}" title="${this._escapeHtml(title)}">
          <span class="opt-icon">${this._escapeHtml(item.icon || '')}</span>
          <span class="opt-name">${this._escapeHtml(item.name)}</span>
          ${isAllowed ? '' : '<span class="opt-badge">&#128274;</span>'}
          ${isSelected ? '<span class="opt-check">&#10003;</span>' : ''}
        </div>`;
    }).join('');
  }

  _escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  toggleSelectorMenu(kind) {
    // In interview mode the language and mode pills cycle to the next option on
    // click instead of opening a dropdown — the interview BrowserView paints
    // over the page, so a menu there would need the view moved aside just to be
    // seen. (The same cycles are on the languageSwitch / modeSwitch shortcuts.)
    if (this.currentMode?.mode === 'interview') {
      if (kind === 'language') {
        this.closeSelectorMenus();
        this.cycleLanguage();
        return;
      }
      if (kind === 'mode') {
        this.closeSelectorMenus();
        this.switchMode();
        return;
      }
    }
    if (this._openSelector === kind) {
      this.closeSelectorMenus();
    } else {
      this.openSelectorMenu(kind);
    }
  }

  openSelectorMenu(kind) {
    // The pinned modes hide the model pill entirely — nothing to open there
    if (kind === 'model' && this._isModelLockedMode()) return;

    this.closeSelectorMenus();

    const def = this._selectorDefs().find(d => d.kind === kind);
    if (!def || !def.pill || !def.menu) return;

    // Options may be stale (a mode change alters the model list) — repaint first
    this._renderSelectorMenu(kind);

    const wrap = def.pill.closest('.selector-wrap');
    if (!wrap) return;
    wrap.classList.add('open');
    def.pill.setAttribute('aria-expanded', 'true');
    this._openSelector = kind;

    // Flip the menu to the pill's right edge if it would overflow the window
    def.menu.classList.remove('align-right');
    if (def.menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
      def.menu.classList.add('align-right');
    }

    // The menu drops down from a top-bar pill into the area the interview
    // BrowserView paints over (a BrowserView always paints above this page, so
    // no z-index can put the menu on top of it). Rather than hiding the whole
    // interview screen, shrink the view down to just below the open menu so the
    // menu shows while the rest of the interview stays visible.
    this._applyInterviewMenuClear(def.menu);

    const selected = def.menu.querySelector('.selector-option.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  // Tells main how far down the interview BrowserView must be pushed so the open
  // selector menu (which lives in this page, below the top bar) isn't covered.
  // No-op outside interview mode, where there is no BrowserView to move.
  _applyInterviewMenuClear(menuEl) {
    if (this.currentMode?.mode !== 'interview') return;
    if (!window.electronAPI?.setInterviewMenuClear || !menuEl) return;
    const bottom = menuEl.getBoundingClientRect().bottom;
    // +12px covers the open animation's slight scale-up so the menu isn't clipped.
    window.electronAPI.setInterviewMenuClear(Math.ceil(bottom + 12));
  }

  _restoreInterviewMenuClear() {
    if (window.electronAPI?.setInterviewMenuClear) {
      window.electronAPI.setInterviewMenuClear(0);
    }
  }

  // Measures the bottom of the host top bar and tells main, so the interview
  // BrowserView sits right below it and follows if the top bar grows (e.g. the
  // pills wrap to a second row). No-op outside interview mode. Measured on the
  // next frame so any pending reflow (a just-changed pill) has settled.
  _reportInterviewContentTop() {
    if (this.currentMode?.mode !== 'interview') return;
    if (!window.electronAPI?.setInterviewContentTop) return;
    requestAnimationFrame(() => {
      const header = document.querySelector('.header');
      if (!header) return;
      const bottom = Math.round(header.getBoundingClientRect().bottom);
      if (bottom > 0) window.electronAPI.setInterviewContentTop(bottom);
    });
  }

  closeSelectorMenus() {
    // Bail before restoring the interview view when nothing is open. This runs on
    // every stray document click, and restoring a view we never shrank would
    // thrash its bounds for no reason.
    if (!this._openSelector) return;
    this._restoreInterviewMenuClear();
    this._selectorDefs().forEach(({ pill }) => {
      const wrap = pill && pill.closest('.selector-wrap');
      if (wrap) wrap.classList.remove('open');
      if (pill) pill.setAttribute('aria-expanded', 'false');
    });
    this._openSelector = null;
  }

  _applySelectorChoice(kind, value) {
    this.closeSelectorMenus();
    if (!value) return;
    if (kind === 'language') return this.cycleLanguage(value);
    if (kind === 'mode') return this.switchMode(value);
    return this.cycleModel(value);
  }

  async loadCurrentMode() {
    try {
      const modeData = await window.electronAPI.getCurrentMode();
      if (modeData) {
        this.currentMode = modeData;
        this.updateModeDisplay(modeData);
      }
    } catch (error) {
      console.error('Error loading current mode:', error);
    }
  }

  // No argument = step to the next mode (shortcut); a mode id = pick it directly (dropdown)
  async switchMode(targetMode) {
    try {
      const newModeData = targetMode
        ? await window.electronAPI.setMode(targetMode)
        : await window.electronAPI.switchMode();
      if (newModeData) {
        this.currentMode = newModeData;
        this.updateModeDisplay(newModeData);
        // The new mode may have dropped a model it doesn't offer (e.g. Fable 5
        // isn't available in Query). Update the model pill from the same response
        // so it never briefly shows the old, now-invalid model before the
        // model-changed event arrives. This runs before refreshSelectorOptions,
        // so the dropdown also renders with the correct model selected.
        if (newModeData.model) {
          this.currentModel = newModeData.model;
          this.updateModelDisplay(newModeData.model);
        }
        this.refreshSelectorOptions();
        this.statusElement.textContent = `Switched to ${newModeData.name}`;

        // Refresh the view to reflect the new mode
        if (newModeData.mode !== 'interview') {
          this.showWelcomeMessage();
        }
      }
    } catch (error) {
      console.error('Error switching mode:', error);
    }
  }

  updateModeDisplay(modeData) {
    this._applyModelSelectorVisibility(modeData && modeData.mode);
    if (this.modeIndicator && modeData) {
      const isAllowed = this._isFeatureAllowed(modeData.mode);
      const lockIcon = isAllowed ? '' : ' 🔒';
      this.modeIndicator.innerHTML = `${modeData.icon} ${modeData.name}${lockIcon}`;
      // In interview mode the pill cycles on click (no dropdown); elsewhere it opens one.
      const isInterview = modeData.mode === 'interview';
      this.modeIndicator.title = !isAllowed
        ? `${modeData.name} requires an upgraded subscription.`
        : isInterview
          ? `Current mode: ${modeData.name}. Click to switch to the next one, or press ${this._sc('modeSwitch')}.`
          : `Current mode: ${modeData.name}. Click to pick one, or press ${this._sc('modeSwitch')} to step through.`;
      this._renderSelectorMenu('mode');

      if (!isAllowed) {
        this.showSubscriptionError({ kind: 'mode', id: modeData.mode, name: modeData.name });
      }

      // Show/Hide Audio controls based on mode
      const audioControls = document.getElementById('audio-controls');
      const transcriptPanel = document.getElementById('live-transcript-panel');
      const scrollBtn = document.getElementById('scroll-to-bottom-btn');

      if (modeData.mode === 'interview') {
        // Interview mode is handled by the companion BrowserView — hide all old UI
        if (audioControls) audioControls.style.display = 'none';
        const recordingPill = document.getElementById('recording-pill');
        if (recordingPill) recordingPill.style.display = 'none';
        if (scrollBtn) scrollBtn.style.display = 'none';
      } else {
        if (audioControls) audioControls.style.display = 'none';
        if (transcriptPanel) transcriptPanel.style.display = 'none';
        if (this.isAudioActive) this.stopAudioCapture();
        if (scrollBtn) scrollBtn.style.display = 'none';
        const recordingPill = document.getElementById('recording-pill');
        if (recordingPill) recordingPill.style.display = 'none';
      }
    }
  }

  async setWindowOpacity(opacity) {
    try {
      await window.electronAPI.setOpacity(opacity);
    } catch (error) {
      console.error('Error setting window opacity:', error);
    }
  }

  async initializeTransparencyControls() {
    try {
      const currentOpacity = await window.electronAPI.getCurrentOpacity();
      if (this.opacitySlider && this.opacityValue) {
        // Convert opacity from decimal (0.0-1.0) to percentage (0-100) for slider
        this.opacitySlider.value = Math.round(currentOpacity * 100);
        this.opacityValue.textContent = Math.round(currentOpacity * 100) + '%';
      }
    } catch (error) {
      console.error('Error initializing transparency controls:', error);
    }
  }

  updateOpacityDisplay(opacity) {
    if (this.opacitySlider && this.opacityValue) {
      // Convert opacity from decimal (0.0-1.0) to percentage (0-100) for slider
      this.opacitySlider.value = Math.round(opacity * 100);
      this.opacityValue.textContent = Math.round(opacity * 100) + '%';
    }
  }

  async loadCurrentLanguage() {
    try {
      const languageData = await window.electronAPI.getCurrentLanguage();
      if (languageData) {
        this.currentLanguage = languageData;
        this.updateLanguageDisplay(languageData);
      }
    } catch (error) {
      console.error('Error loading current language:', error);
    }
  }

  async cycleLanguage(targetLanguage) {
    try {
      const newLanguageData = targetLanguage
        ? await window.electronAPI.setLanguage(targetLanguage)
        : await window.electronAPI.cycleLanguage();
      if (newLanguageData) {
        this.currentLanguage = newLanguageData;
        this.updateLanguageDisplay(newLanguageData);
        this.statusElement.textContent = `Switched to ${newLanguageData.name}`;
        // The pill's width changed; in interview mode re-check whether the top
        // bar grew so the view stays aligned below it.
        this._reportInterviewContentTop();
      }
    } catch (error) {
      console.error('Error cycling language:', error);
    }
  }

  updateLanguageDisplay(languageData) {
    if (this.languageSelector && languageData) {
      this.languageSelector.innerHTML = `${this._escapeHtml(languageData.icon)} ${this._escapeHtml(languageData.name)}`;
      const isInterview = this.currentMode?.mode === 'interview';
      this.languageSelector.title = isInterview
        ? `Current language: ${languageData.name}. Click to switch to the next one, or press ${this._sc('languageSwitch')}.`
        : `Current language: ${languageData.name}. Click to pick one, or press ${this._sc('languageSwitch')} to step through.`;
      this._renderSelectorMenu('language');
    }
  }

  // Interview and MCQ modes are pinned to Gemini 3.7 Flash — no model switching,
  // and the model selector is hidden so it can't be changed from the UI.
  _isModelLockedMode(mode) {
    const modeId = mode || (this.currentMode && this.currentMode.mode);
    return ['interview', 'mcq'].includes(modeId);
  }

  _applyModelSelectorVisibility(mode) {
    if (!this.modelSelector) return;
    const hidden = this._isModelLockedMode(mode);
    this.modelSelector.style.display = hidden ? 'none' : '';
    // Hide the wrapper too, otherwise it still eats a flex gap in the header
    const wrap = this.modelSelector.closest('.selector-wrap');
    if (wrap) wrap.style.display = hidden ? 'none' : '';
    if (hidden && this._openSelector === 'model') this.closeSelectorMenus();
  }

  updateModelDisplay(modelData) {
    this._applyModelSelectorVisibility();
    // The pinned model is always free, so skip the plan check entirely
    if (this._isModelLockedMode()) return;

    if (this.modelSelector && modelData) {
      const isAllowed = this._isFeatureAllowed(modelData.id || modelData.name.toLowerCase().replace(/ /g, '-'));
      const lockIcon = isAllowed ? '' : ' 🔒';
      this.modelSelector.innerHTML = `${modelData.icon} ${modelData.name}${lockIcon}`;
      this.modelSelector.title = isAllowed ? `Current model: ${modelData.name}. Click to pick one, or press ${this._sc('modelSwitch')} to step through.` : `${modelData.name} requires an upgraded subscription.`;
      this._renderSelectorMenu('model');

      if (!isAllowed) {
        this.showSubscriptionError({ kind: 'model', id: modelData.id, name: modelData.name });
      } else if (this.statusElement.textContent === 'Subscription Required') {
        if (!(this.currentMode && this.currentMode.mode === 'interview')) {
          this.showWelcomeMessage();
        }
      }
    }
  }

  async loadCurrentModel() {
    try {
      const modelData = await window.electronAPI.getCurrentModel();
      if (modelData) {
        this.currentModel = modelData;
        this.updateModelDisplay(modelData);
      }
    } catch (error) {
      console.error('Error loading current model:', error);
    }
  }

  async cycleModel(targetModel) {
    try {
      const newModelData = targetModel
        ? await window.electronAPI.setModel(targetModel)
        : await window.electronAPI.cycleModel();
      if (newModelData) {
        this.currentModel = newModelData;
        this.updateModelDisplay(newModelData);
      }
    } catch (error) {
      console.error('Error cycling model:', error);
    }
  }

  // ─── Profile Panel ───────────────────────────────────────

  async _loadAndRenderProfile() {
    try {
      // 1. Instantly load cached profile for fast UI
      if (window.electronAPI.getCachedUserProfile) {
        const cached = await window.electronAPI.getCachedUserProfile();
        if (cached) {
          this._userProfile = cached;
          this._updateAvatarButton(cached);
          if (this.currentModel) this.updateModelDisplay(this.currentModel);
          if (this.currentMode) this.updateModeDisplay(this.currentMode);
        }
      }

      // 2. Fetch fresh profile from network
      const profile = await window.electronAPI.getUserProfile();
      this._userProfile = profile;
      this._updateAvatarButton(profile);

      // Update UI displays to show/hide locks based on fetched plan
      if (this.currentModel) this.updateModelDisplay(this.currentModel);
      if (this.currentMode) this.updateModeDisplay(this.currentMode);
      this._refreshFreeTrialCounter();
    } catch (_) { }
  }

  _getInitials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  async fetchAndSetInterviewContext() {
    try {
      if (!window.electronAPI.fetchUserSettings || !window.electronAPI.setInterviewContext) return;
      const settings = await window.electronAPI.fetchUserSettings();
      if (settings) {
        await window.electronAPI.setInterviewContext({
          interviewTopic: settings.interviewTopic || '',
          resumeText: [settings.professionalSummary, settings.workExperience].filter(Boolean).join('\n\n'),
          jobDescription: settings.jobDescription || '',
          extraInstructions: [settings.customInstructions, settings.extraContext].filter(Boolean).join('\n'),
        });
      }
    } catch (e) {
      console.error('Failed to fetch interview context:', e);
    }
  }

  _updateAvatarButton(profile) {
    const btn = document.getElementById('profile-avatar-btn');
    const initials = document.getElementById('avatar-initials');
    if (!btn || !profile) return;
    if (initials) initials.textContent = this._getInitials(profile.name);
  }

  /**
   * Tracks which page-level overlays are open and tells main to park the
   * interview BrowserView while any of them is — the BrowserView always paints
   * above this page, so otherwise the panel is buried below the 90px top bar.
   */
  _setOverlayMask(id, isOpen) {
    if (!this._openOverlays) this._openOverlays = new Set();
    const wasMasked = this._openOverlays.size > 0;
    if (isOpen) this._openOverlays.add(id);
    else this._openOverlays.delete(id);
    const isMasked = this._openOverlays.size > 0;
    if (isMasked === wasMasked) return;
    // One overlay handing off to another (pill → pill, or panel → menu) closes
    // and reopens inside a single task — settle on a microtask so the view
    // doesn't flash back in between.
    if (this._overlayMaskQueued) return;
    this._overlayMaskQueued = true;
    Promise.resolve().then(() => {
      this._overlayMaskQueued = false;
      const masked = this._openOverlays.size > 0;
      if (masked === this._overlayMaskSent) return;
      this._overlayMaskSent = masked;
      if (window.electronAPI?.setOverlayMask) {
        window.electronAPI.setOverlayMask(masked).catch(() => { });
      }
    });
  }

  _openProfilePanel() {
    const panel = document.getElementById('profile-panel');
    if (!panel) return;
    panel.style.display = 'block';
    this._setOverlayMask('profile-panel', true);
    this._renderProfilePanel(this._userProfile);
    this._refreshUsageHint();
    // Refresh in background
    if (this._isSignedIn && window.electronAPI.getUserProfile) {
      window.electronAPI.getUserProfile().then(p => {
        if (p) { this._userProfile = p; this._renderProfilePanel(p); this._updateAvatarButton(p); }
      }).catch(() => { });
    }
  }

  _closeProfilePanel() {
    const panel = document.getElementById('profile-panel');
    if (panel) panel.style.display = 'none';
    this._setOverlayMask('profile-panel', false);
  }

  _renderProfilePanel(profile) {
    const nameEl = document.getElementById('profile-name');
    const emailEl = document.getElementById('profile-email');
    const imgEl = document.getElementById('profile-avatar-img');
    const initLg = document.getElementById('profile-avatar-initials-large');
    const statusEl = document.getElementById('subscription-status');
    const planEl = document.getElementById('subscription-plan');
    const expiryEl = document.getElementById('subscription-expiry');

    // Signed out: swap the account details for a Sign in call to action.
    // Shortcuts stay available; Dashboard and Sign Out need an account.
    const signedOut = !this._isSignedIn;
    const panel = document.getElementById('profile-panel');
    if (panel) panel.classList.toggle('is-signed-out', signedOut);
    if (signedOut) {
      if (nameEl) nameEl.textContent = 'Not signed in';
      if (emailEl) emailEl.textContent = 'Sign in to get AI answers';
      if (imgEl) imgEl.style.display = 'none';
      if (initLg) { initLg.textContent = ''; initLg.style.display = 'block'; }
      return;
    }

    if (!profile) {
      if (nameEl) nameEl.textContent = 'Loading…';
      if (emailEl) emailEl.textContent = '';
      if (initLg) initLg.textContent = '';
      if (statusEl) statusEl.innerHTML = '<span class="sub-badge sub-badge-loading">Checking…</span>';
      return;
    }

    const initials = this._getInitials(profile.name);
    if (nameEl) nameEl.textContent = profile.name || 'Unknown';
    if (emailEl) emailEl.textContent = profile.email || '';
    if (initLg) initLg.textContent = initials;

    if (imgEl && profile.image) {
      imgEl.src = profile.image;
      imgEl.style.display = 'block';
      if (initLg) initLg.style.display = 'none';
      imgEl.onerror = () => { imgEl.style.display = 'none'; if (initLg) initLg.style.display = 'block'; };
    }

    const sub = profile.subscription;
    if (statusEl) {
      if (sub && sub.active) {
        statusEl.innerHTML = '<span class="sub-badge sub-badge-active">Active</span>';
        if (planEl) {
          // planName ("Sprint Pass (3 Days)") comes from the server; older servers sent only the raw id
          planEl.textContent = sub.planName || (sub.plan || '').replace(/_/g, ' ');
          planEl.style.display = 'block';
        }
        if (expiryEl && sub.endDate) {
          const d = new Date(sub.endDate);
          expiryEl.textContent = `Expires ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
          expiryEl.style.display = 'block';
        }
      } else {
        statusEl.innerHTML = '<span class="sub-badge sub-badge-inactive">No active plan</span>';
        if (planEl) planEl.style.display = 'none';
        if (expiryEl) expiryEl.style.display = 'none';
      }
    }
  }

  async _doLogout() {
    try {
      await window.electronAPI.logout();
    } catch (err) {
      console.error('Logout failed:', err);
    }
    // Back to a fresh-install state: explorable, no previous answers on screen.
    this._userProfile = null;
    this._usageData = null;
    this._pendingAuthAction = null;
    const imgEl = document.getElementById('profile-avatar-img');
    if (imgEl) { imgEl.src = ''; imgEl.style.display = 'none'; }
    if (this.isAudioActive) this.stopAudioCapture();
    if (this._voice) this.stopVoiceRecording(false);
    await this.checkAuthentication();
    this.handleConversationReset();
    if (this.currentModel) this.updateModelDisplay(this.currentModel);
    if (this.currentMode) this.updateModeDisplay(this.currentMode);
    this.showToast('Signed out', 'info');
  }

  // ─── Premium Login Card ───────────────────────────────────

  _renderLoginCard() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.innerHTML = `
      <div class="login-topbar">
        <button type="button" id="login-cancel-btn" class="login-back-btn" title="Continue without signing in">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back
        </button>
      </div>
      <div class="login-card">
        <div class="login-brand">
          <div class="login-logo">
            <img src="assets/logo-mark.png" alt="Solvro" draggable="false" />
          </div>
          <span class="login-wordmark">Solvro</span>
        </div>
        <h2>Welcome to Solvro</h2>
        <p>Sign in, or create a free account to get started.</p>
        <div class="login-panel">
          <div id="login-error" class="login-error" style="display:none;"></div>
          <form id="email-login-form" class="email-login-form">
            <label class="login-field">
              <span>Email</span>
              <div class="login-input-wrap">
                <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
                <input type="email" id="login-email" placeholder="you@example.com" required autocomplete="email" />
              </div>
            </label>
            <label class="login-field">
              <span>Password</span>
              <div class="login-input-wrap">
                <svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                <input type="password" id="login-password" placeholder="Enter your password" required autocomplete="current-password" />
                <button type="button" id="login-pw-toggle" class="login-pw-toggle" title="Show password" aria-label="Show password">
                  <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </label>
            <button type="submit" id="email-login-btn" class="login-btn email-login-btn">Sign In</button>
          </form>
        <div class="login-card-divider-text">
          <span>or</span>
        </div>
        <button id="login-btn" class="login-btn google-login-btn">
          <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Continue with Google
        </button>
        </div>
        <div class="login-signup-row">
          <span>New to Solvro?</span>
          <button type="button" id="login-signup-btn" class="login-signup-btn">Create a free account</button>
        </div>
        <div class="login-shortcuts">
          <div><kbd>${this._sc('toggleWindow')}</kbd><span>Hide / show</span></div>
          <div><kbd>${this._scGroup(['moveUp', 'moveDown', 'moveLeft', 'moveRight'])}</kbd><span>Move window</span></div>
        </div>
      </div>
    `;
  }

  // Fired the instant the shortcut/button is pressed, BEFORE the capture + encode
  // finishes. We optimistically flip the view to the screenshot state right away so
  // there's no perceived lag; the real data arrives a moment later via
  // handleScreenshotQueued (or is rolled back by an error/limit event).
  handleScreenshotCapturing() {
    this._showScreenshotToast('📸 Screenshot captured');
    this._capturingPending = true;
    if (this._isChatMode()) {
      // Show a pending attachment chip immediately in the chat composer.
      this.renderChatAttachments(true);
    } else if (this.currentMode && this.currentMode.mode === 'interview') {
      // Interview mode captures through its own BrowserView, so this event isn't
      // expected here — do nothing beyond the toast to stay out of its way.
      this._capturingPending = false;
    } else {
      // coding / mcq — flip from the welcome/initial page to the queue page now,
      // with a "capturing…" placeholder card at the top.
      this.showQueueStatus();
    }
  }

  // Roll back the optimistic placeholder when a capture fails or is rejected
  // (error / queue-full race) so a stale "capturing…" indicator can't linger.
  _clearCapturingPlaceholder() {
    const wasPending = this._capturingPending;
    this._capturingPending = false;
    if (!wasPending) return;
    if (this._isChatMode()) {
      this.renderChatAttachments();
    } else if (!(this.currentMode && this.currentMode.mode === 'interview')) {
      // coding / mcq — re-render the queue page without the placeholder (falls
      // back to the welcome message if the queue is now empty).
      this.showQueueStatus();
    }
  }

  handleScreenshotQueued(data) {
    // Real capture landed — clear the optimistic flag so the reconciled render is clean.
    this._capturingPending = false;
    this.screenshotQueue = data.queue;
    // null in uncapped modes (interview) and from builds of main.js that predate the cap
    this.maxScreenshots = data.maxScreenshots || null;
    const count = this.maxScreenshots ? `${data.queueSize}/${this.maxScreenshots}` : `${data.queueSize} total`;
    // Replaces the instant "captured" toast fired on keypress (same slot).
    this._showScreenshotToast(`📸 Screenshot added to queue (${count})`);

    if (this._isChatMode()) {
      this.renderChatAttachments();
    } else if (this.currentMode && this.currentMode.mode === 'interview') {
      const tray = document.getElementById('screenshot-tray');
      if (tray) {
        tray.style.display = 'flex';
        tray.innerHTML = this.screenshotQueue.map((s, i) => {
          // Use s.image from aiService
          return s.image
            ? `<img src="${this._chatImageSrc(s.image)}" alt="Screenshot ${i + 1}" title="Queued Screenshot ${i + 1}">`
            : `<div style="width:24px;height:24px;background:#333;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;">${i + 1}</div>`;
        }).join('');
      }
    } else {
      this.showQueueStatus();
    }
  }

  showTextExtraction(data) {
    this.updateStatus('Extracting text from screenshot...');
    this.analysisText.innerHTML = `
      <div class="processing">
        <div class="spinner"></div>
        <p>📝 ${data.message}</p>
        <p class="extraction-note">Using AI to extract and structure content...</p>
      </div>
    `;
    this.resizeWindowToContent();
  }

  showQueueStatus() {
    if (this.screenshotQueue.length === 0 && !this._capturingPending) {
      this.showWelcomeMessage();
      return;
    }

    // Optimistic "capturing…" card shown the instant the shortcut fires, before the
    // real screenshot lands. Cleared on screenshot-queued / error / limit.
    const pendingHtml = this._capturingPending ? `
      <div class="queue-item queue-item-pending">
        <div class="queue-item-header">📸 Screenshot ${this.screenshotQueue.length + 1} — capturing…</div>
        <div class="screenshot-preview">
          <span class="spinner"></span> Capturing current screen…
        </div>
      </div>
    ` : '';

    const queueHtml = this.screenshotQueue.map((screenshot, index) => {
      return `
        <div class="queue-item">
          <div class="queue-item-header">
            📸 Screenshot ${index + 1} 
            <span class="mode-badge">${screenshot.mode}</span>
            <span class="timestamp">(${screenshot.addedAt})</span>
          </div>
          <div class="screenshot-preview">
            <strong>Mode:</strong> ${screenshot.mode.toUpperCase()}
            <br><strong>Ready for analysis</strong>
            <br>${this._scText('em', 'Will be analyzed when you press {sendQueue}')}
          </div>
        </div>
      `;
    }).join('');

    this.analysisText.innerHTML = `
      <div class="queue-display">
        <h3>📋 Screenshot Queue (${this.screenshotQueue.length}${this.maxScreenshots ? `/${this.maxScreenshots}` : ''})</h3>
        <p class="queue-description">Screenshots ready for AI analysis</p>
        ${queueHtml}
        ${pendingHtml}
        <div class="queue-controls">
          <div class="input-section">
            <label for="additional-text">Additional context (optional):</label>
            <textarea id="additional-text" placeholder="Type here or anywhere - keys captured globally!" rows="3"></textarea>
            <p class="capture-hint">💡 Global capture active - type from anywhere, even with other windows focused!</p>
          </div>
          <div class="button-section">
            ${this._scText('button', '🧠 Analyze with AI ({sendQueue})', 'id="send-queue-btn" class="primary-btn"')}
            ${this._scText('button', '🔄 Reset ({resetConversation})', 'id="reset-conversation-btn" class="secondary-btn"')}
          </div>
        </div>
        <div class="queue-help">
          <p><strong>Simple Workflow:</strong></p>
          <ul>
            <li>Take screenshots with ${this._scText('kbd', '{screenshot}')} (added to queue)</li>
            <li>Press ${this._scText('kbd', '{sendQueue}')} to analyze all screenshots directly with AI</li>
            <li>Reset and start fresh with ${this._scText('kbd', '{resetConversation}')}</li>
          </ul>
        </div>
      </div>
    `;

    // Setup input and button references
    this.additionalTextInput = document.getElementById('additional-text');

    // Add event listeners for buttons
    document.getElementById('send-queue-btn').addEventListener('click', () => {
      this.sendQueue();
    });

    document.getElementById('reset-conversation-btn').addEventListener('click', () => {
      this.resetConversation();
    });

    // Resize window to fit content
    this.resizeWindowToContent();
  }

  showQueueProcessing(data) {
    this.updateStatus(`Analyzing ${data.queueSize} screenshots...`);

    // The card is shown optimistically the moment the send starts, and main's
    // 'queue-processing' event arrives for the same send a moment later — keep
    // the one already on screen instead of stacking a second spinner under it.
    if (this.currentProcessingId && document.getElementById(this.currentProcessingId)) return;

    // Collapse the queued-screenshots list so the analyzing card is what's actually on
    // screen — with a long queue the spinner used to be appended far below the fold and
    // nothing seemed to happen. Hidden, not removed, so #additional-text keeps its value
    // and stays the target for global key capture; restored if the send fails.
    const queueDisplay = this.analysisText.querySelector('.queue-display');
    if (queueDisplay) queueDisplay.style.display = 'none';

    const cardId = 'processing-' + Date.now();
    this.currentProcessingId = cardId;

    const processingCard = document.createElement('div');
    processingCard.className = 'processing';
    processingCard.id = cardId;
    processingCard.innerHTML = `
      <div class="spinner"></div>
      <p>🧠 Analyzing ${data.queueSize} screenshot(s) with AI...</p>
      <p style="color: var(--text-tertiary); font-size: var(--text-sm); margin-top: var(--space-3);">This may take a moment</p>
      <div style="margin-top: var(--space-5);">
        <div class="skeleton skeleton-line skeleton-line-full"></div>
        <div class="skeleton skeleton-line skeleton-line-medium"></div>
        <div class="skeleton skeleton-block"></div>
        <div class="skeleton skeleton-line skeleton-line-short"></div>
      </div>
    `;
    this.analysisText.appendChild(processingCard);
    // Bring the card into view so the user sees it immediately instead of having to
    // scroll past whatever the panel was showing before
    try {
      processingCard.scrollIntoView({ block: 'start' });
    } catch (e) {
      const host = this._scrollHost();
      if (host) host.scrollTop = host.scrollHeight;
    }
    this.resizeWindowToContent();
  }

  /** Bring the queued-screenshots list back after a failed send so the user can retry */
  _restoreQueueDisplay() {
    if (this.currentProcessingId) {
      const processingEl = document.getElementById(this.currentProcessingId);
      if (processingEl) processingEl.remove();
      this.currentProcessingId = null;
    }
    const queueDisplay = this.analysisText && this.analysisText.querySelector('.queue-display');
    if (queueDisplay) queueDisplay.style.display = '';
  }

  showQueueAnalysis(data) {
    this.conversationHistory = data.history;
    // this.screenshotQueue = []; // Do NOT clear queue display after successful analysis

    this.updateStatus(`Analysis complete (${data.analyzedScreenshots} screenshots, ${data.conversationLength} messages) - Conversation preserved`);
    this._usageData = null;
    this._refreshFreeTrialCounter();

    // Remove the processing spinner if it exists
    if (this.currentProcessingId) {
      const processingEl = document.getElementById(this.currentProcessingId);
      if (processingEl) {
        processingEl.remove();
      }
      this.currentProcessingId = null;
    }

    const historyHtml = this.conversationHistory.length > 2 ? `
      <div class="conversation-context" style="font-size: var(--text-xs); color: var(--text-tertiary); margin-bottom: 8px;">
        <em>Using context from ${Math.floor(this.conversationHistory.length / 2)} previous exchanges</em>
      </div>
    ` : '';

    // Render all modes as markdown
    const formattedResponse = this.formatAnalysis(data.response);

    const resultCard = document.createElement('div');
    resultCard.className = 'analysis-result';
    resultCard.innerHTML = `
        <h3>📊 Result</h3>
        <div class="response-actions">
          <button id="copy-response-btn" class="copy-button" title="Copy response to clipboard">
            📋 Copy Response
          </button>
        </div>
        ${historyHtml}
        <div class="analysis-content">${formattedResponse}</div>
        <div class="analysis-meta">
          <span class="meta-item">📸 ${data.analyzedScreenshots} screenshot(s) analyzed</span>
          <span class="timestamp">Analyzed at ${new Date().toLocaleTimeString()}</span>
        </div>
        <div class="continue-conversation">
          <p><strong>Continue the conversation:</strong> Take more screenshots and ask follow-up questions!</p>
        </div>
    `;
    // Streaming (handleStreamChunk) has already rendered this same answer into a live
    // card. Swap that card out for the final one instead of appending, otherwise the
    // response is shown twice, one after another.
    const streamCard = document.getElementById('stream-content')?.closest('.analysis-result');
    if (streamCard) {
      streamCard.replaceWith(resultCard);
    } else {
      this.analysisText.appendChild(resultCard);
    }
    this.cancelStreamRender();
    this.streamBuffer = '';

    // Setup copy button for the new card. The old handler called a
    // window.electronAPI.copyToClipboard that never existed — it threw and
    // nothing reached the clipboard while the button still said "Copied!".
    const copyBtn = resultCard.querySelector('.copy-button');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const ok = await this._copyTextToClipboard(this._stripEnclosingCodeFence(data.response));
        copyBtn.innerHTML = ok ? '✅ Copied!' : '❌ Copy failed';
        setTimeout(() => {
          copyBtn.innerHTML = '📋 Copy Response';
        }, 2000);
      });
    }

    // Per-code-block "Copy code" buttons (plain text — ideal for pasting a single
    // block into a terminal/editor), same as Query and Interview modes.
    this._enhanceCodeBlocks(resultCard);
    this.applySyntaxHighlighting();
    this.scrollToBottomIfEnabled();
    this.resizeWindowToContent();
  }

  handleScreenshotQueueCleared(data) {
    // A mode change (or reset) invalidates any in-flight optimistic placeholder.
    this._capturingPending = false;
    const hadScreenshots = this.screenshotQueue.length > 0;
    this.screenshotQueue = [];

    // Clear both trays: the mode may have already flipped, so the tray that was
    // showing the chips isn't necessarily the one for the current mode.
    this.renderChatAttachments();
    const tray = document.getElementById('screenshot-tray');
    if (tray) {
      tray.innerHTML = '';
      tray.style.display = 'none';
    }

    if (hadScreenshots && data && data.reason === 'mode-changed') {
      this.showToast('📸 Screenshot queue cleared for the new mode', 'info');
    }
    this.updateStatus();
  }

  handleConversationReset() {
    this.screenshotQueue = [];
    this.conversationHistory = [];
    this.chatMessages = [];
    this.showWelcomeMessage();
    this.updateStatus('Conversation reset - Starting fresh');
    // Resize window after reset
    this.resizeWindowToContent();
  }

  updateStatus(message = null) {
    if (message) {
      this.statusElement.textContent = message;
      // Reset to default after 3 seconds
      setTimeout(() => {
        this.statusElement.textContent = `Ready - Stealth Protection Active (Queue: ${this.screenshotQueue.length})`;
      }, 3000);
    } else {
      this.statusElement.textContent = `Ready - Stealth Protection Active (Queue: ${this.screenshotQueue.length})`;
    }
  }

  takeScreenshot() {
    window.electronAPI.takeScreenshot();
  }

  // ─── Live Audio Interview Implementation ───────────────────────────────────

  async toggleAudioCapture() {
    if (this.isAudioActive) {
      this.stopAudioCapture();
    } else {
      await this.startAudioCapture();
    }
  }

  toggleMicMute() {
    this.isMicMuted = !this.isMicMuted;
    // Actually mute/unmute the mic gain node
    if (this.micGainNode) {
      this.micGainNode.gain.value = this.isMicMuted ? 0 : 1;
    }
    const btn = document.getElementById('mute-mic-btn');
    if (btn) {
      if (this.isMicMuted) {
        btn.innerHTML = '<span class="icon">🔇</span> Mic Muted';
        btn.classList.add('muted');
        this.showToast('Microphone muted', 'warning');
      } else {
        btn.innerHTML = '<span class="icon">🔊</span> Mic On';
        btn.classList.remove('muted');
        this.showToast('Microphone active', 'success');
      }
    }
  }

  async startAudioCapture() {
    if (!(await this._requireSignIn('interview'))) return;
    try {
      this.updateStatus('Initializing dual-channel audio capture...');
      const btn = document.getElementById('toggle-audio-btn');

      // Get the speech-to-text session from the backend. This carries the
      // credential and the URL to open — the STT vendor, model and tuning are
      // all chosen server-side, so they can change without an app update.
      const sttSession = await window.electronAPI.getSttSession('dual');

      if (!sttSession || !sttSession.url) {
        this.showMessage('Failed to start transcription. Ensure you are signed in and try again.', 'error');
        this.stopAudioCapture();
        return;
      }

      // 1. Get Desktop Audio Source (Interviewer channel)
      const sources = await window.electronAPI.getDesktopSources();
      const screenSource = sources.find(s => s.name === 'Entire Screen' || s.name.includes('Screen 1')) || sources[0];

      if (!screenSource) {
        this.showMessage('Could not find system audio source', 'error');
        return;
      }

      // 2. Request Desktop Stream (System Audio = Interviewer)
      const desktopStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screenSource.id
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: screenSource.id,
            minWidth: 1,
            maxWidth: 1,
            minHeight: 1,
            maxHeight: 1
          }
        }
      });

      // 3. Request Mic Stream (Candidate channel)
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      // 4. Create AudioContext
      if (!this.audioContext) {
        this.audioContext = new window.AudioContext({ sampleRate: 16000 });
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // ── Helper: Convert float32 audio to PCM16 (linear16) — used as fallback ──
      const floatToPCM16 = (inputData) => {
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          let s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16;
      };

      // ── Try AudioWorklet (modern, non-blocking) with ScriptProcessor fallback ──
      let useWorklet = false;
      try {
        if (this.audioContext.audioWorklet) {
          await this.audioContext.audioWorklet.addModule('src/renderer/audio-worklet-processor.js');
          useWorklet = true;
          console.log('[Interview] AudioWorklet loaded successfully');
        }
      } catch (workletErr) {
        console.warn('[Interview] AudioWorklet not available, falling back to ScriptProcessor:', workletErr.message);
      }

      // ── Interviewer Pipeline (System Audio → Deepgram) ──
      const desktopSource = this.audioContext.createMediaStreamSource(desktopStream);
      if (useWorklet) {
        this.interviewerProcessor = new AudioWorkletNode(this.audioContext, 'pcm-processor');
        desktopSource.connect(this.interviewerProcessor);
      } else {
        this.interviewerProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
        const dummyGain1 = this.audioContext.createGain();
        dummyGain1.gain.value = 0;
        desktopSource.connect(this.interviewerProcessor);
        this.interviewerProcessor.connect(dummyGain1);
        dummyGain1.connect(this.audioContext.destination);
      }

      // ── Candidate Pipeline (Mic → GainNode → Deepgram) ──
      const micSource = this.audioContext.createMediaStreamSource(micStream);
      this.micGainNode = this.audioContext.createGain();
      this.micGainNode.gain.value = this.isMicMuted ? 0 : 1;
      if (useWorklet) {
        this.candidateProcessor = new AudioWorkletNode(this.audioContext, 'pcm-processor');
        micSource.connect(this.micGainNode);
        this.micGainNode.connect(this.candidateProcessor);
      } else {
        this.candidateProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
        const dummyGain2 = this.audioContext.createGain();
        dummyGain2.gain.value = 0;
        micSource.connect(this.micGainNode);
        this.micGainNode.connect(this.candidateProcessor);
        this.candidateProcessor.connect(dummyGain2);
        dummyGain2.connect(this.audioContext.destination);
      }

      // ── STT URL, built by the backend for the 'dual' profile (no diarize —
      // we handle speaker separation via dual channels) ──
      const dgUrl = sttSession.url;
      const dgProtocols = sttSession.protocols;

      // ═══════════════════════════════════════════════════════════════════
      // CHANNEL 1: Interviewer (System Audio → Deepgram)
      // ═══════════════════════════════════════════════════════════════════
      this.deepgramSocketInterviewer = new WebSocket(dgUrl, dgProtocols);
      let interimElementInterviewer = null;

      this.deepgramSocketInterviewer.onopen = () => {
        // Wire up audio → Deepgram based on processor type
        if (useWorklet) {
          this.interviewerProcessor.port.onmessage = (e) => {
            if (this.deepgramSocketInterviewer && this.deepgramSocketInterviewer.readyState === WebSocket.OPEN) {
              this.deepgramSocketInterviewer.send(e.data);
            }
          };
        } else {
          this.interviewerProcessor.onaudioprocess = (e) => {
            if (this.deepgramSocketInterviewer && this.deepgramSocketInterviewer.readyState === WebSocket.OPEN) {
              const pcm16 = floatToPCM16(e.inputBuffer.getChannelData(0));
              this.deepgramSocketInterviewer.send(pcm16.buffer);
            }
          };
        }

        this.isAudioActive = true;
        this.updateRecordingPillState('recording');
        this.startRecordingTimer();
        if (btn) {
          btn.innerHTML = '<span class="icon">🛑</span> Stop';
          btn.classList.add('active');
        }

        // Show mini caption strip in HUD
        const miniStrip = document.getElementById('mini-caption-strip');
        if (miniStrip) miniStrip.classList.remove('hidden');
        this.updateHudStackVisibility();

        this.showToast(`Live Audio Interview Active (${useWorklet ? 'AudioWorklet' : 'Legacy'})`, 'success');
      };

      this.deepgramSocketInterviewer.onmessage = (message) => {
        const received = JSON.parse(message.data);
        const transcript = received.channel?.alternatives[0]?.transcript;
        if (transcript) {
          if (received.is_final) {
            if (interimElementInterviewer && interimElementInterviewer.parentNode) {
              interimElementInterviewer.parentNode.removeChild(interimElementInterviewer);
              interimElementInterviewer = null;
            }
            // Gibberish filter — only process valid transcripts
            if (this._isValidTranscript(transcript)) {
              this.appendTranscript(transcript, 'Interviewer');
              this.handleTranscriptUpdate(transcript, 'Interviewer');
            }
          } else {
            // Show interim results for interviewer
            this.updateMiniCaptionStrip(transcript, 'Interviewer', true);
            const panel = document.getElementById('transcript-content');
            if (panel) {
              if (!interimElementInterviewer) {
                interimElementInterviewer = document.createElement('div');
                interimElementInterviewer.className = 'transcript-line interim interviewer';
                interimElementInterviewer.style.opacity = '0.7';
                interimElementInterviewer.style.fontStyle = 'italic';
                panel.appendChild(interimElementInterviewer);
              }
              interimElementInterviewer.innerHTML = `
                <span class="transcript-speaker">Interviewer:</span>
                <span class="transcript-text">${transcript}</span>
              `;
              panel.scrollTop = panel.scrollHeight;
            }
          }
        }
      };

      this.deepgramSocketInterviewer.onerror = (error) => {
        console.error('Interviewer Deepgram WebSocket Error:', error);
        this.showToast('Interviewer transcription connection error', 'error');
        this.stopAudioCapture();
      };

      this.deepgramSocketInterviewer.onclose = (event) => {
        console.log(`Interviewer Deepgram Closed. Code: ${event.code}, Reason: ${event.reason}`);
        if (event.code !== 1000 && event.code !== 1005) {
          this.showToast(`Interviewer transcription disconnected: ${event.reason || event.code}`, 'warning');
        }
        this.stopAudioCapture();
      };

      // ═══════════════════════════════════════════════════════════════════
      // CHANNEL 2: Candidate (Mic Audio → Deepgram)
      // ═══════════════════════════════════════════════════════════════════
      this.deepgramSocketCandidate = new WebSocket(dgUrl, dgProtocols);
      let interimElementCandidate = null;

      this.deepgramSocketCandidate.onopen = () => {
        if (useWorklet) {
          this.candidateProcessor.port.onmessage = (e) => {
            if (this.deepgramSocketCandidate && this.deepgramSocketCandidate.readyState === WebSocket.OPEN) {
              if (this.isMicMuted) return;
              this.deepgramSocketCandidate.send(e.data);
            }
          };
        } else {
          this.candidateProcessor.onaudioprocess = (e) => {
            if (this.deepgramSocketCandidate && this.deepgramSocketCandidate.readyState === WebSocket.OPEN) {
              // Don't send audio when mic is muted (saves bandwidth/credits)
              if (this.isMicMuted) return;
              const pcm16 = floatToPCM16(e.inputBuffer.getChannelData(0));
              this.deepgramSocketCandidate.send(pcm16.buffer);
            }
          };
        }
        console.log('[Interview] Candidate audio channel connected');
      };

      this.deepgramSocketCandidate.onmessage = (message) => {
        const received = JSON.parse(message.data);
        const transcript = received.channel?.alternatives[0]?.transcript;
        if (transcript) {
          if (received.is_final) {
            if (interimElementCandidate && interimElementCandidate.parentNode) {
              interimElementCandidate.parentNode.removeChild(interimElementCandidate);
              interimElementCandidate = null;
            }
            if (this._isValidTranscript(transcript)) {
              this.appendTranscript(transcript, 'Me');
              this.handleTranscriptUpdate(transcript, 'Me');
            }
          } else {
            // Show interim results for candidate
            this.updateMiniCaptionStrip(transcript, 'Me', true);
            const panel = document.getElementById('transcript-content');
            if (panel) {
              if (!interimElementCandidate) {
                interimElementCandidate = document.createElement('div');
                interimElementCandidate.className = 'transcript-line interim me';
                interimElementCandidate.style.opacity = '0.7';
                interimElementCandidate.style.fontStyle = 'italic';
                panel.appendChild(interimElementCandidate);
              }
              interimElementCandidate.innerHTML = `
                <span class="transcript-speaker">Me:</span>
                <span class="transcript-text">${transcript}</span>
              `;
              panel.scrollTop = panel.scrollHeight;
            }
          }
        }
      };

      this.deepgramSocketCandidate.onerror = (error) => {
        console.error('Candidate Deepgram WebSocket Error:', error);
        // Non-fatal: interviewer channel still works
        this.showToast('Candidate mic transcription error (interviewer channel still active)', 'warning');
      };

      this.deepgramSocketCandidate.onclose = (event) => {
        console.log(`Candidate Deepgram Closed. Code: ${event.code}`);
        // Non-fatal: don't call stopAudioCapture — interviewer channel may still be live
      };

      // Keep legacy reference pointing to interviewer socket
      this.deepgramSocket = this.deepgramSocketInterviewer;

    } catch (err) {
      console.error('Failed to start audio capture:', err);
      this.showMessage('Failed to capture audio: ' + err.message, 'error');
    }
  }

  stopAudioCapture() {
    // Guard against double-invocation (onerror + onclose both call this)
    if (!this.isAudioActive) return;
    this.isAudioActive = false;

    // Update recording pill
    this.updateRecordingPillState('disconnecting');
    this.stopRecordingTimer();
    setTimeout(() => this.updateRecordingPillState(null), 600);

    const btn = document.getElementById('toggle-audio-btn');
    if (btn) {
      btn.innerHTML = '<span class="icon">🎙️</span> Start';
      btn.classList.remove('active');
    }

    // Hide mini caption strip
    const miniStrip = document.getElementById('mini-caption-strip');
    if (miniStrip) miniStrip.classList.add('hidden');
    this.updateHudStackVisibility();

    // Disconnect audio processors
    if (this.interviewerProcessor) {
      this.interviewerProcessor.disconnect();
      this.interviewerProcessor.onaudioprocess = null;
      this.interviewerProcessor = null;
    }
    if (this.candidateProcessor) {
      this.candidateProcessor.disconnect();
      this.candidateProcessor.onaudioprocess = null;
      this.candidateProcessor = null;
    }

    // Close both Deepgram WebSocket connections
    if (this.deepgramSocketInterviewer && this.deepgramSocketInterviewer.readyState === WebSocket.OPEN) {
      this.deepgramSocketInterviewer.close();
    }
    if (this.deepgramSocketCandidate && this.deepgramSocketCandidate.readyState === WebSocket.OPEN) {
      this.deepgramSocketCandidate.close();
    }
    this.deepgramSocketInterviewer = null;
    this.deepgramSocketCandidate = null;
    this.deepgramSocket = null;

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.micGainNode = null;

    // Clear detection timers
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout);
      this.pauseTimeout = null;
    }
    if (this._candidateSilenceTimeout) {
      clearTimeout(this._candidateSilenceTimeout);
      this._candidateSilenceTimeout = null;
    }
    this.candidateSpeaking = false;

    this.showToast('Live Interview Stopped', 'info');
  }

  appendTranscript(text, speaker) {
    // Add to TranscriptManager (structured turn-based storage)
    this.transcriptManager.addTurn(speaker, text);

    // Also update legacy transcriptBuffer for backward compatibility
    if (!this.transcriptBuffer) this.transcriptBuffer = '';
    this.transcriptBuffer += ` [${speaker}]: ${text}\n`;

    // Keep legacy buffer to last ~1000 words
    const words = this.transcriptBuffer.split(' ');
    if (words.length > 1000) {
      this.transcriptBuffer = words.slice(-1000).join(' ');
    }

    // Update mini caption strip (new HUD)
    this.updateMiniCaptionStrip(text, speaker, false);

    // Also update legacy transcript panel UI
    const panel = document.getElementById('transcript-content');
    if (!panel) return;

    const line = document.createElement('div');
    line.className = `transcript-line ${speaker === 'Interviewer' ? 'interviewer' : 'me'}`;
    line.innerHTML = `
      <span class="transcript-speaker">${speaker === 'Interviewer' ? 'Interviewer:' : 'Me:'}</span>
      <span class="transcript-text">${text}</span>
    `;

    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
  }

  handleTranscriptUpdate(text, speaker) {
    if (speaker === 'Interviewer') {
      // ── Interviewer is speaking — start/reset silence timer ──
      if (this.pauseTimeout) {
        clearTimeout(this.pauseTimeout);
      }

      // After 2.5 seconds of interviewer silence, check for question
      this.pauseTimeout = setTimeout(() => {
        // Don't auto-trigger if candidate is currently speaking (they're answering)
        if (this.candidateSpeaking) {
          console.log('[Interview] Skipping auto-trigger: candidate is speaking');
          return;
        }

        // Check if the recent interviewer text contains a question
        const recentInterviewerText = this.transcriptManager.getLastInterviewerText();
        if (recentInterviewerText && this._containsQuestion(recentInterviewerText)) {
          console.log('[Interview] Question detected, triggering answer:', recentInterviewerText.substring(0, 80) + '...');
          this.triggerLiveAnswer();
        } else {
          console.log('[Interview] No question detected in interviewer text, skipping auto-trigger');
        }
      }, 2500);

    } else if (speaker === 'Me') {
      // ── Candidate is speaking — suppress auto-trigger ──
      this.candidateSpeaking = true;

      if (this._candidateSilenceTimeout) {
        clearTimeout(this._candidateSilenceTimeout);
      }

      // After 4 seconds of candidate silence, mark as done speaking
      this._candidateSilenceTimeout = setTimeout(() => {
        this.candidateSpeaking = false;
      }, 4000);
    }
  }

  async triggerLiveAnswer(typedQuestion = null) {
    // Auth gate
    if (!(await this._requireSignIn('answer', () => this.triggerLiveAnswer(typedQuestion)))) {
      return;
    }

    if (this._isGenerating) return;
    this._isGenerating = true;

    const forceBtn = document.getElementById('force-answer-btn');
    if (forceBtn) {
      forceBtn.disabled = true;
      forceBtn.innerHTML = '<span class="icon">⏳</span> Thinking...';
    }

    try {
      const cardId = 'hint-' + Date.now();
      const lastQuestion = this._getLastQuestion();
      const textForBubble = typedQuestion || lastQuestion || 'Listening...';

      // Build full transcript context for the LLM (structured with speaker labels)
      const fullTranscript = this.transcriptManager.getFullTranscript();

      // PREVENT OLD QUESTION BUG: Instruct the LLM to only focus on the END of the transcript
      const contextInstruction = "\n\n[SYSTEM INSTRUCTION]: Read the transcript above. Focus ONLY on the most recent unresolved question or statement at the very end. Do NOT answer old questions.";
      const textToSend = typedQuestion || (fullTranscript + contextInstruction) || lastQuestion || 'Listening...';

      // Show user question bubble (just the question, not the full transcript)
      if (!typedQuestion) {
        this._showInterviewUserBubble(textForBubble);
      }

      // Create AI response container (clean, no card)
      const aiResponse = document.createElement('div');
      aiResponse.className = 'interview-ai-response fade-in-container';
      aiResponse.innerHTML = `
        <div class="analysis-content" id="${cardId}">
           <div class="generating-indicator">
             <span class="gen-spinner"></span> Generating Answer
           </div>
        </div>
      `;
      this.analysisText.appendChild(aiResponse);
      this.scrollToBottomIfEnabled();
      this.resizeWindowToContent();

      // Send recent structured transcript context to LLM
      const result = await window.electronAPI.sendQueue('TRANSCRIPT_TRIGGER: ' + textToSend);

      // Clear the screenshot tray since they were just sent
      const tray = document.getElementById('screenshot-tray');
      if (tray) {
        tray.innerHTML = '';
        tray.style.display = 'none';
      }

      if (result && result.success) {
        const hintElement = document.getElementById(cardId);
        if (!hintElement) {
          this._isGenerating = false;
          return;
        }

        let textToStream = result.analysis;

        // Handle [IGNORE] token — chitchat/backchannel
        if (textToStream.trim() === '[IGNORE]' || textToStream.includes('[IGNORE]')) {
          console.log('[Interview] AI returned [IGNORE] for chitchat/small talk');
          aiResponse.style.display = 'none';
          this._isGenerating = false;
          if (forceBtn) {
            forceBtn.disabled = false;
            forceBtn.innerHTML = '<span class="icon">⚡</span> Answer';
          }
          return;
        }

        // The final answer lands here; drop any streaming frame still queued so
        // it can't repaint the partial buffer over the finished card.
        this.cancelStreamRender();
        this.streamBuffer = '';
        hintElement.innerHTML = '';

        // ── Parse structured JSON cards from Live Coach ──
        const cards = this._parseInterviewCards(textToStream);

        if (cards && cards.success) {
          // ── Populate the HUD panels (co-founder's 2-column UI) ──
          this.populateHudFromCards(cards);

          // Also render inline card for scroll history
          hintElement.innerHTML = this._renderInterviewCard(cards);
          // Animate card entry
          const cardEl = hintElement.querySelector('.live-coach-card');
          if (cardEl) {
            cardEl.style.opacity = '0';
            cardEl.style.transform = 'translateY(12px)';
            requestAnimationFrame(() => {
              cardEl.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
              cardEl.style.opacity = '1';
              cardEl.style.transform = 'translateY(0)';
            });
          }
        } else {
          // Fallback: render raw text with markdown formatting
          textToStream = textToStream.replace(/```[a-zA-Z]*\n/g, '').replace(/```/g, '');
          hintElement.innerHTML = this.formatAnalysis(textToStream);
        }

        this._enhanceCodeBlocks(hintElement);
        this.applySyntaxHighlighting();
        this._addCollapseToggle(aiResponse, hintElement);
        this.scrollToBottomIfEnabled();
        this.resizeWindowToContent();

        // Release lock
        this._isGenerating = false;
        if (forceBtn) {
          forceBtn.disabled = false;
          forceBtn.innerHTML = '<span class="icon">⚡</span> Answer';
        }

      } else {
        const errorMsg = result ? result.error : 'Unknown error';
        if (errorMsg && (errorMsg.includes('402') || errorMsg.includes('403') || errorMsg.includes('Payment Required'))) {
          let customMsg = null;
          try {
            const match = errorMsg.match(/\{.*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              customMsg = parsed.error;
            }
          } catch (e) { }
          this.showSubscriptionError(customMsg);
        } else {
          this.showToast(`Hint generation failed`, 'error');
        }

        // Release lock on error
        this._isGenerating = false;
        if (forceBtn) {
          forceBtn.disabled = false;
          forceBtn.innerHTML = '<span class="icon">⚡</span> Answer';
        }
      }
    } catch (error) {
      console.error('Error generating live hint:', error);
      // Release lock on exception
      this._isGenerating = false;
      if (forceBtn) {
        forceBtn.disabled = false;
        forceBtn.innerHTML = '<span class="icon">⚡</span> Answer';
      }
    }
  }

  async sendQueue() {
    // Query mode is a chat: each send is one message with its own attachments
    if (this._isChatMode()) {
      // Mid-recording, the send shortcut stops and transcribes into the composer
      if (this._voice) return this.stopVoiceRecording(true);
      return this.sendChatMessage();
    }

    // One request per Ctrl+Enter: ignore repeats (key auto-repeat, double taps) while one is in flight
    if (this._queueBusy) return;
    this._queueBusy = true;
    try {
      await this._sendQueueOnce();
    } finally {
      this._queueBusy = false;
    }
  }

  async _sendQueueOnce() {
    // No interview-context fetch here: that context (resume, job description)
    // only feeds query and interview prompts, and neither mode sends through
    // this path — it was a blocking network round trip on every Ctrl+Enter.

    const isQueryMode = this.currentMode && this.currentMode.mode === 'query';
    const additionalTextEarly = this.additionalTextInput ? this.additionalTextInput.value.trim() : '';
    if (this.screenshotQueue.length === 0 && !isQueryMode) {
      this.showMessage('No screenshots in queue', 'error');
      return;
    }
    if (isQueryMode && this.screenshotQueue.length === 0 && !additionalTextEarly) {
      this.showMessage('Type a custom instruction or add a screenshot', 'error');
      return;
    }

    // Feedback first, before anything is awaited, so the keypress never looks ignored
    this.showQueueProcessing({ queueSize: this.screenshotQueue.length });

    // Auth gate — must be logged in to get AI responses. The queue is left
    // untouched, so signing in re-runs this send with the same screenshots.
    if (!(await this._requireSignIn('answer', () => this.sendQueue()))) {
      this._restoreQueueDisplay();
      return;
    }

    // Disable the send button to prevent double-clicking
    const sendBtn = document.getElementById('send-queue-btn');
    if (sendBtn) {
      sendBtn.disabled = true;
      this._setPlainText(sendBtn, '🔄 Processing...');
    }

    this.cancelStreamRender();
    this.streamBuffer = ''; // Reset stream buffer

    if (!navigator.onLine) {
      this._restoreQueueDisplay();
      this.offlineQueue.push({
        queue: [...this.screenshotQueue],
        text: this.additionalTextInput ? this.additionalTextInput.value.trim() : ''
      });
      this.updateStatus('Queued (Offline)');
      this.showToast('Request queued for when you are back online.', 'info');

      if (sendBtn) {
        sendBtn.disabled = false;
        this._setPlainText(sendBtn, 'Queued (Offline)');
      }
      return;
    }

    try {
      const additionalText = this.additionalTextInput ? this.additionalTextInput.value.trim() : '';

      // Call the main process sendQueue which handles the new workflow
      const result = await window.electronAPI.sendQueue(additionalText);

      // Only errors are handled here. On success the result card is rendered by the
      // 'queue-analysis' IPC event (showQueueAnalysis), which also carries the
      // conversation history and screenshot count — rendering it again here would
      // show the same answer twice. The queue is deliberately not cleared locally.
      if (!result || !result.success) {
        const errorMsg = result ? result.error : 'Unknown error';
        // A structured rejection (quota spent, plan too low) gets its own card.
        if (result && result.details && this.showErrorForCode(result.details, errorMsg)) {
          // The card owns the panel; the queue stays put so a retry is one keypress away.
        } else if (errorMsg && (errorMsg.includes('Payment Required') || errorMsg.includes('Active subscription needed'))) {
          this.showSubscriptionError();
        } else {
          this.showMessage(`Analysis failed: ${errorMsg}`, 'error');
          // Nothing was rendered — put the queue list back so the user can retry
          this._restoreQueueDisplay();
        }
      }

    } catch (error) {
      console.error('Error sending queue:', error);
      if (error.message && (error.message.includes('Payment Required') || error.message.includes('Active subscription needed'))) {
        this.showSubscriptionError();
      } else {
        this.showMessage(`Failed to process queue: ${error.message}`, 'error');
        this._restoreQueueDisplay();
      }
    } finally {
      // Re-enable the send button
      if (sendBtn) {
        sendBtn.disabled = false;
        this._setScText(sendBtn, (this.currentMode && this.currentMode.mode === 'query') ? '🧠 Analyze ({sendQueue})' : '🔍 Extract & Analyze ({sendQueue})');
      }
    }
  }

  async resetConversation() {
    try {
      const result = await window.electronAPI.resetConversation();
      if (result.success) {
        this.screenshotQueue = [];
        this.conversationHistory = [];
        this.chatMessages = [];
        this.transcriptBuffer = '';
        this.transcriptManager.reset();
        this.candidateSpeaking = false;

        // Clear detection timers
        if (this.pauseTimeout) {
          clearTimeout(this.pauseTimeout);
          this.pauseTimeout = null;
        }
        if (this._candidateSilenceTimeout) {
          clearTimeout(this._candidateSilenceTimeout);
          this._candidateSilenceTimeout = null;
        }

        const transcriptPanel = document.getElementById('live-transcript-panel');
        if (transcriptPanel) transcriptPanel.style.display = 'none';
        const transcriptContent = document.getElementById('transcript-content');
        if (transcriptContent) transcriptContent.innerHTML = '';

        if (this.additionalTextInput) this.additionalTextInput.value = '';
        const interviewChatInput = document.getElementById('interview-chat-input');
        if (interviewChatInput) interviewChatInput.value = '';

        this.showWelcomeMessage();
        this.updateStatus('Conversation reset - Starting fresh');
      }
    } catch (error) {
      console.error('Error resetting conversation:', error);
      this.showError('Failed to reset conversation');
    }
  }

  // ── Premium Interview Chat Helpers ──

  // ═══════════════════════════════════════════════════════════════════════════
  // Live Coach HUD Functions (from co-founder's mainAppRenderer.js)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Show/hide the HUD stack based on whether mini-caption or coach panel is visible */
  updateHudStackVisibility() {
    const hudStack = document.getElementById('hud-stack');
    if (!hudStack) return;

    const miniStrip = document.getElementById('mini-caption-strip');
    const coachPanel = document.getElementById('live-coach-panel');

    const miniStripVisible = !!miniStrip && !miniStrip.classList.contains('hidden');
    const coachVisible = !!coachPanel && !coachPanel.classList.contains('hidden');
    const willBeVisible = miniStripVisible || coachVisible;

    if (willBeVisible) {
      hudStack.classList.remove('hidden');
      requestAnimationFrame(() => {
        hudStack.classList.add('is-visible');
      });
    } else {
      hudStack.classList.remove('is-visible');
      setTimeout(() => {
        const stillMini = !!miniStrip && !miniStrip.classList.contains('hidden');
        const stillCoach = !!coachPanel && !coachPanel.classList.contains('hidden');
        if (!stillMini && !stillCoach) {
          hudStack.classList.add('hidden');
        }
      }, 260);
    }

    hudStack.classList.toggle('has-mini-strip', !!miniStripVisible);
    hudStack.classList.toggle('coach-ready', this._coachHasShownReady);
  }

  /** Toggle the live coach panel visibility */
  setLiveCoachPanelVisible(isVisible) {
    const panel = document.getElementById('live-coach-panel');
    if (!panel) return;
    panel.classList.toggle('hidden', !isVisible);
    if (isVisible) panel.classList.remove('hidden');
    this.updateHudStackVisibility();
  }

  /** Update the question text in the coach panel */
  setLiveCoachQuestionText(text) {
    const el = document.getElementById('live-coach-question-text');
    if (!el) return;
    el.textContent = text;
    el.dataset.fullText = text;
  }

  /** Update the "They asked:" label */
  setLiveCoachQuestionLabelText(text) {
    const labelEl = document.querySelector('.live-coach-question-label span');
    if (labelEl) labelEl.textContent = text;
  }

  /** Show the SAY/ASK first sentence prompt with mode coloring */
  showLiveCoachFirstSentence(text, mode) {
    const el = document.getElementById('live-coach-first-sentence');
    if (!el) return;
    const safeText = typeof text === 'string' ? text.trim() : '';
    const safeMode = ['ask', 'ask_them'].includes(mode) ? mode : (safeText.endsWith('?') ? 'ask' : '');

    if (!safeText) {
      this.hideLiveCoachFirstSentence();
      return;
    }

    el.textContent = safeText;
    el.dataset.fullText = safeText;
    el.classList.remove('hidden', 'deemphasized', 'fallback');
    el.dataset.mode = safeMode || '';
    el.dataset.prefix = safeMode === 'ask_them' ? 'ASK THEM' : safeMode === 'ask' ? 'ASK' : 'SAY';

    const panel = document.getElementById('live-coach-panel');
    if (panel) panel.classList.toggle('has-action-line', true);
  }

  /** Hide the first sentence prompt */
  hideLiveCoachFirstSentence() {
    const el = document.getElementById('live-coach-first-sentence');
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('deemphasized', 'fallback');
    delete el.dataset.mode;
    delete el.dataset.prefix;
    delete el.dataset.fullText;
    const panel = document.getElementById('live-coach-panel');
    if (panel) panel.classList.remove('has-action-line');
  }

  /** Show empty/waiting state in the HUD */
  renderLiveCoachEmptyState(label = 'Waiting for question...') {
    this.setLiveCoachQuestionLabelText('They asked:');
    this.setLiveCoachQuestionText(label);
    this.hideLiveCoachFirstSentence();

    const planEl = document.getElementById('live-coach-plan-list');
    const dontMissEl = document.getElementById('live-coach-dontmiss-list');
    if (planEl) { planEl.innerHTML = ''; const li = document.createElement('li'); li.textContent = label; planEl.appendChild(li); }
    if (dontMissEl) { dontMissEl.innerHTML = ''; const li = document.createElement('li'); li.textContent = label; dontMissEl.appendChild(li); }
  }

  /** Reset the entire Live Coach UI to initial state */
  resetLiveCoachUI() {
    this.setLiveCoachQuestionLabelText('They asked:');
    this.setLiveCoachQuestionText('Waiting for question...');
    this.hideLiveCoachFirstSentence();
    this.renderLiveCoachEmptyState();
    this._coachHasShownReady = false;
  }

  /** Update the mini caption strip with latest transcript lines */
  updateMiniCaptionStrip(text, speaker, isPartial = false) {
    const strip = document.getElementById('mini-caption-strip');
    const linesContainer = document.getElementById('mini-caption-lines');
    if (!strip || !linesContainer) return;

    // Show the strip
    strip.classList.remove('hidden');

    if (isPartial) {
      // Update or create a partial line
      let partial = linesContainer.querySelector('.mini-caption-line.partial');
      if (!partial) {
        partial = document.createElement('div');
        partial.className = 'mini-caption-line partial';
        linesContainer.appendChild(partial);
      }
      partial.innerHTML = `
        <span class="speaker ${speaker === 'Me' ? 'user' : 'interviewer'}">${speaker === 'Me' ? 'You' : 'Them'}:</span>
        <span class="text">${this._escapeHtml(text)}</span>
      `;
    } else {
      // Remove any partial line first
      const partial = linesContainer.querySelector('.mini-caption-line.partial');
      if (partial) partial.remove();

      // Add a final line
      const line = document.createElement('div');
      line.className = 'mini-caption-line';
      line.innerHTML = `
        <span class="speaker ${speaker === 'Me' ? 'user' : 'interviewer'}">${speaker === 'Me' ? 'You' : 'Them'}:</span>
        <span class="text">${this._escapeHtml(text)}</span>
      `;
      linesContainer.appendChild(line);

      // Keep only last 3 lines
      while (linesContainer.children.length > 3) {
        linesContainer.removeChild(linesContainer.firstChild);
      }
    }

    this.updateHudStackVisibility();
  }

  /** Update recording pill visual state */
  updateRecordingPillState(state) {
    const pill = document.getElementById('recording-pill');
    if (!pill) return;
    pill.classList.remove('recording', 'initializing', 'disconnecting', 'paused');
    if (state) pill.classList.add(state);
  }

  /** Start the recording timer display */
  startRecordingTimer() {
    this._recordingStartTime = Date.now();
    const timerEl = document.getElementById('coach-audio-timer');
    if (this._recordingTimerInterval) clearInterval(this._recordingTimerInterval);
    this._recordingTimerInterval = setInterval(() => {
      if (!timerEl || !this._recordingStartTime) return;
      const elapsed = Math.floor((Date.now() - this._recordingStartTime) / 1000);
      const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const sec = String(elapsed % 60).padStart(2, '0');
      timerEl.textContent = `${min}:${sec}`;
    }, 1000);

    // Start simple waveform animation
    this.startCoachAudioWave();
  }

  /** Stop the recording timer */
  stopRecordingTimer() {
    if (this._recordingTimerInterval) {
      clearInterval(this._recordingTimerInterval);
      this._recordingTimerInterval = null;
    }
    this._recordingStartTime = null;
    const timerEl = document.getElementById('coach-audio-timer');
    if (timerEl) timerEl.textContent = '00:00';
    this.stopCoachAudioWave();
  }

  /** Simple animated waveform on the coach canvas */
  startCoachAudioWave() {
    const canvas = document.getElementById('coach-audio-wave');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const barCount = 20;
    const barWidth = 3;
    const gap = (w - barCount * barWidth) / (barCount - 1);

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < barCount; i++) {
        const x = i * (barWidth + gap);
        const amplitude = 3 + Math.random() * (h * 0.6);
        const y = (h - amplitude) / 2;
        ctx.fillStyle = `rgba(247, 134, 0, ${0.5 + Math.random() * 0.4})`;
        ctx.fillRect(x, y, barWidth, amplitude);
      }
      this._audioWaveRAF = requestAnimationFrame(draw);
    };
    draw();
  }

  /** Stop the waveform animation */
  stopCoachAudioWave() {
    if (this._audioWaveRAF) {
      cancelAnimationFrame(this._audioWaveRAF);
      this._audioWaveRAF = null;
    }
    const canvas = document.getElementById('coach-audio-wave');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /** Populate the HUD panels from parsed interview cards data */
  populateHudFromCards(cards) {
    if (!cards || !cards.success) return;

    // Set question
    if (cards.question) {
      this.setLiveCoachQuestionLabelText('They asked:');
      this.setLiveCoachQuestionText(cards.question);
    }

    // Set first sentence
    if (cards.firstSentence) {
      const mode = cards.firstSentence.endsWith('?') ? 'ask' : '';
      this.showLiveCoachFirstSentence(cards.firstSentence, mode);
    }

    // Set talking points (plan)
    const planEl = document.getElementById('live-coach-plan-list');
    if (planEl && cards.outline && cards.outline.length > 0) {
      planEl.innerHTML = '';
      cards.outline.forEach(point => {
        const li = document.createElement('li');
        li.textContent = point;
        planEl.appendChild(li);
      });
    }

    // Set avoid (don't miss)
    const dontMissEl = document.getElementById('live-coach-dontmiss-list');
    if (dontMissEl && cards.dontMiss && cards.dontMiss.length > 0) {
      dontMissEl.innerHTML = '';
      cards.dontMiss.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item;
        dontMissEl.appendChild(li);
      });
    }

    // Show the coach panel and mark as ready
    this._coachHasShownReady = true;
    this.setLiveCoachPanelVisible(true);

    // Add emphasis glow briefly
    const panel = document.getElementById('live-coach-panel');
    if (panel) {
      panel.classList.add('emphasis');
      setTimeout(() => panel.classList.remove('emphasis'), 3000);
    }
  }

  /** Wire up the recording pill click handlers */
  setupRecordingPill() {
    const pill = document.getElementById('recording-pill');
    if (!pill) return;

    // Main pill click → toggle audio
    pill.addEventListener('click', (e) => {
      // Don't toggle if clicking pause/stop icons
      if (e.target.closest('.pause-icon') || e.target.closest('.stop-icon')) return;
      if (pill.classList.contains('recording') || pill.classList.contains('initializing') || pill.classList.contains('disconnecting')) return;
      this.toggleAudioCapture();
    });

    // Stop icon click
    const stopIcon = pill.querySelector('.stop-icon');
    if (stopIcon) {
      stopIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        this.stopAudioCapture();
      });
    }

    // Pause icon click (toggle mute)
    const pauseIcon = pill.querySelector('.pause-icon');
    if (pauseIcon) {
      pauseIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMicMute();
        pill.classList.toggle('paused', this.isMicMuted);
      });
    }

    // Mini caption hide button
    const hideBtn = document.getElementById('mini-caption-hide-btn');
    if (hideBtn) {
      hideBtn.addEventListener('click', () => {
        const strip = document.getElementById('mini-caption-strip');
        if (strip) strip.classList.add('hidden');
        this.updateHudStackVisibility();
      });
    }
  }

  /** Show a right-aligned user question bubble in the analysis area */
  _showInterviewUserBubble(text) {
    if (!this.analysisText) return;
    const bubble = document.createElement('div');
    bubble.className = 'interview-user-bubble';
    bubble.textContent = text;
    this.analysisText.appendChild(bubble);
    this.scrollToBottomIfEnabled();
    this.resizeWindowToContent();
  }

  /** Parse structured JSON interview cards from the AI response text */
  _parseInterviewCards(rawText) {
    try {
      // Try to find and parse a JSON object from the response
      // The AI may wrap it in markdown code fences or add extra text
      let jsonStr = rawText.trim();

      // Strip markdown code fences if present
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

      // Try direct parse first
      let parsed = null;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        // Try to extract JSON object from text using regex
        const match = jsonStr.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]);
          } catch (e2) {
            // Try to fix common JSON issues (trailing commas, single quotes)
            let fixed = match[0]
              .replace(/,\s*([}\]])/g, '$1')  // trailing commas
              .replace(/'/g, '"');              // single quotes
            try {
              parsed = JSON.parse(fixed);
            } catch (e3) {
              console.warn('[Interview] Could not parse JSON from response');
            }
          }
        }
      }

      if (parsed && typeof parsed === 'object') {
        const firstSentence = (parsed.firstSentence || parsed.first_sentence || '').trim();

        // Extract outline/talking points
        let outline = parsed.outline || parsed.plan || parsed.steps || parsed.skeleton || [];
        if (typeof outline === 'string') outline = outline.split('\n').filter(Boolean);
        if (!Array.isArray(outline)) outline = [];
        outline = outline
          .map(item => String(item || '').replace(/^[-•*]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
          .filter(item => item.length > 2)
          .slice(0, 4);

        // Extract dontMiss warnings
        let dontMiss = parsed.dontMiss || parsed.dont_miss || [];
        if (typeof dontMiss === 'string') dontMiss = dontMiss.split('\n').filter(Boolean);
        if (!Array.isArray(dontMiss)) dontMiss = [];
        dontMiss = dontMiss
          .map(item => String(item || '').replace(/^[-•*]\s*/, '').trim())
          .filter(item => item.length > 2)
          .slice(0, 2);

        const questionType = (parsed.questionType || parsed.question_type || 'other').toLowerCase();
        const question = (parsed.question || parsed.canonicalQuestion || '').trim();
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

        // Require at least outline to be present for a valid card
        if (outline.length > 0) {
          return {
            success: true,
            firstSentence,
            outline,
            dontMiss,
            questionType,
            question,
            confidence
          };
        }
      }
    } catch (e) {
      console.warn('[Interview] Card parsing error:', e.message);
    }

    return { success: false };
  }

  /** Render a premium structured interview card from parsed cards data */
  _renderInterviewCard(cards) {
    const typeIcons = {
      behavioral: '🗣️',
      coding: '💻',
      system_design: '🏗️',
      other: '💡'
    };
    const typeLabels = {
      behavioral: 'Behavioral',
      coding: 'Coding',
      system_design: 'System Design',
      other: 'General'
    };

    const icon = typeIcons[cards.questionType] || '💡';
    const label = typeLabels[cards.questionType] || 'General';

    let html = `<div class="live-coach-card">`;

    // Question type badge + detected question
    html += `<div class="lc-header">`;
    html += `<span class="lc-type-badge lc-type-${cards.questionType}">${icon} ${label}</span>`;
    if (cards.question) {
      html += `<span class="lc-question-summary">${this._escapeHtml(cards.question)}</span>`;
    }
    html += `</div>`;

    // First sentence — the opening line to say
    if (cards.firstSentence) {
      html += `<div class="lc-first-sentence">`;
      html += `<div class="lc-section-label">💬 Say First</div>`;
      html += `<div class="lc-first-sentence-text">"${this._escapeHtml(cards.firstSentence)}"</div>`;
      html += `</div>`;
    }

    // Talking points / outline
    if (cards.outline && cards.outline.length > 0) {
      html += `<div class="lc-outline">`;
      html += `<div class="lc-section-label">📋 Talking Points</div>`;
      html += `<ul class="lc-outline-list">`;
      cards.outline.forEach((point, i) => {
        html += `<li class="lc-outline-item" style="animation-delay: ${i * 0.08}s">${this._escapeHtml(point)}</li>`;
      });
      html += `</ul>`;
      html += `</div>`;
    }

    // Don't miss warnings
    if (cards.dontMiss && cards.dontMiss.length > 0) {
      html += `<div class="lc-dont-miss">`;
      html += `<div class="lc-section-label">⚠️ Don't Miss</div>`;
      html += `<ul class="lc-dont-miss-list">`;
      cards.dontMiss.forEach(item => {
        html += `<li class="lc-dont-miss-item">${this._escapeHtml(item)}</li>`;
      });
      html += `</ul>`;
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  /** Escape HTML entities */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /** Extract the most recent interviewer question from the transcript */
  _getLastQuestion() {
    // Use TranscriptManager for structured lookup
    const lastInterviewerText = this.transcriptManager.getLastInterviewerText();
    if (lastInterviewerText) {
      return lastInterviewerText.length > 200 ? lastInterviewerText.slice(-200) : lastInterviewerText;
    }

    // Fallback: use legacy buffer
    if (!this.transcriptBuffer || !this.transcriptBuffer.trim()) return null;
    const raw = this.transcriptBuffer.trim();
    if (raw.length > 100) return raw.slice(-100);
    return raw;
  }

  // ─── Interview Intelligence: Gibberish Filter & Question Detection ────────

  /** Filter out gibberish, noise, and low-quality transcript chunks */
  _isValidTranscript(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length < 3) return false;

    const words = trimmed.split(/\s+/);
    if (words.length < 2) return false;

    // Filter out pure filler/noise words
    const FILLER = new Set([
      'uh', 'um', 'hmm', 'ah', 'oh', 'er', 'mhm', 'huh', 'ugh',
      'mm', 'uhm', 'ehm', 'em', 'hm'
    ]);
    const meaningful = words.filter(w => !FILLER.has(w.toLowerCase()));
    if (meaningful.length < 1) return false;

    // Check for gibberish — words should contain at least one vowel
    // (random noise transcriptions often produce consonant-only syllables)
    const vowelPattern = /[aeiouy]/i;
    const recognizable = words.filter(w => w.length >= 2 && vowelPattern.test(w));
    return recognizable.length / words.length > 0.3;
  }

  /** Detect if text contains a question or request that warrants an AI response */
  _containsQuestion(text) {
    if (!text || text.trim().length < 8) return false;

    const lower = text.toLowerCase().trim();

    // Direct question mark — strongest signal
    if (lower.includes('?')) return true;

    // WH-question words and interrogative patterns
    const questionPatterns = [
      // Direct question starters
      /\b(what|how|why|when|where|which|who|whom|whose)\s/i,
      // Yes/no question starters
      /\b(can you|could you|would you|will you|do you|have you|are you|is there|did you|does it|is it|was it|were you)\b/i,
      // Request/imperative patterns (interviewers phrase questions as commands)
      /\b(tell me|explain|describe|walk me|walk us|give me|show me|talk about|elaborate on|go through|go over)\b/i,
      // Technical interview triggers
      /\b(implement|design|build|create|write|code|solve|optimize|refactor|debug)\b/i,
      // Behavioral interview triggers
      /\b(tell me about a time|give me an example|describe a situation|how did you handle|what would you do)\b/i,
      // Conceptual question patterns
      /\b(what is|what are|what does|what do|how does|how do|how would|how can|how is)\b/i,
      /\b(difference between|compare|contrast|trade.?off|pros and cons|advantages)\b/i,
      // Follow-up patterns
      /\b(can you elaborate|can you explain|what about|and then|follow.?up|any questions)\b/i,
    ];

    return questionPatterns.some(pattern => pattern.test(lower));
  }

  /** Add language labels and "Copy code" buttons to code blocks (InterviewMan style) */
  _enhanceCodeBlocks(container) {
    if (!container) return;
    const pres = container.querySelectorAll('pre');
    pres.forEach(pre => {
      // Skip if already enhanced
      if (pre.querySelector('.code-block-header')) return;

      const code = pre.querySelector('code');
      if (!code) return;

      // Detect language from class (e.g. "language-python" → "python")
      let lang = 'code';
      const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
      if (langClass) lang = langClass.replace('language-', '');

      // Create header
      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.innerHTML = `
        <span>${lang}</span>
        <button class="copy-code-btn" title="Copy code">📋 Copy code</button>
      `;

      // Copy handler
      header.querySelector('.copy-code-btn').addEventListener('click', function () {
        const text = code.textContent;
        navigator.clipboard.writeText(text).then(() => {
          this.textContent = '✓ Copied';
          this.classList.add('copied');
          setTimeout(() => {
            this.textContent = '📋 Copy code';
            this.classList.remove('copied');
          }, 2000);
        });
      });

      pre.insertBefore(header, pre.firstChild);
    });
  }

  /** Add collapse/expand toggle if the response exceeds a certain height */
  _addCollapseToggle(aiResponseDiv, contentElement) {
    if (!aiResponseDiv || !contentElement) return;

    // Wait a frame for the DOM to render and measure height
    requestAnimationFrame(() => {
      const height = contentElement.scrollHeight;
      if (height > 350) {
        aiResponseDiv.classList.add('collapsed');

        const toggle = document.createElement('div');
        toggle.className = 'response-expand-toggle';
        toggle.innerHTML = '<button title="Expand response">∨</button>';

        toggle.querySelector('button').addEventListener('click', () => {
          const isCollapsed = aiResponseDiv.classList.toggle('collapsed');
          toggle.querySelector('button').textContent = isCollapsed ? '∨' : '∧';
          toggle.querySelector('button').title = isCollapsed ? 'Expand response' : 'Collapse response';
          this.resizeWindowToContent();
        });

        aiResponseDiv.appendChild(toggle);
      }
    });
  }

  async toggleStealth() {
    try {
      const result = await window.electronAPI.toggleStealth();
      if (result) {
        this.statusElement.textContent = 'Enhanced Stealth Activated';
        this.stealthButton.textContent = '🔒 Stealth ON';
        this.stealthButton.style.background = '#ff6b6b';
      }
    } catch (error) {
      console.error('Error toggling stealth:', error);
      this.statusElement.textContent = 'Stealth toggle failed';
    }
  }

  showWelcomeMessage() {
    const modeId = this.currentMode ? this.currentMode.mode : 'coding';
    const modelId = this.currentModel ? (this.currentModel.id || this.currentModel.name.toLowerCase().replace(/ /g, '-')) : 'gemini-3.7-flash';

    if (!this._isFeatureAllowed(modeId)) {
      this.showSubscriptionError({ kind: 'mode', id: modeId, name: this.currentMode?.name });
      return;
    }

    if (!this._isModelLockedMode(modeId) && !this._isFeatureAllowed(modelId)) {
      this.showSubscriptionError({ kind: 'model', id: modelId, name: this.currentModel?.name });
      return;
    }

    this.updateStatus();
    const mode = this.currentMode ? this.currentMode.mode : 'coding';

    // Leaving chat mode removes the composer; drop any recording in progress.
    // (Re-rendering the chat itself keeps it — renderChatView restores the UI.)
    if (this._voice && mode !== 'query') this.stopVoiceRecording(false);

    if (this.analysisContainer) {
      this.analysisContainer.classList.toggle('chat-mode', mode === 'query');
    }
    // Chat mode locks the shell to the viewport so only the thread scrolls
    document.body.classList.toggle('query-chat-mode', mode === 'query');
    if (mode === 'query') {
      this.renderChatView();
      return;
    }

    let contentHtml = '';

    if (mode === 'interview') {
      // Interview mode is handled by the companion BrowserView — show loading message only
      contentHtml = `
        <div class="welcome">
          <h2>🎙️ Loading Interview Mode...</h2>
          <p class="tagline">The interview assistant is starting up. Please wait.</p>
        </div>
      `;
    } else if (mode === 'mcq') {
      contentHtml = `
        <div class="welcome welcome-coding">
          <div class="welcome-hero">
            <div class="welcome-hero-icon">
              <svg viewBox="0 0 48 48" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <g stroke="currentColor">
                  <rect x="20.5" y="2.5" width="5" height="3" rx="1"/>
                  <path d="M23 5.5V8"/>
                  <path d="M16 9l-2-2"/>
                  <path d="M30 9l2-2"/>
                  <circle cx="23" cy="16" r="8.5"/>
                  <path d="M23 16V11"/>
                  <path d="M23 16l3.5 2.5"/>
                  <rect x="8" y="22" width="32" height="16" rx="2"/>
                  <path d="M4 42h40l-3-4H7z"/>
                  <path d="M19 28.5h9"/>
                  <path d="M19 33.2h9"/>
                  <path d="M37 24l3 3-7.5 7.5-3.5.5.5-3.5z"/>
                  <path d="M34.5 26.5l3 3"/>
                </g>
                <path d="M12.5 28l1.3 1.3L16.3 27" stroke="#10b981"/>
                <path d="M12.5 33l1.3 1.3L16.3 31.7" stroke="#10b981"/>
              </svg>
            </div>
            <h2>MCQ Mode</h2>
            <p class="tagline">Screenshot one or more multiple-choice questions and get the correct answer for each — with a one-line reason — instantly. Great for online assessments, quizzes, PDFs and docs.</p>
          </div>

          <div class="quick-start">
            <h3>⚡ How it works</h3>
            <ol class="steps">
              <li><span class="step-key"><kbd>${this._sc('screenshot')}</kbd></span><span>Capture the question and all of its options. Take several shots (or scroll and re-capture) to queue a whole page of questions at once.</span></li>
              <li><span class="step-key"><kbd>${this._sc('sendQueue')}</kbd></span><span>Get the answer to every captured question, in order, each with a short rationale.</span></li>
            </ol>
          </div>

          <div class="tip-callout info">
            <h3>💡 Tips for accurate answers</h3>
            <p>Make sure every option is fully visible in the screenshot — if any are cut off, re-capture. Questions spread across several screenshots are all answered together.</p>
            <p>Starting a new set? Press <kbd>${this._sc('resetConversation')}</kbd> to clear the queue first.</p>
          </div>

          <div class="keyboard-shortcuts">
            <h3>⌨️ Shortcuts</h3>
            <div class="shortcuts-grid">

              <span class="shortcuts-section-label">Core</span>

              <kbd class="shortcut-row-key">${this._sc('screenshot')}</kbd>
              <span class="shortcut-row-desc">Capture a question → add to queue</span>

              <kbd class="shortcut-row-key">${this._sc('sendQueue')}</kbd>
              <span class="shortcut-row-desc">Answer all queued questions</span>

              <kbd class="shortcut-row-key">${this._sc('resetConversation')}</kbd>
              <span class="shortcut-row-desc">Reset &amp; clear the queue</span>

              <span class="shortcuts-section-label">Stealth &amp; window</span>

              <kbd class="shortcut-row-key">${this._sc('toggleWindow')}</kbd>
              <span class="shortcut-row-desc">Hide / show the window instantly</span>

              <kbd class="shortcut-row-key">${this._sc('transparencyIncrease')} / ${this._sc('transparencyDecrease')}</kbd>
              <span class="shortcut-row-desc">Nudge transparency up / down</span>

              <kbd class="shortcut-row-key">${this._scGroup(['moveUp', 'moveDown', 'moveLeft', 'moveRight'])}</kbd>
              <span class="shortcut-row-desc">Move the window</span>

              <kbd class="shortcut-row-key">${this._sc('scrollUp')} / ${this._sc('scrollDown')}</kbd>
              <span class="shortcut-row-desc">Scroll the answers up / down</span>

              <span class="shortcuts-section-label">Settings</span>

              <kbd class="shortcut-row-key">${this._sc('modeSwitch')}</kbd>
              <span class="shortcut-row-desc">Switch mode (Coding → MCQ → Interview → Query)</span>

              <kbd class="shortcut-row-key">${this._sc('toggleTheme')}</kbd>
              <span class="shortcut-row-desc">Toggle dark / light theme</span>

            </div>
          </div>

          <div class="welcome-footer">
            <p class="welcome-footer-muted">MCQ mode always uses the fast model automatically. Want different keys, or to check your model usage? Open the profile menu (top-right) → <strong>Shortcuts</strong> to rebind any of these, or <strong>Usage</strong> to see your AI model usage.</p>
          </div>

          <div class="stealth-info">
            <p><strong>🔒 Stealth Active</strong> — Invisible to screen-share &amp; recording software.</p>
          </div>
        </div>
      `;
    } else {
      contentHtml = `
        <div class="welcome welcome-coding">
          <div class="welcome-hero">
            <div class="welcome-hero-icon">
              <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="5" y="7" width="38" height="27" rx="3"/>
                <path d="M18 17 12 24 18 31"/>
                <path d="M30 17 36 24 30 31"/>
                <path d="M26.5 15 21.5 33"/>
                <path d="M24 34v5"/>
                <path d="M16 42h16"/>
              </svg>
            </div>
            <h2>Coding Mode</h2>
            <p class="tagline">Screenshot a coding problem and get a complete, ready-to-run solution in your chosen language — then auto-type it into your editor or copy it in one click.</p>
          </div>

          <div class="quick-start">
            <h3>⚡ How it works</h3>
            <ol class="steps">
              <li><span class="step-key"><kbd>${this._sc('screenshot')}</kbd></span><span>Capture the problem. Take more shots for multi-part or scrolled questions — they're queued together.</span></li>
              <li><span class="step-key"><kbd>${this._sc('sendQueue')}</kbd></span><span>Generate the solution in the selected language.</span></li>
              <li><span class="step-key"><kbd>${this._sc('startAutotyping')}</kbd></span><span>Auto-type it into your editor, or hit <strong>Copy Response</strong> to paste it anywhere.</span></li>
            </ol>
          </div>

          <div class="tip-callout">
            <h3>💡 Refining an answer vs. asking something new</h3>
            <p><strong>Same question, better answer:</strong> if the code is wrong or incomplete, screenshot the problem (or its failing output) again and regenerate — the conversation keeps context and improves the <em>same</em> solution.</p>
            <p><strong>A different question:</strong> press <kbd>${this._sc('resetConversation')}</kbd> first. Without a reset, the AI may answer your new problem in the context of the old one.</p>
          </div>

          <div class="tip-callout info">
            <h3>⌛ Auto-typing: give it a moment</h3>
            <p>After you press <kbd>${this._sc('startAutotyping')}</kbd> (or <kbd>${this._sc('resumeAutotyping')}</kbd> to resume), typing may take a few seconds — up to around <strong>15 seconds</strong> on a slower machine — before it begins. Be patient and <strong>don't click anywhere else while it's starting</strong>, or the code will be typed into the wrong place and the sequence gets disrupted.</p>
            <p>Once typing has started you can pause it with <kbd>${this._sc('stopAutotyping')}</kbd> and continue from where it stopped with <kbd>${this._sc('resumeAutotyping')}</kbd>.</p>
          </div>

          <div class="keyboard-shortcuts">
            <h3>⌨️ Shortcuts</h3>
            <div class="shortcuts-grid">

              <span class="shortcuts-section-label">Core</span>

              <kbd class="shortcut-row-key">${this._sc('screenshot')}</kbd>
              <span class="shortcut-row-desc">Take screenshot → add to queue</span>

              <kbd class="shortcut-row-key">${this._sc('sendQueue')}</kbd>
              <span class="shortcut-row-desc">Generate solution from the queue</span>

              <kbd class="shortcut-row-key">${this._sc('resetConversation')}</kbd>
              <span class="shortcut-row-desc">Reset conversation &amp; clear the queue</span>

              <span class="shortcuts-section-label">Auto-type</span>

              <kbd class="shortcut-row-key">${this._sc('startAutotyping')}</kbd>
              <span class="shortcut-row-desc">Auto-type from the beginning</span>

              <kbd class="shortcut-row-key">${this._sc('resumeAutotyping')}</kbd>
              <span class="shortcut-row-desc">Resume auto-type from where it paused</span>

              <kbd class="shortcut-row-key">${this._sc('stopAutotyping')}</kbd>
              <span class="shortcut-row-desc">Pause auto-typing (resumable)</span>

              <span class="shortcuts-section-label">Stealth &amp; window</span>

              <kbd class="shortcut-row-key">${this._sc('toggleWindow')}</kbd>
              <span class="shortcut-row-desc">Hide / show the window instantly</span>

              <kbd class="shortcut-row-key">${this._sc('transparencyIncrease')} / ${this._sc('transparencyDecrease')}</kbd>
              <span class="shortcut-row-desc">Nudge transparency up / down</span>

              <kbd class="shortcut-row-key">${this._scGroup(['moveUp', 'moveDown', 'moveLeft', 'moveRight'])}</kbd>
              <span class="shortcut-row-desc">Move the window</span>

              <kbd class="shortcut-row-key">${this._sc('scrollUp')} / ${this._sc('scrollDown')}</kbd>
              <span class="shortcut-row-desc">Scroll the answer up / down</span>

              <span class="shortcuts-section-label">Settings</span>

              <kbd class="shortcut-row-key">${this._sc('languageSwitch')}</kbd>
              <span class="shortcut-row-desc">Cycle the solution language</span>

              <kbd class="shortcut-row-key">${this._sc('modelSwitch')}</kbd>
              <span class="shortcut-row-desc">Cycle the AI model</span>

              <kbd class="shortcut-row-key">${this._sc('modeSwitch')}</kbd>
              <span class="shortcut-row-desc">Switch mode (Coding → MCQ → Interview → Query)</span>

              <kbd class="shortcut-row-key">${this._sc('toggleTheme')}</kbd>
              <span class="shortcut-row-desc">Toggle dark / light theme</span>

            </div>
          </div>

          <div class="welcome-footer">
            <p>Pick the solution language from the top bar or with <kbd>${this._sc('languageSwitch')}</kbd>.</p>
            <p class="welcome-footer-muted">Want different keys, or to check your model usage? Open the profile menu (top-right) → <strong>Shortcuts</strong> to rebind any of these, or <strong>Usage</strong> to see your AI model usage.</p>
          </div>

          <div class="stealth-info">
            <p><strong>🔒 Stealth Active</strong> — Invisible to screen-share &amp; recording software.</p>
          </div>
        </div>
      `;
    }

    this.analysisText.innerHTML = contentHtml;

    this.resizeWindowToContent();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Query Mode Chat (ChatGPT-style thread + composer with screenshot attachments)
  // ═══════════════════════════════════════════════════════════════════════════

  _isChatMode() {
    return !!(this.currentMode && this.currentMode.mode === 'query');
  }

  /** Normalize a queued screenshot's image into something an <img> can display */
  _chatImageSrc(image) {
    if (!image) return '';
    return image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
  }

  renderChatView() {
    const sendKey = this._sc('sendQueue');
    const shotKey = this._sc('screenshot');
    const resetKey = this._sc('resetConversation');

    // Keep an unsent draft across re-renders (e.g. switching modes and back)
    const prevInput = this.additionalTextInput;
    const draft = prevInput && prevInput.classList.contains('chat-input') ? prevInput.value : '';

    this.analysisText.innerHTML = `
      <div class="chat-view">
        <div class="chat-header">
          <span class="chat-title">❓ Chat</span>
          <button id="chat-new-btn" class="chat-new-btn" title="New chat (${resetKey})">＋ New chat</button>
        </div>
        <div id="chat-thread" class="chat-thread"></div>
        <div class="chat-composer">
          <div id="chat-attachments" class="chat-attachments"></div>
          <div class="chat-input-row">
            <textarea id="additional-text" class="chat-input" rows="1" placeholder="Message… (typing anywhere is captured)"></textarea>
            <button id="chat-mic-btn" class="chat-mic-btn" title="Voice input">
              <span class="chat-mic-icon">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>
                <span class="chat-mic-spinner" aria-hidden="true"></span>
              </span>
              <span class="chat-mic-time"></span>
            </button>
            <button id="send-queue-btn" class="chat-send-btn" title="Send (Enter / ${sendKey})">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
            </button>
          </div>
          <div class="chat-hint">
            <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> new line · <kbd>${sendKey}</kbd> send from anywhere · <kbd>${shotKey}</kbd> attach · <kbd>${this._sc('startInterview')}</kbd> voice · <kbd>${resetKey}</kbd> new chat
          </div>
        </div>
      </div>
    `;

    this.additionalTextInput = document.getElementById('additional-text');
    this.additionalTextInput.value = draft;

    this.additionalTextInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Keep document-level shortcuts (e.g. space preventDefault) out of the composer
      if (e.key === 'Escape' && this._voice) {
        e.preventDefault();
        this.stopVoiceRecording(false);
        return;
      }
      // Ctrl+Enter is handled by the global shortcut; plain Enter sends, Shift+Enter inserts a newline
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        this.sendChatMessage();
      }
    });
    this.additionalTextInput.addEventListener('input', () => this._autoGrowChatInput());

    document.getElementById('send-queue-btn').addEventListener('click', () => this.sendChatMessage());
    document.getElementById('chat-mic-btn').addEventListener('click', () => this.toggleVoiceRecording());
    document.getElementById('chat-new-btn').addEventListener('click', () => this.resetConversation());

    const thread = document.getElementById('chat-thread');
    // The thread is the only scroller in chat mode — track auto-scroll from it
    thread.addEventListener('scroll', () => {
      this.autoScrollEnabled = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 50;
    });

    if (this.chatMessages.length === 0) {
      thread.innerHTML = `
        <div class="chat-empty">
          <div class="chat-empty-mascot"><img src="assets/copilot.webp" alt="" draggable="false"></div>
          <h2>What can I help with?</h2>
          <p class="chat-empty-sub">Ask anything and get a direct answer — then keep asking follow-ups in the same chat and it remembers the context. Type it, speak it, or attach what's on your screen. Great for quick explanations, debugging help, rewrites, or anything that isn't a single coding/MCQ screenshot.</p>
          <div class="chat-empty-cards">
            <div class="chat-empty-card"><kbd>${shotKey}</kbd><span>Attach a screenshot as context</span></div>
            <div class="chat-empty-card"><kbd>${this._sc('startInterview')}</kbd><span>Speak your question (voice → text)</span></div>
            <div class="chat-empty-card"><kbd>${this._sc('startAutotyping')}</kbd><span>Auto-type any answer into another app</span></div>
            <div class="chat-empty-card"><kbd>${resetKey}</kbd><span>Start a fresh conversation</span></div>
          </div>
          <p class="chat-empty-foot">Rebind any key from the profile menu (top-right) → <strong>Shortcuts</strong>.</p>
        </div>
      `;
    } else {
      this.chatMessages.forEach(msg => thread.appendChild(this._createChatMessageEl(msg)));
      this.applySyntaxHighlighting();
    }

    this.renderChatAttachments();
    this._autoGrowChatInput();
    this._updateChatSendState();
    this._setMicRecordingUI(!!this._voice);
    this.autoScrollEnabled = true;
    this.scrollToBottomIfEnabled();
    this.resizeWindowToContent();
  }

  _createChatMessageEl(msg) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-msg-${msg.role}`;

    if (msg.role === 'user') {
      const imgs = (msg.images || [])
        .map((src, i) => `<img class="chat-msg-image" src="${src}" alt="Attached screenshot ${i + 1}">`)
        .join('');
      el.innerHTML = `
        ${imgs ? `<div class="chat-msg-images">${imgs}</div>` : ''}
        ${msg.text ? `<div class="chat-bubble chat-bubble-user">${this._escapeHtml(msg.text)}</div>` : ''}
      `;
      el.querySelectorAll('.chat-msg-image').forEach(img => {
        img.addEventListener('click', () => this.openImagePreview(img.src));
      });
    } else {
      el.innerHTML = `
        <div class="chat-avatar"><img src="assets/copilot.webp" alt="" class="chat-avatar-img" draggable="false"></div>
        <div class="chat-msg-body">
          <div class="chat-bubble chat-bubble-assistant analysis-content"></div>
          <div class="chat-msg-actions">
            <button class="chat-action-btn" title="Copy response">📋 Copy</button>
            <span class="chat-msg-time"></span>
          </div>
        </div>
      `;
      el.querySelector('.chat-action-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        navigator.clipboard.writeText(msg.text || '').then(() => {
          btn.textContent = '✅ Copied';
          setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
        }).catch(() => this.copyResponseToClipboard(msg.text || ''));
      });
      this._fillAssistantEl(el, msg);
    }
    return el;
  }

  /** Render an assistant message's current state (typing / error / final markdown) into its element */
  _fillAssistantEl(el, msg) {
    const bubble = el.querySelector('.chat-bubble');
    const actions = el.querySelector('.chat-msg-actions');
    const avatar = el.querySelector('.chat-avatar');

    bubble.classList.toggle('is-typing', !!msg.pending);
    bubble.classList.toggle('chat-bubble-error', !!msg.error);
    // The mascot avatar breathes (dims and lights up) while the AI is thinking.
    if (avatar) avatar.classList.toggle('is-thinking', !!msg.pending);

    if (msg.pending) {
      bubble.innerHTML = '<span class="chat-typing"><span></span><span></span><span></span></span>';
      actions.style.display = 'none';
      return;
    }
    if (msg.error) {
      bubble.textContent = `⚠️ ${msg.error}`;
      actions.style.display = 'none';
      return;
    }

    bubble.innerHTML = this.formatAnalysis(msg.text);
    this._enhanceCodeBlocks(bubble);
    actions.style.display = '';
    el.querySelector('.chat-msg-time').textContent = msg.time || '';
  }

  _appendChatMessage(msg) {
    this.chatMessages.push(msg);
    const thread = document.getElementById('chat-thread');
    if (!thread) return null;
    const empty = thread.querySelector('.chat-empty');
    if (empty) empty.remove();
    const el = this._createChatMessageEl(msg);
    thread.appendChild(el);
    this.autoScrollEnabled = true;
    this.scrollToBottomIfEnabled();
    return el;
  }

  renderChatAttachments(pending = false) {
    const tray = document.getElementById('chat-attachments');
    if (!tray) return;

    // Optimistic pending chip (shown the instant the shortcut fires, before the
    // real screenshot lands). It has no data-id so the listener loop skips it.
    const pendingChip = pending
      ? `<div class="chat-attachment chat-attachment-pending" title="Capturing…"><span class="spinner"></span></div>`
      : '';

    tray.innerHTML = this.screenshotQueue.map((s, i) => `
      <div class="chat-attachment" data-id="${s.id}">
        <img src="${this._chatImageSrc(s.image)}" alt="Screenshot ${i + 1}" title="Click to preview">
        <button class="chat-attachment-remove" title="Remove">✕</button>
      </div>
    `).join('') + pendingChip + (this.maxScreenshots && this.screenshotQueue.length > 0
      ? `<span class="chat-attachment-count" title="Screenshots attached (max ${this.maxScreenshots})">${this.screenshotQueue.length}/${this.maxScreenshots}</span>`
      : '');
    tray.classList.toggle('has-items', this.screenshotQueue.length > 0 || pending);

    tray.querySelectorAll('.chat-attachment').forEach(chip => {
      const img = chip.querySelector('img');
      const removeBtn = chip.querySelector('.chat-attachment-remove');
      // The pending placeholder has neither — skip it so we don't bind to null.
      if (!img || !removeBtn) return;
      const id = Number(chip.dataset.id);
      img.addEventListener('click', (e) => this.openImagePreview(e.currentTarget.src));
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeChatAttachment(id);
      });
    });

    this._updateChatSendState();
  }

  async removeChatAttachment(id) {
    try {
      this.screenshotQueue = await window.electronAPI.removeFromQueue(id);
    } catch (error) {
      console.error('Error removing attachment:', error);
      this.screenshotQueue = this.screenshotQueue.filter(s => s.id !== id);
    }
    this.renderChatAttachments();
    this.updateStatus();
  }

  openImagePreview(src) {
    const overlay = document.createElement('div');
    overlay.className = 'chat-image-preview';
    overlay.innerHTML = `
      <img src="${src}" alt="Screenshot preview">
      <button class="chat-image-preview-close" title="Close (Esc)">✕</button>
    `;
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
  }

  _autoGrowChatInput() {
    const input = this.additionalTextInput;
    if (!input || !input.classList.contains('chat-input')) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    input.scrollTop = input.scrollHeight;
    this._updateChatSendState();
  }

  _updateChatSendState() {
    const sendBtn = document.getElementById('send-queue-btn');
    if (!sendBtn || !sendBtn.classList.contains('chat-send-btn')) return;
    const hasContent = !!(this.additionalTextInput && this.additionalTextInput.value.trim()) || this.screenshotQueue.length > 0;
    sendBtn.disabled = this._chatBusy || !hasContent;
    sendBtn.classList.toggle('is-busy', this._chatBusy);
    const micBtn = document.getElementById('chat-mic-btn');
    if (micBtn) micBtn.disabled = !!this._transcribing;
  }

  // ─── Query-mode voice input (dictation) ────────────────────
  // Records the mic as 16 kHz mono PCM (same worklet the interview path uses),
  // sends it as a WAV clip to /api/ai/transcribe (Gemini Flash, free — not
  // counted as a response) and drops the text into the composer so the user can
  // edit it before sending, like ChatGPT's dictation.

  async toggleVoiceRecording() {
    if (this._voice) return this.stopVoiceRecording(true);
    if (this._voiceStarting || this._transcribing) return;
    // Transcription goes through the server, so check before opening the mic
    // rather than after the user has already spoken.
    if (!(await this._requireSignIn('dictation'))) return;
    this._voiceStarting = true;
    let stream = null;
    let ctx = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      ctx = new window.AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      await ctx.audioWorklet.addModule('src/renderer/audio-worklet-processor.js');
      const node = new AudioWorkletNode(ctx, 'pcm-processor');
      const chunks = [];
      node.port.onmessage = (e) => chunks.push(new Int16Array(e.data));
      ctx.createMediaStreamSource(stream).connect(node);

      const startedAt = Date.now();
      const timer = setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        const label = document.querySelector('#chat-mic-btn .chat-mic-time');
        if (label) label.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        if (secs >= VOICE_MAX_SECONDS) this.stopVoiceRecording(true);
      }, 250);

      this._voice = { stream, ctx, node, chunks, startedAt, timer };
      this._setMicRecordingUI(true);
    } catch (err) {
      console.error('Voice recording failed to start:', err);
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (ctx) ctx.close().catch(() => {});
      this.showToast(`Microphone unavailable: ${err.message}`, 'error');
    } finally {
      this._voiceStarting = false;
    }
  }

  async stopVoiceRecording(transcribe) {
    const v = this._voice;
    if (!v) return;
    this._voice = null;
    clearInterval(v.timer);
    v.node.port.onmessage = null;
    v.node.disconnect();
    v.stream.getTracks().forEach(t => t.stop());
    v.ctx.close().catch(() => {});
    this._setMicRecordingUI(false);
    if (!transcribe) return;

    const total = v.chunks.reduce((n, c) => n + c.length, 0);
    if (total < VOICE_SAMPLE_RATE * 0.5) {
      this.showToast('Recording too short — hold on a little longer', 'warning');
      return;
    }

    this._transcribing = true;
    this._setMicRecordingUI(false);
    try {
      const data = await this._blobToBase64(this._encodeWav(v.chunks, total, VOICE_SAMPLE_RATE));
      const result = await window.electronAPI.transcribeAudio({ data, mimeType: 'audio/wav' });
      if (!result || !result.success) {
        this.showToast(result && result.error ? result.error : 'Could not transcribe audio', 'error');
        return;
      }
      const text = (result.text || '').trim();
      if (!text) {
        this.showToast("Didn't catch that — try again", 'warning');
        return;
      }
      this._insertDictation(text);
    } catch (err) {
      console.error('Transcription failed:', err);
      this.showToast(`Could not transcribe audio: ${err.message}`, 'error');
    } finally {
      this._transcribing = false;
      this._setMicRecordingUI(false);
    }
  }

  /** Append dictated text to the composer draft and leave it there to edit/send */
  _insertDictation(text) {
    const input = this.additionalTextInput;
    if (!input || !input.isConnected || !input.classList.contains('chat-input')) {
      this.showToast('Switch back to Query mode to use the transcription', 'warning');
      return;
    }
    const existing = input.value;
    input.value = existing && !/\s$/.test(existing) ? `${existing} ${text}` : existing + text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    this._autoGrowChatInput();
  }

  _setMicRecordingUI(recording) {
    const btn = document.getElementById('chat-mic-btn');
    if (btn) {
      const transcribing = !recording && !!this._transcribing;
      btn.classList.toggle('is-recording', recording);
      btn.classList.toggle('is-transcribing', transcribing);
      const shortcut = this._sc('startInterview');
      btn.title = recording
        ? `Recording — click or ${shortcut} to stop, Esc to cancel`
        : transcribing
          ? 'Transcribing…'
          : `Voice input (${shortcut}) — click to record, click again to stop`;
      const label = btn.querySelector('.chat-mic-time');
      if (label) label.textContent = recording ? '0:00' : transcribing ? 'Transcribing' : '';
    }
    this._updateChatSendState();
  }

  _encodeWav(chunks, sampleCount, sampleRate) {
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + sampleCount * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, sampleCount * 2, true);
    const pcm = new Int16Array(buffer, 44, sampleCount);
    let offset = 0;
    for (const c of chunks) { pcm.set(c, offset); offset += c.length; }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async sendChatMessage() {
    if (this._chatBusy) return;

    const text = this.additionalTextInput ? this.additionalTextInput.value.trim() : '';
    const images = this.screenshotQueue.map(s => this._chatImageSrc(s.image));
    if (!text && images.length === 0) {
      this.showMessage('Type a message or attach a screenshot', 'error');
      return;
    }

    // Auth gate — must be logged in to get AI responses. Runs before the
    // composer is cleared, so the message is still there to send after sign-in.
    if (!(await this._requireSignIn('answer', () => this.sendChatMessage()))) {
      return;
    }

    if (!navigator.onLine) {
      this.showToast('You are offline — message not sent.', 'error');
      return;
    }

    this._chatBusy = true;

    // Optimistically show the user's message and clear the composer, like ChatGPT
    const userMsg = { role: 'user', text, images };
    this._appendChatMessage(userMsg);
    this.additionalTextInput.value = '';
    const sentQueue = this.screenshotQueue;
    this.screenshotQueue = [];
    this.renderChatAttachments();
    this._autoGrowChatInput();

    const assistantMsg = { role: 'assistant', text: '', pending: true };
    const assistantEl = this._appendChatMessage(assistantMsg);
    this._chatStreamEl = assistantEl ? assistantEl.querySelector('.chat-bubble') : null;
    this.cancelStreamRender();
    this.streamBuffer = '';
    this.updateStatus('Thinking...');

    try {
      const result = await window.electronAPI.sendQueue(text);

      if (result && result.success) {
        assistantMsg.pending = false;
        assistantMsg.text = result.analysis;
        assistantMsg.time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (!result.queueCleared) this.screenshotQueue = sentQueue; // Main kept them; stay in sync
        this.updateStatus('Response received');
      } else {
        const failure = new Error(result ? result.error : 'Unknown error');
        // Keep the backend's structured reason alive across the throw.
        failure.details = result ? result.details : null;
        throw failure;
      }
    } catch (error) {
      console.error('Error sending chat message:', error);
      const errorMsg = error.message || 'Unknown error';

      // The failed pair stays visible for now but isn't kept in the thread;
      // the text and screenshots go back into the composer so the user can retry
      this.chatMessages = this.chatMessages.filter(m => m !== userMsg && m !== assistantMsg);
      if (this.additionalTextInput && !this.additionalTextInput.value) this.additionalTextInput.value = text;
      this.screenshotQueue = sentQueue;
      assistantMsg.pending = false;
      assistantMsg.error = `Failed to get a response: ${errorMsg}`;

      if (error.details && this.showErrorForCode(error.details, errorMsg)) {
        // Handled by a dedicated card.
      } else if (errorMsg.includes('Payment Required') || errorMsg.includes('Active subscription needed')) {
        this.showSubscriptionError();
      }
    } finally {
      this._chatBusy = false;
      this.cancelStreamRender();
      this._chatStreamEl = null;
      this.streamBuffer = '';
      if (assistantEl && assistantEl.isConnected) {
        this._fillAssistantEl(assistantEl, assistantMsg);
        this.applySyntaxHighlighting();
      }
      this.renderChatAttachments();
      this._autoGrowChatInput();
      this.scrollToBottomIfEnabled();
    }
  }

  showProcessing() {
    this.statusElement.textContent = 'Processing...';
    this.analysisText.innerHTML = `
      <div class="processing">
        <div class="spinner"></div>
        <p>Analyzing with AI...</p>
        <div style="margin-top: var(--space-5);">
          <div class="skeleton skeleton-line skeleton-line-full"></div>
          <div class="skeleton skeleton-line skeleton-line-medium"></div>
          <div class="skeleton skeleton-block"></div>
          <div class="skeleton skeleton-line skeleton-line-short"></div>
        </div>
      </div>
    `;
    this.resizeWindowToContent();
  }

  showAnalysis(analysis) {
    this.statusElement.textContent = 'Analysis Complete';
    const formattedContent = this.formatAnalysis(analysis);

    this.analysisText.innerHTML = `
      <div class="analysis-result">
        <h3>📊 Result</h3>
        <div class="response-actions">
          <button id="copy-response-btn" class="copy-button" title="Copy response to clipboard">
            📋 Copy Response
          </button>
        </div>
        <div class="analysis-content">${formattedContent}</div>
        <div class="timestamp">Analyzed at ${new Date().toLocaleTimeString()}</div>
      </div>
    `;

    // Apply syntax highlighting to all code blocks
    this.applySyntaxHighlighting();

    // Set up copy button event listener
    setTimeout(() => {
      const copyBtn = document.getElementById('copy-response-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          this.copyResponseToClipboard(analysis);
        });
      }
    }, 100);

    // Resize window to fit content
    this.resizeWindowToContent();
  }

  // ─── Streaming render throttle ─────────────────────────────
  //
  // Every chunk used to re-run formatAnalysis() over the WHOLE buffer and
  // replace innerHTML — a full markdown parse plus a highlight.js pass plus a
  // full DOM teardown/rebuild, per chunk. The provider sends chunks far faster
  // than a frame, and the cost of each render grows with the answer, so the work
  // is quadratic in the response length: by a few thousand tokens the renderer
  // is saturated, the window stops repainting, and Windows marks it "not
  // responding". Long answers, the ones users care about most, froze the worst.
  //
  // Instead, chunks only append to the buffer, and the expensive render is
  // coalesced to at most one per animation frame. The user can't perceive more
  // than that anyway, and the frame budget goes back to painting.
  _scheduleStreamRender(render) {
    this._pendingStreamRender = render;
    if (this._streamRenderFrame) return;
    this._streamRenderFrame = requestAnimationFrame(() => {
      this._streamRenderFrame = null;
      const pending = this._pendingStreamRender;
      this._pendingStreamRender = null;
      if (!pending) return;
      try {
        pending();
      } catch (err) {
        console.error('Stream render error:', err);
      }
    });
  }

  /**
   * Drops any queued render. Call this wherever the stream ends: the completion
   * path writes the final, authoritative content, and a frame left in flight
   * would land afterwards and paint the half-finished buffer back over it.
   */
  cancelStreamRender() {
    if (this._streamRenderFrame) {
      cancelAnimationFrame(this._streamRenderFrame);
      this._streamRenderFrame = null;
    }
    this._pendingStreamRender = null;
  }

  handleStreamChunk(chunk) {
    if (this.currentMode && this.currentMode.mode === 'interview') {
      const hintElements = document.querySelectorAll('.interview-ai-response .analysis-content');
      if (hintElements.length > 0) {
        const hintElement = hintElements[hintElements.length - 1];
        if (!this.streamBuffer) {
          this.streamBuffer = '';
          hintElement.innerHTML = '';
        }
        this.streamBuffer += chunk;
        this._scheduleStreamRender(() => {
          // The card can be replaced mid-stream; don't write into a detached node.
          if (!hintElement.isConnected) return;
          hintElement.innerHTML = this.formatAnalysis(this.streamBuffer);
          this.scrollToBottomIfEnabled();
          this.resizeWindowToContent();
        });
      }
      return;
    }

    if (this._isChatMode()) {
      if (!this._chatStreamEl) return;
      this.streamBuffer = (this.streamBuffer || '') + chunk;
      this._chatStreamEl.classList.remove('is-typing');
      this._scheduleStreamRender(() => {
        const el = this._chatStreamEl;
        if (!el || !el.isConnected) return;
        el.innerHTML = this.formatAnalysis(this.streamBuffer);
        this.scrollToBottomIfEnabled();
      });
      return;
    }

    if (!this.streamBuffer) {
      this.streamBuffer = '';
      this.statusElement.textContent = 'Receiving analysis...';

      this.analysisText.innerHTML = `
        <div class="analysis-result">
          <h3>📊 Result</h3>
          <div class="response-actions">
            <button id="copy-response-btn" class="copy-button" title="Copy response to clipboard" disabled>
              📋 Copy Response
            </button>
          </div>
          <div id="stream-content" class="analysis-content"></div>
          <div class="timestamp">Streaming...</div>
        </div>
      `;
    }

    this.streamBuffer += chunk;
    this._scheduleStreamRender(() => {
      const streamContent = document.getElementById('stream-content');
      if (streamContent) {
        streamContent.innerHTML = this.formatAnalysis(this.streamBuffer);
      }
    });

    // Throttle resize
    if (!this._resizeTimeout) {
      this._resizeTimeout = setTimeout(() => {
        this.resizeWindowToContent();
        this._resizeTimeout = null;
      }, 100);
    }
  }

  applySyntaxHighlighting() {
    if (typeof window.hljs !== 'undefined' && window.hljs.highlightAll) {
      try {
        setTimeout(() => { window.hljs.highlightAll(); }, 50);
      } catch (error) {
        console.error('Syntax highlighting error:', error);
      }
    }
  }

  testMarkdownRendering() {
    const testMarkdown = `# Heading 1 Test
This is a test of heading 1.

## Heading 2 Test
This is a test of heading 2.

### Heading 3 Test
This is a test of heading 3.

**Bold text** and *italic text* and \`inline code\`.

Here's a code block:

\`\`\`javascript
function testFunction() {
  console.log("Hello, World!");
  return 42;
}
\`\`\`

- List item 1
- List item 2
- List item 3

1. Numbered item 1
2. Numbered item 2
3. Numbered item 3`;

    console.log('Testing markdown rendering...');
    this.showAnalysis(testMarkdown);
  }

  showError(error) {
    // Accepts a plain string, or { message, details } from the main process when
    // the backend rejected the request with a structured reason.
    const message = typeof error === 'string'
      ? error
      : (error && error.message) || 'Unknown error';
    const details = (error && typeof error === 'object' && error.details) || null;

    if (details && this.showErrorForCode(details, message)) return;

    this.statusElement.textContent = 'Error';
    this.analysisText.innerHTML = `
      <div class="error">
        <h3>❌ Error</h3>
        <p>${this._escapeHtml(message)}</p>
      </div>
    `;
    // Resize window to fit content
    this.resizeWindowToContent();
  }

  /** Routes a structured backend rejection to its own card. Returns true if handled. */
  showErrorForCode(details, message) {
    switch (details && details.code) {
      case 'daily_limit_reached':
      case 'free_trial_exhausted':
        this.showLimitReached(details);
        return true;
      case 'plan_required':
        this.showSubscriptionError({ kind: 'model', id: details.model, name: details.modelLabel });
        return true;
      default:
        return false;
    }
  }

  // ─── Paywall shell (shared by the upgrade and quota cards) ───
  // `eyebrow`, `titleHtml` and `body` are trusted markup built here; `desc`
  // is escaped because it can carry a server-supplied message.
  _paywallCard({ icon, quiet = false, compact = false, eyebrow, titleHtml, desc, body }) {
    return `
      <div class="paywall">
        <div class="paywall-card${compact ? ' is-compact' : ''}">
          <div class="paywall-hero">
            <div class="paywall-mark${quiet ? ' is-quiet' : ''}">${this._paywallIcon(icon)}</div>
          </div>
          <div class="paywall-body">
            <div class="paywall-eyebrow">${eyebrow}</div>
            <h3 class="paywall-title">${titleHtml}</h3>
            <p class="paywall-desc">${this._escapeHtml(desc)}</p>
            ${body}
          </div>
        </div>
      </div>
    `;
  }

  // What each plan adds, worded to match the pricing section on solvro.in
  // (website/src/app/page.js proFeatures / proPlusFeatures). Keep them in sync.
  _paywallFeatures(tier = 2) {
    const row = (icon, title, sub) =>
      `<li><span class="paywall-ico">${this._paywallIcon(icon)}</span><div><b>${title}</b><small>${sub}</small></div></li>`;
    if (tier === 1) {
      return `
      <ul class="paywall-list">
        ${row('layers', 'Both Gemini models', 'Gemini 3.7 Flash and Gemini 3.1 Pro')}
        ${row('grid', 'Coding, Query and MCQ modes', 'Every mode except live Interview')}
        ${row('keyboard', 'Custom shortcut keys', 'Run Solvro without leaving the keyboard')}
      </ul>`;
    }
    return `
      <ul class="paywall-list">
        ${row('spark', 'Every Claude model', 'Sonnet 5, Opus 5 and Fable 5')}
        ${row('mic', 'Live Interview mode', 'Real-time answers shaped by your resume')}
        ${row('grid', 'Coding, Query and MCQ too', 'Both Gemini models, plus custom modes on request')}
      </ul>`;
  }

  _paywallUpgradeButton(id, label = 'See plans') {
    return `
      <button id="${id}" class="paywall-btn">
        <span>${label}</span>${this._paywallIcon('arrow')}
      </button>
      <p class="paywall-foot">${this._paywallIcon('lock')}Secure checkout via Razorpay</p>`;
  }

  // Plan tier a model needs, per the pricing page: Claude models are Pro+,
  // Gemini 3.1 Pro is Pro, Gemini 3.7 Flash is free.
  _paywallModelTier(id = '') {
    const key = String(id).toLowerCase();
    if (/claude|sonnet|opus|fable/.test(key)) return 2;
    if (key.includes('flash')) return 0;
    return 1;
  }

  _paywallIcon(name) {
    const paths = {
      arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
      bolt: '<path d="M13 2L4.5 13.5H12L11 22l8.5-11.5H12z"/>',
      grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
      keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
      lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
      mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
      spark: '<path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  }


  /**
   * Shown when a quota runs out. The point is to make the wall feel like a
   * pause rather than a failure: say plainly what was used, when it comes back,
   * and offer the one action that lets the user keep working right now.
   */
  showLimitReached(details = {}) {
    const isTrial = details.code === 'free_trial_exhausted';
    // Claude caps are monthly now; the code stays 'daily_limit_reached' so older
    // builds still show this card, and `period` says which wording to use.
    const isMonthly = details.period === 'month';
    const periodWord = isMonthly ? 'this month' : 'today';
    // A Sprint Pass allowance doesn't refill, so its card leads with an upgrade.
    const isPass = details.allowance === 'pass';
    const limit = Number(details.limit) || 0;
    const modelLabel = details.modelLabel || 'this model';

    // Reset time is sent as an ISO instant so it lands in the user's timezone.
    const resetsAt = details.resetsAt ? new Date(details.resetsAt) : null;
    const validReset = resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null;
    const resetClock = validReset
      ? isMonthly
        ? `${validReset.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${validReset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : (validReset.getHours() === 0 && validReset.getMinutes() === 0
          ? 'at midnight'
          : `at ${validReset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
      : null;
    const resetRelative = validReset ? this._formatCountdown(validReset - Date.now()) : null;

    // The first uncapped model the user's plan already covers.
    const alternative = Array.isArray(details.alternatives) ? details.alternatives[0] : null;

    const titleHtml = isTrial
      ? 'You’ve felt the <em>difference</em>'
      : isPass
        ? `That’s all ${limit} on <em>your pass</em>`
        : `That’s all ${limit} for <em>${periodWord}</em>`;
    const desc = isTrial
      ? `That was all ${limit} of your free responses. Go Pro to keep Solvro in your corner — every mode, every model, no interruptions.`
      : isPass
        ? `You've used every ${modelLabel} request on your ${details.planName || 'Sprint Pass'}. Upgrade for more${alternative ? ', or keep working on a model that’s unlimited on your plan' : ''}.`
        : `You've used your full ${modelLabel} allowance for ${periodWord}${resetRelative ? `. It refills ${resetRelative}` : ''}. Everything else still works in the meantime.`;

    const meter = limit
      ? `
        <div class="paywall-meter" role="img" aria-label="${limit} of ${limit} requests used">
          <div class="paywall-meter-fill"></div>
        </div>
        <div class="paywall-meter-labels">
          <span>${limit} of ${limit} used</span>
          ${resetClock ? `<span class="paywall-meter-reset">Refills ${this._escapeHtml(resetClock)}</span>` : ''}
        </div>`
      : '';

    const action = isTrial
      ? `${this._paywallFeatures()}${this._paywallUpgradeButton('limit-upgrade-btn')}`
      : isPass
        ? this._passLimitActions(details, alternative)
      : alternative
        ? `<button id="limit-switch-btn" class="paywall-btn" data-model="${this._escapeHtml(alternative.id)}">
             <span>Continue on ${this._escapeHtml(alternative.label)}</span>${this._paywallIcon('arrow')}
           </button>
           <p class="paywall-foot">${isMonthly ? 'Unlimited on your plan' : 'No daily cap'} — pick up right where you left off.</p>`
        : `<button id="limit-upgrade-btn" class="paywall-btn">
             <span>View your plan</span>${this._paywallIcon('arrow')}
           </button>`;

    this.statusElement.textContent = isTrial
      ? 'Trial Complete'
      : isPass ? 'Pass Limit Reached' : isMonthly ? 'Monthly Limit Reached' : 'Daily Limit Reached';
    this.analysisText.innerHTML = this._paywallCard({
      icon: isTrial || isPass ? 'spark' : 'clock',
      quiet: !isTrial && !isPass,
      compact: isPass,
      eyebrow: isTrial ? 'Free trial complete' : isPass ? 'Sprint Pass limit' : isMonthly ? 'Monthly limit' : 'Daily limit',
      titleHtml,
      desc,
      body: isTrial ? `${action}` : `${meter}${action}`,
    });

    setTimeout(() => {
      const switchBtn = document.getElementById('limit-switch-btn');
      if (switchBtn) {
        switchBtn.addEventListener('click', async () => {
          const target = switchBtn.getAttribute('data-model');
          switchBtn.disabled = true;
          await this.cycleModel(target);
          this.showToast(`Switched to ${alternative.label} — send again to continue`, 'success');
          this._restoreQueueDisplay();
        });
      }
      const upgradeBtn = document.getElementById('limit-upgrade-btn');
      if (upgradeBtn) {
        upgradeBtn.addEventListener('click', () => {
          if (window.electronAPI.openExternal) {
            window.electronAPI.openExternal(isPass ? 'https://solvro.in/dashboard#plans' : 'https://solvro.in/dashboard');
          }
        });
      }
    }, 100);

    this.resizeWindowToContent();
  }

  /**
   * What a Sprint Pass holder can do once a model runs out: the plans that give
   * more of it, the upgrade button, and the one-click way to keep working now.
   */
  _passLimitActions(details, alternative) {
    const options = details.upgrade && Array.isArray(details.upgrade.options) ? details.upgrade.options : [];
    const rows = options
      .map((option) => `<li><b>${this._escapeHtml(option.name)}</b><span>${Number(option.limit) || 0} requests</span></li>`)
      .join('');
    const keepGoing = alternative
      ? `<button id="limit-switch-btn" class="paywall-btn paywall-btn-secondary" data-model="${this._escapeHtml(alternative.id)}">
           <span>Continue on ${this._escapeHtml(alternative.label)}</span>
         </button>`
      : '';
    return `
      ${rows ? `<ul class="paywall-options">${rows}</ul>` : ''}
      <button id="limit-upgrade-btn" class="paywall-btn">
        <span>Upgrade for more</span>${this._paywallIcon('arrow')}
      </button>
      ${keepGoing}`;
  }

  /** "in about 3 days" / "in about 6 hours" / "in 40 minutes" — vague on purpose, it only has to reassure. */
  _formatCountdown(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'shortly';
    const hours = Math.floor(ms / 3600000);
    const days = Math.floor(hours / 24);
    if (days >= 2) return `in about ${days} days`;
    if (days === 1) return 'in about a day';
    if (hours >= 1) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
    const minutes = Math.max(1, Math.round(ms / 60000));
    return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  /**
   * Upgrade card for anything the user's plan doesn't include. `context` says
   * what was locked — { kind: 'mode' | 'model', id, name } — so the card can
   * sell that specific thing and name the plan that unlocks it. Anything else
   * (a server message string, or nothing) gets the general card; server text
   * is intentionally not shown, it reads as a rejection.
   */
  showSubscriptionError(context) {
    this.statusElement.textContent = 'Subscription Required';
    const ctx = context && typeof context === 'object' ? context : {};
    // Mode names carry a suffix ("Coding Test Mode") — the title adds its own "mode"
    const rawName = ctx.name ? String(ctx.name) : '';
    const name = ctx.kind === 'mode' ? rawName.replace(/\s+(test\s+)?mode$/i, '') : rawName;
    const accent = `<em>${this._escapeHtml(name)}</em>`;
    const proPlus = { eyebrow: 'Solvro Pro+', tier: 2, cta: 'Upgrade to Pro+' };
    const pro = { eyebrow: 'Solvro Pro', tier: 1, cta: 'Upgrade to Pro' };

    let card;
    if (ctx.kind === 'mode' && ctx.id === 'interview') {
      card = {
        ...proPlus,
        titleHtml: 'Walk in <em>prepared</em>',
        desc: 'Interview mode listens along and hands you answers shaped by your resume, right as the question lands. It comes with Pro+, along with every Claude model.',
      };
    } else if (ctx.kind === 'mode' && name) {
      card = {
        ...pro,
        titleHtml: `Unlock ${accent} mode`,
        desc: 'Built for exactly this moment. Go Pro to switch it on, along with both Gemini models.',
      };
    } else if (ctx.kind === 'model' && name && this._paywallModelTier(ctx.id || name) === 2) {
      card = this._planTier() === 1
        ? {
          ...proPlus,
          titleHtml: 'Ready for <em>more</em>?',
          desc: `${name} is part of Pro+, along with the full Claude lineup and live Interview mode with answers shaped by your resume.`,
        }
        : {
          ...proPlus,
          titleHtml: `Meet ${accent}`,
          desc: `Our sharpest thinking for your hardest questions. Pro+ unlocks ${name} and every other Claude model, plus live Interview mode.`,
        };
    } else if (ctx.kind === 'model' && name) {
      card = {
        ...pro,
        titleHtml: `Meet ${accent}`,
        desc: `Deeper reasoning for the tough problems. Go Pro to use ${name} across Coding, Query and MCQ modes.`,
      };
    } else {
      card = {
        eyebrow: 'Solvro Pro',
        tier: 2,
        cta: 'See plans',
        titleHtml: 'Keep your <em>edge</em>',
        desc: 'Go Pro for both Gemini models across Coding, Query and MCQ, or Pro+ for every Claude model and live Interview mode.',
      };
    }

    this.analysisText.innerHTML = this._paywallCard({
      icon: ctx.id === 'interview' ? 'mic' : 'spark',
      eyebrow: card.eyebrow,
      titleHtml: card.titleHtml,
      desc: card.desc,
      body: `${this._paywallFeatures(card.tier)}${this._paywallUpgradeButton('upgrade-now-btn', card.cta)}`,
    });

    setTimeout(() => {
      const upgradeBtn = document.getElementById('upgrade-now-btn');
      if (upgradeBtn) {
        upgradeBtn.addEventListener('click', () => {
          if (window.electronAPI.openExternal) {
            window.electronAPI.openExternal('https://solvro.in/dashboard');
          }
        });
      }
    }, 100);

    this.resizeWindowToContent();
  }

  showSessionSaved(data) {
    if (data.success) {
      const modeLabel = data.mode ? ` (${data.mode})` : '';
      this.showToast(`💾 Session saved: ${data.folderName}${modeLabel}`, 'success');
    }
  }

  // ─── Toast Notification System ───
  showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
    }, duration);
  }

  showMessage(message, type = 'info') {
    this.showToast(message, type);
  }

  // One reusable toast slot for the screenshot flow, so the instant "captured"
  // confirmation (fired on keypress) is smoothly replaced by the "added to
  // queue (n/m)" message instead of stacking a second toast on top of it.
  _showScreenshotToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    if (this._screenshotToast && this._screenshotToast.parentNode) {
      this._screenshotToast.parentNode.removeChild(this._screenshotToast);
    }
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.textContent = message;
    container.appendChild(toast);
    this._screenshotToast = toast;
    clearTimeout(this._screenshotToastTimer);
    this._screenshotToastTimer = setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
      if (this._screenshotToast === toast) this._screenshotToast = null;
    }, 3000);
  }

  handleGlobalKeyCaptured(data) {
    const { key, type } = data;

    let targetInput = null;
    if (this.currentMode && this.currentMode.mode === 'interview') {
      targetInput = document.getElementById('interview-chat-input');
    } else {
      targetInput = this.additionalTextInput;
    }

    if (!targetInput) return;

    // When the input itself is focused the keystroke already landed natively — don't type it twice
    if (document.hasFocus() && document.activeElement === targetInput) return;

    if (type === 'char') {
      targetInput.value += key;
    } else if (type === 'special' && key === 'Backspace') {
      targetInput.value = targetInput.value.slice(0, -1);
    }

    if (this._isChatMode() && targetInput.id === 'additional-text') {
      this._autoGrowChatInput();
    }
  }

  formatAnalysis(analysis) {
    let cleanedAnalysis = typeof analysis === 'string' ? analysis : String(analysis || '');
    const fencedMatch = cleanedAnalysis
      .trim()
      .match(/^```(?:\s*markdown)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);

    if (fencedMatch) {
      cleanedAnalysis = fencedMatch[1];
    }

    // Chat replies mix prose and code — never force the whole reply into a code block
    if (!/```/.test(cleanedAnalysis) && !this._isChatMode()) {
      const isCodingMode = this.currentMode && this.currentMode.mode === 'coding';
      if (isCodingMode || this.isLikelyRawCode(cleanedAnalysis)) {
        const languageTag = this.getPreferredCodeLanguageTag();
        cleanedAnalysis = `\n\`\`\`${languageTag}\n${cleanedAnalysis}\n\`\`\`\n`;
      }
    }

    try {
      if (typeof window.marked !== 'undefined' && window.marked.parse) {
        return window.marked.parse(cleanedAnalysis);
      } else {
        return this.fallbackFormatting(cleanedAnalysis);
      }
    } catch (error) {
      console.error('Markdown parsing error:', error);
      return this.fallbackFormatting(cleanedAnalysis);
    }
  }

  getPreferredCodeLanguageTag() {
    const selected = this.currentLanguage && this.currentLanguage.language
      ? this.currentLanguage.language
      : '';

    if (selected === 'java' || selected === 'python' || selected === 'cpp') {
      return selected;
    }

    return 'java';
  }

  isLikelyRawCode(text) {
    if (!text || typeof text !== 'string') {
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const lines = trimmed.split(/\r?\n/);
    if (lines.length < 3) {
      return false;
    }

    const codeSignalRegex = /(class\s+\w+|public\s+class|public\s+static\s+void\s+main|import\s+java\.|System\.out\.print|def\s+\w+\(|#include\s*<|std::|using\s+namespace\s+std|function\s+\w+\(|=>|;\s*$|\{\s*$|^\s*\})/;
    const signalCount = lines.reduce((count, line) => {
      return codeSignalRegex.test(line) ? count + 1 : count;
    }, 0);

    return signalCount >= 2;
  }

  fallbackFormatting(text) {
    // Enhanced fallback formatting with better markdown support
    let html = text;

    // Extract code blocks first to protect their newlines
    const codeBlocks = [];
    html = html.replace(/```(\w+)?\r?\n([\s\S]*?)\r?\n```/g, (match, lang, code) => {
      const language = lang || 'plaintext';
      const escapedCode = this.escapeHtml(code);
      codeBlocks.push(`<pre><code class="hljs language-${language}">${escapedCode}</code></pre>`);
      return `%%%CODE_BLOCK_${codeBlocks.length - 1}%%%`;
    });

    // Headings (must be processed before other formatting)
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Lists
    html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Wrap consecutive li elements in ul
    html = html.replace(/(<li>.*?<\/li>\n?)+/g, '<ul>$&</ul>');

    // Line breaks (for non-code text)
    html = html.replace(/\n\n/g, '<br><br>');
    html = html.replace(/\n/g, '<br>');

    // Restore code blocks
    html = html.replace(/%%%CODE_BLOCK_(\d+)%%%/g, (match, index) => {
      return codeBlocks[parseInt(index, 10)];
    });

    return html;
  }

  parseMarkdown(markdown) {
    // This method is now a wrapper for marked.parse
    // Keeping it for backward compatibility
    return this.formatAnalysis(markdown);
  }

  formatAnalysisWithCode(analysis, braceAnalysis) {

    // If we have formatted code, use it instead of the raw response
    if (braceAnalysis && braceAnalysis.formattedCode) {

      // Split the analysis into parts: before code, code, after code
      const codeBlockPatterns = [
        /```[\w]*\s*\n([\s\S]*?)\n```/gi,  // Code blocks with language
        /```\s*\n([\s\S]*?)\n```/gi  // Generic code blocks
      ];

      let processedAnalysis = analysis;
      let foundCodeBlocks = false;

      // Replace each code block with the formatted version
      for (const pattern of codeBlockPatterns) {
        const matches = Array.from(analysis.matchAll(pattern));
        if (matches.length > 0) {
          foundCodeBlocks = true;
          processedAnalysis = analysis.replace(pattern, `
<div class="formatted-code-container">
<pre class="formatted-code">${this.escapeHtml(braceAnalysis.formattedCode)}</pre>
</div>
          `.trim());
          break; // Use the first pattern that matches
        }
      }

      if (!foundCodeBlocks) {
        processedAnalysis += `\n\n<div class="formatted-code-container">
<h4>Generated Code:</h4>
<pre class="formatted-code">${this.escapeHtml(braceAnalysis.formattedCode)}</pre>
</div>`;
      }

      // Apply markdown formatting to the rest of the text
      return this.parseMarkdown(processedAnalysis);
    } else {
      // Fall back to regular formatting if no formatted code
      return this.formatAnalysis(analysis);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Copies plain text to the clipboard and resolves true/false. Tries the async
  // Clipboard API, then falls back to execCommand (Electron's file:// page is
  // not always a secure context, where the async API rejects).
  async _copyTextToClipboard(text) {
    const value = typeof text === 'string' ? text : String(text ?? '');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) { /* fall through to execCommand */ }
    try {
      const textArea = document.createElement('textarea');
      textArea.value = value;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textArea);
      return ok;
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      return false;
    }
  }

  // Strips one enclosing ```lang … ``` fence so a copied coding answer pastes
  // straight into a terminal/editor without the markdown backticks. Leaves mixed
  // prose+code or multi-block responses untouched.
  _stripEnclosingCodeFence(text) {
    if (typeof text !== 'string') return '';
    const m = text.trim().match(/^```[^\n`]*\n([\s\S]*?)\n?```$/);
    return m ? m[1] : text;
  }

  copyResponseToClipboard(response) {
    if (navigator.clipboard && window.isSecureContext) {
      // Use the modern clipboard API
      navigator.clipboard.writeText(response).then(() => {
        this.showCopySuccess();
      }).catch(err => {
        console.error('Failed to copy with clipboard API:', err);
        this.fallbackCopyToClipboard(response);
      });
    } else {
      // Fallback for older browsers or non-secure contexts
      this.fallbackCopyToClipboard(response);
    }
  }

  fallbackCopyToClipboard(text) {
    // Create a temporary textarea element
    const textArea = document.createElement('textarea');
    textArea.value = text;

    // Make it invisible
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const successful = document.execCommand('copy');
      if (successful) {
        this.showCopySuccess();
      } else {
        this.showCopyError();
      }
    } catch (err) {
      console.error('Fallback copy failed:', err);
      this.showCopyError();
    }

    document.body.removeChild(textArea);
  }

  showCopySuccess() {
    const copyBtn = document.getElementById('copy-response-btn');
    if (copyBtn) {
      const originalText = copyBtn.textContent;
      copyBtn.textContent = '✅ Copied!';
      copyBtn.style.backgroundColor = '#4CAF50';

      setTimeout(() => {
        copyBtn.textContent = originalText;
        copyBtn.style.backgroundColor = '';
      }, 2000);
    }

    this.updateStatus('Response copied to clipboard');
  }

  showCopyError() {
    const copyBtn = document.getElementById('copy-response-btn');
    if (copyBtn) {
      const originalText = copyBtn.textContent;
      copyBtn.textContent = '❌ Copy Failed';
      copyBtn.style.backgroundColor = '#f44336';

      setTimeout(() => {
        copyBtn.textContent = originalText;
        copyBtn.style.backgroundColor = '';
      }, 2000);
    }

    this.updateStatus('Failed to copy response');
  }

  // New extraction event handlers
  showExtractionStarted(data) {
    this.analysisText.innerHTML = `
      <div class="extraction-progress">
        <h3>🔍 Starting Text Extraction</h3>
        <p>${data.message}</p>
        <p>Screenshots in queue: ${data.queueSize}</p>
        <div class="progress-bar">
          <div class="progress-fill" style="width: 0%"></div>
        </div>
      </div>
    `;
    this.resizeWindowToContent();
  }

  showExtractionProgress(progress) {
    const percentage = Math.round((progress.current / progress.total) * 100);
    this.analysisText.innerHTML = `
      <div class="extraction-progress">
        <h3>🔍 Extracting Text</h3>
        <p>${progress.message}</p>
        <p>Progress: ${progress.current} of ${progress.total} screenshots</p>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${percentage}%"></div>
        </div>
        <div class="progress-text">${percentage}%</div>
      </div>
    `;
    this.resizeWindowToContent();
  }

  showExtractionCompleted(data) {
    this.analysisText.innerHTML = `
      <div class="extraction-completed">
        <h3>✅ Text Extraction Complete</h3>
        <p>${data.message}</p>
        <div class="loading-animation">
          <div class="spinner"></div>
          <p>Analyzing with AI...</p>
        </div>
      </div>
    `;
    this.resizeWindowToContent();
  }

  resizeWindowToContent() {
    // Coalesced. This is called from ~30 places, several of which fire in the
    // same task (render → scroll → resize), and each call used to queue its own
    // timer. Every one of those then read scrollHeight — forcing a synchronous
    // layout — and sent an IPC that made the main process do a real Win32 window
    // resize. A burst of them stalls both processes at once, which is what made
    // the window jerk and stop responding while an answer came in. One pending
    // resize is all that can ever be useful.
    try {
      if (this._resizeRequestTimer) return;
      this._resizeRequestTimer = setTimeout(() => {
        this._resizeRequestTimer = null;
        const container = document.querySelector('.container');
        if (!container) return;
        // In chat mode the stylesheet pins the shell to the viewport — don't override it
        container.style.height = this._isChatMode() ? '' : 'auto';
        window.electronAPI.resizeWindowToContent(container.scrollHeight);
      }, 150);
    } catch (error) {
      console.error('Error resizing window:', error);
    }
  }

  /** The element that actually scrolls: the chat thread in query mode, otherwise the analysis container */
  _scrollHost() {
    if (this._isChatMode()) {
      return document.getElementById('chat-thread') || this.analysisContainer;
    }
    return this.analysisContainer;
  }

  scrollToBottomIfEnabled() {
    const host = this._scrollHost();
    if (this.autoScrollEnabled && host) {
      host.scrollTop = host.scrollHeight;
      const scrollBtn = document.getElementById('scroll-to-bottom-btn');
      if (scrollBtn) {
        scrollBtn.style.display = 'none';
      }
    }
  }

  // --- Update UI -----------------------------------------------------------

  /**
   * Updates download silently in the background and install silently after the
   * next PC restart. A forced update (server set FORCE_UPDATE_BELOW) needs nothing
   * from the user, so it shows nothing. A normal one offers a banner to install now
   * or cancel.
   */
  _wireUpdateEvents() {
    const showUpdate = (info) => {
      if (info && info.forced) return;
      this._showUpdateBanner(info);
    };
    window.electronAPI.onUpdateAvailable(() => {});
    window.electronAPI.onUpdateDownloaded((event, info) => showUpdate(info));
    window.electronAPI.onUpdateError(() => {});
    if (window.electronAPI.getPendingUpdate) {
      window.electronAPI.getPendingUpdate().then((pending) => {
        if (pending && pending.phase === 'downloaded') showUpdate(pending);
      }).catch(() => {});
    }
  }

  _showUpdateBanner(info) {
    const banner = document.getElementById('update-banner');
    if (!banner) return;
    // The app re-checks every 10 minutes and hears about the same update each time.
    // Cancelled means cancelled until the next launch.
    const v = info && info.version;
    if (v && this._cancelledUpdate === v) return;
    const text = document.getElementById('update-banner-text');
    if (text) {
      text.textContent = v ? `Version ${v} is ready to install` : 'Update ready to install';
    }
    const installBtn = document.getElementById('update-banner-install');
    if (installBtn) {
      installBtn.onclick = () => {
        installBtn.textContent = 'Restarting…';
        installBtn.disabled = true;
        window.electronAPI.installUpdate();
      };
    }
    const dismissBtn = document.getElementById('update-banner-dismiss');
    if (dismissBtn) {
      dismissBtn.onclick = () => {
        banner.hidden = true;
        this._cancelledUpdate = v;
        if (window.electronAPI.dismissUpdate) window.electronAPI.dismissUpdate();
      };
    }
    banner.hidden = false;
  }

  showCodeCopiedMessage(data) {
    // The buffer-ready ping (sent after extracting an answer's auto-type text)
    // carries no payload — nothing to display for it.
    if (!data) return;
    if (data.error) {
      this.showMessage(data.message, 'error');
      return;
    }

    if (data.isSecure) {
      if (data.countdown) {
        // Show countdown for secure typing
        this.statusElement.textContent = data.message;
        this.statusElement.style.color = data.isResume ? '#f59e0b' : '#4CAF50';
        this.statusElement.style.fontWeight = 'bold';

        // Resume and fresh-start look distinct so it's clear which is happening:
        // amber "Resuming" (continues from where it stopped) vs green "Auto-Typing"
        // (types from the very beginning).
        const cdMs = typeof data.countdownMs === 'number' && data.countdownMs > 0 ? data.countdownMs : 3000;
        const cdSecs = (cdMs / 1000).toFixed(cdMs % 1000 === 0 ? 0 : 1);
        if (data.isResume) {
          const from = typeof data.resumeIndex === 'number' ? data.resumeIndex : null;
          const total = typeof data.totalLength === 'number' ? data.totalLength : null;
          const pos = (from !== null && total) ? ` <span class="resume-pos">(char ${from} of ${total})</span>` : '';
          this.showTemporaryOverlay(`
            <div class="secure-typing-overlay resume">
              <h3>⏯️ Resuming Auto-Typing</h3>
              <p><strong>Click back into your target application now!</strong></p>
              <p>Continues where it stopped${pos} in ${cdSecs}s…</p>
              <div class="typing-progress">
                <div class="progress-bar resume" style="animation: progressBar ${cdMs}ms linear forwards;"></div>
              </div>
              <p class="secure-note">✅ No clipboard used - completely secure</p>
            </div>
          `, cdMs);
        } else {
          this.showTemporaryOverlay(`
            <div class="secure-typing-overlay">
              <h3>🔒 Secure Auto-Typing</h3>
              <p><strong>Click on your target application now!</strong></p>
              <p>Typing from the start in ${cdSecs}s…</p>
              <div class="typing-progress">
                <div class="progress-bar" style="animation: progressBar ${cdMs}ms linear forwards;"></div>
              </div>
              <p class="secure-note">✅ No clipboard used - completely secure</p>
            </div>
          `, cdMs);
        }

      } else if (data.typing) {
        // Show typing in progress
        this.statusElement.textContent = data.message;
        this.statusElement.style.color = '#2196F3';
        this.statusElement.style.fontWeight = 'bold';

      } else if (data.completed) {
        // Show completion message
        this.statusElement.textContent = data.message;
        this.statusElement.style.color = '#4CAF50';
        this.statusElement.style.fontWeight = 'bold';

        setTimeout(() => {
          this.updateStatus();
        }, 3000);
      }
    } else {
      // This branch should no longer be used since we removed clipboard
      this.statusElement.textContent = data.message;
      this.statusElement.style.color = '#ff9800';
      setTimeout(() => {
        this.updateStatus();
      }, 5000);
    }
  }

  showTemporaryOverlay(htmlContent, duration = 3000) {
    // Create overlay element
    const overlay = document.createElement('div');
    overlay.className = 'code-copy-overlay';
    overlay.innerHTML = htmlContent;

    // Add CSS for overlay if not already present
    if (!document.getElementById('secure-typing-styles')) {
      const style = document.createElement('style');
      style.id = 'secure-typing-styles';
      style.textContent = `
        .code-copy-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.8);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          animation: fadeIn 0.3s ease-in;
        }
        .secure-typing-overlay {
          background: #1a1a1a;
          padding: 30px;
          border-radius: 15px;
          text-align: center;
          border: 2px solid #4CAF50;
          max-width: 450px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7);
          color: white;
        }
        .secure-typing-overlay h3 {
          margin-top: 0;
          color: #4CAF50;
          font-size: 20px;
          margin-bottom: 15px;
        }
        .secure-typing-overlay p {
          margin: 10px 0;
          font-size: 14px;
          line-height: 1.4;
        }
        .typing-progress {
          width: 100%;
          height: 8px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          margin: 15px 0;
          overflow: hidden;
        }
        .progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #4CAF50, #45a049);
          width: 0%;
          border-radius: 4px;
        }
        .secure-note {
          font-size: 12px;
          color: #4CAF50;
          margin-bottom: 0;
          font-weight: bold;
        }
        /* Resume variant — amber accent so it's unmistakably different from a
           fresh start (which is green). */
        .secure-typing-overlay.resume {
          border-color: #f59e0b;
        }
        .secure-typing-overlay.resume h3 {
          color: #f59e0b;
        }
        .progress-bar.resume {
          background: linear-gradient(90deg, #f59e0b, #d97706);
        }
        .resume-pos {
          color: #fbbf24;
          font-weight: bold;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes progressBar {
          from { width: 0%; }
          to { width: 100%; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);

    // Remove overlay after duration
    setTimeout(() => {
      overlay.style.animation = 'fadeOut 0.3s ease-out';
      setTimeout(() => {
        if (overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
      }, 300);
    }, duration);
  }

  showUserKeyDialog() {
    // Remove any existing dialog
    this.hideUserKeyDialog();

    const overlay = document.createElement('div');
    overlay.id = 'user-key-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      animation: fadeIn 0.3s ease-out;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #2c2c2c;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      text-align: center;
      max-width: 400px;
      width: 90%;
      border: 1px solid #444;
    `;

    dialog.innerHTML = `
      <h2 style="color: #fff; margin-bottom: 20px; font-size: 18px;">User Key Required</h2>
      <p style="color: #ccc; margin-bottom: 20px; font-size: 14px;">
        Please enter your user key to access the AI services:
      </p>
      <input type="text" id="user-key-input" placeholder="Enter your user key..." 
             style="width: 100%; padding: 10px; border: 1px solid #666; border-radius: 5px; 
                    background: #1a1a1a; color: #fff; font-size: 14px; margin-bottom: 20px;" />
      <div id="user-key-error" style="color: #ff6b6b; margin-bottom: 15px; font-size: 12px; display: none;"></div>
      <div style="display: flex; gap: 10px; justify-content: center;">
        <button id="user-key-submit" 
                style="background: #4CAF50; color: white; border: none; padding: 10px 20px; 
                       border-radius: 5px; cursor: pointer; font-size: 14px;">
          Submit
        </button>
        <button id="user-key-cancel" 
                style="background: #666; color: white; border: none; padding: 10px 20px; 
                       border-radius: 5px; cursor: pointer; font-size: 14px;">
          Cancel
        </button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Event listeners
    const input = document.getElementById('user-key-input');
    const submitBtn = document.getElementById('user-key-submit');
    const cancelBtn = document.getElementById('user-key-cancel');

    const submitKey = async () => {
      const userKey = input.value.trim();
      if (!userKey) {
        this.showUserKeyError('Please enter a user key');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Validating...';

      try {
        await window.electronAPI.submitUserKey(userKey);
        // Success case will be handled by the success event listener
      } catch (error) {
        console.error('Error submitting user key:', error);
        this.showUserKeyError('Failed to submit user key');
        // Reset button state on error
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
      }
    };

    submitBtn.addEventListener('click', submitKey);

    cancelBtn.addEventListener('click', () => {
      this.hideUserKeyDialog();
    });

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        submitKey();
      }
    });

    // Focus on input
    setTimeout(() => input.focus(), 100);
  }

  hideUserKeyDialog() {
    const overlay = document.getElementById('user-key-overlay');
    if (overlay) {
      overlay.style.animation = 'fadeOut 0.3s ease-out';
      setTimeout(() => {
        if (overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
      }, 300);
    }
  }

  showUserKeyError(errorMessage) {
    const errorDiv = document.getElementById('user-key-error');
    if (errorDiv) {
      errorDiv.textContent = errorMessage;
      errorDiv.style.display = 'block';
    }

    // Reset submit button
    const submitBtn = document.getElementById('user-key-submit');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  }


  triggerInterviewManLiveAnswer(typedQuestion = null) {
    if (this._isGenerating) return;
    this._isGenerating = true;

    try {
      const cardId = 'im-card-' + Date.now();
      const container = document.getElementById('interviewman-cards');
      const hero = document.getElementById('interviewman-hero');
      if (hero) hero.style.display = 'none';

      const aiResponse = document.createElement('div');
      aiResponse.className = 'interviewman-card';
      aiResponse.innerHTML = `
        <div class="interviewman-card-header">✨ Answer</div>
        <div class="interviewman-card-content" id="${cardId}">
           <span class="gen-spinner"></span> Generating...
        </div>
      `;
      container.appendChild(aiResponse);

      container.scrollTop = container.scrollHeight;

      let transcript = '';
      if (this.transcriptManager) {
        transcript = this.transcriptManager.getFullTranscript();
      }

      const requestData = {
        question: typedQuestion || null,
        transcript: transcript
      };

      window.electronAPI.sendQueue(JSON.stringify(requestData));
    } catch (e) {
      this._isGenerating = false;
      console.error(e);
    }
  }

  triggerInterviewManNewQuestion() {
    if (this.transcriptManager) this.transcriptManager.clear();
    const tc = document.getElementById('interviewman-transcript-content');
    if (tc) tc.innerHTML = 'Transcription cleared. Ready for next question.';
    const cards = document.getElementById('interviewman-cards');
    if (cards) cards.innerHTML = '';
    const hero = document.getElementById('interviewman-hero');
    if (hero) hero.style.display = 'flex';
  }

  // ─── Usage ────────────────────────────────────────────────
  // Every row comes from /api/user/usage, so limits can change server-side
  // without a release; this only draws what it is handed.

  initUsageModal() {
    const usageBtn = document.getElementById('profile-usage-btn');
    const modal = document.getElementById('usage-modal');
    const closeBtn = document.getElementById('usage-modal-close');
    const refreshBtn = document.getElementById('usage-refresh-btn');
    if (!usageBtn || !modal) return;

    usageBtn.addEventListener('click', () => {
      // Keep the mask up across the handoff: modal first, then drop the panel
      this._setOverlayMask('usage-modal', true);
      this._closeProfilePanel();
      modal.classList.remove('hidden');
      this._loadUsage();
    });

    const close = () => {
      modal.classList.add('hidden');
      this._setOverlayMask('usage-modal', false);
    };
    if (closeBtn) closeBtn.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
    });
    if (refreshBtn) refreshBtn.addEventListener('click', () => this._loadUsage());

    const body = document.getElementById('usage-body');
    if (body) {
      body.addEventListener('click', (e) => {
        const action = e.target.closest('[data-usage-action]');
        if (!action) return;
        const kind = action.getAttribute('data-usage-action');
        if (kind === 'retry') this._loadUsage();
        if (kind === 'upgrade' && window.electronAPI.openExternal) {
          window.electronAPI.openExternal('https://solvro.in/dashboard#plans');
        }
        if (kind === 'signin') {
          close();
          if (typeof this._showLoginOverlay === 'function') this._showLoginOverlay();
        }
      });
    }
  }

  async _loadUsage() {
    const body = document.getElementById('usage-body');
    const refreshBtn = document.getElementById('usage-refresh-btn');
    if (!body) return;
    // Only a first load gets the skeleton; a refresh keeps the numbers on
    // screen and just spins the button, so nothing jumps. Numbers already
    // fetched for the profile button's hint are drawn straight away.
    if (!body.children.length || !this._usageData) {
      if (this._usageData) this._renderUsage(this._usageData);
      else body.innerHTML = this._usageSkeletonHtml();
    }
    if (refreshBtn) refreshBtn.classList.add('is-loading');

    let result;
    try {
      result = window.electronAPI.getUsage
        ? await window.electronAPI.getUsage()
        : { ok: false, reason: 'server' };
    } catch (_) {
      result = { ok: false, reason: 'offline' };
    }
    if (refreshBtn) refreshBtn.classList.remove('is-loading');

    if (result && result.ok && result.data) {
      this._usageData = result.data;
      this._renderUsage(result.data);
      this._setUsageHint(result.data);
    } else {
      this._renderUsageError(result ? result.reason : 'offline');
    }
  }

  _renderUsage(data) {
    const body = document.getElementById('usage-body');
    const updated = document.getElementById('usage-updated');
    if (!body) return;
    const esc = (t) => this._escapeHtml(String(t ?? ''));
    const plan = data.plan || {};

    // ── Plan header
    const tierClass = ['free', 'pro', 'proplus'][plan.tier] || 'free';
    let planMeta = 'One-time allowance';
    if (plan.endDate) {
      const d = new Date(plan.endDate);
      const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      planMeta = `${plan.autoRenew ? 'Renews' : 'Ends'} ${date}`;
    }
    let html = `
      <div class="usage-plan usage-plan-${tierClass}">
        <span class="usage-tier-chip">${esc(plan.tierName || 'Free Trial')}</span>
        <div class="usage-plan-text">
          <div class="usage-plan-name">${esc(plan.name || 'Free Trial')}</div>
          <div class="usage-plan-meta">${esc(planMeta)}</div>
        </div>
      </div>`;

    // ── Monthly limits (a Sprint Pass's one-time allowance is drawn here too)
    if (data.monthly && Array.isArray(data.monthly.meters) && data.monthly.meters.length) {
      const isPass = data.monthly.allowance === 'pass';
      const anyFull = data.monthly.meters.some((m) => Number(m.limit) > 0 && Number(m.used) >= Number(m.limit));
      const resetsAt = data.monthly.resetsAt ? new Date(data.monthly.resetsAt) : null;
      const valid = resetsAt && !Number.isNaN(resetsAt.getTime());
      const resetLabel = valid
        ? `Resets ${resetsAt.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${resetsAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : 'Starts with your next request';
      const resetTitle = valid ? resetsAt.toLocaleString() : 'Your 30-day window starts the first time you use a limited model';
      html += `
        <section class="usage-section">
          <div class="usage-section-head">
            <h3>${isPass ? 'Pass limits' : 'Monthly limits'}</h3>
            ${isPass
              ? '<span class="usage-reset-chip usage-reset-chip-muted">One-time · doesn’t refill</span>'
              : `<span class="usage-reset-chip" title="${esc(resetTitle)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              ${esc(resetLabel)}
            </span>`}
          </div>
          ${data.monthly.meters.map((m) => this._usageMeterHtml(m, valid ? resetsAt : null)).join('')}
          ${isPass && anyFull
            ? `<button class="usage-upgrade-btn" type="button" data-usage-action="upgrade">
            <span>Upgrade for more</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>`
            : ''}
        </section>`;
    }

    // ── One-time allowances (free trial, and Pro's leftover interview minutes)
    if (data.trial && Array.isArray(data.trial.meters) && data.trial.meters.length) {
      html += `
        <section class="usage-section">
          <div class="usage-section-head">
            <h3>Free trial</h3>
            <span class="usage-reset-chip usage-reset-chip-muted">One-time · never resets</span>
          </div>
          ${data.trial.meters.map((m) => this._usageMeterHtml(m, null)).join('')}
        </section>`;
    }

    // ── Unlimited
    if (Array.isArray(data.unlimited) && data.unlimited.length) {
      html += `
        <section class="usage-section">
          <div class="usage-section-head"><h3>Unlimited on your plan</h3></div>
          <div class="usage-unlimited-grid">
            ${data.unlimited.map((u) => `
              <div class="usage-unlimited-item">
                <span class="usage-infinity" aria-hidden="true">∞</span>
                <span>${esc(u.label)}</span>
              </div>`).join('')}
          </div>
        </section>`;
    }

    // ── Locked
    if (Array.isArray(data.locked) && data.locked.length) {
      html += `
        <section class="usage-section">
          <div class="usage-section-head"><h3>Not on your plan</h3></div>
          <div class="usage-locked-list">
            ${data.locked.map((l) => `
              <div class="usage-locked-item">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                <span class="usage-locked-label">${esc(l.label)}</span>
                <span class="usage-plan-pill">${esc(l.requiredPlan)}</span>
              </div>`).join('')}
          </div>
          <button class="usage-upgrade-btn" type="button" data-usage-action="upgrade">
            <span>See plans</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </section>`;
    }

    body.innerHTML = html;
    if (updated) {
      updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }

    // Grow the bars in on the next frame so the width transition runs.
    requestAnimationFrame(() => {
      body.querySelectorAll('.usage-bar-fill').forEach((el) => {
        el.style.width = `${el.getAttribute('data-pct')}%`;
      });
    });
  }

  _usageMeterHtml(meter, resetsAt) {
    const esc = (t) => this._escapeHtml(String(t ?? ''));
    const limit = Math.max(0, Number(meter.limit) || 0);
    const used = Math.min(limit, Math.max(0, Number(meter.used) || 0));
    const pct = limit ? Math.round((used / limit) * 100) : 0;
    const state = pct >= 100 ? 'full' : pct >= 75 ? 'warn' : 'ok';
    const isTime = meter.unit === 'ms';
    const fmt = (v) => (isTime ? this._formatUsageDuration(v) : String(v));
    const left = limit - used;

    let foot;
    if (state === 'full') {
      foot = resetsAt
        ? `Limit reached · back ${esc(this._formatCountdown(resetsAt - Date.now()))}`
        : 'All used';
    } else {
      foot = `${fmt(left)} left`;
    }

    return `
      <div class="usage-meter usage-meter-${state}">
        <div class="usage-meter-top">
          <span class="usage-meter-label">${esc(meter.label)}</span>
          <span class="usage-meter-count"><strong>${esc(fmt(used))}</strong> / ${esc(fmt(limit))}</span>
        </div>
        <div class="usage-bar" role="progressbar" aria-label="${esc(meter.label)}"
          aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${used}">
          <div class="usage-bar-fill" data-pct="${pct}"></div>
        </div>
        <div class="usage-meter-foot">
          <span>${pct}% used</span>
          <span class="usage-meter-left">${foot}</span>
        </div>
      </div>`;
  }

  /** 250000 → "4m 10s", 600000 → "10m". */
  _formatUsageDuration(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const m = Math.floor(total / 60);
    const sec = total % 60;
    if (m && sec) return `${m}m ${sec}s`;
    if (m) return `${m}m`;
    return `${sec}s`;
  }

  _usageSkeletonHtml() {
    const row = `
      <div class="usage-meter usage-skeleton">
        <div class="usage-meter-top"><span class="usage-skel usage-skel-text"></span><span class="usage-skel usage-skel-num"></span></div>
        <div class="usage-skel usage-skel-bar"></div>
      </div>`;
    return `
      <div class="usage-plan usage-skeleton">
        <span class="usage-skel usage-skel-chip"></span>
        <div class="usage-plan-text"><span class="usage-skel usage-skel-text"></span><span class="usage-skel usage-skel-sub"></span></div>
      </div>
      <section class="usage-section">${row}${row}</section>`;
  }

  _renderUsageError(reason) {
    const body = document.getElementById('usage-body');
    if (!body) return;
    const signedOut = reason === 'signed_out';
    // A refresh that fails keeps the last good numbers visible.
    if (this._usageData && !signedOut) {
      this.showToast('Could not refresh usage — showing the last numbers', 'error');
      return;
    }
    this._usageData = null;
    body.innerHTML = `
      <div class="usage-empty">
        <div class="usage-empty-icon">
          ${signedOut
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg>'}
        </div>
        <div class="usage-empty-title">${signedOut ? 'Sign in to see your usage' : 'Couldn’t load your usage'}</div>
        <div class="usage-empty-text">${signedOut ? 'Your limits and what’s left appear here once you’re signed in.' : 'Check your connection and try again.'}</div>
        <button class="usage-upgrade-btn" type="button" data-usage-action="${signedOut ? 'signin' : 'retry'}">
          <span>${signedOut ? 'Sign in' : 'Try again'}</span>
        </button>
      </div>`;
  }

  // A one-glance summary on the profile panel's Usage button.
  async _refreshUsageHint() {
    const hint = document.getElementById('profile-usage-hint');
    if (!hint) return;
    if (!this._isSignedIn || !window.electronAPI.getUsage) { hint.textContent = ''; return; }
    if (this._usageData) this._setUsageHint(this._usageData);
    try {
      const result = await window.electronAPI.getUsage();
      if (result && result.ok && result.data) {
        this._usageData = result.data;
        this._setUsageHint(result.data);
      }
    } catch (_) { /* the hint is decoration; the modal reports errors */ }
  }

  _setUsageHint(data) {
    const hint = document.getElementById('profile-usage-hint');
    if (!hint) return;
    // The meter closest to its cap is the one worth surfacing.
    const meters = [
      ...((data.monthly && data.monthly.meters) || []),
      ...((data.trial && data.trial.meters) || []),
    ].filter((m) => Number(m.limit) > 0);
    if (!meters.length) { hint.textContent = ''; hint.className = 'usage-btn-hint'; return; }
    const top = meters
      .map((m) => ({ m, pct: Math.min(100, Math.round((Number(m.used) / Number(m.limit)) * 100)) }))
      .sort((a, b) => b.pct - a.pct)[0];
    hint.textContent = `${top.pct}% used`;
    hint.className = `usage-btn-hint${top.pct >= 100 ? ' is-full' : top.pct >= 75 ? ' is-warn' : ''}`;
    hint.title = top.m.label;
    this._updateFreeTrialCounter(data);
  }

  async _refreshFreeTrialCounter() {
    const tier = this._planTier();
    const el = document.getElementById('free-trial-counter');
    if (tier > 0 || !this._isSignedIn) { if (el) el.style.display = 'none'; return; }
    if (this._usageData) { this._updateFreeTrialCounter(this._usageData); return; }
    try {
      if (!window.electronAPI.getUsage) return;
      const result = await window.electronAPI.getUsage();
      if (result && result.ok && result.data) {
        this._usageData = result.data;
        this._updateFreeTrialCounter(result.data);
      }
    } catch (_) { }
  }

  _updateFreeTrialCounter(data) {
    const el = document.getElementById('free-trial-counter');
    if (!el) return;
    const tier = this._planTier();
    if (tier > 0) { el.style.display = 'none'; return; }
    const trialMeters = (data.trial && data.trial.meters) || [];
    if (!trialMeters.length) { el.style.display = 'none'; return; }
    const parts = [];
    for (const m of trialMeters) {
      const used = Number(m.used) || 0;
      const limit = Number(m.limit) || 0;
      if (limit <= 0) continue;
      const remaining = Math.max(0, limit - used);
      if (m.unit === 'ms') {
        const mins = Math.ceil(remaining / 60000);
        parts.push(`${mins}m interview`);
      } else {
        parts.push(`${remaining}/${limit} requests`);
      }
    }
    if (!parts.length) { el.style.display = 'none'; return; }
    el.textContent = parts.join(' · ');
    const pct = trialMeters.reduce((worst, m) => {
      const p = Number(m.limit) ? Math.round((Number(m.used) / Number(m.limit)) * 100) : 0;
      return Math.max(worst, p);
    }, 0);
    el.className = `free-trial-counter${pct >= 100 ? ' is-full' : pct >= 75 ? ' is-warn' : ''}`;
    el.style.display = 'inline';
  }

  initShortcutsModal() {
    const shortcutsBtn = document.getElementById('profile-shortcuts-btn');
    const modal = document.getElementById('shortcuts-modal');
    const closeBtn = document.getElementById('shortcuts-modal-close');
    const listContainer = document.getElementById('shortcuts-list');

    if (!shortcutsBtn || !modal) return;

    shortcutsBtn.addEventListener('click', async () => {
      // Keep the mask up across the handoff: modal first, then drop the panel
      this._setOverlayMask('shortcuts-modal', true);
      this._closeProfilePanel();

      // Load and render shortcuts
      const shortcuts = await window.electronAPI.getShortcuts();
      this.currentShortcuts = shortcuts;
      this.renderShortcutsList(shortcuts, listContainer);

      // Show modal
      modal.classList.remove('hidden');
    });

    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      this._setOverlayMask('shortcuts-modal', false);
      this._cancelShortcutCapture();
    });

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
        this._setOverlayMask('shortcuts-modal', false);
        this._cancelShortcutCapture();
      }
    });
  }

  /** Aborts an in-progress shortcut capture: detaches the key listener and re-registers the global shortcuts */
  _cancelShortcutCapture() {
    if (this._activeShortcutCaptureCleanup) {
      this._activeShortcutCaptureCleanup();
      this._activeShortcutCaptureCleanup = null;
    }
    if (this.isEditingShortcut) {
      this.isEditingShortcut = false;
      window.electronAPI.stopShortcutCapture().catch(console.error);
    }
  }

  /**
   * Converts a keydown event into an Electron accelerator string, or returns null while only
   * modifiers are held. Uses e.code for printable keys so Shift doesn't turn ']' into '}'
   * or '1' into '!', which Electron can't register.
   */
  _keyEventToAccelerator(e) {
    const CODE_MAP = {
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
      Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
    };

    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;

    let keyName;
    const code = e.code || '';
    if (/^Key[A-Z]$/.test(code)) keyName = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) keyName = code.slice(5);
    else if (/^Numpad[0-9]$/.test(code)) keyName = 'num' + code.slice(6);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) keyName = code;
    else if (CODE_MAP[code]) keyName = CODE_MAP[code];
    else if (e.key === '+') keyName = 'Plus';
    else if (e.key && e.key.length === 1) keyName = e.key.toUpperCase();
    else keyName = e.key;

    const parts = [];
    // The primary modifier is Cmd (metaKey) on macOS and Ctrl (ctrlKey) on
    // Windows/Linux. Either way it is stored as the cross-platform
    // `CommandOrControl` token so the saved accelerator works on every OS.
    const hasPrimary = IS_MAC ? e.metaKey : e.ctrlKey;
    // Modifiers that are never allowed in a shortcut: Alt everywhere, plus the
    // key that isn't the primary one (the Windows/Super key on Windows, a stray
    // Ctrl on Mac) so it can't sneak into the accelerator.
    const hasForbiddenMod = IS_MAC ? (e.altKey || e.ctrlKey) : (e.altKey || e.metaKey);
    // Same modifier order as the defaults, so string comparisons in the duplicate check line up.
    if (hasPrimary) parts.push('CommandOrControl');
    if (e.shiftKey) parts.push('Shift');
    parts.push(keyName);
    return { accelerator: parts.join('+'), keyName, hasCtrl: hasPrimary, hasAltOrMeta: hasForbiddenMod };
  }

  renderShortcutsList(shortcuts, container) {
    container.innerHTML = '';

    // Keep the warning notice at the top (it was in the HTML originally)
    const warningNotice = document.createElement('div');
    warningNotice.className = 'shortcuts-warning-notice';
    warningNotice.innerHTML = `<strong>Important:</strong> Ensure you choose shortcuts that do not conflict with your common OS or app functionalities (like ${PRIMARY_MOD_LABEL}+R to refresh the browser). This app will intercept and override them globally while running.`;
    container.appendChild(warningNotice);
    for (const [id, config] of Object.entries(shortcuts)) {
      const item = document.createElement('div');
      item.className = 'shortcut-item';

      const info = document.createElement('div');
      info.className = 'shortcut-info';

      const label = document.createElement('span');
      label.className = 'shortcut-label';
      label.textContent = config.label;
      info.appendChild(label);

      const keysContainer = document.createElement('div');
      keysContainer.className = 'shortcut-keys-container';

      const keysDiv = document.createElement('div');
      keysDiv.className = 'shortcut-keys';

      const renderKeys = (accelerator) => {
        keysDiv.innerHTML = '';
        this._formatKeyParts(accelerator).forEach(key => {
          const k = document.createElement('span');
          k.className = 'shortcut-key';
          k.textContent = key;
          keysDiv.appendChild(k);
        });
      };
      renderKeys(config.keys);

      const editBtn = document.createElement('button');
      editBtn.className = 'shortcut-edit-btn';
      editBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
      `;

      editBtn.addEventListener('click', async () => {
        if (this.isEditingShortcut) return;

        this.isEditingShortcut = true;
        item.classList.add('listening');
        keysDiv.innerHTML = '<span class="listening-text">Listening... press keys</span>';

        await window.electronAPI.startShortcutCapture();

        // Detaches listeners and restores the row; the caller decides what happens to capture mode in main
        const finishCapture = () => {
          window.removeEventListener('keydown', keydownHandler, true);
          window.removeEventListener('blur', blurHandler);
          item.classList.remove('listening');
          this._activeShortcutCaptureCleanup = null;
        };
        const cancel = () => {
          finishCapture();
          renderKeys(config.keys);
          this.isEditingShortcut = false;
          window.electronAPI.stopShortcutCapture().catch(console.error);
        };

        const keydownHandler = async (e) => {
          e.preventDefault();
          e.stopPropagation();

          const parsed = this._keyEventToAccelerator(e);
          if (!parsed) return; // Wait for a non-modifier key

          const { accelerator: finalShortcut, keyName, hasCtrl, hasAltOrMeta } = parsed;

          // Plain Escape cancels editing
          if (finalShortcut === 'Escape') {
            cancel();
            return;
          }

          if (hasAltOrMeta) {
            const forbidden = IS_MAC ? 'Alt/Option and Control' : 'Alt and Windows';
            this.showToast(`${forbidden} keys are not allowed. Use ${PRIMARY_MOD_LABEL} (optionally with Shift). Press Esc to cancel.`, 'error', 4000);
            return; // Keep listening
          }

          // Global shortcuts swallow the key system-wide, so anything without the primary modifier
          // (e.g. a bare key or Shift+letter) would stop the user from typing it in every other app.
          // F-keys are the exception.
          const isFunctionKey = /^F\d{1,2}$/.test(keyName);
          if (!hasCtrl && !isFunctionKey) {
            this.showToast(`Shortcut must include ${PRIMARY_MOD_LABEL} (F1–F24 can be used alone). Press Esc to cancel.`, 'error', 4000);
            return; // Keep listening
          }

          // Duplicate check against latest shortcuts (main re-checks and also catches OS-level conflicts)
          const isDuplicate = Object.entries(this.currentShortcuts || {}).some(([otherId, otherConfig]) => {
            const otherKeys = typeof otherConfig === 'string' ? otherConfig : otherConfig.keys;
            return otherId !== id && otherKeys.toLowerCase() === finalShortcut.toLowerCase();
          });
          if (isDuplicate) {
            cancel();
            this.showToast('You cannot use the same shortcut for two functions.', 'error');
            return;
          }

          finishCapture();
          renderKeys(finalShortcut);

          try {
            // Saving also ends capture mode and re-registers all shortcuts in main
            const result = await window.electronAPI.saveShortcut(id, finalShortcut);
            this.isEditingShortcut = false;
            if (result && result.ok === false) {
              renderKeys(config.keys);
              this.showToast(`Could not set shortcut: ${result.error}`, 'error', 4000);
              return;
            }
            config.keys = finalShortcut;
            if (result && result.shortcuts) this.currentShortcuts = result.shortcuts;
            this.showToast(`${config.label} → ${this._formatKey(finalShortcut)}`, 'success');
          } catch (err) {
            console.error('Error saving shortcut:', err);
            cancel();
          }
        };

        // Clicking away from the app would otherwise leave every global shortcut unregistered
        const blurHandler = () => cancel();

        window.addEventListener('keydown', keydownHandler, true);
        window.addEventListener('blur', blurHandler);
        this._activeShortcutCaptureCleanup = () => {
          finishCapture();
          renderKeys(config.keys);
        };
      });

      keysContainer.appendChild(keysDiv);
      keysContainer.appendChild(editBtn);

      item.appendChild(info);
      item.appendChild(keysContainer);

      container.appendChild(item);
    }

    // Add "Reset to Defaults" button at the bottom
    const resetBtnContainer = document.createElement('div');
    resetBtnContainer.className = 'shortcuts-reset-container';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'shortcuts-reset-btn';
    resetBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
        <path d="M3 3v5h5"></path>
      </svg>
      Reset to Defaults
    `;
    resetBtn.addEventListener('click', async () => {
      this._cancelShortcutCapture();
      const freshShortcuts = await window.electronAPI.resetAllShortcuts();
      this.currentShortcuts = freshShortcuts;
      this.renderShortcutsList(freshShortcuts, container);
      this._updateShortcutTextsInPlace();
      this.showToast('All shortcuts have been reset to defaults.', 'success');
    });
    resetBtnContainer.appendChild(resetBtn);
    container.appendChild(resetBtnContainer);
  }

  /**
   * Instantly updates every shortcut reference in the visible UI after a rebind,
   * without re-rendering the whole page: the declarative data-sc-title/data-sc-text
   * hints, the header selectors' tooltips, and any view built from a template.
   */
  _updateShortcutTextsInPlace() {
    if (!this.currentShortcuts) return;

    // Static markup hints (transparency slider, audio buttons, quit, scroll button…)
    this._applyShortcutHints();

    // Header selectors build their tooltip alongside the current mode/language/model name
    if (this.currentMode) this.updateModeDisplay(this.currentMode);
    if (this.currentLanguage) this.updateLanguageDisplay(this.currentLanguage);
    if (this.currentModel) this.updateModelDisplay(this.currentModel);

    // The queue view carries its own data-sc-text hints (refreshed above), so it
    // must not be re-rendered — that would discard the user's typed context.
    if (this.screenshotQueue && this.screenshotQueue.length > 0) return;
    if (this._chatBusy) return; // a rebind mid-stream must not drop the partial reply

    // Re-render the welcome / chat view so its <kbd> hints pick up the new bindings,
    // but only when that's what's on screen — never wipe an analysis being read.
    if (this.analysisText && this.analysisText.querySelector('.welcome, .chat-view')) {
      this.showWelcomeMessage();
    }
  }

  // Alias for backward compatibility
  _updateWelcomeScreens() {
    this._updateShortcutTextsInPlace();
  }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new AppRenderer();

  // Title-bar double-click to maximize/restore. On Windows this is handled
  // natively in the main process (the drag region is the OS caption, so the page
  // never sees the double-click); on macOS/Linux the page does, so forward it.
  if (window.electronAPI && window.electronAPI.platform !== 'win32') {
    const titleBar = document.querySelector('.title-bar');
    if (titleBar) {
      titleBar.addEventListener('dblclick', (e) => {
        // Ignore double-clicks on the interactive controls in the bar.
        if (e.target.closest('.title-bar-actions')) return;
        window.electronAPI.toggleMaximize();
      });
    }
  }
});
