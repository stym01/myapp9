// interviewBridge.js — Manages the interview mode React app
// Serves the built React interview UI via Express and manages a BrowserView
// Handles Deepgram WebSocket STT and AI request proxying

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const express = require('express');
const WebSocket = require('ws');
const electron = require('electron');
const { BrowserView, ipcMain, desktopCapturer, clipboard, screen } = electron;
const app = electron.app || {};
const remoteConfig = require('./remoteConfig');
const { readSessionToken } = require('./sessionToken');
const { clientHeaders } = require('./clientInfo');
const shortcutManager = require('./shortcutManager');

// --- Shortcut display formatting ---
// Mirrors renderer.js's KEY_DISPLAY_MAP / _formatKeyParts / _formatKey (the host
// window's own shortcut-label formatting) so the interview BrowserView's React
// app can show the same human-readable key labels without duplicating that UI
// logic — this is the main process's copy of just the pure string formatting.
const KEY_DISPLAY_MAP = {
  commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl',
  command: 'Cmd', cmd: 'Cmd', meta: 'Cmd', super: 'Win',
  alt: 'Alt', option: 'Alt', altgr: 'AltGr', shift: 'Shift',
  return: 'Enter', enter: 'Enter', escape: 'Esc', esc: 'Esc',
  up: '↑', down: '↓', left: '←', right: '→',
  plus: '+', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Del',
  pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End', insert: 'Ins',
  numadd: 'Num+', numsub: 'Num-', nummult: 'Num*', numdiv: 'Num/', numdec: 'Num.'
};

function formatShortcutKeys(keys) {
  if (!keys) return '';
  return String(keys).split('+').map(part => {
    const token = part.trim();
    if (!token) return '+';
    const mapped = KEY_DISPLAY_MAP[token.toLowerCase()];
    if (mapped) return mapped;
    if (/^num[0-9]$/i.test(token)) return 'Num ' + token.slice(3);
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
    return token.length === 1 ? token.toUpperCase() : token;
  }).join('+');
}

// id -> formatted display string (e.g. 'Ctrl+Shift+S'), for every shortcut.
function getFormattedShortcuts() {
  const shortcuts = shortcutManager.getShortcuts();
  const formatted = {};
  for (const [id, cfg] of Object.entries(shortcuts)) {
    formatted[id] = formatShortcutKeys(cfg.keys);
  }
  return formatted;
}

// Current theme, source of truth is the host window's own toggle (and its
// localStorage persistence) — this is just a cache so a freshly (re)created
// BrowserView can be told the right theme without waiting on a renderer push.
let currentTheme = 'dark';

function setTheme(theme) {
  currentTheme = theme === 'light' ? 'light' : 'dark';
  if (interviewView && !interviewView.webContents.isDestroyed()) {
    interviewView.webContents.send('interview-theme-changed', currentTheme);
  }
}

function pushShortcutsUpdate() {
  if (interviewView && !interviewView.webContents.isDestroyed()) {
    interviewView.webContents.send('interview-shortcuts-changed', getFormattedShortcuts());
  }
}

// Safe debug logger.
//
// Buffered and flushed asynchronously. This runs on the main process and some of
// its callers are per-transcript (Deepgram fires several messages a second), so
// the old appendFileSync put a blocking disk write on the audio path — the exact
// thing that makes the window stop repainting mid-interview.
let DEBUG_LOG_PATH;
try { DEBUG_LOG_PATH = path.join(require('electron').app.getPath('userData'), 'solvro-interview-debug.log'); }
catch (_) { DEBUG_LOG_PATH = path.join(require('os').tmpdir(), 'solvro-interview-debug.log'); }
const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
let debugBuffer = [];
let debugFlushTimer = null;
let debugWriteInFlight = false;

function flushDebugLog() {
  if (debugWriteInFlight || debugBuffer.length === 0) return;
  const chunk = debugBuffer.join('');
  debugBuffer = [];
  debugWriteInFlight = true;
  fs.appendFile(DEBUG_LOG_PATH, chunk, 'utf8', () => {
    debugWriteInFlight = false;
    if (debugBuffer.length > 0) flushDebugLog();
  });
}

// The log was never truncated and grew for the life of the install. Roll it when
// it gets large so a long-lived machine doesn't end up appending to a file big
// enough to make each write slow.
function rotateDebugLogIfNeeded() {
  fs.stat(DEBUG_LOG_PATH, (err, stat) => {
    if (err || !stat || stat.size < DEBUG_LOG_MAX_BYTES) return;
    fs.rename(DEBUG_LOG_PATH, `${DEBUG_LOG_PATH}.1`, () => { });
  });
}
rotateDebugLogIfNeeded();

function debugLog(message) {
  try {
    const ts = new Date().toISOString();
    debugBuffer.push(`[${ts}] ${message}\n`);
    if (debugBuffer.length > 500) debugBuffer = debugBuffer.slice(-250);
    if (!debugFlushTimer) {
      debugFlushTimer = setTimeout(() => {
        debugFlushTimer = null;
        flushDebugLog();
      }, 1000);
      if (debugFlushTimer.unref) debugFlushTimer.unref();
    }
  } catch (_) { /* ignore */ }
}

// --- Configuration ---
const INTERVIEW_PORT = 18097;
// Height of Solvro's own top bar; the interview BrowserView sits below it.
const TOP_BAR_HEIGHT = 90;
// Same base as the rest of the app (SOLVRO_API_BASE env, default solvro.in),
// so a dev run can point the interview at a local website.
const SOLVRO_API_BASE = remoteConfig.API_BASE;

// https in production; plain http only for a local dev server.
function requestFor(url) {
  return url.protocol === 'http:' ? http.request : https.request;
}

// One pooled, kept-alive connection to the backend. The interview pings every
// 10s, so the TLS session to solvro.in stays warm and an answer request skips
// the DNS + TCP + TLS handshake (a few hundred ms from India to the US edge).
const keepAliveAgents = {
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 }),
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 }),
};
function agentFor(url) {
  return keepAliveAgents[url.protocol];
}

// Path to the interview-web React build
const COMPANION_WEB_PATH = (function () {
  const unpackedPath = path.join(process.resourcesPath, 'interview-web');
  const asarPath = path.join(__dirname, '../../interview-web');
  if (app.isPackaged && fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }
  return asarPath;
})();

let server = null;
let interviewView = null;
let mainWindowRef = null;
let isInterviewActive = false;
let suspendedViewBounds = null;
let menuClearActive = false;
// Y the interview view's top sits at — below the host top bar. Starts at the
// nominal 90 and is updated to the measured top-bar bottom (so a taller top bar
// never covers the interview screen).
let interviewContentTop = TOP_BAR_HEIGHT;
let pingInterval = null;

// --- Helper: Get Solvro session token ---
function getSolvroToken() {
  return readSessionToken();
}

// The interview UI lives in a BrowserView that paints over the main window, so
// it can't show the sign-in page itself. Ask the main window to prompt instead.
function requestSignIn(reason = 'interview') {
  try {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('auth-required', { reason });
    }
  } catch (_) { }
}

const SIGN_IN_REQUIRED = 'Sign in to use interview mode.';

// --- Helper: Fetch from Solvro API ---
function solvroFetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const token = getSolvroToken();
    const url = new URL(urlPath, SOLVRO_API_BASE);

    const reqOptions = {
      method: options.method || 'GET',
      agent: agentFor(url),
      headers: {
        'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        ...clientHeaders(),
        ...options.headers,
      },
    };

    const req = requestFor(url)(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => req.destroy(new Error('timeout')));
    }

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// --- Express Server ---

function startInterviewServer() {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve();
      return;
    }

    const expressApp = express();

    // Serve the React build as static files
    expressApp.use(express.static(COMPANION_WEB_PATH));

    // SPA fallback — serve index.html for all unmatched routes
    expressApp.use((req, res) => {
      res.sendFile(path.join(COMPANION_WEB_PATH, 'index.html'));
    });

    server = expressApp.listen(INTERVIEW_PORT, '127.0.0.1', () => {
      console.log(`[InterviewBridge] Server started on http://127.0.0.1:${INTERVIEW_PORT}`);
      resolve();
    });

    server.on('error', (err) => {
      server = null;
      reject(err);
    });
  });
}

function stopInterviewServer() {
  if (server) {
    server.close(() => {
      console.log('[InterviewBridge] Server stopped');
    });
    server = null;
  }
}

// --- BrowserView Management ---

function createInterviewView(mainWindow) {
  debugLog('createInterviewView called');
  if (interviewView) {
    destroyInterviewView();
  }

  mainWindowRef = mainWindow;

  interviewView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../renderer/interviewPreload.js'),
      webSecurity: true,
      sandbox: false,
      // The interview keeps listening while the user is in another window.
      // Throttling would delay the transcript -> question -> answer path.
      backgroundThrottling: false,
    }
  });

  // Grant media permissions for microphone + system audio capture
  interviewView.setBackgroundColor('#080A12');
  interviewView.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'audio-capture', 'display-capture'].includes(permission);
    callback(allowed);
  });

  mainWindow.addBrowserView(interviewView);

  // Position below Solvro's top bar (height refined once the renderer measures it)
  const bounds = mainWindow.getContentBounds();
  interviewView.setBounds({
    x: 0,
    y: interviewContentTop,
    width: bounds.width,
    height: Math.max(bounds.height - interviewContentTop, 200)
  });
  interviewView.setAutoResize({ width: true, height: true });

  // Block external navigation
  interviewView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:')) {
      event.preventDefault();
      debugLog('Blocked redirect to: ' + url);
    }
  });

  interviewView.webContents.loadURL(`http://127.0.0.1:${INTERVIEW_PORT}`);

  interviewView.webContents.on('console-message', (_event, _level, message) => {
    debugLog('[React] ' + message);
  });
  interviewView.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    debugLog('[React FAIL] ' + errorDescription);
  });

  // Handle window open requests — deny all
  interviewView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  initLiveCoach();
  isInterviewActive = true;
  console.log('[InterviewBridge] BrowserView created and loading React app');
}

function destroyInterviewView() {
  suspendedViewBounds = null;
  // Close Deepgram if active
  closeDeepgram();
  cancelActiveAIRequest();
  destroyLiveCoach();

  if (interviewView && mainWindowRef) {
    try {
      mainWindowRef.removeBrowserView(interviewView);
    } catch (e) {
      console.error('[InterviewBridge] Error removing BrowserView:', e);
    }
    interviewView.webContents.destroy();
    interviewView = null;
  }
  isInterviewActive = false;
  console.log('[InterviewBridge] BrowserView destroyed');
}

function hideInterviewView() {
  suspendedViewBounds = null;
  menuClearActive = false;
  if (interviewView && mainWindowRef) {
    interviewView.setBounds({ x: -9999, y: -9999, width: 0, height: 0 });
    interviewView.setAutoResize({ width: false, height: false });
  }
  isInterviewActive = false;
}

// Temporarily tucks the BrowserView out of sight so the host page's own overlays
// (profile panel, shortcuts modal, ...) can be seen — a BrowserView always paints
// above the window's web contents, so no CSS z-index can win against it.
// Size is preserved so the React app doesn't reflow while it's parked.
function suspendInterviewView() {
  // Only a view that is actually on screen can be parked. hideInterviewView()
  // leaves the BrowserView alive at 0x0 offscreen when the user switches away
  // from interview mode, so `interviewView` being non-null says nothing about
  // whether anything is visible -- isInterviewActive is the real state.
  //
  // Without this gate, suspending a hidden view recorded its 0x0 offscreen
  // bounds, and the matching resume below then "restored" it to FULL SIZE over
  // the coding UI. Opening and closing a mode/model/language dropdown was
  // enough to do it: the interview screen appeared on top of coding mode even
  // though the mode had never changed.
  if (!interviewView || suspendedViewBounds || !isInterviewActive) return false;
  try {
    const bounds = interviewView.getBounds();
    suspendedViewBounds = bounds;
    interviewView.setAutoResize({ width: false, height: false });
    interviewView.setBounds({
      x: -(bounds.width + 100),
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    });
    return true;
  } catch (e) {
    console.error('[InterviewBridge] suspendInterviewView failed:', e);
    suspendedViewBounds = null;
    return false;
  }
}

function resumeInterviewView() {
  // Same gate as suspend, and for the same reason: this recomputes full-size
  // bounds rather than replaying the saved ones, so it can only ever make the
  // view visible. Calling it for a view that is not meant to be on screen
  // un-hides the interview UI over whatever mode the user is actually in.
  // Nothing suspends while inactive now, but this is also reached from
  // did-finish-load on every reload, so it must refuse on its own.
  if (!interviewView || !suspendedViewBounds || !isInterviewActive) {
    suspendedViewBounds = null;
    return false;
  }
  suspendedViewBounds = null;
  try {
    // Recompute from the window — it may have been resized while parked
    const contentBounds = mainWindowRef
      ? mainWindowRef.getContentBounds()
      : null;
    if (contentBounds) {
      interviewView.setBounds({
        x: 0,
        y: interviewContentTop,
        width: contentBounds.width,
        height: Math.max(contentBounds.height - interviewContentTop, 200)
      });
    }
    interviewView.setAutoResize({ width: true, height: true });
    return true;
  } catch (e) {
    console.error('[InterviewBridge] resumeInterviewView failed:', e);
    return false;
  }
}

// The host measured its top bar's actual bottom; keep the view's top aligned to
// it so a taller top bar (wrapped pills, etc.) never overlaps the interview UI.
function setContentTop(y) {
  const clamped = Math.min(Math.max(Math.round(Number(y)) || TOP_BAR_HEIGHT, 60), 320);
  if (clamped === interviewContentTop) return;
  interviewContentTop = clamped;
  // Apply immediately unless the view is parked (modal) or shrunk for a menu —
  // those paths restore to interviewContentTop when they end.
  if (interviewView && isInterviewActive && mainWindowRef && !suspendedViewBounds && !menuClearActive) {
    try {
      const b = mainWindowRef.getContentBounds();
      interviewView.setBounds({
        x: 0,
        y: interviewContentTop,
        width: b.width,
        height: Math.max(b.height - interviewContentTop, 200),
      });
    } catch (e) {
      console.error('[InterviewBridge] setContentTop failed:', e);
    }
  }
}

// A selector dropdown opened in the host page: push the BrowserView down to just
// below the open menu (bottomY, in content px) so the menu is visible while the
// rest of the interview screen stays on screen. bottomY <= 0 restores full size.
// This replaces fully parking the view off-screen for a mere dropdown, which
// used to blank the whole interview area.
function setMenuClearTop(bottomY) {
  if (!interviewView || !isInterviewActive || !mainWindowRef || suspendedViewBounds) return;
  try {
    const contentBounds = mainWindowRef.getContentBounds();
    const clearTo = Math.round(bottomY);
    if (clearTo > interviewContentTop) {
      menuClearActive = true;
      interviewView.setAutoResize({ width: false, height: false });
      interviewView.setBounds({
        x: 0,
        y: clearTo,
        width: contentBounds.width,
        height: Math.max(contentBounds.height - clearTo, 120),
      });
    } else if (menuClearActive) {
      menuClearActive = false;
      interviewView.setBounds({
        x: 0,
        y: interviewContentTop,
        width: contentBounds.width,
        height: Math.max(contentBounds.height - interviewContentTop, 200),
      });
      interviewView.setAutoResize({ width: true, height: true });
    }
  } catch (e) {
    console.error('[InterviewBridge] setMenuClearTop failed:', e);
  }
}

function showInterviewView() {
  suspendedViewBounds = null;
  if (interviewView && mainWindowRef) {
    // Resize main window to full screen height
    const { screen } = require('electron');
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const bounds = mainWindowRef.getBounds();
    mainWindowRef.setBounds({
      x: bounds.x,
      y: 0,
      width: bounds.width,
      height: workArea.height
    });

    const newBounds = mainWindowRef.getContentBounds();
    interviewView.setBounds({
      x: 0,
      y: TOP_BAR_HEIGHT,
      width: newBounds.width,
      height: Math.max(newBounds.height - TOP_BAR_HEIGHT, 200)
    });
    interviewView.setAutoResize({ width: true, height: true });
  }
  isInterviewActive = true;
}

// --- Deepgram WebSocket Management ---

// Interview audio runs as one STT stream per speaker:
//   'sys' -- system audio (the interviewer on the call / video)
//   'mic' -- the microphone (the candidate)
// Separate streams give every transcript line a reliable speaker, which the
// renderer uses to drop mic echoes of the interviewer and to decide whose
// speech may trigger an answer. The mixed-mono + diarization setup had to
// guess who was talking.
const STT_ROLES = ['mic', 'sys'];

// The connection parameters live on the server (see remoteConfig / appConfig).
// `serverUrl` is what the backend handed us for this session; `options` are
// per-session overrides from the live-coach UI, which still take precedence.
// If the backend is older than this feature we rebuild the URL from the cached
// config, which in the worst case is the same defaults the app used to hardcode.
function buildSttUrl(serverUrl, options = {}) {
  const url = new URL(serverUrl || remoteConfig.buildSttUrl('diarized'));

  if (options.model) url.searchParams.set('model', options.model);
  if (options.language) url.searchParams.set('language', options.language);
  if (options.diarize !== undefined) url.searchParams.set('diarize', String(options.diarize !== false));
  // Low-latency overrides for live interview use. endpointing is how long
  // Deepgram waits for silence before committing a final (and firing the
  // answer trigger); utterance_end_ms is the backstop for noisy audio. Both
  // are set a bit tighter than the server default so the transcript settles
  // and the AI starts answering sooner. interim_results stays on (server sets
  // it), so words still stream in live as they're spoken.
  if (options.endpointing !== undefined) url.searchParams.set('endpointing', String(options.endpointing));
  if (options.utterance_end_ms !== undefined) url.searchParams.set('utterance_end_ms', String(options.utterance_end_ms));

  return url.toString();
}

// Asks the backend for an STT session: credential + ready-to-open URL, so the
// STT model and tuning are server-side settings. Per-speaker streams use the
// `split` profile; a backend that predates it answers with its default
// profile, which still works once diarization is switched off.
// Reused across a stop/start within the same app session (and across an
// automatic drop-reconnect) instead of re-fetched from solvro.in every time --
// the vended credential is valid for up to DEEPGRAM_TEMP_KEY_TTL_SECONDS
// (default 1h server-side), so re-fetching it on every reconnect was a pure
// network round trip for nothing. Refetched early (margin below) rather than
// exactly at expiry, and dropped immediately if a connection attempt that
// used it fails to open (connectSttStream's close handler).
let cachedSttSession = null; // { session, expiresAtMs: number | null }
const STT_SESSION_REFRESH_MARGIN_MS = 60 * 1000;

function sttSessionCacheUsable() {
  if (!cachedSttSession) return false;
  const { expiresAtMs } = cachedSttSession;
  // No expiry reported (permanent, non-temporary key) -- keep using it.
  if (!expiresAtMs) return true;
  return Date.now() < expiresAtMs - STT_SESSION_REFRESH_MARGIN_MS;
}

async function fetchSttSession() {
  if (sttSessionCacheUsable()) return cachedSttSession.session;

  const keyResponse = await solvroFetch('/api/keys/deepgram?profile=split');

  // The server gates this endpoint on interview entitlement (Pro+/Sprint, or
  // a free account with budget left) and explains WHY it refused. Surface that
  // message verbatim -- otherwise an out-of-minutes user is told the key fetch
  // failed, which reads like a bug rather than "your free trial is used up".
  if (keyResponse.status === 402 || keyResponse.status === 403) {
    return {
      error: keyResponse.data?.error || 'Interview mode requires Pro+ or Sprint pass.',
      upgradeRequired: true,
    };
  }

  const apiKey = keyResponse.data?.key || keyResponse.data?.apiKey || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return { error: 'Failed to get Deepgram API key from server or local environment' };
  }

  const serverProfile = keyResponse.data?.profile;
  const session = {
    serverUrl: keyResponse.data?.url,
    authHeader: keyResponse.data?.authHeader || `Token ${apiKey}`,
    // One speaker per stream: diarization would only add latency and noise.
    forceNoDiarize: serverProfile !== 'split',
  };
  const expiresAt = keyResponse.data?.expiresAt;
  cachedSttSession = { session, expiresAtMs: expiresAt ? new Date(expiresAt).getTime() : null };
  return session;
}

// True between the renderer's start and stop. A stream that closes while this
// is set dropped on its own (network blip, sleep, Deepgram timeout) and is
// reopened -- previously it just died and the UI kept showing "recording"
// while nothing was transcribed.
let sttWanted = false;
let sttOptions = {};
let sttStreams = {}; // role -> stream state, see createSttStream()
let deepgramKeepAliveTimer = null;
const DEEPGRAM_MAX_RECONNECT_ATTEMPTS = 20;

// Audio that arrives while a stream is still opening (the first second of the
// interview, and any reconnect gap) is held and sent on open, so the start of
// a question is not lost. Capped at ~5s of 16kHz mono PCM16 per stream.
const PENDING_AUDIO_MAX_BYTES = 16000 * 2 * 5;

function createSttStream(role) {
  return {
    role,
    ws: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    lastAudioSentAt: 0,
    pendingAudio: [],
    pendingAudioBytes: 0,
  };
}

function sendSttStatus(state, extra = {}) {
  if (interviewView && !interviewView.webContents.isDestroyed()) {
    interviewView.webContents.send('interview-deepgram-status', { state, ...extra });
  }
}

function isStreamOpen(stream) {
  return !!stream && !!stream.ws && stream.ws.readyState === WebSocket.OPEN;
}

function anyStreamOpen() {
  return Object.values(sttStreams).some(isStreamOpen);
}

// 'connected' once every stream is up; 'reconnecting' while any is down.
function reportSttHealth() {
  const streams = Object.values(sttStreams);
  if (streams.length === 0) return;
  sendSttStatus(streams.every(isStreamOpen) ? 'connected' : 'reconnecting');
}

// Interview usage is metered by this ping. It runs per session, not per
// stream, and only while at least one stream is actually transcribing, so a
// dropped connection doesn't burn the user's free minutes.
function ensureMeteringPing() {
  if (pingInterval) return;
  pingInterval = setInterval(async () => {
    try {
      const res = await solvroFetch('/api/ai/interview_ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: Date.now() }),
      });
      if (res.status === 402 || res.status === 403) {
        sendSttStatus('error', { error: res.data?.error || 'Interview limit reached. Please upgrade.' });
        closeDeepgram();
      }
    } catch (err) {
      debugLog('Interview ping failed: ' + err.message);
    }
  }, 10000);
}

function stopMeteringPing() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// Deepgram closes a stream that gets no data for ~10s. Audio normally flows
// continuously (silence included), but if capture stalls this keeps the
// sockets up while the renderer recovers the audio graph.
function ensureKeepAlive() {
  if (deepgramKeepAliveTimer) return;
  deepgramKeepAliveTimer = setInterval(() => {
    for (const stream of Object.values(sttStreams)) {
      if (isStreamOpen(stream) && Date.now() - stream.lastAudioSentAt > 5000) {
        try { stream.ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch (_) { }
      }
    }
  }, 4000);
}

function queuePendingAudio(stream, buf) {
  stream.pendingAudio.push(buf);
  stream.pendingAudioBytes += buf.length;
  while (stream.pendingAudioBytes > PENDING_AUDIO_MAX_BYTES && stream.pendingAudio.length > 1) {
    stream.pendingAudioBytes -= stream.pendingAudio.shift().length;
  }
}

function clearPendingAudio(stream) {
  stream.pendingAudio = [];
  stream.pendingAudioBytes = 0;
}

// options.roles: which speaker streams to open. The renderer passes ['mic']
// when system audio could not be captured.
async function startDeepgram(options = {}) {
  closeDeepgram();
  // Signed-out users can explore interview mode but not start it. Checked here
  // as well as in the React UI so interview bundles built before that check
  // are gated too.
  if (!getSolvroToken()) {
    requestSignIn('interview');
    return { success: false, error: SIGN_IN_REQUIRED, authRequired: true };
  }
  const { roles, ...urlOptions } = options || {};
  const wanted = (Array.isArray(roles) ? roles : ['mic']).filter((r) => STT_ROLES.includes(r));
  if (wanted.length === 0) return { success: false, error: 'No audio source to transcribe' };

  sttWanted = true;
  sttOptions = urlOptions;
  for (const role of wanted) sttStreams[role] = createSttStream(role);

  // One credential for the opening connections; reconnects fetch their own.
  const session = await fetchSttSession().catch((err) => ({ error: err.message }));
  if (session.error) {
    closeDeepgram();
    return { success: false, error: session.error, upgradeRequired: !!session.upgradeRequired };
  }
  if (!sttWanted) return { success: false, error: 'Stopped' };

  const results = await Promise.all(
    Object.values(sttStreams).map((stream) => connectSttStream(stream, session)),
  );
  const failed = results.find((r) => !r.success);
  if (failed) {
    closeDeepgram();
    return failed;
  }
  ensureKeepAlive();
  reportSttHealth();
  return { success: true, roles: wanted };
}

function scheduleStreamReconnect(stream, reason) {
  if (!sttWanted || sttStreams[stream.role] !== stream || stream.reconnectTimer) return;
  if (stream.reconnectAttempts >= DEEPGRAM_MAX_RECONNECT_ATTEMPTS) {
    closeDeepgram();
    sendSttStatus('error', { error: 'Transcription connection lost. Press stop and start again.' });
    return;
  }
  const delay = Math.min(500 * 2 ** stream.reconnectAttempts, 5000);
  stream.reconnectAttempts += 1;
  debugLog(`Deepgram[${stream.role}] reconnect #${stream.reconnectAttempts} in ${delay}ms (${reason})`);
  reportSttHealth();
  stream.reconnectTimer = setTimeout(async () => {
    stream.reconnectTimer = null;
    if (!sttWanted || sttStreams[stream.role] !== stream) return;
    const session = await fetchSttSession().catch((err) => ({ error: err.message }));
    if (session.upgradeRequired) {
      closeDeepgram();
      sendSttStatus('error', { error: session.error });
      return;
    }
    const result = session.error ? { success: false, error: session.error } : await connectSttStream(stream, session);
    if (result.success) {
      reportSttHealth();
    } else if (sttWanted) {
      scheduleStreamReconnect(stream, result.error || 'connect failed');
    }
  }, delay);
}

function connectSttStream(stream, session) {
  const wsUrl = buildSttUrl(session.serverUrl, {
    ...sttOptions,
    ...(session.forceNoDiarize && { diarize: false }),
    // endpointing is the main low-latency lever (ms of silence before a final);
    // 200 is well within range. utterance_end_ms is only the backstop and
    // Deepgram REQUIRES it to be >= 1000 — a smaller value makes the WebSocket
    // handshake fail with HTTP 400, so it stays at the 1000 minimum.
    endpointing: 200,
    utterance_end_ms: 1000,
  });

  let ws;
  try {
    ws = new WebSocket(wsUrl, { headers: { 'Authorization': session.authHeader } });
  } catch (err) {
    return Promise.resolve({ success: false, error: err.message });
  }
  stream.ws = ws;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ws.on('open', () => {
      if (stream.ws !== ws) return;
      debugLog(`Deepgram[${stream.role}] connected`);
      stream.reconnectAttempts = 0;

      // Anything captured while the socket was opening goes first.
      for (const buf of stream.pendingAudio) {
        try { ws.send(buf); } catch (_) { /* socket state is handled by close */ }
      }
      clearPendingAudio(stream);
      stream.lastAudioSentAt = Date.now();
      ensureMeteringPing();

      ws.on('message', (data) => {
        // Drop anything from a socket that is no longer the active one for its
        // role. After a stop/start or "New Conversation", closeDeepgram() clears
        // sttStreams and this stream object is orphaned; without this guard its
        // last few buffered results (for audio spoken before the reset) would
        // still be forwarded and reappear in the fresh transcript.
        if (sttStreams[stream.role] !== stream) return;
        try {
          const response = JSON.parse(data.toString());
          // Tagged with the stream it came from: that is the speaker.
          response.role = stream.role;
          if (interviewView && !interviewView.webContents.isDestroyed()) {
            interviewView.webContents.send('interview-deepgram-transcript', response);
          }

          // Feed to LiveCoachEngine (no-op while Live Coach is disabled)
          if (liveCoachEngine && response.is_final && response.channel?.alternatives?.[0]) {
            const text = response.channel.alternatives[0].transcript?.trim();
            if (text) {
              try {
                // The engine's method is onFinalTurn({ speaker, text }) — the
                // old appendTranscriptTurn() call did not exist and threw on
                // every final transcript, swallowed as a "parse error".
                liveCoachEngine.onFinalTurn({
                  speaker: stream.role === 'sys' ? 'Interviewer' : 'User',
                  text,
                });
              } catch (err) {
                debugLog('LiveCoach onFinalTurn error: ' + err.message);
              }
            }
          }
        } catch (e) {
          debugLog('Deepgram parse error: ' + e.message);
        }
      });

      settle({ success: true });
    });

    ws.on('close', (code, reason) => {
      debugLog(`Deepgram[${stream.role}] closed: ${code} ${reason}`);
      if (stream.ws !== ws) return; // an older socket we already replaced
      stream.ws = null;
      // Don't meter minutes while nothing is being transcribed.
      if (!anyStreamOpen()) stopMeteringPing();
      if (settled) {
        scheduleStreamReconnect(stream, `closed ${code}`);
      } else {
        // Never opened with this credential -- don't hand it to the next
        // reconnect attempt too; make it fetch a fresh one.
        if (cachedSttSession && cachedSttSession.session === session) cachedSttSession = null;
        settle({ success: false, error: `Connection closed (${code})` });
      }
    });

    ws.on('error', (err) => {
      debugLog(`Deepgram[${stream.role}] error: ${err.message}`);
      // 'close' follows and drives the reconnect; this only settles a
      // connect attempt that never opened.
      settle({ success: false, error: err.message });
    });

    // Timeout after 10s
    setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        settle({ success: false, error: 'Connection timeout' });
        ws.terminate();
      }
    }, 10000);
  });
}

function sendDeepgramAudio(audioData, role = 'mic') {
  if (!sttWanted) return;
  const stream = sttStreams[role];
  if (!stream) return;
  const buf = Buffer.from(audioData);
  if (isStreamOpen(stream)) {
    try {
      stream.ws.send(buf);
      stream.lastAudioSentAt = Date.now();
    } catch (e) {
      debugLog(`Deepgram[${role}] send error: ${e.message}`);
    }
  } else {
    queuePendingAudio(stream, buf);
  }
}

function closeDeepgram() {
  sttWanted = false;
  stopMeteringPing();
  if (deepgramKeepAliveTimer) {
    clearInterval(deepgramKeepAliveTimer);
    deepgramKeepAliveTimer = null;
  }
  const streams = Object.values(sttStreams);
  sttStreams = {};
  for (const stream of streams) {
    clearPendingAudio(stream);
    if (stream.reconnectTimer) {
      clearTimeout(stream.reconnectTimer);
      stream.reconnectTimer = null;
    }
    const ws = stream.ws;
    stream.ws = null; // before close(), so its 'close' handler sees it as replaced
    if (!ws) continue;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        // Send close frame to flush remaining audio
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      ws.close();
    } catch (_) { }
  }
}

// --- AI Request Proxy ---

// The server rolls daily quotas over at midnight where the user actually is, so
// every request reports this machine's zone. Falls back to UTC on the rare
// system where Intl cannot resolve one.
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

// The proxies forward request bodies to the provider verbatim, so a Claude model
// needs an Anthropic-shaped body. Posting Gemini's `contents` at /api/ai/claude
// used to 400 upstream — after the request had already been counted against the
// user's daily quota.
function toClaudeBody(model, contents, maxTokens, system) {
  const messages = contents
    .map((entry) => ({
      role: entry.role === 'model' ? 'assistant' : 'user',
      content: (entry.parts || [])
        .map((part) => {
          if (part.text) return { type: 'text', text: part.text };
          if (part.inline_data) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.inline_data.mime_type,
                data: part.inline_data.data,
              },
            };
          }
          return null;
        })
        .filter(Boolean),
    }))
    .filter((message) => message.content.length > 0);

  // Anthropic rejects a conversation that opens on an assistant turn.
  while (messages.length > 0 && messages[0].role === 'assistant') messages.shift();

  return { model, max_tokens: maxTokens, ...(system && { system }), messages };
}

function aiEndpointFor(model) {
  return model.startsWith('claude-') ? '/api/ai/claude' : '/api/ai/gemini';
}

// Gemini and Anthropic stream different SSE payloads; either can arrive here
// depending on the selected model.
function extractStreamText(parsed) {
  if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
    return parsed.candidates[0].content.parts[0].text;
  }
  if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
    return parsed.delta.text;
  }
  if (typeof parsed === 'string') return parsed;
  return parsed.text || '';
}

// Interview mode is pinned to one model, and which model that is comes from
// the server -- the React UI no longer names it, so it can be changed from the
// website without rebuilding either the app or the interview bundle.
function interviewModel() {
  return remoteConfig.getFixedModelForMode('interview') || remoteConfig.getDefaultModel();
}

function sendToInterviewView(channel, payload) {
  if (interviewView && !interviewView.webContents.isDestroyed()) {
    interviewView.webContents.send(channel, payload);
  }
}

// The answer currently streaming. A newly detected question supersedes it:
// the old request is torn down so its tokens stop competing for the screen
// and the connection, and nothing it emits afterwards reaches the UI.
let activeAIRequest = null;

function cancelActiveAIRequest() {
  if (!activeAIRequest) return;
  const { req, state } = activeAIRequest;
  activeAIRequest = null;
  state.cancelled = true;
  try { req.destroy(); } catch (_) { }
}

// `requestId` is only passed by the model fallback below, which must keep the
// id the renderer is listening for -- a fresh id made its chunks invisible.
function sendAIRequest(params, requestId = null) {
  const { transcript, systemPrompt, conversationHistory = [], model = interviewModel(), images = [] } = params;
  if (!requestId && !getSolvroToken()) {
    requestSignIn('interview');
    return { success: false, error: SIGN_IN_REQUIRED, authRequired: true };
  }
  if (!requestId) {
    cancelActiveAIRequest();
    requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const state = { cancelled: false };

  try {
    const token = getSolvroToken();

    const contents = [];

    // Conversation history
    for (const msg of conversationHistory) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }

    // Current transcript + images
    const userParts = [{ text: transcript || 'Please answer the question shown in the screenshot.' }];
    if (images && images.length > 0) {
      for (const img of images) {
        userParts.push({ inline_data: { mime_type: "image/png", data: img } });
      }
    }

    contents.push({
      role: 'user',
      parts: userParts
    });

    // The system prompt goes in the providers' real system field. It used to be
    // sent as a fake user turn plus a canned "Understood" model turn, which the
    // model follows less reliably and which padded every request. The server
    // recognises interview requests by the x-solvro-mode header below.
    const url = new URL(aiEndpointFor(model), SOLVRO_API_BASE);
    const body = JSON.stringify(
      model.startsWith('claude-')
        ? toClaudeBody(model, contents, 2048, systemPrompt)
        : {
            model,
            contents,
            ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2048,
            },
          }
    );

    const reqOptions = {
      method: 'POST',
      agent: agentFor(url),
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        'x-timezone': localTimeZone(),
        // Free-trial interview answers are metered by interview minutes, not
        // the 10 free responses; this tells the server which kind this is. It
        // also opts the request into the server's low-latency answer config.
        'x-solvro-mode': 'interview',
        ...clientHeaders(),
        'Accept': 'text/event-stream',
      },
    };

    const sentAt = Date.now();
    let firstChunkLogged = false;
    let failed = false;

    // Fall back to the configured backup model when the request never got an
    // answer. The server already retries Vertex errors itself; this covers
    // the app not reaching the server at all.
    const tryFallback = () => {
      const fallbackModel = remoteConfig.getFallbackModel();
      if (model === fallbackModel || state.cancelled) return false;
      debugLog(`Falling back to ${fallbackModel}`);
      sendAIRequest({ ...params, model: fallbackModel }, requestId);
      return true;
    };

    const emitText = (text) => {
      if (!text || state.cancelled) return;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        debugLog(`AI first chunk after ${Date.now() - sentAt}ms (${requestId})`);
      }
      sendToInterviewView('interview-ai-chunk', { requestId, chunk: text });
    };

    const emitError = (error) => {
      if (state.cancelled || failed) return;
      failed = true;
      if (activeAIRequest?.req === req) activeAIRequest = null;
      sendToInterviewView('interview-ai-error', { requestId, error });
    };

    const handleLine = (line) => {
      if (!line.startsWith('data: ')) return;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (_) {
        emitText(data); // Raw text chunk
        return;
      }
      // The proxy reports upstream failures in-band (it has already sent a
      // 200). Treating them as text produced an empty answer and no error.
      if (parsed && parsed.error) {
        const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
        emitError(message || 'AI request failed');
        return;
      }
      emitText(extractStreamText(parsed));
    };

    const req = requestFor(url)(url, reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', chunk => errorData += chunk);
        res.on('end', () => {
          if (state.cancelled) return;
          debugLog(`AI request failed: ${res.statusCode} ${errorData}`);

          if ((res.statusCode === 429 || res.statusCode >= 500) && tryFallback()) return;

          emitError(`AI request failed (${res.statusCode}): ${errorData}`);
        });
        return;
      }

      // Stream SSE response
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        if (state.cancelled) return;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
      });

      res.on('end', () => {
        if (state.cancelled) return;
        // Process any remaining buffer
        if (buffer.trim()) {
          for (const line of buffer.split('\n')) handleLine(line);
        }
        if (activeAIRequest?.req === req) activeAIRequest = null;
        if (!failed) sendToInterviewView('interview-ai-done', { requestId });
        debugLog(`AI response complete for ${requestId} in ${Date.now() - sentAt}ms`);
      });

      res.on('error', (err) => {
        debugLog('AI response stream error: ' + err.message);
        emitError(err.message);
      });
    });

    req.on('error', (err) => {
      if (state.cancelled) return;
      debugLog('AI request error: ' + err.message);
      if (tryFallback()) return;
      emitError(err.message);
    });

    activeAIRequest = { req, state };
    req.write(body);
    req.end();

    return { success: true, requestId };
  } catch (err) {
    debugLog('AI request setup error: ' + err.message);
    return { success: false, error: err.message };
  }
}


// --- LiveCoach Engine Integration ---
const { LiveCoachEngine } = require('./liveCoach.js');
const { createLiveCoachRuntime } = require('./liveCoachRuntime.js');

let liveCoachEngine = null;

async function executeAIRequestSync(payload) {
  const token = getSolvroToken();

  let resolvedModel = payload.model || remoteConfig.getDefaultModel();
  // LiveCoach uses openai/gpt-oss-120b as a generic placeholder for "use the default".
  if (resolvedModel.startsWith('openai/')) {
    resolvedModel = remoteConfig.getDefaultModel();
  }

  const url = new URL(aiEndpointFor(resolvedModel), SOLVRO_API_BASE);
  const contents = [];
  for (const msg of payload.messages) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  const maxTokens = payload.max_tokens ?? 2048;
  const body = JSON.stringify(
    resolvedModel.startsWith('claude-')
      ? toClaudeBody(resolvedModel, contents, maxTokens)
      : {
          model: resolvedModel,
          contents,
          generationConfig: {
            temperature: payload.temperature ?? 0.7,
            maxOutputTokens: maxTokens,
          },
        }
  );

  return new Promise((resolve) => {
    const reqOptions = {
      method: 'POST',
      agent: agentFor(url),
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        'x-timezone': localTimeZone()
      },
    };

    const req = requestFor(url)(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const liveCoachFallback = remoteConfig.getFallbackModel();
        if (res.statusCode !== 200 && payload.model !== liveCoachFallback) {
          debugLog(`LiveCoach AI fallback to ${liveCoachFallback} triggered`);
          resolve(executeAIRequestSync({ ...payload, model: liveCoachFallback }));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          let text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || parsed.text || data;

          resolve({
            ok: true,
            status: 200,
            headers: { get: () => '' },
            json: async () => ({
              choices: [{ message: { content: text } }]
            }),
            text: async () => text
          });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, text: async () => data });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, status: 500, text: async () => err.message });
    });

    req.write(body);
    req.end();
  });
}

// Live Coach (the separate question-detection + talking-points engine) is off.
// It never actually ran before — its transcript feed called a method that did
// not exist and threw on every turn — so enabling it now would change how the
// panel behaves rather than restore anything. Flip this to true to turn it on
// once its output has been tuned; the wiring underneath is correct.
const LIVE_COACH_ENABLED = false;

function initLiveCoach() {
  if (liveCoachEngine) return;
  if (!LIVE_COACH_ENABLED) {
    debugLog('LiveCoach disabled — using transcript-driven answers only');
    return;
  }

  const runtime = createLiveCoachRuntime({
    workerUrl: 'https://mock',
    // Required: the runtime refuses to issue a request when the token is
    // unusable, so without this every card generation was rejected before
    // fetchImpl was ever reached.
    getAuthToken: () => getSolvroToken(),
    clientType: 'oacopilot-desktop',
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      return await executeAIRequestSync(payload);
    }
  });

  liveCoachEngine = new LiveCoachEngine({
    sendIpc: (channel, payload) => {
      if (interviewView && !interviewView.webContents.isDestroyed()) {
        interviewView.webContents.send(channel, payload);
      }
    },
    generateCards: runtime.generateLiveCoachCards,
    classifyTurn: runtime.generateLiveCoachIntent
  });

  // Enable the engine
  liveCoachEngine.setEnabled(true);

  // Fetch settings and start session with context
  solvroFetch('/api/user/settings').then(response => {
    const settings = response.data?.settings || {};
    let briefParts = [];

    if (settings.interviewTopic) {
      briefParts.push('Interview context: Interviewing for the role of ' + settings.interviewTopic);
    }
    if (settings.professionalSummary || settings.workExperience) {
      briefParts.push('Resume/Profile:\n' + [settings.professionalSummary, settings.workExperience].filter(Boolean).join('\n\n'));
    }
    if (settings.jobDescription) {
      briefParts.push('Job Description:\n' + settings.jobDescription);
    }
    if (settings.extraContext || settings.customInstructions) {
      briefParts.push('Extra Context/Instructions:\n' + [settings.extraContext, settings.customInstructions].filter(Boolean).join('\n'));
    }

    liveCoachEngine.startSession({
      brief: briefParts.join('\n\n---\n\n'),
      answerLanguage: 'English'
    });

    debugLog('LiveCoachEngine initialized and started with personalized context');
  }).catch(err => {
    debugLog('Failed to fetch user settings for LiveCoach context: ' + err.message);
    liveCoachEngine.startSession({ brief: '', answerLanguage: 'English' });
  });
}

function destroyLiveCoach() {
  if (liveCoachEngine) {
    // NOTE: the engine exposes stopSession(), not destroy(). Calling the wrong
    // one here left session timers running for the lifetime of the app.
    try { liveCoachEngine.stopSession(); } catch (err) {
      debugLog('Error stopping LiveCoach session: ' + err.message);
    }
    liveCoachEngine = null;
  }
}

// --- IPC Handlers ---

function setupIpcHandlers() {
  // The engine's API is onFinalTurn({ speaker, text, start, end }) with speaker
  // strictly "Interviewer" | "User" — anything else is ignored downstream.
  ipcMain.on('interview-transcript-update', (_event, payload) => {
    if (!liveCoachEngine || !payload) return;

    const speaker = payload.speaker === 'Interviewer' ? 'Interviewer' : 'User';
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) return;

    try {
      liveCoachEngine.onFinalTurn({
        speaker,
        text,
        start: typeof payload.start === 'number' ? payload.start : null,
        end: typeof payload.end === 'number' ? payload.end : null,
      });
    } catch (err) {
      debugLog('LiveCoach onFinalTurn error: ' + err.message);
    }
  });

  ipcMain.on('interview-livecoach-action', (_event, action) => {
    if (liveCoachEngine) {
      if (action.type === 'pause') liveCoachEngine.pauseSession();
      if (action.type === 'resume') liveCoachEngine.resumeSession();
      if (action.type === 'trigger') {
        // trigger generation for current question
        if (liveCoachEngine._currentQuestion) {
          liveCoachEngine._triggerGeneration(liveCoachEngine._currentQuestion);
        }
      }
    }
  });

  // --- Deepgram STT ---
  ipcMain.handle('interview-deepgram-start', async (_event, options) => {
    return await startDeepgram(options);
  });

  ipcMain.on('interview-deepgram-audio', (_event, audioData, role) => {
    sendDeepgramAudio(audioData, role);
  });

  ipcMain.handle('interview-deepgram-stop', async () => {
    closeDeepgram();
  });

  // --- AI Requests ---
  ipcMain.handle('interview-ai-request', async (_event, params) => {
    return sendAIRequest(params);
  });

  ipcMain.on('interview-ai-cancel', () => {
    cancelActiveAIRequest();
  });

  // Server-side question detector for lines the local rules can't classify.
  // Anything but a clean decision comes back as 'unavailable', so the renderer
  // falls back to its local rules instead of stalling the interview.
  ipcMain.handle('interview-detect', async (_event, payload) => {
    const startedAt = Date.now();
    try {
      const res = await solvroFetch('/api/ai/interview-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-solvro-mode': 'interview' },
        body: JSON.stringify(payload || {}),
        timeoutMs: 4000,
      });
      debugLog(`interview-detect ${res.status} ${res.data?.action || ''} in ${Date.now() - startedAt}ms`);
      if (res.status !== 200 || !res.data || typeof res.data.action !== 'string') {
        // 404 = a backend that predates the detector.
        return { action: 'unavailable', reason: res.status === 404 ? 'not_deployed' : `http_${res.status}` };
      }
      return res.data;
    } catch (err) {
      debugLog('interview-detect failed: ' + err.message);
      return { action: 'unavailable', reason: err.message === 'timeout' ? 'timeout' : 'network' };
    }
  });

  ipcMain.on('interview-require-sign-in', () => {
    requestSignIn('interview');
  });

  // --- Theme ---
  ipcMain.handle('interview-get-theme', () => {
    return currentTheme;
  });

  // --- Keyboard shortcuts ---
  ipcMain.handle('interview-get-shortcuts', () => {
    return getFormattedShortcuts();
  });

  // --- User Context ---
  ipcMain.handle('interview-get-token', () => {
    return getSolvroToken();
  });

  ipcMain.handle('interview-get-user-settings', async () => {
    try {
      const response = await solvroFetch('/api/user/settings');
      // THE FIX: /api/user/settings responds with { settings, hasPassword }.
      // Returning that envelope meant the renderer read every field one level
      // too high (settings.professionalSummary etc. were all undefined), so
      // the resume and JD never made it into the prompt. Return the settings
      // object itself, matching main.js's fetch-user-settings handler.
      const settings = response.data?.settings || response.data || {};
      debugLog(
        `User settings loaded (resume=${!!(settings.professionalSummary || settings.workExperience)}, ` +
        `jd=${!!settings.jobDescription}, topic=${!!settings.interviewTopic})`
      );
      return settings;
    } catch (err) {
      debugLog('Failed to get user settings: ' + err.message);
      return {};
    }
  });

  // --- Interview Ping (usage tracking) ---
  ipcMain.handle('interview-ping', async () => {
    try {
      await solvroFetch('/api/ai/interview_ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: Date.now() }),
      });
    } catch (err) {
      debugLog('Interview ping failed: ' + err.message);
    }
  });

  // --- Screen capture sources ---
  ipcMain.handle('interview-get-sources', async () => {
    try {
      // Callers (system-audio capture, screenshot source lookup) only ever
      // match on id/name to find the screen source -- thumbnails are never
      // read, so skip rendering them (thumbnailSize: 0x0) rather than paying
      // for a bitmap of every screen and window on each connect.
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      return sources.map(source => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
      }));
    } catch (error) {
      debugLog('Error getting sources: ' + error.message);
      return [];
    }
  });

  // --- Screenshot ---
  ipcMain.handle('interview-take-screenshot', async () => {
    try {
      const ScreenshotService = require('./screenshot.js');
      const screenshot = new ScreenshotService();
      const base64 = await screenshot.captureScreen();
      return base64;
    } catch (e) {
      debugLog('Error taking screenshot: ' + e.message);
      return null;
    }
  });

  // --- Clipboard ---
  ipcMain.handle('interview-write-clipboard', (_event, text) => {
    if (typeof text !== 'string') return false;
    try {
      clipboard.writeText(text);
      return true;
    } catch (error) {
      debugLog('Clipboard error: ' + error.message);
      return false;
    }
  });

  // --- Window operations ---
  ipcMain.on('interview-set-opacity', (_event, value) => {
    if (mainWindowRef && typeof value === 'number') {
      mainWindowRef.setOpacity(value);
    }
  });

  ipcMain.on('interview-set-content-protection', (_event, value) => {
    if (mainWindowRef) {
      mainWindowRef.setContentProtection(value !== false);
    }
  });

  ipcMain.handle('interview-get-window-position', () => {
    if (!mainWindowRef) return { x: 0, y: 0 };
    const [x, y] = mainWindowRef.getPosition();
    return { x, y };
  });

  ipcMain.handle('interview-get-window-size', () => {
    if (!mainWindowRef) return { width: 500, height: 600 };
    const [width, height] = mainWindowRef.getSize();
    return { width, height };
  });

  ipcMain.handle('interview-get-screen-size', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return { width, height };
  });
}

// The signed-in account changed (login or logout). Stop anything running under
// the old session and reload the interview UI so it drops the previous user's
// transcript, answers and resume context and picks up the new account's.
function resetForAuthChange() {
  closeDeepgram();
  cancelActiveAIRequest();
  if (interviewView && !interviewView.webContents.isDestroyed()) {
    try { interviewView.webContents.reload(); } catch (_) { }
  }
}

// --- Public API ---

module.exports = {
  startInterviewServer,
  stopInterviewServer,
  createInterviewView,
  destroyInterviewView,
  hideInterviewView,
  showInterviewView,
  suspendInterviewView,
  resumeInterviewView,
  resetForAuthChange,
  setupIpcHandlers,
  isActive: () => isInterviewActive,
  getView: () => interviewView,
  setTheme,
  pushShortcutsUpdate,
  setMenuClearTop,
  setContentTop,
  INTERVIEW_PORT
};
