const path = require('path');
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, nativeImage, Notification, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
let autoUpdater;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}
const interviewBridge = require('./src/utils/interviewBridge');
const shortcutManager = require('./src/utils/shortcutManager');
const remoteConfig = require('./src/utils/remoteConfig');

// Lazy-load GlobalKeyboardListener to reduce startup cost

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance already holds the lock. Do NOT call dialog.* here — this
  // runs before app 'ready', and the dialog module throws "can only be used
  // after app is ready", which surfaced as an ugly main-process crash. The
  // first instance already focuses its window via the 'second-instance' handler
  // below, so just exit quietly.
  console.log("App is already running, quitting this instance.");
  app.quit();
  // Exit early to prevent further execution in this instance
  process.exit(0);
}

app.on('second-instance', (event, commandLine, workingDirectory) => {
  // The app was closed and is only finishing a forced update in the background,
  // so there is no window to focus. Start fresh; that session picks the download
  // back up.
  if (backgroundUpdate === 'running') {
    logToFile('Reopened while finishing an update in the background: relaunching');
    flushLogBufferSync();
    app.relaunch();
    app.exit(0);
    return;
  }

  // A reinstall (or the installer's runAfterFinish + the script's own launch)
  // starts the app while an instance is already running. That freshly-minted
  // session token is sitting in %TEMP%, but migrateOldTokens() only ran at cold
  // start, so without this the running instance never picks it up and the user
  // stays on the login screen. Re-adopt here and ask the renderer to re-check
  // auth so the login overlay clears without a manual restart.
  try {
    if (migrateOldTokens()) {
      logToFile('second-instance: adopted freshly-installed session token; refreshing auth UI');
      sendToRenderer('auth-refresh');
    }
  } catch (err) {
    logToFile(`second-instance token adoption failed: ${err.message}`);
  }

  // Someone tried to run a second instance, we should focus our window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    // Also if window is hidden, we might want to show it
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

// --- Remote Authentication System ---

const { readSessionToken, writeSessionToken } = require('./src/utils/sessionToken');

const AUTH_LOCAL_PORT = 18234;

// --- Token Migration (OaCopilot / TmpDir → UserData) ---
// Automatically migrate old token/profile files so existing users don't need to re-login
const migrateOldTokens = () => {
  const oldTmpToken = path.join(os.tmpdir(), 'solvro-token.txt');
  const oldTmpProfile = path.join(os.tmpdir(), 'solvro-profile.json');
  const legacyTmpToken = path.join(os.tmpdir(), 'oacopilot-token.txt');
  const legacyTmpProfile = path.join(os.tmpdir(), 'oacopilot-profile.json');
  
  const newToken = path.join(app.getPath('userData'), 'solvro-token.txt');
  const newProfile = path.join(app.getPath('userData'), 'solvro-profile.json');

  // The installer writes the freshly minted session token to %TEMP% (the one
  // folder the installer and Node's os.tmpdir() resolve identically — the app's
  // userData path is only known to the app itself, so the installer can't write
  // there reliably). ALWAYS adopt a temp token, overwriting any older token from
  // a previous install/session, so a new install logs in as the account that
  // just installed instead of a stale one. Then delete the temp copy so it can't
  // be re-adopted on a later launch. A normal in-app login writes userData
  // directly and never leaves a temp token, so this only fires right after an
  // install and never clobbers an interactive login.
  const freshTmpToken = fs.existsSync(oldTmpToken) ? oldTmpToken
                      : fs.existsSync(legacyTmpToken) ? legacyTmpToken
                      : null;
  let adopted = false;
  if (freshTmpToken) {
    try {
      fs.copyFileSync(freshTmpToken, newToken);
      adopted = true;
    } catch (_) { }
    for (const p of [oldTmpToken, legacyTmpToken]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { }
    }
  }

  const freshTmpProfile = fs.existsSync(oldTmpProfile) ? oldTmpProfile
                        : fs.existsSync(legacyTmpProfile) ? legacyTmpProfile
                        : null;
  if (freshTmpProfile && !fs.existsSync(newProfile)) {
    try { fs.copyFileSync(freshTmpProfile, newProfile); } catch (_) { }
  }

  // True only when a freshly-installed temp token was just adopted, so callers
  // can tell "a new install just logged in" from "nothing changed".
  return adopted;
};

// Cold-start adoption. logToFile isn't defined yet at module-eval time, so we
// stash the result and log it once app.whenReady() runs.
const installTokenAdoptedAtStartup = migrateOldTokens();

ipcMain.handle('check-auth', () => {
  // Presence of the file is not enough — an interrupted write leaves a
  // zero-byte token that passes existsSync but 401s on every request, which
  // reads to the user as "it logged me out but still thinks I'm signed in".
  const token = readSessionToken();
  const isAuth = !!token;
  logToFile(`check-auth called: token=${token ? token.slice(0, 20) + '...' : '(empty)'}, result=${isAuth}`);
  // Re-write the token to touch the file timestamp — ensures hope.exe sees
  // the current token even if no login/refresh has run this session.
  if (token) {
    const ok = writeSessionToken(token);
    logToFile(`check-auth: re-wrote token to disk: ${ok}`);
  }
  return isAuth;
});

ipcMain.handle('logout', () => {
  // Never throw out of here: an unlink that fails (file locked by AV, or
  // already gone) used to reject the IPC call, and the renderer's
  // `await window.electronAPI.logout()` threw before it could reset the UI,
  // leaving the app in a half-signed-out state.
  const tokenPath = path.join(app.getPath('userData'), 'solvro-token.txt');
  const profilePath = path.join(app.getPath('userData'), 'solvro-profile.json');
  logToFile(`LOGOUT: deleting token at ${tokenPath}`);
  for (const p of [tokenPath, profilePath]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        logToFile(`LOGOUT: deleted ${p}`);
      } else {
        logToFile(`LOGOUT: file not found ${p}`);
      }
    } catch (err) {
      logToFile(`LOGOUT: FAILED to remove ${p}: ${err.message}`);
      console.error(`logout: could not remove ${p}: ${err.message}`);
    }
  }
  // Signing out returns the app to its freshly-installed state: stop any
  // interview still running on the old session and drop the conversation so
  // the next person to sign in doesn't see it.
  try { interviewBridge.resetForAuthChange(); } catch (err) {
    console.error(`logout: interview reset failed: ${err.message}`);
  }
  try { if (aiService) aiService.resetConversation(); } catch (err) {
    console.error(`logout: conversation reset failed: ${err.message}`);
  }
  return true;
});

ipcMain.handle('get-cached-profile', async () => {
  const profilePath = path.join(app.getPath('userData'), 'solvro-profile.json');
  if (fs.existsSync(profilePath)) {
    try {
      return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (_) { }
  }
  return null;
});

ipcMain.handle('get-user-profile', async () => {
  const profilePath = path.join(app.getPath('userData'), 'solvro-profile.json');

  if (!readSessionToken()) return null;

  // Return cached profile if fresh (< 5 minutes old)
  if (fs.existsSync(profilePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (Date.now() - cached._fetchedAt < 5 * 60 * 1000) {
        return cached;
      }
    } catch (_) { /* stale cache, refetch */ }
  }

  try {
    const token = readSessionToken();
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://solvro.in/api/user/me', {
        headers: {
          'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (data && data.email) {
      data._fetchedAt = Date.now();
      fs.writeFileSync(profilePath, JSON.stringify(data), 'utf8');
    }
    return data;
  } catch (err) {
    console.error('get-user-profile error:', err.message);
    return null;
  }
});

// The Usage panel's rows, straight from /api/user/usage. Never cached: the
// point of the panel is the current count. Resolves to { ok, data } or
// { ok: false, reason } so the panel can tell signed-out from offline.
ipcMain.handle('get-usage', async () => {
  const token = readSessionToken();
  if (!token) return { ok: false, reason: 'signed_out' };

  try {
    const https = require('https');
    const { clientHeaders } = require('./src/utils/clientInfo');
    const url = new URL('/api/user/usage', remoteConfig.API_BASE);
    return await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          ...clientHeaders(),
          'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401) return resolve({ ok: false, reason: 'signed_out' });
          if (res.statusCode !== 200) return resolve({ ok: false, reason: 'server' });
          try { resolve({ ok: true, data: JSON.parse(body) }); } catch (_) { resolve({ ok: false, reason: 'server' }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch (err) {
    console.error('get-usage error:', err.message);
    return { ok: false, reason: 'offline' };
  }
});

ipcMain.handle('fetch-user-settings', async () => {
  const settingsPath = path.join(app.getPath('userData'), 'solvro-settings.json');

  if (!readSessionToken()) return null;

  // Return cached settings if fresh (< 10 seconds old)
  if (fs.existsSync(settingsPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (Date.now() - cached._fetchedAt < 10 * 1000) {
        return cached.settings || cached;
      }
    } catch (_) { /* stale cache, refetch */ }
  }

  try {
    const token = readSessionToken();
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://solvro.in/api/user/settings', {
        headers: {
          'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (data && data.settings) {
      data._fetchedAt = Date.now();
      fs.writeFileSync(settingsPath, JSON.stringify(data), 'utf8');
      return data.settings;
    }
    return null;
  } catch (err) {
    console.error('fetch-user-settings error:', err.message);
    return null;
  }
});

// --- Session keep-alive ---
//
// The session token is a JWT on disk with a fixed expiry and nothing ever
// renewed it, so a working install would one day start failing every request at
// once and drop the user at a login screen for no visible reason. Walk the
// expiry forward while the token is still valid: once at startup and once a day
// after that. A failure here is deliberately silent — the existing token stays
// in place and keeps working until its own expiry, so a flaky network or an
// older backend without this route costs nothing.
const TOKEN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function refreshSessionToken() {
  const token = readSessionToken();
  if (!token) return false;

  try {
    const https = require('https');
    const url = new URL('/api/auth/desktop-refresh', remoteConfig.API_BASE);

    const data = await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Length': 0,
          'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          // A 401 means the token is already dead — there is nothing to renew,
          // and clearing it here would only turn a recoverable state into a
          // forced logout. Leave it; the normal auth path will handle it.
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    if (data && data.success && data.sessionToken) {
      logToFile(`REFRESH: got new token, length=${data.sessionToken.length}, writing...`);
      if (writeSessionToken(data.sessionToken)) {
        logToFile('REFRESH: writeSessionToken SUCCESS');
        return true;
      } else {
        logToFile('REFRESH: writeSessionToken FAILED');
      }
    }
  } catch (err) {
    logToFile(`Session refresh failed (non-fatal): ${err.message}`);
  }
  return false;
}

function startSessionKeepAlive() {
  // Refresh token immediately so the file is fresh before overlay mode can launch.
  // The old 15s delay caused the Electron app to quit (overlay launch) before
  // the refresh ever fired, leaving a stale token on disk.
  const initial = setTimeout(() => { refreshSessionToken(); }, 2000);
  if (initial.unref) initial.unref();

  const timer = setInterval(() => { refreshSessionToken(); }, TOKEN_REFRESH_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

// Asks the website for a speech-to-text session. The response carries the
// credential *and* the exact WebSocket URL to open, so the STT vendor, model,
// language and tuning are all server-side decisions. The app only opens what it
// is handed.
//
// `profile` selects between the capture shapes the app supports — 'dual' for the
// two-socket path that separates speakers itself, 'diarized' for the single
// socket that lets the vendor do it.
async function fetchSttSession(profile) {
  const token = readSessionToken();
  if (!token) return null;

  const https = require('https');
  const requestUrl = new URL('/api/keys/deepgram', remoteConfig.API_BASE);
  if (profile) requestUrl.searchParams.set('profile', profile);

  const data = await new Promise((resolve, reject) => {
    const req = https.get(requestUrl, {
      headers: {
        'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });

  // Response is { key, url, protocols, ... }, or — against an older backend —
  // { key } or the bare key string.
  const key = typeof data === 'object' ? (data.key || data.apiKey) : data;
  if (!key) return null;

  const stt = remoteConfig.getSttProfile(profile).stt;

  return {
    key,
    // Fall back to building the URL locally when the backend predates the
    // richer response, so this keeps working during a staged rollout.
    url: (typeof data === 'object' && data.url) || remoteConfig.buildSttUrl(profile),
    protocols: (typeof data === 'object' && data.protocols) || [stt.protocolPrefix, key],
    authHeader: (typeof data === 'object' && data.authHeader) || `Token ${key}`,
    provider: (typeof data === 'object' && data.provider) || stt.provider,
  };
}

ipcMain.handle('get-stt-session', async (_event, profile) => {
  try {
    return await fetchSttSession(profile);
  } catch (err) {
    console.error('get-stt-session error:', err.message);
    return null;
  }
});

// A kept-alive connection pool to the backend, so a second dictation (or any
// repeat request) skips the DNS + TCP + TLS handshake — a few hundred ms saved
// per call on a far edge. The transcription itself is server-side (Gemini Flash)
// and unaffected, but the round-trip overhead is cut.
const backendKeepAliveAgent = new (require('https').Agent)({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 8,
});

// Query-mode dictation: posts a recorded clip to the website, which transcribes it
// with Gemini Flash and returns only the text. The renderer drops that text into
// the composer for the user to edit and send. Transcription is free — the server
// doesn't count it as an AI response.
ipcMain.handle('transcribe-audio', async (_event, audio) => {
  try {
    const token = readSessionToken();
    if (!token) return { success: false, error: 'Please sign in to use voice input' };
    if (!audio || typeof audio.data !== 'string' || !audio.data) {
      return { success: false, error: 'No audio recorded' };
    }

    const https = require('https');
    const body = JSON.stringify({ audio: audio.data, mimeType: audio.mimeType || 'audio/wav' });
    const requestUrl = new URL('/api/ai/transcribe', remoteConfig.API_BASE);

    const { status, data } = await new Promise((resolve, reject) => {
      const req = https.request(requestUrl, {
        method: 'POST',
        agent: backendKeepAliveAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Cookie': `next-auth.session-token=${token}; __Secure-next-auth.session-token=${token}`,
        },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { /* non-JSON error page */ }
          resolve({ status: res.statusCode, data: parsed });
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Transcription timed out')); });
      req.write(body);
      req.end();
    });

    if (status !== 200 || !data || typeof data.text !== 'string') {
      return { success: false, error: (data && data.error) || `Transcription failed (${status})` };
    }
    return { success: true, text: data.text };
  } catch (err) {
    console.error('transcribe-audio error:', err.message);
    return { success: false, error: err.message };
  }
});

// Kept for callers that only ever wanted the raw credential.
ipcMain.handle('get-deepgram-key', async () => {
  try {
    const session = await fetchSttSession();
    return session ? session.key : null;
  } catch (err) {
    console.error('get-deepgram-key error:', err.message);
    return null;
  }
});

ipcMain.handle('start-login', async (_event, opts) => {
  // "Create a free account" sends { mode: 'signup' } so the browser opens on the
  // sign-up tab; the rest of the flow (token back to AUTH_LOCAL_PORT) is the same.
  const modeQuery = opts && opts.mode === 'signup' ? '&mode=signup' : '';
  return new Promise((resolve) => {
    const http = require('http');
    const { shell } = require('electron');

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${AUTH_LOCAL_PORT}`);
      if (url.pathname === '/auth-callback') {
        const token = url.searchParams.get('token');
        if (token) {
          logToFile(`LOGIN (start-login): got token, length=${token.length}, writing...`);
          const writeOk = writeSessionToken(token);
          logToFile(`LOGIN (start-login): writeSessionToken returned ${writeOk}`);
          try { interviewBridge.resetForAuthChange(); } catch (_) { }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="background:white;color:black;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <h1>Logged in successfully</h1>
              </body>
            </html>
          `);
          server.close();
          resolve(true);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication failed. Please try again.</h1></body></html>');
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(AUTH_LOCAL_PORT, '127.0.0.1', () => {
      shell.openExternal(`https://solvro.in/auth/desktop?port=${AUTH_LOCAL_PORT}${modeQuery}`);
    });

    server.on('error', (err) => {
      console.error('Auth server error:', err);
      shell.openExternal(`https://solvro.in/auth/desktop?port=${AUTH_LOCAL_PORT}${modeQuery}`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (!readSessionToken()) {
        console.error('Authentication timed out.');
        server.close();
        resolve(false);
      }
    }, 300000);
  });
});

ipcMain.handle('email-password-login', async (event, { email, password }) => {
  try {
    const https = require('https');

    return new Promise((resolve) => {
      const postData = JSON.stringify({ email, password });

      const options = {
        hostname: 'solvro.in',
        port: 443,
        path: '/api/auth/desktop-login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode === 200 && parsed.success && parsed.sessionToken) {
              logToFile(`LOGIN (email-password): got token, length=${parsed.sessionToken.length}, writing...`);
              const writeOk = writeSessionToken(parsed.sessionToken);
              logToFile(`LOGIN (email-password): writeSessionToken returned ${writeOk}`);
              try { interviewBridge.resetForAuthChange(); } catch (_) { }
              resolve({ success: true });
            } else {
              resolve({ success: false, error: parsed.error || 'Login failed' });
            }
          } catch (e) {
            resolve({ success: false, error: 'Invalid server response' });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: 'Network error. Please check your connection.' });
      });

      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ success: false, error: 'Request timed out' });
      });

      req.write(postData);
      req.end();
    });
  } catch (err) {
    return { success: false, error: 'Unexpected error' };
  }
});

ipcMain.handle('open-external', (event, url) => {
  const { shell } = require('electron');
  // Whitelist to only allow the dashboard URL
  if (typeof url === 'string' && (url.startsWith('https://solvro.in/') || url.startsWith('https://oacopilot.netlify.app/'))) {
    shell.openExternal(url);
  }
});

ipcMain.handle('get-desktop-sources', async () => {
  const { desktopCapturer } = require('electron');
  try {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    // Only return serializable properties (NativeImage objects can't cross IPC cleanly)
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (err) {
    console.error('Error getting desktop sources:', err);
    return [];
  }
});

// --- Debug Logging System ---
const logFilePath = path.join(app.getPath('userData'), 'electron-app-log.txt');

// Clear the log file on each startup
try {
  fs.writeFileSync(logFilePath, '');
} catch (e) {
  console.log('Could not clear log file.');
}

// Logging is buffered and flushed asynchronously.
//
// This used to be a plain fs.appendFileSync per call. logToFile is on hot paths —
// notably the global key listener, which logs twice for EVERY keystroke the user
// types anywhere on the machine — so each keypress blocked the main thread on a
// disk write. With Defender (or any AV) inspecting the file, those writes can
// stall for hundreds of milliseconds, and a blocked main thread is exactly what
// Windows reports as "Solvro is not responding".
const LOG_FLUSH_MS = 1000;
const LOG_BUFFER_MAX = 200;
let logBuffer = [];
let logFlushTimer = null;
let logWriteInFlight = false;

const flushLogBuffer = () => {
  if (logWriteInFlight || logBuffer.length === 0) return;
  const chunk = logBuffer.join('');
  logBuffer = [];
  logWriteInFlight = true;
  fs.appendFile(logFilePath, chunk, 'utf8', () => {
    logWriteInFlight = false;
    // More arrived while the write was in flight — keep draining.
    if (logBuffer.length > 0) flushLogBuffer();
  });
};

const logToFile = (message) => {
  try {
    const timestamp = new Date().toISOString();
    logBuffer.push(`${timestamp}: ${message}\n`);
    // Never let the buffer grow without bound if the disk is wedged.
    if (logBuffer.length > LOG_BUFFER_MAX * 2) {
      logBuffer = logBuffer.slice(-LOG_BUFFER_MAX);
    }
    if (logBuffer.length >= LOG_BUFFER_MAX) {
      flushLogBuffer();
      return;
    }
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => {
        logFlushTimer = null;
        flushLogBuffer();
      }, LOG_FLUSH_MS);
      if (logFlushTimer.unref) logFlushTimer.unref();
    }
  } catch (e) {
    console.log('Could not write to log file.');
  }
};

// Last-chance flush so a crash report isn't lost in the buffer. Sync is fine
// here: the process is on its way out either way.
const flushLogBufferSync = () => {
  if (logBuffer.length === 0) return;
  const chunk = logBuffer.join('');
  logBuffer = [];
  try { fs.appendFileSync(logFilePath, chunk, 'utf8'); } catch (_) { }
};

// Catch uncaught exceptions
process.on('uncaughtException', (error, origin) => {
  logToFile(`!!!!!!!!!! UNCAUGHT EXCEPTION !!!!!!!!!!!`);
  logToFile(`Error: ${error ? error.stack : 'N/A'}`);
  logToFile(`Origin: ${origin}`);
  flushLogBufferSync();
  // app.quit(); // removed to prevent crashing on its own
});

process.on('unhandledRejection', (reason) => {
  logToFile(`!!!!!!!!!! UNHANDLED REJECTION !!!!!!!!!!!`);
  logToFile(`Reason: ${reason && reason.stack ? reason.stack : reason}`);
});

// Every message to the renderer goes through here.
//
// mainWindow can be alive while its webContents is already gone (during quit, a
// reload, or after a renderer crash), and webContents.send() on a destroyed
// target throws. Those throws used to land in uncaughtException above — which no
// longer quits the app — leaving whatever operation was mid-flight silently
// abandoned. A dropped message is always better than an aborted send path.
const sendToRenderer = (channel, ...args) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return false;
    wc.send(channel, ...args);
    return true;
  } catch (err) {
    logToFile(`sendToRenderer(${channel}) failed: ${err.message}`);
    return false;
  }
};

logToFile('App starting...');

// Load modules with error handling
let config, AIService, ScreenshotService, StealthService;

try {
  logToFile('Loading config module...');
  config = require(path.join(__dirname, 'src/utils/config.js'));
  logToFile('Config loaded successfully.');
} catch (error) {
  logToFile(`Failed to load config: ${error.stack}`);
}

try {
  logToFile('Loading AIService module...');
  AIService = require(path.join(__dirname, 'src/utils/aiService.js'));
  logToFile('AIService module loaded successfully.');
} catch (error) {
  logToFile(`Failed to load AIService: ${error.stack}`);
}

try {
  logToFile('Loading ScreenshotService module...');
  ScreenshotService = require(path.join(__dirname, 'src/utils/screenshot.js'));
  logToFile('ScreenshotService module loaded successfully.');
} catch (error) {
  logToFile(`Failed to load ScreenshotService: ${error.stack}`);
}

try {
  logToFile('Loading StealthService module...');
  StealthService = require(path.join(__dirname, 'src/utils/stealth.js'));
  logToFile('StealthService module loaded successfully.');
} catch (error) {
  logToFile(`Failed to load StealthService: ${error.stack}`);
}

let LocalStorageService;
try {
  logToFile('Loading LocalStorageService module...');
  LocalStorageService = require(path.join(__dirname, 'src/utils/localStorage.js'));
  logToFile('LocalStorageService module loaded successfully.');
} catch (error) {
  logToFile(`Failed to load LocalStorageService: ${error.stack}`);
}

// Fix cache directory issues 
const userDataPath = app.getPath('userData');
const cachePath = path.join(userDataPath, 'cache');

// Ensure cache directory exists and is writable
try {
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath, { recursive: true });
  }
  // Set cache path to a writable location
  app.setPath('cache', cachePath);
} catch (error) {
  console.log('Cache directory setup:', error.message);
  // Use temp directory as fallback
  app.setPath('cache', path.join(app.getPath('userData'), 'electron-cache'));
}

// --- Global Keyboard Listener Setup (lazy) ---
let keyboardListener = null;
let isGlobalKeyCaptureActive = false;
let lastProcessedKeys = new Map(); // Track to prevent duplicates

const ensureKeyboardListener = () => {
  if (keyboardListener) return;
  try {
    const { GlobalKeyboardListener } = require('node-global-key-listener');
    keyboardListener = new GlobalKeyboardListener();
    logToFile('GlobalKeyboardListener initialized (lazy)');

    // Handle any errors from the keyboard listener's internal processes
    if (keyboardListener && keyboardListener.on) {
      keyboardListener.on('error', (error) => {
        logToFile(`GlobalKeyboardListener error event: ${error.message}`);
      });
    }

    keyboardListener.addListener((e, down) => {
      // Intercept and swallow Escape/F8 keys during auto-typing
      if (isAutoTyping && e.state === 'DOWN') {
        const keyName = e.name;
        if (keyName === 'ESCAPE' || keyName === 'F8') {
          console.log(`Auto-typing interrupted by node-global-key-listener: ${keyName}`);
          stopAutoTyping(`User pressed ${keyName}`, keyName);
          return true; // Return true to block the key from propagating to other apps (like the browser)
        }
      }

      // Only process further if capture is active
      if (!isGlobalKeyCaptureActive || !mainWindow) {
        return;
      }
      try {
        const key = e.name;
        const timestamp = Date.now();
        if (e.state !== 'DOWN') {
          return;
        }

        // Skip modifier keys entirely — they should never be treated as character input
        const modifierKeys = ['LEFT SHIFT', 'RIGHT SHIFT', 'LEFT CTRL', 'RIGHT CTRL', 'LEFT ALT', 'RIGHT ALT', 'LEFT META', 'RIGHT META', 'CAPS LOCK', 'TAB', 'ESCAPE', 'LEFT SHIFT', 'RIGHT SHIFT'];
        if (modifierKeys.includes(key)) {
          return;
        }

        // Ignore chorded keys (Ctrl/Alt/Meta + key). Those are shortcuts such as
        // Ctrl+R, not text input, and must never be typed into the query box.
        // Shift is intentionally excluded — it only changes the character's case.
        const isCtrlDown = !!(down && (down['LEFT CTRL'] || down['RIGHT CTRL']));
        const isAltDown = !!(down && (down['LEFT ALT'] || down['RIGHT ALT']));
        const isMetaDown = !!(down && (down['LEFT META'] || down['RIGHT META']));
        if (isCtrlDown || isAltDown || isMetaDown) {
          logToFile(`Ignoring chorded key: ${key} (ctrl: ${isCtrlDown}, alt: ${isAltDown}, meta: ${isMetaDown})`);
          return;
        }

        // Deduplicate: the library can fire multiple events for the same keypress
        const dedupeKey = `${key}_${e.rawKey ? e.rawKey.vKey : ''}`;
        const lastTime = lastProcessedKeys.get(dedupeKey);
        if (lastTime && (timestamp - lastTime) < 80) {
          return;
        }
        lastProcessedKeys.set(dedupeKey, timestamp);
        // Clean up old entries
        for (const [k, t] of lastProcessedKeys.entries()) {
          if (timestamp - t > 200) {
            lastProcessedKeys.delete(k);
          }
        }

        logToFile(`Global key captured: ${key}, state: ${e.state}`);

        if (key === 'BACKSPACE') {
          logToFile('Sending Backspace to renderer');
          sendToRenderer('global-key-captured', { key: 'Backspace', type: 'special' });
        } else if (key === 'SPACE' || key === 'SPACE BAR' || key === 'SPACEBAR') {
          logToFile('Sending Space to renderer');
          sendToRenderer('global-key-captured', { key: ' ', type: 'char' });
        } else if (key && key.length === 1) {
          // Determine proper case: the library always reports uppercase names (e.g., "T")
          // Check if Shift is currently held to decide the actual character
          const isShiftDown = down && (down['LEFT SHIFT'] || down['RIGHT SHIFT']);
          const actualKey = isShiftDown ? key.toUpperCase() : key.toLowerCase();
          logToFile(`Sending char to renderer: ${actualKey} (shift: ${!!isShiftDown})`);
          sendToRenderer('global-key-captured', { key: actualKey, type: 'char' });
        } else if (key === 'RETURN' || key === 'ENTER') {
          logToFile('Sending Enter to renderer');
          sendToRenderer('global-key-captured', { key: '\n', type: 'char' });
        }
        // Scrolling is handled by the configurable scrollUp/scrollDown global shortcuts (scrollActiveView)
      } catch (error) {
        logToFile(`Global key capture error: ${error.message}`);
      }
    });
    logToFile('Global keyboard listener event handlers set up');
  } catch (e) {
    logToFile(`Failed to initialize GlobalKeyboardListener: ${e.message}`);
    logToFile(`Stack trace: ${e.stack}`);
    keyboardListener = null; // Ensure it's null if initialization fails
  }
};

// Disable GPU cache and other problematic features to prevent cache errors
app.commandLine.appendSwitch('--disable-gpu-cache');
app.commandLine.appendSwitch('--disable-gpu-sandbox');
app.commandLine.appendSwitch('--disable-software-rasterizer');
app.commandLine.appendSwitch('--disable-background-timer-throttling');
app.commandLine.appendSwitch('--disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('--disable-renderer-backgrounding');
app.commandLine.appendSwitch('--disable-features', 'TranslateUI');
app.commandLine.appendSwitch('--disable-ipc-flooding-protection');

// Disable developer tools and console access in production
if (!process.argv.includes('--dev')) {
  app.commandLine.appendSwitch('--disable-dev-shm-usage');
  app.commandLine.appendSwitch('--disable-extensions');
  app.commandLine.appendSwitch('--disable-plugins');
  app.commandLine.appendSwitch('--disable-default-apps');
}

// Minimum opacity the window can be restored to - keeps Ctrl+Space from
// "unhiding" into a still-invisible window.
const MIN_VISIBLE_OPACITY = 0.05;

// The opacity the user is currently steering. While the window is hidden via
// Ctrl+Space it sits at 0, so adjustments target the value Ctrl+Space restores.
const getTargetOpacity = () => (isOpacityHidden ? lastVisibleOpacity : currentOpacity);

// Applies a new target opacity and returns the value actually in effect.
// Returns the previous value unchanged when nothing moved.
const applyTargetOpacity = (opacity) => {
  const clamped = Math.max(0.0, Math.min(1.0, opacity));

  if (isOpacityHidden) {
    // Stay invisible: only the restore value moves, the window keeps opacity 0
    // until the user presses Ctrl+Space.
    const pending = Math.max(MIN_VISIBLE_OPACITY, clamped);
    if (pending === lastVisibleOpacity) return lastVisibleOpacity;
    lastVisibleOpacity = pending;
    return lastVisibleOpacity;
  }

  if (clamped === currentOpacity) return currentOpacity;
  currentOpacity = clamped;
  if (currentOpacity > 0) {
    lastVisibleOpacity = currentOpacity;
  }
  mainWindow.setOpacity(currentOpacity);
  return currentOpacity;
};

// Function to adjust window transparency
const adjustWindowTransparency = (delta) => {
  if (!mainWindow) return;

  const previous = getTargetOpacity();
  const applied = applyTargetOpacity(previous + delta);
  if (applied === previous) return;

  const percentage = Math.round(applied * 100);
  const via = delta > 0 ? 'increase' : 'decrease';
  if (isOpacityHidden) {
    console.log(`Window hidden - restore opacity changed to: ${percentage}% (${applied})`);
    logToFile(`Hidden window restore opacity changed to: ${percentage}% via ${via} shortcut`);
  } else {
    console.log(`Window opacity changed to: ${percentage}% (${applied})`);
    logToFile(`Window opacity changed to: ${percentage}% via ${via} shortcut`);
  }

  // Broadcast opacity change to renderer processes
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToRenderer('opacity-changed', applied);
  }
};

// Function to set window transparency from UI
const setWindowTransparency = (opacity) => {
  if (!mainWindow) return;

  const previous = getTargetOpacity();
  const applied = applyTargetOpacity(opacity);

  if (applied !== previous) {
    const percentage = Math.round(applied * 100);
    if (isOpacityHidden) {
      console.log(`Window hidden - restore opacity set to: ${percentage}% (${applied}) via UI`);
      logToFile(`Hidden window restore opacity set to: ${percentage}% via UI slider`);
    } else {
      console.log(`Window opacity set to: ${percentage}% (${applied}) via UI`);
      logToFile(`Window opacity set to: ${percentage}% via UI slider`);
    }
  }

  return applied;
};

// Function to toggle window opacity between 0 and last visible value (Ctrl+Space behavior)
const toggleWindowOpacity = async () => {
  if (!mainWindow) return;
  hideCount++;

  if (isOpacityHidden) {
    // Window is currently hidden (opacity 0), restore to last visible opacity
    currentOpacity = lastVisibleOpacity;
    isOpacityHidden = false;

    // Don't call show() to prevent taskbar flickering - just restore opacity
    mainWindow.setOpacity(currentOpacity);

    console.log(`Ctrl+Space pressed - Restoring opacity to ${Math.round(currentOpacity * 100)}%`);
    logToFile(`Window opacity restored to ${Math.round(currentOpacity * 100)}% via Ctrl+Space toggle`);
  } else {
    // Window is currently visible, save current opacity and hide
    lastVisibleOpacity = currentOpacity;
    currentOpacity = 0.0;
    isOpacityHidden = true;

    // Set opacity to 0 (effectively invisible but window stays shown)
    mainWindow.setOpacity(currentOpacity);

    console.log(`Ctrl+Space pressed - Hiding window (opacity 0%), saved previous opacity: ${Math.round(lastVisibleOpacity * 100)}%`);
    logToFile(`Window hidden via opacity toggle, saved opacity: ${Math.round(lastVisibleOpacity * 100)}%`);
  }

  // Broadcast opacity change to renderer processes
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToRenderer('opacity-changed', currentOpacity);
  }
};

let mainWindow;
let tray;
let aiService;
let screenshotService;
let stealthService;
let localStorageService;
let lastGeneratedCode = ''; // Preserve original formatting for display/manual access
let lastGeneratedCodeForAutoType = ''; // Normalized code used only for auto-typing
let autoTypeResumeIndex = 0; // Tracks how many characters were typed before stopping
let autoTypeFullCode = ''; // Stores the full code that is being typed
let autoTypeSessionStartIndex = 0; // Snapshot of autoTypeResumeIndex at start of each typing session
let isClickThroughEnabled = false; // Track click-through state - default to false (clickable)
let currentOpacity = 1.0; // Track current window opacity (default 100%)
// Latched state for the update banner. The update check can resolve
// before the renderer has registered its IPC listeners (or the renderer may
// reload), and sendToRenderer() silently drops messages when that happens — so
// the banner would never appear. We remember the latest update state here and
// replay it on every 'did-finish-load' so the update banner is shown
// the instant the renderer is ready, no matter which side won the race.
let pendingUpdateState = null; // { phase: 'downloading'|'downloaded', version, forced } | null
let backgroundUpdate = null; // null | 'running' | 'ended': see startBackgroundUpdate
let lastUpdateDownloadProgress = null; // last { percent, transferred, total, bytesPerSecond }

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function isForceUpdate() {
  const threshold = remoteConfig.get().forceUpdateBelow;
  if (!threshold) return false;
  try {
    return compareVersions(app.getVersion(), threshold) < 0;
  } catch (_) { return false; }
}

// A forced update still downloading when the app is closed finishes in the
// background, so it's ready to install after the next PC restart. This is how long
// it gets before giving up; the next launch carries on from there.
const BACKGROUND_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
let backgroundUpdateTimer = null;

function shouldFinishUpdateInBackground() {
  return Boolean(autoUpdater)
    && backgroundUpdate === null
    && Boolean(pendingUpdateState)
    && pendingUpdateState.phase === 'downloading'
    && isForceUpdate();
}

function startBackgroundUpdate() {
  backgroundUpdate = 'running';
  logToFile('Closed with a forced update still downloading: finishing in the background');

  // Only the download stays. Everything the user could notice goes now.
  try {
    globalShortcut.unregisterAll();
    if (stealthService) stealthService.stopMonitoring();
    interviewBridge.destroyInterviewView();
    interviewBridge.stopInterviewServer();
    if (keyboardListener) {
      keyboardListener.kill();
      keyboardListener = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch (error) {
    logToFile(`Error while closing for a background update: ${error.message}`);
  }

  backgroundUpdateTimer = setTimeout(() => endBackgroundUpdate('timed out'), BACKGROUND_UPDATE_TIMEOUT_MS);
}

// Nothing installs here. A finished download is already scheduled for after the
// next PC restart; a failed one is picked up again by the next launch.
function endBackgroundUpdate(reason) {
  if (backgroundUpdate !== 'running') return;
  backgroundUpdate = 'ended';
  clearTimeout(backgroundUpdateTimer);
  logToFile(`Background update ended: ${reason}`);
  flushLogBufferSync();
  app.quit();
  setTimeout(() => process.exit(0), 2000);
}

// Updates install after the next PC restart, never when the app closes: closing the
// app is also how the overlay opens, and the user may reopen it straight away. Windows
// runs this once at the next sign-in and forgets it, and the installer clears it if
// the update was installed some other way first ("Install & restart").
const UPDATE_RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const UPDATE_RUN_ONCE_VALUE = 'SolvroUpdate';
let updateCancelled = false;

function scheduleUpdateAfterRestart(done = () => {}) {
  const installer = autoUpdater && autoUpdater.installerPath;
  if (process.platform !== 'win32' || !app.isPackaged || !installer || (updateCancelled && !isForceUpdate())) {
    done();
    return;
  }
  const command = `"${installer}" --updated /S --at-restart`;
  require('child_process').execFile(
    'reg',
    ['add', UPDATE_RUN_ONCE_KEY, '/v', UPDATE_RUN_ONCE_VALUE, '/t', 'REG_SZ', '/d', command, '/f'],
    { windowsHide: true },
    (error) => {
      if (error) logToFile(`Could not schedule the update for after a restart: ${error.message}`);
      done();
    },
  );
}

function cancelUpdateAfterRestart() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  require('child_process').execFile(
    'reg',
    ['delete', UPDATE_RUN_ONCE_KEY, '/v', UPDATE_RUN_ONCE_VALUE, '/f'],
    { windowsHide: true },
    () => {}, // Fails when nothing was scheduled, which is fine.
  );
}

// The quit paths force an exit in case app.quit() gets stuck. That must not cut
// off a forced update finishing in the background.
function forceExitUnlessUpdating() {
  if (backgroundUpdate !== 'running') process.exit(0);
}
let isOpacityHidden = false; // Track if window is hidden via opacity toggle (Ctrl+Space)
let lastVisibleOpacity = 1.0; // Store the last visible opacity value for restoration
let isAutoTyping = false; // Track if auto-typing is currently active
let typingProcess = null; // Store the current typing process for interruption
let shouldStopTyping = false; // Flag to signal typing should stop
// Delay from pressing the auto-type (or resume) shortcut to the first keystroke.
// Just long enough to glance/click into the target editor; was 3000+450ms, which
// felt sluggish. Kept cancellable so the stop key still aborts during the wait.
const AUTO_TYPE_COUNTDOWN_MS = 1000;
const AUTO_TYPE_SETTLE_MS = 150;
let hideCount = 0; // Track consecutive hide requests to prevent flicker

// --- Renderer crash / hang recovery ---
//
// The main process survives a renderer crash, so without this the app kept
// running with a blank, frozen window: the tray and global shortcuts still
// worked, but the UI was dead and Windows eventually flagged it as "not
// responding". Reload the page instead — the renderer re-reads auth and mode
// from the main process on boot, so a reload restores a working UI rather than
// dropping the user back at a login screen.
const RENDERER_RELOAD_COOLDOWN_MS = 10000;
const RENDERER_MAX_RELOADS = 3;
let rendererReloads = 0;
let lastRendererReloadAt = 0;

const recoverRenderer = (reason) => {
  const now = Date.now();
  // A crash long after the last one starts the budget over; a burst of them in
  // quick succession means reloading isn't helping, so stop rather than spin.
  if (now - lastRendererReloadAt > 60000) rendererReloads = 0;
  if (now - lastRendererReloadAt < RENDERER_RELOAD_COOLDOWN_MS) return;
  if (rendererReloads >= RENDERER_MAX_RELOADS) {
    logToFile(`Renderer recovery: giving up after ${rendererReloads} reloads (${reason})`);
    return;
  }
  rendererReloads++;
  lastRendererReloadAt = now;
  logToFile(`Renderer recovery: reloading (attempt ${rendererReloads}) after ${reason}`);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reloadIgnoringCache();
    }
  } catch (err) {
    logToFile(`Renderer recovery reload failed: ${err.message}`);
  }
};

const attachRendererRecovery = (win) => {
  if (!win) return;

  win.webContents.on('render-process-gone', (event, details) => {
    logToFile(`Renderer process gone: ${details.reason} (exitCode ${details.exitCode})`);
    // 'clean-exit' is a normal teardown; everything else is a crash or an OOM.
    if (details.reason !== 'clean-exit') recoverRenderer(details.reason);
  });

  // Fired when the renderer hasn't pumped its event loop for a few seconds.
  // Don't reload on the first sign — a long markdown/highlight pass can trip
  // this and finish on its own. Only step in if it's still wedged.
  let unresponsiveTimer = null;
  win.on('unresponsive', () => {
    logToFile('Renderer reported unresponsive');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      recoverRenderer('unresponsive');
    }, 15000);
  });

  win.on('responsive', () => {
    logToFile('Renderer responsive again');
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which a normal in-app navigation raises.
    if (!isMainFrame || errorCode === -3) return;
    logToFile(`Renderer failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    recoverRenderer('did-fail-load');
  });

  // A dead GPU/utility child shows up as a frozen or black window. Logging it
  // makes the "app stopped painting" reports diagnosable.
  win.webContents.on('plugin-crashed', (event, name) => {
    logToFile(`Plugin crashed: ${name}`);
  });
};

const createWindow = () => {
  // Get screen dimensions
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.bounds; // Use bounds instead of workAreaSize

  mainWindow = new BrowserWindow({
    width: 800,
    height: screenHeight,
    x: 0, // Position at left edge
    y: 0, // Position at top
    minWidth: 600,
    minHeight: 200,
    maxWidth: 1200,
    maxHeight: screenHeight, // Allow up to full screen height
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // No native resize borders: Windows shows its resize cursor at those edges,
    // and the OS cursor isn't covered by content protection, so it gives the
    // window away in a capture. Users resize via the in-page edge strips
    // (src/renderer/stealthUi.js -> 'stealth-resize-*' IPC below); setSize/
    // setBounds still work on a non-resizable window.
    resizable: false,
    movable: true,   // Allow manual moving via mouse dragging
    // Screen sharing protection options
    enableLargerThanScreen: true,
    thickFrame: false,
    hasShadow: false,
    focusable: true,  // Keep focusable for keyboard shortcuts
    minimizable: false,
    maximizable: false,
    closable: true, // Enable close functionality
    // Additional hiding options
    show: false,
    opacity: 1.0, // Fully opaque by default (afterwards managed by currentOpacity variable)
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src/renderer/preload.js'),
      webSecurity: true,
      // Prevent content from being captured
      enableRemoteModule: false,
      sandbox: false,
      // Cache and performance settings
      partition: 'persist:main',
      cache: false,
      // Additional settings to prevent cache errors
      experimentalFeatures: false,
      enableBlinkFeatures: '',
      disableBlinkFeatures: '',
      // Disable developer tools completely in production
      devTools: process.argv.includes('--dev')
    }
  });

  mainWindow.loadFile('index.html');

  // Title-bar double-click -> maximize/restore. The title bar is a
  // -webkit-app-region: drag area, which Windows treats as the caption
  // (HTCAPTION), so the page never sees the clicks — catch the non-client
  // double-click message instead. maximizable:false stops Windows acting on it.
  if (process.platform === 'win32') {
    const WM_NCLBUTTONDBLCLK = 0x00A3;
    mainWindow.hookWindowMessage(WM_NCLBUTTONDBLCLK, () => toggleWindowMaximized());
  }

  // Disable developer tools and console access
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Disable F11, F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U, and other dev tools shortcuts
    if (input.key === 'F11' ||
      input.key === 'F1' ||
      (input.control && input.shift && (input.key === 'I' || input.key === 'J' || input.key === 'C')) ||
      (input.control && input.key === 'U') ||
      (input.control && input.shift && input.key === 'Delete')) {
      event.preventDefault();
    }
  });

  // Disable right-click context menu
  mainWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });

  // Prevent opening new windows/popups
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.setContentProtection(true);
  mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  });
  mainWindow.setAlwaysOnTop(true, "screen-saver", 1);

  // Disable click-through by default - window is interactive
  mainWindow.setIgnoreMouseEvents(false);

  // Set window to be ignored by screen capture
  if (process.platform === 'darwin') {
    // macOS specific: Set window level to avoid capture

  }

  // After DOM is ready, trigger resize to content and show window
  mainWindow.webContents.on('did-finish-load', () => {
    // A reload wipes the renderer's overlay state — make sure the interview
    // view isn't left parked offscreen by an overlay that no longer exists.
    try { interviewBridge.resumeInterviewView(); } catch (_) { }

    // Replay a downloaded update if one is ready. The renderer has
    // just (re)registered its IPC listeners, so this is the first moment it can
    // actually paint the update banner. Without this replay, an update
    // downloaded before the renderer was ready (common now that the check fires
    // at launch) would be dropped by sendToRenderer and the banner would never
    // show.
    if (pendingUpdateState && pendingUpdateState.phase === 'downloaded') {
      const replay = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const forced = pendingUpdateState.forced || isForceUpdate();
        sendToRenderer('update-downloaded', { version: pendingUpdateState.version, forced });
      };
      setTimeout(replay, 0);
    }
    try {
      mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
      mainWindow.webContents.setZoomFactor(1.0);
    } catch (e) {
      logToFile('Error setting zoom limits: ' + e);
    }
    setTimeout(() => {
      // The window can be gone by the time this fires (quit during load).
      if (!mainWindow || mainWindow.isDestroyed()) return;
      sendToRenderer('trigger-resize-to-content');
      mainWindow.show();
      mainWindow.setOpacity(currentOpacity);
      // Warm up the interview view in the background so the first open is
      // instant. Delayed so it doesn't compete with the main window's first
      // paint; guarded to run only once.
      setTimeout(() => { try { prewarmInterviewView(); } catch (_) { } }, 1500);
    }, 200);
  });

  attachRendererRecovery(mainWindow);

  // Window event handlers
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Quit the app when window is closed
    app.quit();
  });

  // Handle window close event (before closed)
  mainWindow.on('close', (event) => {
    logToFile('Window close event triggered');
    // Don't prevent close, let it proceed to quit the app
  });

  // Removed blur event handler - window should stay open when clicking other windows
  // mainWindow.on('blur', () => {
  //   hideWindowWithStealth();
  // });
};

const createTray = () => {
  // Create a simple tray icon using nativeImage
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Toggle Window Opacity',
      click: () => {
        if (mainWindow) {
          // Use the same opacity toggle as Ctrl+Space
          toggleWindowOpacity();
        }
      }
    },
    {
      label: 'Take Screenshot',
      click: () => {
        handleScreenshot();
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        logToFile('Quit requested from tray menu');

        // Force cleanup
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
          mainWindow = null;
        }

        if (tray) {
          tray.destroy();
          tray = null;
        }

        app.quit();

        // Force exit if needed
        setTimeout(forceExitUnlessUpdating, 2000);
      }
    },
    {
      label: 'Force Quit',
      click: () => {
        logToFile('Force quit requested from tray menu');
        process.exit(0);
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('Solvro');

  tray.on('click', () => {
    if (mainWindow) {
      // Use opacity toggle instead of hide/show
      toggleWindowOpacity();
    }
  });
};

// Shortcuts that are registered but not user-configurable; custom shortcuts must not collide with these
const RESERVED_SHORTCUTS = [
  'CommandOrControl+Shift+C',
  config?.app?.shortcuts?.toggleMicrophoneMute || 'CommandOrControl+Shift+V',
  config?.app?.shortcuts?.forceAnswerTrigger || 'CommandOrControl+Shift+Return'
];

// Scrolls the content under the middle of the viewport. The page itself never scrolls
// (body is overflow: visible) — content lives in inner containers like #analysis-container
// or the interview BrowserView's panels, so window.scrollBy() is a no-op.
const buildScrollScript = (delta) => `(() => {
  const canScroll = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    return /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  };
  let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  while (el && !canScroll(el)) el = el.parentElement;
  if (!el) {
    const preferred = document.getElementById('analysis-container');
    if (canScroll(preferred)) {
      el = preferred;
    } else {
      let bestArea = 0;
      for (const candidate of document.querySelectorAll('*')) {
        if (!canScroll(candidate)) continue;
        const r = candidate.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; el = candidate; }
      }
    }
  }
  (el || document.scrollingElement).scrollBy({ top: ${delta}, behavior: 'smooth' });
})();`;

const SCROLL_STEP = 120;

const scrollActiveView = (direction) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let target = mainWindow.webContents;
  if (aiService && aiService.getCurrentMode() === 'interview') {
    const interviewBridge = require('./src/utils/interviewBridge.js');
    if (interviewBridge.isActive() && interviewBridge.getView()) {
      target = interviewBridge.getView().webContents;
    }
  }
  const delta = direction === 'up' ? -SCROLL_STEP : SCROLL_STEP;
  target.executeJavaScript(buildScrollScript(delta)).catch(e => logToFile('Error scrolling content: ' + e));
};

// Returns an error message if the accelerator can't be used, otherwise null.
// Must be called while our own shortcuts are unregistered (capture mode) so we don't collide with ourselves.
const validateShortcut = (id, keys) => {
  const ruleError = shortcutManager.checkAcceleratorRules(keys);
  if (ruleError) return ruleError;
  const normalized = keys.toLowerCase();

  if (RESERVED_SHORTCUTS.some(k => k.toLowerCase() === normalized)) {
    return `${keys.replace(/CommandOrControl/g, 'Ctrl')} is reserved by the app.`;
  }
  const current = shortcutManager.getShortcuts();
  const clash = Object.entries(current).find(([otherId, cfg]) => otherId !== id && cfg.keys.toLowerCase() === normalized);
  if (clash) return `Already used by "${clash[1].label}".`;

  try {
    const ok = globalShortcut.register(keys, () => { });
    if (!ok) return 'This shortcut is already taken by another application or by Windows.';
    globalShortcut.unregister(keys);
  } catch (err) {
    return 'This key combination is not supported.';
  }
  return null;
};

let activeStopAutotypingKeys = null; // Stop key registered for the current auto-typing session

const registerStopAutotypingShortcut = () => {
  const keys = shortcutManager.getShortcuts().stopAutotyping.keys;
  try {
    const ok = globalShortcut.register(keys, () => {
      console.log(`${keys} pressed - pausing auto-type`);
      stopAutoTyping(`User pressed ${keys}`, keys);
    });
    if (!ok) logToFile(`Failed to register stop-autotyping shortcut ${keys} (in use elsewhere)`);
  } catch (err) {
    logToFile(`Invalid stop-autotyping shortcut ${keys}: ${err.message}`);
  }
  activeStopAutotypingKeys = keys;
};

const registerShortcuts = () => {
  if (isEditingShortcut) return []; // Do not register if we are currently capturing a new shortcut

  globalShortcut.unregisterAll();
  const sc = shortcutManager.getShortcuts();
  const failed = [];

  const safeRegister = (keyConfig, handler) => {
    if (keyConfig && keyConfig.keys) {
      try {
        // register() returns false (it does not throw) when another app already owns the accelerator
        if (!globalShortcut.register(keyConfig.keys, handler)) {
          failed.push(keyConfig);
          logToFile(`Shortcut ${keyConfig.keys} (${keyConfig.label}) is in use by another application`);
        }
      } catch (err) {
        failed.push(keyConfig);
        logToFile(`Failed to register shortcut ${keyConfig.keys}: ${err.message}`);
      }
    }
  };

  safeRegister(sc.screenshot, () => {
    // In interview mode, click the BrowserView's screenshot button instead
    if (aiService && aiService.getCurrentMode() === 'interview') {
      const interviewBridge = require('./src/utils/interviewBridge.js');
      if (interviewBridge.isActive() && interviewBridge.getView()) {
        interviewBridge.getView().webContents.executeJavaScript(`
          (() => {
            const b = Array.from(document.querySelectorAll('button')).find(btn => {
              const t = btn.textContent.toLowerCase();
              return t.includes('screenshot') || t.includes('capture');
            });
            if (b) b.click();
          })();
        `).catch(e => console.error('Error clicking screenshot btn:', e));
        return;
      }
    }
    handleScreenshot();
  });
  safeRegister(sc.toggleWindow, () => {
    if (mainWindow) toggleWindowOpacity();
  });

  const sendQueueHandler = () => {
    console.log('Send Queue / Assist shortcut triggered');
    logToFile('Send Queue / Assist global shortcut triggered in main process');
    if (mainWindow && mainWindow.isVisible()) {
      if (aiService && aiService.getCurrentMode() === 'interview') {
        const interviewBridge = require('./src/utils/interviewBridge.js');
        if (interviewBridge.isActive() && interviewBridge.getView()) {
          interviewBridge.getView().webContents.executeJavaScript(`
            (() => {
              const b = Array.from(document.querySelectorAll('button')).find(btn => {
                const t = btn.textContent.toLowerCase();
                return t.includes('assist') || t.includes('force answer') || t.includes('generate');
              });
              if (b) b.click();
            })();
          `).catch(e => logToFile('Error clicking assist btn: ' + e));
        }
        return; // Prevent global action
      } else {
        sendToRenderer('send-queue-shortcut');
      }
    }
  };
  safeRegister(sc.sendQueue, sendQueueHandler);

  safeRegister(sc.resetConversation, () => {
    if (aiService) {
      if (mainWindow && mainWindow.isVisible() && aiService.getCurrentMode() === 'interview') {
        const interviewBridge = require('./src/utils/interviewBridge.js');
        if (interviewBridge.isActive() && interviewBridge.getView()) {
           // The interview UI's "New conversation" control is an icon-only button.
           // Its `title` can't be used: stealthUi.js strips every title into
           // data-stealth-tip so native tooltips don't leak into screen shares.
           // Match the stable data-action hook first, then the tooltip text.
           interviewBridge.getView().webContents.executeJavaScript(`
             (() => {
               const label = (btn) => (
                 (btn.getAttribute('data-stealth-tip') || '') + ' ' +
                 (btn.getAttribute('title') || '') + ' ' +
                 (btn.getAttribute('aria-label') || '')
               ).toLowerCase();
               const b =
                 document.querySelector('button[data-action="new-conversation"]') ||
                 Array.from(document.querySelectorAll('button'))
                   .find(btn => label(btn).includes('new conversation'));
               if (b) { b.click(); return true; }
               return false;
             })();
           `).then(clicked => {
             logToFile('Interview reset button clicked: ' + clicked);
           }).catch(e => logToFile('Error clicking reset btn: ' + e));
           return; // Prevent global reset — the interview UI owns its own state
        }
      }

      // Normal global reset for other modes
      aiService.resetConversation();
      setGeneratedCodeBuffersRaw(''); // nothing to auto-type after a reset
      if (mainWindow && mainWindow.isVisible()) {
        sendToRenderer('conversation-reset');
      }
    }
  });

  safeRegister(sc.moveUp, () => moveWindowGlobally(0, -50));
  safeRegister(sc.moveDown, () => moveWindowGlobally(0, 50));
  safeRegister(sc.moveLeft, () => moveWindowGlobally(-50, 0));
  safeRegister(sc.moveRight, () => moveWindowGlobally(50, 0));

  safeRegister(sc.scrollUp, () => scrollActiveView('up'));
  safeRegister(sc.scrollDown, () => scrollActiveView('down'));

  safeRegister(sc.transparencyIncrease, () => adjustWindowTransparency(0.1));
  safeRegister(sc.transparencyDecrease, () => adjustWindowTransparency(-0.1));

  safeRegister(sc.startAutotyping, () => {
    autoTypeResumeIndex = 0;
    autoTypeGeneratedCode();
  });
  safeRegister(sc.resumeAutotyping, () => resumeAutoType());

  safeRegister(sc.quit, () => {
    logToFile('Force quit requested via global shortcut');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      mainWindow = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
    app.quit();
    setTimeout(forceExitUnlessUpdating, 1000);
  });

  safeRegister(sc.languageSwitch, () => cycleLanguage());
  safeRegister(sc.modelSwitch, () => cycleModel());
  safeRegister(sc.modeSwitch, () => switchMode());
  safeRegister(sc.toggleTheme, () => sendToRenderer('toggle-theme'));

  // Toggles the interview mic: starts it when stopped, stops it when running.
  // (There used to be a separate stop shortcut; the start one matched only a
  // button labelled "Start", so it could never stop.)
  safeRegister(sc.startInterview, () => {
    logToFile('Start/Stop Interview mic shortcut triggered');
    // Same key doubles as the voice-input toggle in query (chat) mode
    if (mainWindow && aiService && aiService.getCurrentMode() === 'query') {
      sendToRenderer('toggle-voice-input');
      return;
    }
    if (mainWindow && mainWindow.isVisible() && aiService && aiService.getCurrentMode() === 'interview') {
      const interviewBridge = require('./src/utils/interviewBridge.js');
      if (interviewBridge.isActive() && interviewBridge.getView()) {
         interviewBridge.getView().webContents.executeJavaScript(`
            (() => {
              const b =
                document.querySelector('button[data-action="toggle-recording"]') ||
                // stealthUi.js moves the title attribute into data-stealth-tip
                document.querySelector('button[data-stealth-tip="Start recording"], button[data-stealth-tip="Stop recording"]');
              if (b && !b.disabled) b.click();
            })();
         `);
      }
    }
  });
  
  safeRegister(sc.newQuestion, () => {
    logToFile('New Question shortcut triggered');
    if (mainWindow && mainWindow.isVisible() && aiService && aiService.getCurrentMode() === 'interview') {
      const interviewBridge = require('./src/utils/interviewBridge.js');
      if (interviewBridge.isActive() && interviewBridge.getView()) {
         interviewBridge.getView().webContents.executeJavaScript(`
            (() => {
              const b = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.toLowerCase().includes('new question'));
              if (b) b.click();
            })();
         `);
      }
    }
  });

  // Also register old hardcoded ones that aren't in config yet but are necessary
  safeRegister({ label: 'Toggle Click-Through', keys: RESERVED_SHORTCUTS[0] }, () => {
    if (mainWindow) {
      isClickThroughEnabled = !isClickThroughEnabled;
      mainWindow.setIgnoreMouseEvents(isClickThroughEnabled, { forward: true });
      if (mainWindow.isVisible()) {
        sendToRenderer('click-through-toggled', {
          enabled: isClickThroughEnabled,
          message: isClickThroughEnabled ? 'Click-through ENABLED - Clicks pass through window' : 'Click-through DISABLED - Window is now interactive'
        });
      }
    }
  });
  
  safeRegister({ label: 'Toggle Microphone Mute', keys: RESERVED_SHORTCUTS[1] }, () => {
    if (mainWindow) sendToRenderer('toggle-mic-mute');
  });

  safeRegister({ label: 'Force Answer', keys: RESERVED_SHORTCUTS[2] }, () => {
    if (mainWindow) sendToRenderer('force-answer-trigger');
  });

  // unregisterAll() above also dropped the auto-typing kill switch — restore it if typing is in progress
  if (isAutoTyping) registerStopAutotypingShortcut();

  // Initialize keyboard listener at startup (used for Esc/F8 auto-typing interrupts and input capture)
  ensureKeyboardListener();
  return failed;
};

// Function to setup temporary keyboard interrupt monitoring during auto-typing
const setupTemporaryKeyboardMonitoring = () => {
  // We now rely on node-global-key-listener to swallow the Escape key during auto-typing
  ensureKeyboardListener();
  console.log('Temporary keyboard monitoring configured (using node-global-key-listener)');
};

// Function to remove temporary keyboard monitoring
const removeTemporaryKeyboardMonitoring = () => {
  // No explicit removal needed, node-global-key-listener handles this dynamically via isAutoTyping flag
};

// Function to stop auto-typing
const stopAutoTyping = (reason, keyName = null) => {
  if (!isAutoTyping) return;

  console.log(`Stopping auto-typing: ${reason}`);
  shouldStopTyping = true;
  isAutoTyping = false;

  // F8 always preserves the resume index for Ctrl+Shift+Y resume
  console.log(`Auto-type paused at index ${autoTypeResumeIndex}/${autoTypeFullCode.length}. Use Ctrl+Shift+Y to resume.`);

  // Kill the typing process if it exists
  if (typingProcess && !typingProcess.killed) {
    try {
      typingProcess.kill('SIGTERM');
      const spawn = require('child_process').spawn;
      spawn('taskkill', ['/pid', typingProcess.pid, '/f', '/t']);
      console.log('Auto-typing process terminated with taskkill');
    } catch (error) {
      console.error('Error killing typing process:', error);
    }
  }

  // Send notification to UI
  if (mainWindow && mainWindow.webContents) {
    const remaining = autoTypeFullCode.length - autoTypeResumeIndex;
    const canResume = autoTypeResumeIndex > 0 && remaining > 0;
    const message = canResume
      ? `⏸️ Auto-typing paused (${remaining} chars remaining). Ctrl+Shift+Y to resume, Ctrl+Shift+T to restart.`
      : `🛑 Auto-typing stopped.`;
    sendToRenderer('code-copied-for-typing', {
      message,
      typing: false,
      paused: canResume,
      resumeIndex: autoTypeResumeIndex,
      totalChars: autoTypeFullCode.length,
      error: false
    });
  }

  // Remove temporary keyboard monitoring
  removeTemporaryKeyboardMonitoring();

  // Re-enable interrupt monitoring after a short delay
  setTimeout(() => {
    shouldStopTyping = false;
  }, 1000);
};

const autoTypeGeneratedCode = async () => {
  if (!autoTypeFullCode) {
    console.log('No generated code available to type');
    if (mainWindow && mainWindow.webContents) {
      sendToRenderer('code-copied-for-typing', {
        message: 'No generated code available to type',
        codeLength: 0,
        error: true
      });
    }
    return;
  }

  // Get the remaining code to type based on resume index
  const codeToType = autoTypeFullCode.substring(autoTypeResumeIndex);

  if (!codeToType) {
    console.log('No remaining code to type (resume index at end)');
    autoTypeResumeIndex = 0; // Reset for next time
    return;
  }

  // Check if auto-typing is already in progress
  if (isAutoTyping) {
    console.log('Auto-typing already in progress, stopping current session');
    stopAutoTyping('New auto-typing session requested');
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait for cleanup
  }

  try {
    // Set typing state
    isAutoTyping = true;
    shouldStopTyping = false;
    typingProcess = null;

    console.log(`Starting secure keyboard simulation (no clipboard). Resuming from index: ${autoTypeResumeIndex}`);

    // Dynamically register stop autotyping shortcut
    registerStopAutotypingShortcut();
    const stopKeyLabel = activeStopAutotypingKeys.replace(/CommandOrControl/g, 'Ctrl');
    const stopHint = stopKeyLabel.toUpperCase() === 'F8' ? 'ESC or F8' : `ESC, F8 or ${stopKeyLabel}`;

    // Setup temporary keyboard monitoring (only essential keys)
    setupTemporaryKeyboardMonitoring();

    // Send notification that typing will start
    const countdownSecs = (AUTO_TYPE_COUNTDOWN_MS / 1000).toFixed(AUTO_TYPE_COUNTDOWN_MS % 1000 === 0 ? 0 : 1);
    if (mainWindow && mainWindow.webContents) {
      const isResume = autoTypeResumeIndex > 0;
      const resumeMsg = isResume ? ` (Resuming from char ${autoTypeResumeIndex})` : '';
      sendToRenderer('code-copied-for-typing', {
        message: `🔒 Secure auto-typing starting in ${countdownSecs}s... (${codeToType.length} chars)${resumeMsg} - Press ${stopHint} to stop`,
        codeLength: codeToType.length,
        isSecure: true,
        countdown: true,
        typing: true,
        // Distinguishes a resume (continue from where it stopped) from a fresh
        // start (type from the very beginning) so the UI can show which it is.
        isResume,
        resumeIndex: autoTypeResumeIndex,
        totalLength: autoTypeFullCode.length,
        // So the overlay's progress bar + auto-dismiss match the real countdown.
        countdownMs: AUTO_TYPE_COUNTDOWN_MS,
      });
    }

    // Brief window to focus the target app, checked often so the stop key can
    // still abort during the wait.
    const countdownStart = Date.now();
    while (Date.now() - countdownStart < AUTO_TYPE_COUNTDOWN_MS) {
      if (shouldStopTyping) {
        console.log('Auto-typing cancelled during countdown');
        isAutoTyping = false;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    // Final check before starting typing
    if (shouldStopTyping) {
      console.log('Auto-typing cancelled before start');
      isAutoTyping = false;
      return;
    }

    // Give target editor a brief focus settle window before sending first key.
    await new Promise(resolve => setTimeout(resolve, AUTO_TYPE_SETTLE_MS));

    console.log(`Auto-type diagnostics: length=${codeToType.length}, hasPublic=${codeToType.includes('public:')}`);

    // Send notification that typing is starting
    if (mainWindow && mainWindow.webContents) {
      sendToRenderer('code-copied-for-typing', {
        message: `⌨️ Typing code securely... (${codeToType.length} chars) - Press ${stopHint} to stop`,
        codeLength: codeToType.length,
        isSecure: true,
        typing: true
      });
    }

    // Snapshot the current resume index for PROGRESS calculation
    autoTypeSessionStartIndex = autoTypeResumeIndex;

    // Type the code securely using PowerShell SendKeys
    await typeCodeSecurely(codeToType);

    // Only show completion if not interrupted
    if (isAutoTyping && !shouldStopTyping) {
      console.log('Secure auto-typing completed successfully');

      // Auto-typing completed entirely, reset the resume index
      autoTypeResumeIndex = 0;

      if (mainWindow && mainWindow.webContents) {
        sendToRenderer('code-copied-for-typing', {
          message: '✅ Secure auto-typing completed successfully!',
          codeLength: codeToType.length,
          isSecure: true,
          completed: true,
          typing: false
        });
      }
    }

  } catch (error) {
    console.error('Error in secure auto-typing:', error);

    // Reset typing state on error
    isAutoTyping = false;
    shouldStopTyping = false;

    if (mainWindow && mainWindow.webContents) {
      sendToRenderer('code-copied-for-typing', {
        message: `❌ Secure auto-typing failed: ${error.message}`,
        codeLength: 0,
        error: true,
        typing: false
      });
    }
  } finally {
    // Always reset typing state when function completes
    isAutoTyping = false;
    typingProcess = null;

    // Unregister dynamic kill switch (the key that was actually registered, even if the setting changed mid-typing)
    if (activeStopAutotypingKeys) {
      globalShortcut.unregister(activeStopAutotypingKeys);
      activeStopAutotypingKeys = null;
    }

    // Remove temporary keyboard monitoring
    removeTemporaryKeyboardMonitoring();
  }
};

const resumeAutoType = () => {
  if (isAutoTyping) {
    console.log('Auto-typing already in progress, ignoring resume request');
    return;
  }

  if (!autoTypeFullCode) {
    if (mainWindow && mainWindow.webContents) {
      sendToRenderer('code-copied-for-typing', {
        message: '⚠️ No code available to resume.',
        error: true
      });
    }
    return;
  }

  if (autoTypeResumeIndex === 0) {
    if (mainWindow && mainWindow.webContents) {
      sendToRenderer('code-copied-for-typing', {
        message: '⚠️ Nothing to resume. Use Ctrl+Shift+T to start from beginning.',
        error: true
      });
    }
    return;
  }

  if (autoTypeResumeIndex >= autoTypeFullCode.length) {
    if (mainWindow && mainWindow.webContents) {
      sendToRenderer('code-copied-for-typing', {
        message: '✅ Auto-typing already completed.',
        error: false
      });
    }
    autoTypeResumeIndex = 0;
    return;
  }

  console.log(`Resuming auto-type from char ${autoTypeResumeIndex}/${autoTypeFullCode.length}`);
  autoTypeGeneratedCode();
};

const prepareCodeForAutoTyping = (code, language) => {
  if (!code) return '';

  const normalizedLineEndings = code.replace(/\r\n?/g, '\n');
  const lines = normalizedLineEndings.split('\n');
  const isPython = language === 'python' || language === 'python3';

  if (isPython) {
    // Convert tabs to 4 spaces (consistent indentation) and trim trailing whitespace
    const expandedLines = lines.map((line) => line.replace(/\t/g, '    ').replace(/ +$/g, ''));

    // Find minimum indentation (ignoring empty lines) to dedent the code
    // This preserves relative indentation which is critical for Python
    let minIndent = Infinity;
    for (const line of expandedLines) {
      if (line.trim().length === 0) continue; // skip empty lines
      const leadingSpaces = line.match(/^( *)/)[1].length;
      if (leadingSpaces < minIndent) minIndent = leadingSpaces;
    }
    if (minIndent === Infinity) minIndent = 0;

    // Dedent by removing common leading whitespace
    const dedentedLines = expandedLines.map((line) => {
      if (line.trim().length === 0) return '';
      return line.substring(minIndent);
    });

    return dedentedLines.join('\n');
  } else {
    // Old logic: aggressively normalize indentation for typing reliability:
    // remove tabs, trim line-leading spaces, and remove trailing whitespace.
    const normalizedLines = lines.map((line) => line.replace(/\t/g, '').replace(/^ +/, '').replace(/ +$/g, ''));
    return normalizedLines.join('\n');
  }
};

const ensureCppPublicSpecifier = (code) => {
  if (!code) return '';

  // Add `public:` for common LeetCode class pattern when omitted.
  const classStart = code.match(/class\s+Solution\b[^\{]*\{/m);
  if (!classStart || classStart.index === undefined) return code;

  const insertAt = classStart.index + classStart[0].length;
  const rest = code.slice(insertAt);
  const firstBlock = rest.split('}')[0] || rest;

  // Skip insertion if any explicit access specifier already exists.
  if (/\b(public|private|protected)\s*:/.test(firstBlock)) {
    return code;
  }

  return `${code.slice(0, insertAt)}\npublic:\n${rest.replace(/^\n*/, '')}`;
};

const setGeneratedCodeBuffers = (code) => {
  const sourceCode = code || '';
  lastGeneratedCode = sourceCode;
  const currentLanguage = aiService ? aiService.getCurrentLanguage() : '';
  const autoTypeSource = currentLanguage === 'cpp'
    ? ensureCppPublicSpecifier(sourceCode)
    : sourceCode;

  // Auto-type the WHOLE solution, exactly as shown. The old extractFunctionBody
  // step tried to strip a class wrapper and type only the method body; for a
  // multi-function C++ answer it returned the class body starting at "public:"
  // and dropped the `class … {` line, so typing began mid-way and the code came
  // out incomplete. Typing the full source is what the user sees and expects.
  lastGeneratedCodeForAutoType = prepareCodeForAutoTyping(autoTypeSource, currentLanguage);

  // Reset resume state for new code
  autoTypeResumeIndex = 0;
  autoTypeFullCode = lastGeneratedCodeForAutoType;
};

// Sets the auto-type buffer to text that must be typed EXACTLY as given, with no
// indentation stripping or language-specific massaging (used for Query-mode
// plain-text answers, where tables and list indentation must be preserved).
const setGeneratedCodeBuffersRaw = (text) => {
  const value = text || '';
  lastGeneratedCode = value;
  lastGeneratedCodeForAutoType = value;
  autoTypeResumeIndex = 0;
  autoTypeFullCode = value;
};

// Converts a markdown answer to clean plain text for Query-mode auto-typing —
// so what gets typed reads like the rendered reply (no **, #, backticks or link
// syntax) and tables come out as aligned columns, rather than raw markdown.
const markdownToPlainText = (md) => {
  if (!md) return '';
  const src = String(md).replace(/\r\n?/g, '\n');
  const outLines = [];
  const lines = src.split('\n');
  let inFence = false;

  // Render a run of markdown table rows as aligned, padded columns.
  const flushTable = (rows) => {
    // Drop the |---|---| separator row.
    const dataRows = rows.filter(r => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r) || /[A-Za-z0-9]/.test(r));
    const cells = dataRows.map(r =>
      r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => inlinePlain(c).trim())
    );
    const widths = [];
    for (const row of cells) row.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, c.length); });
    for (const row of cells) {
      outLines.push(row.map((c, i) => c.padEnd(widths[i])).join('   ').trimEnd());
    }
  };

  // Strip inline markdown (bold/italic/code/links/images) from a fragment.
  const inlinePlain = (s) => s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')      // images → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // links → text
    .replace(/`([^`]+)`/g, '$1')                   // inline code
    .replace(/(\*\*|__)(.*?)\1/g, '$2')            // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')               // italic
    .replace(/~~(.*?)~~/g, '$2');                  // strikethrough

  let tableBuf = [];
  const flushTableBuf = () => { if (tableBuf.length) { flushTable(tableBuf); tableBuf = []; } };

  for (const raw of lines) {
    const fence = raw.match(/^\s*```/);
    if (fence) { flushTableBuf(); inFence = !inFence; continue; } // drop the ``` lines
    if (inFence) { outLines.push(raw); continue; }                // keep code verbatim

    // Table rows: buffer consecutive '|' lines, then align them together.
    if (/^\s*\|.*\|\s*$/.test(raw)) { tableBuf.push(raw); continue; }
    flushTableBuf();

    let line = raw;
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '');     // headings → text
    line = line.replace(/^\s{0,3}>\s?/, '');          // blockquote marker
    if (/^\s{0,3}([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { outLines.push(''); continue; } // hr
    line = line.replace(/^(\s*)[-*+]\s+/, '$1- ');    // bullet marker
    line = inlinePlain(line);
    outLines.push(line);
  }
  flushTableBuf();

  return outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const typeCodeSecurely = async (code) => {
  return new Promise((resolve, reject) => {
    try {
      // Check for interrupt before starting
      if (shouldStopTyping) {
        console.log('Auto-typing cancelled before PowerShell execution');
        resolve();
        return;
      }

      const currentLanguage = aiService ? (aiService.getCurrentLanguage() || '').toLowerCase() : '';
      const currentModeForType = aiService ? aiService.getCurrentMode() : '';
      // Query-mode auto-typing is plain text, not Python source — the Python
      // auto-indent-defeat trick (typing 'x' + Shift+Home + Backspace after each
      // newline) would corrupt it, so only apply it for actual Python code.
      const isPython = currentModeForType !== 'query'
        && (currentLanguage === 'python' || currentLanguage === 'python3');

      let cmd, args;
      const base64Code = Buffer.from(code, 'utf8').toString('base64');

      if (process.platform === 'darwin') {
        const appleScript = `
use framework "Foundation"
on run
  set base64String to "${base64Code}"
  set theData to current application's NSData's alloc()'s initWithBase64EncodedString:base64String options:0
  set codeText to (current application's NSString's alloc()'s initWithData:theData encoding:(current application's NSUTF8StringEncoding)) as string

  repeat with i from 1 to length of codeText
    set char to character i of codeText

    -- No fake-typo flourish: typing a wrong char then backspacing left a stray
    -- character in the target if the process was force-stopped in that gap,
    -- which corrupted the seam when resuming. Typing is now exact; the random
    -- per-char delays below still make it look human-paced.

    if char = (character id 10) or char = (character id 13) then
      tell application "System Events" to key code 36
${isPython ? `      delay 0.03
      tell application "System Events" to keystroke "x"
      tell application "System Events" to key code 123 using {command down, shift down}
      tell application "System Events" to key code 123 using {command down, shift down}
      tell application "System Events" to key code 51` : ''}
    else if char = (character id 9) then
      tell application "System Events" to key code 48
    else
      tell application "System Events" to keystroke char
    end if
    log "PROGRESS:" & (i - 1)
    
    set delayMs to (random number from 35 to 110)
    if (random number from 1 to 30) = 1 then
      set delayMs to (random number from 200 to 500)
    end if
${!isPython ? `    if char = "}" or char = "{" or char = (character id 10) or char = (character id 13) then
      set delayMs to delayMs + 150
    end if` : ''}
    delay (delayMs / 1000.0)
  end repeat
end run
`;
        cmd = 'osascript';
        args = ['-e', appleScript];
      } else if (process.platform === 'linux') {
        // Ensure xdotool is installed before attempting to type
        const { execSync: execSyncLocal } = require('child_process');
        try {
          execSyncLocal('which xdotool', { stdio: 'ignore' });
        } catch (_) {
          logToFile('xdotool not found. Auto-installing...');
          const cmds = [
            'pkexec apt-get install -y xdotool',
            'pkexec dnf install -y xdotool',
            'pkexec pacman -S --noconfirm xdotool',
            'sudo apt-get install -y xdotool',
            'sudo dnf install -y xdotool',
          ];
          let ok = false;
          for (const c of cmds) {
            try {
              execSyncLocal(c, { stdio: 'ignore', timeout: 60000 });
              execSyncLocal('which xdotool', { stdio: 'ignore' });
              logToFile('xdotool installed successfully');
              ok = true;
              break;
            } catch (__) { continue; }
          }
          if (!ok) {
            reject(new Error('xdotool is required but could not be installed. Run: sudo apt-get install xdotool'));
            return;
          }
        }

        const bashScript = `
#!/bin/bash
CODE=$(echo "${base64Code}" | base64 --decode)
len=\${#CODE}

for (( i=0; i<$len; i++ )); do
  char="\${CODE:$i:1}"

  # No fake-typo flourish: typing a wrong char then backspacing left a stray
  # character in the target if the process was force-stopped in that gap,
  # corrupting the seam on resume. Typing is now exact; the random per-char
  # delays below still make it look human-paced.

  if [ "$char" = "$(printf '\\n')" ] || [ "$char" = "$(printf '\\r')" ]; then
    xdotool key Return
${isPython ? `    sleep 0.03
    xdotool type --clearmodifiers "x"
    xdotool key Shift+Home
    xdotool key Shift+Home
    xdotool key BackSpace` : ''}
  elif [ "$char" = "$(printf '\\t')" ]; then
    xdotool key Tab
  else
    xdotool type --clearmodifiers "$char"
  fi
  echo "PROGRESS:$i"
  
  delay_ms=$((35 + RANDOM % 76))
  if [ $((RANDOM % 30)) -eq 0 ]; then
    delay_ms=$((200 + RANDOM % 301))
  fi
${!isPython ? `  if [ "$char" = "}" ] || [ "$char" = "{" ] || [ "$char" = "$(printf '\\n')" ] || [ "$char" = "$(printf '\\r')" ]; then
    delay_ms=$((delay_ms + 150))
  fi` : ''}
  sleep $(awk -v ms=$delay_ms 'BEGIN{print ms/1000}')
done
`;
        cmd = 'bash';
        args = ['-c', bashScript];
      } else {
        // Windows
        const powerShellScript = `
Add-Type -AssemblyName System.Windows.Forms

      function Send-SafeChar {
        param([char]$char)

        switch ($char) {
          "\`n" { 
            [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
${isPython ? `            Start-Sleep -Milliseconds 30
            [System.Windows.Forms.SendKeys]::SendWait("x")
            [System.Windows.Forms.SendKeys]::SendWait("+{HOME}")
            [System.Windows.Forms.SendKeys]::SendWait("+{HOME}")
            [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")` : ''}
          }
          "\`r" { }
          "{" { [System.Windows.Forms.SendKeys]::SendWait("{{}") }
          "}" { [System.Windows.Forms.SendKeys]::SendWait("{}}") }
          "+" { [System.Windows.Forms.SendKeys]::SendWait("{+}") }
          "^" { [System.Windows.Forms.SendKeys]::SendWait("{^}") }
          "%" { [System.Windows.Forms.SendKeys]::SendWait("{%}") }
          "~" { [System.Windows.Forms.SendKeys]::SendWait("{~}") }
          "(" { [System.Windows.Forms.SendKeys]::SendWait("{(}") }
          ")" { [System.Windows.Forms.SendKeys]::SendWait("{)}") }
          "[" { [System.Windows.Forms.SendKeys]::SendWait("{[}") }
          "]" { [System.Windows.Forms.SendKeys]::SendWait("{]}") }
          "\`t" { [System.Windows.Forms.SendKeys]::SendWait("    ") }
          " " { [System.Windows.Forms.SendKeys]::SendWait(" ") }
          default { [System.Windows.Forms.SendKeys]::SendWait($char.ToString()) }
        }
      }

      $base64 = "${base64Code}"
      $bytes = [System.Convert]::FromBase64String($base64)
      $codeText = [System.Text.Encoding]::UTF8.GetString($bytes)
      $chars = $codeText.ToCharArray()

      for ($i = 0; $i -lt $chars.Length; $i++) {
        $char = $chars[$i]

        # No fake-typo flourish: typing a wrong char then backspacing left a
        # stray character in the target if the process was force-stopped in that
        # gap, corrupting the seam on resume. Typing is now exact; the random
        # per-char delays below still make it look human-paced.

        Send-SafeChar -char $char
        [Console]::WriteLine("PROGRESS:$i")
        
        $delay = Get-Random -Minimum 35 -Maximum 110
        if ((Get-Random -Minimum 1 -Maximum 30) -eq 1) {
            $delay = Get-Random -Minimum 200 -Maximum 500
        }
${!isPython ? `        if ($char -eq '}' -or $char -eq '{' -or $char -eq "\`n" -or $char -eq "\`r") {
            $delay += 150
        }` : ''}
        Start-Sleep -Milliseconds $delay
      }

      Write-Output "COMPLETED_SUCCESSFULLY"
`;
        cmd = 'powershell.exe';
        // -NoProfile skips loading the user's PowerShell profile (which can add
        // noticeable startup lag); -NonInteractive avoids any prompt stalls.
        args = ['-NoProfile', '-NonInteractive', '-Command', powerShellScript];
      }

      // Execute script
      const childProc = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      // Store process reference for potential interruption
      typingProcess = childProc;

      let output = '';
      let errorOutput = '';

      childProc.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;

        // Parse PROGRESS output to update autoTypeResumeIndex
        const progressLines = text.split(/\r?\n/);
        for (const pl of progressLines) {
          const match = pl.trim().match(/PROGRESS:(\d+)/);
          if (match) {
            // PROGRESS value is 0-based index within the substring sent to the typing process.
            // Convert to absolute position within autoTypeFullCode.
            const absoluteIndex = autoTypeSessionStartIndex + parseInt(match[1], 10) + 1;
            if (absoluteIndex > autoTypeResumeIndex) {
              autoTypeResumeIndex = absoluteIndex;
            }
          }
        }
      });

      childProc.stderr.on('data', (data) => {
        const stderrText = data.toString();
        errorOutput += stderrText;

        // macOS AppleScript outputs PROGRESS via 'log' (stderr)
        if (process.platform === 'darwin') {
          const stderrLines = stderrText.split(/\r?\n/);
          for (const sl of stderrLines) {
            const match = sl.trim().match(/PROGRESS:(\d+)/);
            if (match) {
              const absoluteIndex = autoTypeSessionStartIndex + parseInt(match[1], 10) + 1;
              if (absoluteIndex > autoTypeResumeIndex) {
                autoTypeResumeIndex = absoluteIndex;
              }
            }
          }
        }
      });

      childProc.on('close', (exitCode) => {
        typingProcess = null; // Clear process reference

        if (shouldStopTyping) {
          console.log('Typing process was interrupted by app signal');
          resolve(); // Resolve normally for interruption
          return;
        }

        if (exitCode === 0) {
          console.log('Typing completed successfully');
          resolve();
        } else {
          console.error('Typing failed with code:', exitCode);
          console.error('Error output:', errorOutput);
          reject(new Error(`Typing failed with code ${exitCode}: ${errorOutput}`));
        }
      });

      childProc.on('error', (error) => {
        typingProcess = null; // Clear process reference
        console.error('Typing execution error:', error);
        reject(error);
      });

      // Handle process interruption
      if (shouldStopTyping) {
        try {
          childProc.kill('SIGTERM');
          console.log('Typing process killed due to app interruption');
        } catch (killError) {
          console.error('Error killing typing process:', killError);
        }
      }

    } catch (error) {
      typingProcess = null; // Clear process reference
      reject(error);
    }
  });
};

const extractGeneratedCode = (analysisText) => {
  try {
    if (!analysisText) {
      console.log('No analysis text to extract code from');
      return;
    }

    // Query mode: the ENTIRE current reply is auto-typeable, as clean plain text
    // (markdown stripped, tables aligned), whether or not it contains code. The
    // buffer is set fresh from this reply every time, so a previous coding answer
    // in the same chat never leaks into a later plain reply, and a code-free reply
    // in a brand-new chat still types.
    const activeMode = aiService ? aiService.getCurrentMode() : '';
    if (activeMode === 'query') {
      setGeneratedCodeBuffersRaw(markdownToPlainText(analysisText));
      if (mainWindow && mainWindow.webContents) {
        sendToRenderer('analysis-complete', { success: true, response: analysisText.trim(), mode: 'query' });
        sendToRenderer('code-copied-for-typing');
      }
      return;
    }

    console.log('Extracting code from analysis text of length:', analysisText.length);

    // Pattern to match code blocks (both ``` and ``` with language)
    const codeBlockPatterns = [
      /```java\s*\n([\s\S]*?)\n```/gi,  // Java code blocks
      /```javascript\s*\n([\s\S]*?)\n```/gi,  // JavaScript code blocks
      /```js\s*\n([\s\S]*?)\n```/gi,  // JS code blocks
      /```python\s*\n([\s\S]*?)\n```/gi,  // Python code blocks
      /```cpp\s*\n([\s\S]*?)\n```/gi,  // C++ code blocks
      /```c\s*\n([\s\S]*?)\n```/gi,  // C code blocks
      /```\s*\n([\s\S]*?)\n```/gi  // Generic code blocks
    ];

    let extractedCode = '';
    let foundCode = false;

    // Try each pattern
    for (const pattern of codeBlockPatterns) {
      const matches = analysisText.matchAll(pattern);
      for (const match of matches) {
        if (match[1] && match[1].trim()) {
          extractedCode += match[1].trim() + '\n\n';
          foundCode = true;
          console.log('Found code block:', match[1].substring(0, 100) + '...');
        }
      }
    }

    // Save extracted code as-is to preserve indentation and formatting.
    if (foundCode) {
      setGeneratedCodeBuffers(extractedCode.trim());

      console.log(`Extracted ${lastGeneratedCode.length} characters of code from analysis`);
      console.log('Code preview:', lastGeneratedCode.substring(0, 200) + '...');
      console.log(`Auto-type normalized length: ${lastGeneratedCodeForAutoType.length}`);

      // Notify frontend that we finished successfully so it can hide the loading spinner
      if (mainWindow && mainWindow.webContents) {
        sendToRenderer('analysis-complete', {
          success: true,
          response: extractedCode.trim(),
          mode: aiService ? aiService.getCurrentMode() : 'coding'
        });
        sendToRenderer('code-copied-for-typing');
      }
      return;
    } else {
      // If no code blocks found, check if this looks like plain code.
      // Since the prompt explicitly says "DO NOT output any markdown blocks", 
      // models like Gemini 3.1 Pro will output raw code.
      // We must keep the ENTIRE text, not filter line-by-line!
      const lines = analysisText.split('\n');
      let codeIndicatorCount = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && (
          trimmed.includes('public ') ||
          trimmed.includes('private ') ||
          trimmed.includes('class ') ||
          trimmed.includes('function ') ||
          trimmed.includes('def ') ||
          trimmed.includes('int ') ||
          trimmed.includes('String ') ||
          trimmed.includes('return ') ||
          trimmed.includes('{') ||
          trimmed.includes('}') ||
          trimmed.includes(';') ||
          trimmed.includes('import ') ||
          trimmed.includes('#include')
        )) {
          codeIndicatorCount++;
        }
      }

      // If we found a few lines that look like code, or it's a very short response,
      // assume the whole thing is the raw code.
      if (codeIndicatorCount > 0) {
        setGeneratedCodeBuffers(analysisText.trim());

        console.log(`Extracted ${lastGeneratedCode.length} characters of raw code from analysis`);
        console.log('Code preview:', lastGeneratedCode.substring(0, 200) + '...');
        console.log(`Auto-type normalized length: ${lastGeneratedCodeForAutoType.length}`);

        // Notify frontend that we finished successfully so it can hide the loading spinner
        if (mainWindow && mainWindow.webContents) {
          sendToRenderer('analysis-complete', {
            success: true,
            response: analysisText.trim(),
            mode: aiService ? aiService.getCurrentMode() : 'coding'
          });
          sendToRenderer('code-copied-for-typing');
        }
        return;
      } else {
        console.log('No code detected in analysis response');
        setGeneratedCodeBuffers('');
      }
    }

  } catch (error) {
    console.error('Error extracting generated code:', error);
    setGeneratedCodeBuffers('');
    return null;
  }
};

// Called with no argument by the cycle shortcut, or with a mode id by the
// dropdown in the renderer to jump straight to that mode.
const switchMode = (targetMode) => {
  if (!aiService) return;

  const modes = Object.keys(config.app.modes);
  const currentMode = aiService.getCurrentMode();
  const currentIndex = modes.indexOf(currentMode);
  const nextIndex = (currentIndex + 1) % modes.length;
  const nextMode = modes.includes(targetMode) ? targetMode : modes[nextIndex];

  if (nextMode === currentMode) return;

  const hadQueuedScreenshots = aiService.getQueue().length > 0;

  // If leaving interview mode, hide/destroy the interview BrowserView
  if (currentMode === 'interview' && nextMode !== 'interview') {
    interviewBridge.hideInterviewView();

    // Restore Solvro's main UI visibility
    if (mainWindow) {
      sendToRenderer('interview-view-hidden');
    }
  }

  const modelBeforeSwitch = aiService.getCurrentModel();
  aiService.setMode(nextMode);
  setGeneratedCodeBuffersRaw(''); // don't carry one mode's auto-type text into another
  const modeInfo = aiService.getModeInfo();

  console.log(`Switched to: ${modeInfo.name}`);

  // Queued screenshots belong to the mode they were taken in (each item carries
  // its own `mode`), and the queue otherwise survives a send until Ctrl+R. So a
  // mode change starts a fresh queue: the next send must only carry screenshots
  // taken after the switch.
  if (hadQueuedScreenshots) {
    aiService.clearQueue();
    // Sent regardless of window visibility so the renderer's copy of the queue
    // can never drift from the main process's.
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToRenderer('screenshot-queue-cleared', {
        reason: 'mode-changed',
        mode: nextMode
      });
    }
  }

  // setMode may drop a model the new mode doesn't offer — keep the UI in sync
  if (aiService.getCurrentModel() !== modelBeforeSwitch && mainWindow && mainWindow.isVisible()) {
    const modelInfo = aiService.getModelInfo();
    sendToRenderer('model-changed', {
      model: aiService.getCurrentModel(),
      name: modelInfo.name,
      icon: modelInfo.icon
    });
  }

  // The renderer process will now determine if it should activate the interview mode
  // based on the user's permissions, avoiding a race condition.

  // Update UI if window is visible
  if (mainWindow && mainWindow.isVisible()) {
    sendToRenderer('mode-changed', {
      mode: nextMode,
      name: modeInfo.name,
      icon: modeInfo.icon
    });
  }

  // Toggle global key capture based on mode or queue state
  if (nextMode === 'query' || (aiService && aiService.getQueue().length > 0)) {
    ensureKeyboardListener();
    isGlobalKeyCaptureActive = true;
  } else {
    isGlobalKeyCaptureActive = false;
  }
};

const activateInterviewMode = async () => {
  if (!mainWindow) return;

  try {
    // Start the Express server serving the Flutter web build
    await interviewBridge.startInterviewServer();

    // Leaving interview mode only HIDES the BrowserView (it stays alive), so on
    // re-entry we reuse that warm view and just show it — the React app is
    // already loaded, so it appears instantly. Only the very first entry (no
    // live view) pays the cost of creating the view and loading the ~1.3MB
    // bundle. Recreating every time is what made returning to interview slow.
    if (interviewBridge.getView()) {
      // showInterviewView() restores the view's bounds and resizes the host
      // window to full height itself.
      interviewBridge.showInterviewView();
    } else {
      interviewBridge.createInterviewView(mainWindow);

      // Keep full height for the interview UI (createInterviewView doesn't touch
      // the host window; showInterviewView handles its own resize above).
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { height: screenHeight } = primaryDisplay.bounds;
      const [x, y] = mainWindow.getPosition();
      const [w, _h] = mainWindow.getSize();
      mainWindow.setBounds({ x, y: 0, width: w, height: screenHeight });
    }

    // Tell renderer to hide its own UI
    sendToRenderer('interview-view-shown');

    console.log('[Interview] Companion app activated');
  } catch (error) {
    console.error('[Interview] Failed to activate:', error);
    // Fall back to showing an error in the renderer
    if (mainWindow) {
      sendToRenderer('interview-view-error', error.message);
    }
  }
};

// Build the interview BrowserView in the background shortly after launch and
// park it offscreen, so the FIRST time the user opens interview mode it's
// already loaded and appears instantly (activateInterviewMode then just shows
// the warm view). Runs once; later mode switches reuse the same view.
let interviewPrewarmStarted = false;
const prewarmInterviewView = async () => {
  if (interviewPrewarmStarted) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Already created (e.g. the user opened interview mode before this fired).
  if (interviewBridge.getView()) { interviewPrewarmStarted = true; return; }
  interviewPrewarmStarted = true;
  try {
    await interviewBridge.startInterviewServer();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (interviewBridge.getView()) return;
    // Create then immediately park offscreen in the same tick, so it never
    // paints over the current UI; the React app finishes loading while hidden.
    interviewBridge.createInterviewView(mainWindow);
    interviewBridge.hideInterviewView();
    logToFile('Interview view prewarmed');
  } catch (e) {
    interviewPrewarmStarted = false; // allow a retry on the next entry
    logToFile('Interview prewarm failed: ' + (e && e.message));
  }
};

// With no argument this steps to the next language; with a language id it
// selects that one directly (dropdown).
const cycleLanguage = (targetLanguage) => {
  if (!aiService) return;

  const languages = aiService.getLanguageOptions().map(l => l.id);
  const currentLanguage = aiService.getCurrentLanguage();
  const currentIndex = languages.indexOf(currentLanguage);
  const nextIndex = (currentIndex + 1) % languages.length;
  const nextLanguage = languages.includes(targetLanguage) ? targetLanguage : languages[nextIndex];

  aiService.setLanguage(nextLanguage);
  const languageInfo = aiService.getLanguageInfo();

  console.log(`Switched to: ${languageInfo.name}`);

  // Update UI if window is visible
  if (mainWindow && mainWindow.isVisible()) {
    sendToRenderer('language-changed', {
      language: nextLanguage,
      name: languageInfo.name,
      icon: languageInfo.icon
    });
  }
};

// With no argument this steps to the next model offered in the current mode;
// with a model id it selects that one directly (dropdown).
const cycleModel = (targetModel) => {
  if (!aiService) return;

  // Interview and MCQ modes are pinned to a single model — ignore switch requests
  if (aiService.isModelLocked(aiService.getCurrentMode())) {
    console.log(`Model switching is disabled in ${aiService.getCurrentMode()} mode`);
    return;
  }

  // Only cycle through the models offered in the current mode (query mode is Gemini only)
  const availableModels = aiService.getAvailableModels();
  const isTargeted = availableModels.includes(targetModel);
  if (!isTargeted && availableModels.length < 2) return;

  const currentModel = aiService.getCurrentModel();
  const currentIndex = availableModels.indexOf(currentModel);
  const nextIndex = (currentIndex + 1) % availableModels.length;
  const nextModel = isTargeted ? targetModel : availableModels[nextIndex];

  aiService.setModel(nextModel);
  const modelInfo = aiService.getModelInfo();

  console.log(`Switched to model: ${modelInfo.name}`);

  if (mainWindow && mainWindow.isVisible()) {
    sendToRenderer('model-changed', {
      model: nextModel,
      name: modelInfo.name,
      icon: modelInfo.icon
    });
  }
};

// Global window movement functions (work without focusing the window)
// Bounds last applied by moveWindowGlobally. On scaled displays (e.g. 125%) getPosition()/getSize()
// come back rounded, so re-reading them before every step makes the window creep and grow a few px
// per move. We move from the tracked bounds instead, and only resync when the window was moved or
// resized some other way (drag, resize-to-content, interview view).
let movedWindowBounds = null;

const moveWindowGlobally = (deltaX, deltaY) => {
  if (!mainWindow) return;

  const actual = mainWindow.getBounds();
  const drifted = !movedWindowBounds || ['x', 'y', 'width', 'height'].some(k => Math.abs(actual[k] - movedWindowBounds[k]) > 4);
  const base = drifted ? actual : movedWindowBounds;
  const newX = base.x + deltaX;
  const newY = base.y + deltaY;

  // Get screen bounds to prevent moving window completely off screen
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.bounds;

  // Keep at least 50px of window visible
  const minVisible = 50;
  const windowWidth = base.width;
  const windowHeight = base.height;

  const boundedX = Math.max(-windowWidth + minVisible, Math.min(newX, screenWidth - minVisible));
  const boundedY = Math.max(-windowHeight + minVisible, Math.min(newY, screenHeight - minVisible));

  movedWindowBounds = { x: boundedX, y: boundedY, width: windowWidth, height: windowHeight };
  mainWindow.setBounds(movedWindowBounds);
  console.log(`Window moved globally to: ${boundedX}, ${boundedY}`);

  // Optional: Show brief notification in window if visible
  if (mainWindow.isVisible()) {
    sendToRenderer('window-moved-notification', {
      x: boundedX,
      y: boundedY,
      direction: deltaX > 0 ? 'right' : deltaX < 0 ? 'left' : deltaY > 0 ? 'down' : 'up'
    });
  }
};

// Function to prompt for user key
const promptForUserKey = async () => {
  try {
    logToFile('Prompting user for user key...');

    // Create a simple dialog to get user key
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'User Key Required',
      message: 'Please enter your user key to access the AI services:',
      detail: 'Your user key is required to use the application features.',
      buttons: ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 0) {
      // Show input dialog (we'll need to create this)
      showUserKeyInputDialog();
    } else {
      logToFile('User cancelled user key input');
    }
  } catch (error) {
    logToFile(`Error showing user key prompt: ${error.message}`);
  }
};

// Function to show user key input dialog
const showUserKeyInputDialog = () => {
  if (!mainWindow) return;

  logToFile('Showing user key input dialog');

  // Send message to renderer to show user key input
  sendToRenderer('show-user-key-input');
};

// Function to handle user key submission
const handleUserKeySubmission = async (userKey) => {
  try {
    logToFile(`Attempting to set user key: ${userKey ? 'provided' : 'empty'}`);

    if (!userKey || userKey.trim() === '') {
      if (mainWindow) {
        sendToRenderer('user-key-error', 'User key cannot be empty');
      }
      return;
    }

    // Set user key in AI service
    await aiService.setUserKey(userKey.trim());
    logToFile('User key set successfully');

    // Notify renderer of success
    if (mainWindow) {
      sendToRenderer('user-key-success', 'User key validated successfully');
    }

  } catch (error) {
    logToFile(`Failed to set user key: ${error.message}`);

    let errorMessage = 'Failed to validate user key';
    if (error.message.includes('expired')) {
      errorMessage = 'User key has expired. Please contact support for a new key.';
    } else if (error.message.includes('Network error')) {
      errorMessage = 'Network error. Please check your internet connection.';
    } else if (error.message.includes('Invalid') || error.message.includes('invalid')) {
      errorMessage = 'Invalid user key. Please check your key and try again.';
    } else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      errorMessage = 'Invalid user key. Please check your key and try again.';
    } else if (error.message.includes('403') || error.message.includes('Forbidden')) {
      errorMessage = 'User key access denied. Please contact support.';
    } else if (error.message.includes('404') || error.message.includes('Not found')) {
      errorMessage = 'Invalid user key. Please check your key and try again.';
    }

    if (mainWindow) {
      sendToRenderer('user-key-error', errorMessage);
    }
  }
};

const resetWindowPosition = () => {
  if (!mainWindow) return;

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { height: fullHeight } = display.bounds;

  clearUserWindowGeometry();
  mainWindow.setPosition(0, 0);
  mainWindow.setSize(800, fullHeight);
  console.log('Window position reset to top-left corner');

  // Optional: Show brief notification in window if visible
  if (mainWindow.isVisible()) {
    sendToRenderer('window-moved-notification', {
      x: 0,
      y: 0,
      direction: 'reset'
    });
  }
};

const notifyScreenshotLimitReached = () => {
  const max = aiService.getMaxScreenshots();
  const queueSize = aiService.getQueue().length;
  logToFile(`Screenshot limit reached (${queueSize}/${max}), not capturing`);
  if (mainWindow) {
    sendToRenderer('screenshot-limit-reached', { max, queueSize });
  }
};

const handleScreenshot = async () => {
  logToFile('handleScreenshot function called');
  try {
    // Check if services are initialized
    if (!screenshotService) {
      logToFile('ERROR: screenshotService is not initialized');
      if (mainWindow) {
        sendToRenderer('screenshot-error', 'Screenshot service not initialized');
      }
      return;
    }

    if (!aiService) {
      logToFile('ERROR: aiService is not initialized');
      if (mainWindow) {
        sendToRenderer('screenshot-error', 'AI service not initialized');
      }
      return;
    }

    logToFile('Services are initialized, proceeding with screenshot');

    // Checked before capturing so a full queue doesn't flicker the window or
    // waste a capture. Only coding/mcq/query are capped (see remoteConfig).
    if (aiService.isQueueFull()) {
      notifyScreenshotLimitReached();
      return;
    }

    // Instant feedback the moment the shortcut fires, so there's no perceived
    // delay while the capture happens. The renderer shows a toast; because the
    // window is content-protected it won't appear in the capture taken just below.
    sendToRenderer('screenshot-capturing');

    // The window does NOT need to be hidden to stay out of its own screenshot:
    // setContentProtection(true) (always on — applyEnhancedStealth) excludes it
    // from every screen capture, desktopCapturer included, so the shot shows the
    // content behind it with the app simply absent. The old opacity dip + 100ms
    // wait is what made the app visibly vanish and reappear. Only fall back to a
    // brief, minimal dip if content protection is somehow not active.
    const contentProtected = !!(stealthService && stealthService.enhancedStealthEnabled);
    const needHide = mainWindow && mainWindow.isVisible() && !contentProtected;
    if (needHide) {
      logToFile('Content protection off — briefly dipping opacity for screenshot');
      mainWindow.setOpacity(0.01);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    logToFile('Taking screenshot...');
    const base64Image = await screenshotService.captureScreen();
    logToFile('Screenshot captured successfully');

    if (needHide) {
      mainWindow.setOpacity(currentOpacity);
    }

    logToFile('Adding screenshot to queue...');
    // Add screenshot to queue with base64 image (no extraction yet)
    const screenshot = aiService.addScreenshotToQueue(
      base64Image,
      null, // No extracted data yet
      new Date().toISOString()
    );
    if (!screenshot) {
      // Queue filled up while this capture was in flight (e.g. rapid shortcut presses)
      notifyScreenshotLimitReached();
      return;
    }
    logToFile(`Screenshot added to queue successfully. ID: ${screenshot.id}`);

    // Get queue safely
    let queue;
    try {
      queue = aiService.getQueue();
      logToFile(`Current queue size: ${queue ? queue.length : 'undefined'}`);
    } catch (queueError) {
      logToFile(`ERROR getting queue: ${queueError.stack}`);
      queue = [];
    }

    // Update UI with new screenshot in queue
    if (mainWindow) {
      logToFile('Sending screenshot-queued event to renderer');
      sendToRenderer('screenshot-queued', {
        screenshot: screenshot,
        queueSize: queue.length,
        queue: queue,
        maxScreenshots: aiService.getMaxScreenshots(),
        message: 'Screenshot added to queue. Press Ctrl+Enter to analyze all screenshots.'
      });

      // Enable global key capture without changing window state to avoid taskbar flickering
      logToFile('Enabling global key capture for queue context input');
      ensureKeyboardListener();
      isGlobalKeyCaptureActive = true;
    }
  } catch (error) {
    logToFile(`Screenshot error: ${error.stack}`);
    if (mainWindow) {
      sendToRenderer('screenshot-error', error.message);
    }
  }
};

const handleSendQueue = async (additionalText = '') => {
  logToFile('handleSendQueue function called');
  try {
    logToFile('=== handleSendQueue called (Direct Analysis) ===');
    logToFile(`additionalText: ${additionalText}`);

    // Disable global key capture
    logToFile('Disabling global key capture as queue is being sent');
    isGlobalKeyCaptureActive = false;

    if (!aiService) {
      logToFile('ERROR: aiService is not initialized');
      if (mainWindow) {
        sendToRenderer('queue-error', 'AI service not initialized');
      }
      return { success: false, error: 'AI service not initialized' };
    }

    let queue;
    try {
      queue = aiService.getQueue();
      logToFile(`Queue retrieved successfully. Length: ${queue ? queue.length : 'undefined'}`);
    } catch (queueError) {
      logToFile(`ERROR getting queue: ${queueError.stack}`);
      if (mainWindow) {
        sendToRenderer('queue-error', 'Failed to get queue');
      }
      return { success: false, error: 'Failed to get queue' };
    }

    // Allow text-only analysis in Query mode or Interview mode even if queue is empty
    const currentModeForSend = aiService.getCurrentMode();
    if ((!queue || queue.length === 0) && currentModeForSend !== 'query' && currentModeForSend !== 'interview') {
      logToFile('No screenshots in queue');
      if (mainWindow) {
        sendToRenderer('queue-error', 'No screenshots in queue to analyze');
      }
      return { success: false, error: 'No screenshots in queue' };
    }

    // Send processing started event
    logToFile('Starting direct image analysis...');
    if (mainWindow) {
      sendToRenderer('queue-processing', {
        queueSize: queue.length,
        message: 'Analyzing screenshots with AI...'
      });
    }

    // Analyze all images directly with OpenAI Vision
    logToFile('Calling analyzeMultipleImages...');
    const analysis = await aiService.analyzeMultipleImages(queue, additionalText, (chunk) => {
      if (mainWindow) {
        sendToRenderer('ai-stream-chunk', chunk);
      }
    });
    logToFile('Direct analysis completed');
    console.log(`[Main] Final analysis length from server: ${analysis.length}`);
    console.log('[Main] Final analysis text start');
    console.log(analysis);
    console.log('[Main] Final analysis text end');

    // Extract and store generated code for auto-typing
    extractGeneratedCode(analysis);

    // Save to local storage if in coding or interview mode
    const currentMode = aiService.getCurrentMode();
    logToFile(`Current mode: ${currentMode}`);
    if ((currentMode === 'coding' || currentMode === 'interview') && localStorageService) {
      logToFile(`${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)} mode - saving session to local storage...`);
      const saveResult = await localStorageService.saveSession(queue, analysis, currentMode, additionalText);
      if (saveResult.success) {
        logToFile(`✓ Session saved to: ${saveResult.path}`);
        // Notify renderer about successful save
        if (mainWindow) {
          sendToRenderer('session-saved', {
            success: true,
            path: saveResult.path,
            folderName: saveResult.folderName,
            mode: currentMode
          });
        }
      } else {
        logToFile(`✗ Failed to save session: ${saveResult.error}`);
      }
    } else if (currentMode !== 'coding' && currentMode !== 'interview') {
      logToFile(`Not in coding/interview mode (${currentMode}) - skipping local save`);
    }

    // Send analysis completed event
    if (mainWindow) {
      let conversationHistory;
      try {
        conversationHistory = aiService.getConversationHistory();
        logToFile(`Conversation history length: ${conversationHistory ? conversationHistory.length : 'undefined'}`);
      } catch (historyError) {
        logToFile(`ERROR getting conversation history: ${historyError.stack}`);
        conversationHistory = [];
      }

      const dataToSend = {
        response: analysis,
        analyzedScreenshots: queue.length,
        conversationLength: conversationHistory.length,
        history: conversationHistory
      };
      logToFile('Sending data to renderer');
      sendToRenderer('queue-analysis', dataToSend);
    }

    // We no longer clear the queue automatically here.
    // The user explicitly requested: "if we press ctrl+enter it should send the previous queue again until we press ctrl+r"
    // So the queue will persist until resetConversation is called.
    // Exception: Query (chat) mode — screenshots are attachments of the message just sent.
    const queueCleared = currentMode === 'query';
    if (queueCleared) {
      aiService.clearQueue();
    }

    return {
      success: true,
      analysis: analysis,
      queueCleared
    };

  } catch (error) {
    logToFile(`Queue processing error: ${error.stack}`);
    // `details` carries the backend's structured rejection (quota, plan, ...) so
    // the renderer can show the right card instead of a generic failure.
    if (mainWindow) {
      sendToRenderer('queue-error', {
        message: error.message,
        details: error.details || null
      });
    }
    return {
      success: false,
      error: error.message,
      details: error.details || null
    };
  } finally {
    // Query (chat) mode keeps capturing keystrokes so the user can type follow-ups
    if (aiService && aiService.getCurrentMode() === 'query') {
      ensureKeyboardListener();
      isGlobalKeyCaptureActive = true;
    }
  }
};

// Stealth mode functions
const enableStealthMode = () => {
  if (!mainWindow || !stealthService) return;

  // Apply enhanced stealth protection using proven techniques
  stealthService.applyEnhancedStealth(mainWindow);

  // Don't override opacity if we're using the opacity toggle system
  // Only set stealth opacity if we're not in opacity-hidden state
  if (!isOpacityHidden) {
    // Make window completely transparent to screen capture
    mainWindow.setOpacity(config.app.stealth.minOpacity);
  }

  // Position window strategically using stealth service
  const stealthPosition = stealthService.getStealthPosition();
  mainWindow.setPosition(stealthPosition.x, stealthPosition.y);

  // Platform-specific stealth settings
  if (process.platform === 'win32') {
    // Windows: Additional stealth settings
    // mainWindow.setSkipTaskbar(true); // Keep app visible in taskbar
  } else if (process.platform === 'darwin') {
    // macOS: Set window level to avoid most screen capture
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  }
};

const disableStealthMode = () => {
  if (!mainWindow || !stealthService) return;

  // Remove enhanced stealth protection
  stealthService.removeEnhancedStealth(mainWindow);

  mainWindow.setOpacity(currentOpacity); // Use currentOpacity instead of config value
};

const showWindowWithStealth = () => {
  if (!mainWindow) return;

  // Always reset to left position when showing
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { height: fullHeight } = display.bounds;

  clearUserWindowGeometry();
  // Set window size first
  mainWindow.setSize(800, fullHeight);

  enableStealthMode();

  // Force window to left position AFTER enabling stealth mode to override stealth positioning
  mainWindow.setPosition(0, 0);

  // Set click-through mode based on current state
  mainWindow.setIgnoreMouseEvents(isClickThroughEnabled, { forward: true });

  mainWindow.show();
  mainWindow.focus(); // Ensure window has focus to receive keyboard events

  // Set opacity directly to current user setting - no gradual animation for toggle
  mainWindow.setOpacity(currentOpacity);

  console.log(`Window shown at left position: 0, 0 with full height: ${fullHeight}, opacity: ${Math.round(currentOpacity * 100)}%`);
};

const hideWindowWithStealth = () => {
  if (!mainWindow) return;

  // For toggle functionality, immediately hide the window without opacity animation
  mainWindow.hide();

  console.log('Window hidden via toggle');
};

// IPC handlers
ipcMain.handle('take-screenshot', handleScreenshot);
let isSendQueueInFlight = false;
ipcMain.handle('send-queue', async (event, additionalText) => {
  // Interview mode manages its own triggers; every other mode gets one response per send
  const guard = !(aiService && aiService.getCurrentMode() === 'interview');
  if (guard && isSendQueueInFlight) {
    logToFile('send-queue ignored: a request is already in flight');
    return { success: false, error: 'A request is already in progress', busy: true };
  }
  if (guard) isSendQueueInFlight = true;
  try {
    return await handleSendQueue(additionalText);
  } finally {
    if (guard) isSendQueueInFlight = false;
  }
});

ipcMain.handle('reset-conversation', () => {
  // Disable global key capture when resetting, unless in query mode
  logToFile('Handling global key capture on conversation reset');
  if (aiService && aiService.getCurrentMode() === 'query') {
    isGlobalKeyCaptureActive = true;
  } else {
    isGlobalKeyCaptureActive = false;
  }

  if (aiService) {
    aiService.resetConversation();
    setGeneratedCodeBuffersRaw(''); // nothing to auto-type after a reset
    return {
      success: true,
      message: 'Conversation reset successfully'
    };
  }
  return { success: false, message: 'AI service not available' };
});
ipcMain.handle('get-queue', () => {
  return aiService ? aiService.getQueue() : [];
});
ipcMain.handle('remove-from-queue', (event, id) => {
  return aiService ? aiService.removeScreenshotFromQueue(id) : [];
});
ipcMain.handle('get-conversation-history', () => {
  return aiService ? aiService.getConversationHistory() : [];
});
ipcMain.handle('hide-interview-view', () => {
  interviewBridge.hideInterviewView();
});
ipcMain.handle('show-interview-view', () => {
  activateInterviewMode();
});

// Page-level overlays (profile panel, shortcuts modal, ...) live in the main
// window's web contents, which the interview BrowserView paints over. The
// renderer tells us when one is open so we can park the view out of the way.
ipcMain.handle('set-overlay-mask', (event, isOpen) => {
  try {
    if (isOpen) {
      interviewBridge.suspendInterviewView();
    } else {
      interviewBridge.resumeInterviewView();
    }
  } catch (e) {
    console.error('[Overlay] mask toggle failed:', e);
  }
  return true;
});
// The host window's own theme toggle only affects its own document; forward it
// to the interview BrowserView (separate web contents) so that screen themes too.
ipcMain.on('set-theme', (event, theme) => {
  try {
    interviewBridge.setTheme(theme);
  } catch (e) {
    console.error('[Theme] forward to interview view failed:', e);
  }
});
// A selector dropdown is open in the host page: shrink the interview BrowserView
// down to `bottomY` so the menu (which this page paints below the top bar) isn't
// covered by it; 0 restores the view to full size.
ipcMain.on('set-interview-menu-clear', (event, bottomY) => {
  try {
    interviewBridge.setMenuClearTop(bottomY);
  } catch (e) {
    console.error('[Interview] menu-clear failed:', e);
  }
});
// The host measured its top bar's height; keep the interview view positioned
// just below it so a taller top bar (e.g. wrapped pills) doesn't get covered.
ipcMain.on('set-interview-content-top', (event, y) => {
  try {
    interviewBridge.setContentTop(y);
  } catch (e) {
    console.error('[Interview] content-top failed:', e);
  }
});
ipcMain.handle('set-interview-context', (event, context) => {
  if (aiService) {
    aiService.setInterviewContext(context);
    return { success: true };
  }
  return { success: false, message: 'AI service not available' };
});
ipcMain.handle('hide-window', () => {
  if (mainWindow) {
    // Use opacity toggle instead of hiding window
    toggleWindowOpacity();
  }
});

ipcMain.handle('quit-app', () => {
  logToFile('Quit app requested via close button');

  // Force close main window
  if (mainWindow) {
    logToFile('Destroying main window');
    mainWindow.destroy();
    mainWindow = null;
  }

  // Quit the app
  app.quit();

  // If app.quit() doesn't work, force exit
  setTimeout(forceExitUnlessUpdating, 1000);
});

ipcMain.handle('launch-overlay-mode', async () => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return { success: false, error: 'Overlay mode is only available on Windows and macOS.' };
  }

  // Refresh the token file BEFORE launching the overlay so it picks up the
  // current session. The normal 15s-delayed refresh never fires because
  // the Electron app quits within ~11s of startup.
  logToFile('launch-overlay-mode: refreshing token before overlay launch...');
  const token = readSessionToken();
  if (token) {
    writeSessionToken(token);
    logToFile('launch-overlay-mode: token re-written to disk');
  }
  try { await refreshSessionToken(); } catch (_) {}

  // ── macOS path ────────────────────────────────────────────────────────
  if (process.platform === 'darwin') {
    let overlayAppPath = path.join(process.resourcesPath, 'overlay-mac', 'solvro-overlay.app');
    if (!fs.existsSync(overlayAppPath)) {
      overlayAppPath = path.join(__dirname, 'overlay-mac', 'solvro-overlay.app');
    }
    if (!fs.existsSync(overlayAppPath)) {
      logToFile('launch-overlay-mode: solvro-overlay.app not found');
      return { success: false, error: 'macOS overlay app not found.' };
    }
    try {
      const { spawn } = require('child_process');
      const child = spawn('open', ['-a', overlayAppPath], { detached: true, stdio: 'ignore' });
      child.unref();
      logToFile('launch-overlay-mode: launched macOS overlay at ' + overlayAppPath);

      if (mainWindow) mainWindow.hide();
      globalShortcut.unregisterAll();
      if (keyboardListener) {
        try { keyboardListener.kill(); } catch (_) {}
        keyboardListener = null;
      }
      logToFile('launch-overlay-mode: macOS overlay launched, quitting Electron');
      if (mainWindow) {
        mainWindow.destroy();
        mainWindow = null;
      }
      app.quit();
      setTimeout(forceExitUnlessUpdating, 500);
      return { success: true };
    } catch (err) {
      logToFile('launch-overlay-mode: macOS spawn failed: ' + err.message);
      if (mainWindow) mainWindow.show();
      return { success: false, error: err.message };
    }
  }

  // ── Windows path ──────────────────────────────────────────────────────
  let hopePath = path.join(process.resourcesPath, 'hope', 'hope.exe');
  if (!fs.existsSync(hopePath)) {
    hopePath = path.join(__dirname, 'hope', 'hope.exe');
  }
  if (!fs.existsSync(hopePath)) {
    logToFile('launch-overlay-mode: hope.exe not found');
    return { success: false, error: 'Overlay executable not found.' };
  }

  const hopeDir = path.dirname(hopePath);
  let launcherPath = process.execPath;
  const launcherDir = !app.isPackaged ? __dirname : '';

  const execAsync = (cmd, opts) => new Promise((resolve, reject) => {
    require('child_process').exec(cmd, opts, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout || '');
    });
  });

  try {
    try {
      await execAsync('taskkill /F /IM hope.exe', { timeout: 5000 });
      await new Promise(r => setTimeout(r, 1500));
      try { await execAsync('taskkill /F /IM hope.exe', { timeout: 3000 }); } catch (_) {}
      await new Promise(r => setTimeout(r, 500));
    } catch (_) {}

    logToFile('launch-overlay-mode: launching ' + hopePath);

    let launched = false;

    const isHopeAlive = async () => {
      try {
        const o = await execAsync('tasklist /FI "IMAGENAME eq hope.exe" /NH', { encoding: 'utf8', timeout: 5000 });
        return o.toLowerCase().includes('hope.exe');
      } catch (_) { return false; }
    };
    const waitForHope = async (delayMs, retries) => {
      for (let i = 0; i < retries; i++) {
        await new Promise(r => setTimeout(r, delayMs));
        if (await isHopeAlive()) return true;
      }
      return false;
    };

    // Path A: try the scheduled task (no UAC prompt — instant)
    if (app.isPackaged) {
      try {
        await execAsync('schtasks /run /tn "SolvroHope"', { timeout: 5000 });
        logToFile('launch-overlay-mode: schtasks /run returned success, verifying...');
        launched = await waitForHope(400, 5);
        if (launched) {
          logToFile('launch-overlay-mode: launched via scheduled task (verified running)');
        } else {
          logToFile('launch-overlay-mode: scheduled task ran but hope.exe not alive (battery/power issue?)');
        }
      } catch (_) {
        logToFile('launch-overlay-mode: scheduled task not found or failed');
      }
    }

    // Path B: create the scheduled task with battery support (one-time UAC), then run it
    if (!launched && app.isPackaged) {
      try {
        const tempScript = path.join(os.tmpdir(), 'solvro-setup-task.ps1');
        const psLines = [
          '$action = New-ScheduledTaskAction -Execute \'' + hopePath.replace(/'/g, "''") + '\' -Argument \'--launcher "' + launcherPath.replace(/'/g, "''") + '"\'',
          '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 72)',
          'Register-ScheduledTask -TaskName "SolvroHope" -Action $action -Settings $settings -RunLevel Highest -Force | Out-Null',
        ].join('\r\n');
        fs.writeFileSync(tempScript, psLines);
        const escapedScript = tempScript.replace(/'/g, "''");
        logToFile('launch-overlay-mode: creating scheduled task via elevation');
        await execAsync(
          `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\\"${escapedScript.replace(/"/g, '`"')}\\\"' -Verb RunAs -Wait -WindowStyle Hidden"`,
          { timeout: 120000 }
        );
        try { fs.unlinkSync(tempScript); } catch(_){}
        await execAsync('schtasks /run /tn "SolvroHope"', { timeout: 5000 });
        launched = await waitForHope(400, 8);
        if (launched) {
          logToFile('launch-overlay-mode: created and launched via new scheduled task');
        } else {
          logToFile('launch-overlay-mode: new task created but hope.exe not alive');
        }
      } catch (taskErr) {
        logToFile('launch-overlay-mode: scheduled task creation failed: ' + taskErr.message);
      }
    }

    // Path C: direct elevation with proper quoting (fallback)
    if (!launched) {
      try {
        const escapedPath = hopePath.replace(/'/g, "''");
        const escapedDir = hopeDir.replace(/'/g, "''");
        const escapedLauncher = launcherPath.replace(/'/g, "''");
        const dirArg = launcherDir ? ` --launcher-dir \\\"${launcherDir.replace(/'/g, "''")}\\\"` : '';
        const psCmd = `Start-Process -FilePath '${escapedPath}' -ArgumentList '--launcher \\\"${escapedLauncher}\\\"${dirArg}' -WorkingDirectory '${escapedDir}' -Verb RunAs`;
        logToFile('launch-overlay-mode: elevating via PowerShell');
        await execAsync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 120000 });
        logToFile('launch-overlay-mode: launched via direct elevation');
        launched = await waitForHope(400, 8);
      } catch (launchErr) {
        logToFile('launch-overlay-mode: elevation failed: ' + launchErr.message);
        return { success: false, error: 'Overlay launch was cancelled or failed. If you saw a UAC prompt, please click Yes.' };
      }
    }

    if (!launched) {
      logToFile('launch-overlay-mode: hope.exe not running after all paths');
      return { success: false, error: 'Overlay started but exited immediately. This is usually caused by antivirus blocking it — check Windows Security and allow hope.exe.' };
    }

    // hope.exe is alive — hide our window INSTANTLY, then clean up and quit.
    if (mainWindow) mainWindow.hide();
    globalShortcut.unregisterAll();
    if (keyboardListener) {
      try { keyboardListener.kill(); } catch (_) {}
      keyboardListener = null;
    }
    logToFile('launch-overlay-mode: hope.exe confirmed running, quitting Electron');

    if (mainWindow) {
      mainWindow.destroy();
      mainWindow = null;
    }
    app.quit();
    setTimeout(forceExitUnlessUpdating, 500);
    return { success: true };
  } catch (err) {
    logToFile('launch-overlay-mode: spawn failed: ' + err.message);
    if (mainWindow) mainWindow.show();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-update', () => {
  logToFile('install-update invoked: quitting to install downloaded update');
  // Silent, so there is no installer wizard to click through. isForceRunAfter=true
  // so the app relaunches itself once the installer finishes.
  if (autoUpdater) autoUpdater.quitAndInstall(true, true);
});

// "Cancel" on the update banner: don't install after the next restart. Offered again
// on the next launch. A forced update can't be cancelled.
ipcMain.handle('dismiss-update', () => {
  if (!autoUpdater || isForceUpdate()) return;
  logToFile('Update cancelled for this session');
  updateCancelled = true;
  autoUpdater.autoInstallOnAppQuit = false;
  cancelUpdateAfterRestart();
});

// Pull side of the update banner. The renderer calls this as soon as its IPC
// listeners are wired, so even if the 'update-downloaded' push was emitted
// before the renderer existed (or the renderer reloaded), it still learns a
// newer version is ready to install and shows the banner. Returns null when
// up to date.
ipcMain.handle('get-pending-update', () => {
  if (!pendingUpdateState) return null;
  return {
    version: pendingUpdateState.version,
    phase: pendingUpdateState.phase,
    forced: pendingUpdateState.forced || isForceUpdate(),
    progress: lastUpdateDownloadProgress
  };
});

ipcMain.handle('get-current-mode', () => {
  if (aiService) {
    const currentMode = aiService.getCurrentMode();
    const modeInfo = aiService.getModeInfo();
    return {
      mode: currentMode,
      name: modeInfo.name,
      icon: modeInfo.icon
    };
  }
  return null;
});
// Mode info plus the current model — switching mode may drop a model the new
// mode doesn't offer (e.g. Fable 5 isn't available in Query), so returning the
// reconciled model here lets the renderer update the model pill in the SAME step
// as the mode, instead of briefly showing the old, now-invalid model until the
// separate model-changed event arrives.
const modeWithModel = () => {
  const modelInfo = aiService.getModelInfo();
  return {
    mode: aiService.getCurrentMode(),
    name: aiService.getModeInfo().name,
    icon: aiService.getModeInfo().icon,
    model: {
      model: aiService.getCurrentModel(),
      name: modelInfo.name,
      icon: modelInfo.icon,
    },
  };
};

ipcMain.handle('switch-mode', () => {
  switchMode();
  return aiService ? modeWithModel() : null;
});

ipcMain.handle('get-current-language', () => {
  if (aiService) {
    const currentLanguage = aiService.getCurrentLanguage();
    const languageInfo = aiService.getLanguageInfo();
    return {
      language: currentLanguage,
      name: languageInfo.name,
      icon: languageInfo.icon
    };
  }
  return null;
});

ipcMain.handle('cycle-language', () => {
  cycleLanguage();
  return aiService ? {
    language: aiService.getCurrentLanguage(),
    name: aiService.getLanguageInfo().name,
    icon: aiService.getLanguageInfo().icon
  } : null;
});

ipcMain.handle('get-current-model', () => {
  if (aiService) {
    const currentModel = aiService.getCurrentModel();
    const modelInfo = aiService.getModelInfo();
    return {
      model: currentModel,
      name: modelInfo.name,
      icon: modelInfo.icon
    };
  }
  return null;
});

ipcMain.handle('cycle-model', () => {
  cycleModel();
  return aiService ? {
    model: aiService.getCurrentModel(),
    name: aiService.getModelInfo().name,
    icon: aiService.getModelInfo().icon
  } : null;
});

// ─── Direct selection (dropdowns) ───
// The cycle handlers above walk one step at a time; these jump straight to a
// chosen mode/language/model. Invalid ids are ignored and the current value is
// returned unchanged.
ipcMain.handle('set-mode', (event, mode) => {
  switchMode(mode);
  return aiService ? modeWithModel() : null;
});

ipcMain.handle('set-language', (event, language) => {
  cycleLanguage(language);
  return aiService ? {
    language: aiService.getCurrentLanguage(),
    name: aiService.getLanguageInfo().name,
    icon: aiService.getLanguageInfo().icon
  } : null;
});

ipcMain.handle('set-model', (event, model) => {
  cycleModel(model);
  return aiService ? {
    model: aiService.getCurrentModel(),
    name: aiService.getModelInfo().name,
    icon: aiService.getModelInfo().icon
  } : null;
});

// Everything the dropdowns need to render: the full option lists plus which
// entry is selected. Models are already filtered to the current mode.
ipcMain.handle('get-selector-options', () => {
  if (!aiService) return null;
  return {
    modes: aiService.getModeOptions(),
    languages: aiService.getLanguageOptions(),
    models: aiService.getModelOptions(),
    // Every model's plan tier, not just the ones this mode offers, so the
    // renderer can gate any id it is handed. Server-supplied: a model added on
    // the website is gated correctly by app builds that predate it.
    modelTiers: Object.fromEntries(
      remoteConfig.getModels().map(m => [m.id, m.tier])
    ),
    modelLocked: aiService.isModelLocked(aiService.getCurrentMode())
  };
});
ipcMain.handle('move-window', (event, deltaX, deltaY) => {
  if (mainWindow) {
    const [currentX, currentY] = mainWindow.getPosition();
    const newX = currentX + deltaX;
    const newY = currentY + deltaY;

    // Get screen bounds to prevent moving window completely off screen
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.workAreaSize;

    // Keep at least 50px of window visible
    const minVisible = 50;
    const [windowWidth, windowHeight] = mainWindow.getSize();

    const boundedX = Math.max(-windowWidth + minVisible, Math.min(newX, screenWidth - minVisible));
    const boundedY = Math.max(-windowHeight + minVisible, Math.min(newY, screenHeight - minVisible));

    mainWindow.setPosition(boundedX, boundedY);
    console.log(`Window moved to: ${boundedX}, ${boundedY}`);
    return { x: boundedX, y: boundedY };
  }
  return null;
});

ipcMain.handle('set-window-position', (event, x, y) => {
  if (mainWindow) {
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.bounds;

    // Keep at least 50px of window visible
    const minVisible = 50;
    const [windowWidth, windowHeight] = mainWindow.getSize();

    const boundedX = Math.max(-windowWidth + minVisible, Math.min(x, screenWidth - minVisible));
    const boundedY = Math.max(-windowHeight + minVisible, Math.min(y, screenHeight - minVisible));

    mainWindow.setPosition(boundedX, boundedY);
    console.log(`Window position set to: ${boundedX}, ${boundedY}`);
    return { x: boundedX, y: boundedY };
  }
  return null;
});
// Window geometry the user chose by hand. While either is set, the automatic
// full-height sizing below leaves the window alone. Cleared by the explicit
// "put it back" paths (showWindowWithStealth, resetWindowPosition,
// maximize-height) via clearUserWindowGeometry().
let userSizedHeight = false;   // user dragged the top/bottom edge
let maximizedFrom = null;      // bounds to restore when un-maximizing, or null

const WINDOW_MIN_W = 600;
const WINDOW_MAX_W = 1200;
const WINDOW_MIN_H = 200;

const restoreWindowSizeLimits = () => {
  if (!mainWindow) return;
  const { screen } = require('electron');
  mainWindow.setMaximumSize(WINDOW_MAX_W, screen.getPrimaryDisplay().bounds.height);
};

const clearUserWindowGeometry = () => {
  userSizedHeight = false;
  if (maximizedFrom) {
    maximizedFrom = null;
    restoreWindowSizeLimits();
  }
};

// Double-click on the title bar: toggle between filling the work area (like a
// maximized Explorer/browser window, taskbar still visible) and the previous
// bounds. Done by hand rather than with maximize(): the window is
// maximizable:false and a native maximize of a transparent frameless window
// misbehaves on Windows.
const toggleWindowMaximized = () => {
  if (!mainWindow) return;
  if (maximizedFrom) {
    const restore = maximizedFrom;
    maximizedFrom = null;
    restoreWindowSizeLimits();
    mainWindow.setBounds(restore);
    return;
  }
  const { screen } = require('electron');
  maximizedFrom = mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(maximizedFrom);
  mainWindow.setMaximumSize(0, 0); // lift the 1200px cap while maximized
  mainWindow.setBounds(workArea);
};

// Title-bar double-click maximize for macOS/Linux. On Windows the drag region is
// the native caption, so the page never sees the double-click and it's handled by
// hookWindowMessage(WM_NCLBUTTONDBLCLK) at window creation. On other platforms the
// renderer detects the double-click on .title-bar and calls this instead.
ipcMain.handle('toggle-maximize', () => {
  if (process.platform !== 'win32') toggleWindowMaximized();
});

ipcMain.handle('resize-window-to-content', (event, contentHeight) => {
  if (mainWindow) {
    const [currentWidth, currentHeight] = mainWindow.getSize();
    // Respect a height the user set (edge drag or title-bar maximize).
    if (userSizedHeight || maximizedFrom) {
      return { width: currentWidth, height: currentHeight };
    }
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const screenHeight = display.bounds.height;

    // Force full screen height
    const newHeight = screenHeight;

    mainWindow.setSize(currentWidth, newHeight);
    // Don't change window position - keep it where user placed it
    console.log(`Window forced to full height: ${currentWidth}x${newHeight}`);
    return { width: currentWidth, height: newHeight };
  }
  return null;
});

// In-page edge resizing (see src/renderer/stealthUi.js). The window is created
// with resizable:false so Windows never shows its resize cursor at the edges;
// instead the page draws invisible edge/corner strips and drives the resize
// here. `edge` is one of top/bottom/left/right or a corner like 'bottom-right'.
let stealthResize = null; // { edge, startCursor, startBounds, maxH }

ipcMain.on('stealth-resize-start', (_event, edge) => {
  if (!mainWindow || typeof edge !== 'string' || !/^(top|bottom|left|right)(-(left|right))?$/.test(edge)) return;
  const { screen } = require('electron');
  // Grabbing an edge while maximized drops back to a normal, user-sized window.
  if (maximizedFrom) {
    maximizedFrom = null;
    restoreWindowSizeLimits();
  }
  const startBounds = mainWindow.getBounds();
  stealthResize = {
    edge,
    startCursor: screen.getCursorScreenPoint(),
    startBounds,
    maxH: screen.getDisplayMatching(startBounds).bounds.height
  };
});

ipcMain.on('stealth-resize-move', () => {
  if (!mainWindow || !stealthResize) return;
  const { screen } = require('electron');
  const { edge, startCursor, startBounds, maxH } = stealthResize;
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - startCursor.x;
  const dy = cursor.y - startCursor.y;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let { x, y, width, height } = startBounds;
  // The opposite edge stays put: dragging left/top moves x/y by however much
  // the (clamped) size actually changed.
  if (edge.includes('right')) width = clamp(startBounds.width + dx, WINDOW_MIN_W, WINDOW_MAX_W);
  if (edge.includes('left')) {
    width = clamp(startBounds.width - dx, WINDOW_MIN_W, WINDOW_MAX_W);
    x = startBounds.x + startBounds.width - width;
  }
  if (edge.includes('bottom')) height = clamp(startBounds.height + dy, WINDOW_MIN_H, maxH);
  if (edge.includes('top')) {
    height = clamp(startBounds.height - dy, WINDOW_MIN_H, maxH);
    y = startBounds.y + startBounds.height - height;
  }
  if (height !== startBounds.height) userSizedHeight = true;
  mainWindow.setBounds({ x, y, width, height });
});

ipcMain.on('stealth-resize-end', () => {
  stealthResize = null;
});

ipcMain.handle('maximize-height', () => {
  if (mainWindow) {
    const [currentWidth] = mainWindow.getSize();
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const workAreaHeight = display.workAreaSize.height;

    clearUserWindowGeometry();
    mainWindow.setSize(currentWidth, workAreaHeight);
    // Align to top
    const [currentX] = mainWindow.getPosition();
    mainWindow.setPosition(currentX, 0);
    return true;
  }
  return false;
});



ipcMain.handle('toggle-stealth', () => {
  if (mainWindow && stealthService) {
    // Simple toggle between enhanced stealth and normal mode
    try {
      // Check if content protection is currently enabled
      enableStealthMode();
      console.log('Enhanced stealth mode enabled');
      return true;
    } catch (error) {
      console.error('Error toggling stealth:', error);
      return false;
    }
  }
  return false;
});

// Get last generated code for manual access
ipcMain.handle('get-generated-code', () => {
  return lastGeneratedCode || '';
});

// Manual trigger for auto-typing (starts from beginning)
ipcMain.handle('auto-type-code', () => {
  autoTypeResumeIndex = 0;
  autoTypeGeneratedCode();
  return true;
});

// Resume auto-typing from pause point
ipcMain.handle('resume-auto-type', () => {
  resumeAutoType();
  return true;
});

ipcMain.on('relaunch-app', () => {
  app.relaunch();
  app.exit(0);
});

// Shortcut Manager IPC handlers
let isEditingShortcut = false;

ipcMain.handle('get-shortcuts', () => {
  return shortcutManager.getShortcuts();
});

ipcMain.handle('save-shortcut', (event, { id, keys }) => {
  if (!shortcutManager.defaultShortcuts[id]) {
    return { ok: false, error: 'Unknown shortcut.' };
  }

  // Validate while our shortcuts are still unregistered, so only real conflicts are reported
  globalShortcut.unregisterAll();
  const error = validateShortcut(id, keys);
  if (!error) shortcutManager.saveShortcut(id, keys);

  // Saving ends capture mode; re-register everything (with the new key if it was accepted)
  isEditingShortcut = false;
  registerShortcuts();

  const updatedShortcuts = shortcutManager.getShortcuts();
  if (!error && mainWindow && mainWindow.webContents) {
    // Notify renderer of updated shortcuts so UI updates instantly
    sendToRenderer('shortcuts-changed', updatedShortcuts);
    interviewBridge.pushShortcutsUpdate();
  }
  return { ok: !error, error, shortcuts: updatedShortcuts };
});

ipcMain.handle('start-shortcut-capture', () => {
  isEditingShortcut = true;
  globalShortcut.unregisterAll();
  return true;
});

ipcMain.handle('stop-shortcut-capture', () => {
  isEditingShortcut = false;
  registerShortcuts();
  return true;
});

ipcMain.handle('reset-all-shortcuts', () => {
  const freshShortcuts = shortcutManager.resetAllShortcuts();
  isEditingShortcut = false;
  registerShortcuts();
  // Notify renderer of updated shortcuts so UI updates instantly
  if (mainWindow && mainWindow.webContents) {
    sendToRenderer('shortcuts-changed', freshShortcuts);
    interviewBridge.pushShortcutsUpdate();
  }
  return freshShortcuts;
});

// Handle user key submission
ipcMain.handle('submit-user-key', async (event, userKey) => {
  await handleUserKeySubmission(userKey);
  return true;
});

// Toggle click-through mode
ipcMain.handle('toggle-click-through', () => {
  if (mainWindow) {
    // Toggle the current state
    isClickThroughEnabled = !isClickThroughEnabled;

    mainWindow.setIgnoreMouseEvents(isClickThroughEnabled, { forward: true });

    logToFile(`Click-through mode ${isClickThroughEnabled ? 'enabled' : 'disabled'} via IPC`);

    return {
      enabled: isClickThroughEnabled,
      message: isClickThroughEnabled ? 'Click-through ENABLED - Clicks pass through window' : 'Click-through DISABLED - Window is now interactive'
    };
  }
  return { enabled: false, message: 'Window not available' };
});

// Transparency control IPC handlers
ipcMain.handle('set-window-opacity', (event, opacity) => {
  const actualOpacity = setWindowTransparency(opacity);
  return {
    opacity: actualOpacity,
    percentage: Math.round(actualOpacity * 100)
  };
});

ipcMain.handle('get-window-opacity', () => {
  return {
    opacity: currentOpacity,
    percentage: Math.round(currentOpacity * 100)
  };
});

ipcMain.handle('adjust-window-opacity', (event, delta) => {
  adjustWindowTransparency(delta);
  return {
    opacity: currentOpacity,
    percentage: Math.round(currentOpacity * 100)
  };
});

// Additional handlers for renderer compatibility
ipcMain.handle('set-opacity', (event, opacity) => {
  const actualOpacity = setWindowTransparency(opacity);
  // Broadcast opacity change to all renderer processes
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToRenderer('opacity-changed', actualOpacity);
  }
  return actualOpacity;
});

ipcMain.handle('get-current-opacity', () => {
  // While hidden via Ctrl+Space the window sits at 0; report the value the
  // slider actually steers (and that Ctrl+Space will restore).
  return getTargetOpacity();
});

// macOS gates the microphone, screen capture and automation behind TCC
// permissions. Unlike Windows, none of these "just work" — the first attempt
// silently returns empty/black or is denied until the user flips a switch in
// System Settings. Walk the user through the three the app depends on:
//   - Accessibility   -> auto-type (osascript keystrokes)
//   - Microphone      -> interview speech transcription
//   - Screen Recording-> screenshots + interview system audio (BlackHole route)
// Each check is best-effort and independently guarded so one failure never
// blocks startup. Deep links open the exact Privacy pane where supported.
async function ensureMacPermissions() {
  const { systemPreferences, dialog, shell } = require('electron');

  const openPane = (anchor) => {
    // e.g. Privacy_Microphone / Privacy_ScreenCapture / Privacy_Accessibility
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`)
      .catch((e) => logToFile(`Failed to open Settings pane ${anchor}: ${e.message}`));
  };

  // 1. Accessibility — required for the auto-type feature.
  try {
    const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (!isTrusted) {
      logToFile('macOS Accessibility permission missing. Prompting user.');
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Accessibility Permission Required',
        message: 'Solvro needs Accessibility permission to type answers for you (auto-type).',
        detail: 'macOS will prompt you now. Grant it under System Settings → Privacy & Security → Accessibility, then restart Solvro.',
        buttons: ['OK']
      });
      // Triggers the macOS system prompt (adds Solvro to the Accessibility list).
      systemPreferences.isTrustedAccessibilityClient(true);
    }
  } catch (e) {
    logToFile(`Accessibility permission check failed: ${e.message}`);
  }

  // 2. Microphone — required for interview transcription.
  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    logToFile(`macOS microphone permission status: ${micStatus}`);
    if (micStatus === 'not-determined') {
      // Ask the OS directly so the native prompt appears before the first use.
      const granted = await systemPreferences.askForMediaAccess('microphone').catch(() => false);
      logToFile(`Microphone access requested, granted=${granted}`);
    } else if (micStatus === 'denied' || micStatus === 'restricted') {
      const r = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Microphone Access Needed',
        message: 'Interview mode can\'t hear you without microphone access.',
        detail: 'Enable Solvro under System Settings → Privacy & Security → Microphone, then restart Solvro.',
        buttons: ['Open Settings', 'Later'],
        defaultId: 0,
        cancelId: 1
      });
      if (r === 0) openPane('Privacy_Microphone');
    }
  } catch (e) {
    logToFile(`Microphone permission check failed: ${e.message}`);
  }

  // 3. Screen Recording — required for screenshots and (with BlackHole) interview
  //    system audio. macOS has no API to request this programmatically; it is
  //    prompted on first capture and must be granted manually, so guide the user.
  try {
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    logToFile(`macOS screen-recording permission status: ${screenStatus}`);
    if (screenStatus !== 'granted') {
      const r = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Screen Recording Permission Needed',
        message: 'Solvro needs Screen Recording permission for screenshots and interview audio capture.',
        detail: 'Enable Solvro under System Settings → Privacy & Security → Screen Recording, then restart Solvro. Without it, screenshots come out blank.',
        buttons: ['Open Settings', 'Later'],
        defaultId: 0,
        cancelId: 1
      });
      if (r === 0) openPane('Privacy_ScreenCapture');
    }
  } catch (e) {
    logToFile(`Screen-recording permission check failed: ${e.message}`);
  }
}

// Driverless system-audio capture for interview mode. initMain() appends the
// Chromium 'enable-features' switch that turns on loopback capture — that MUST
// happen before the app is 'ready', so this runs at module load, not inside
// whenReady — and registers the enable/disable-loopback-audio IPC handlers the
// interview view calls. On macOS this uses ScreenCaptureKit (13+) or Core Audio
// process taps (14.4+), so the interviewer's audio is captured with no BlackHole
// virtual device — Screen Recording permission (prompted above) is enough.
try {
  const { initMain: initAudioLoopback } = require('electron-audio-loopback');
  // Core Audio taps (macOS 14.4+ / Darwin 23.4+) avoid the ScreenCaptureKit
  // custom-picker limitation on 14.2+. Older macOS uses the SCK path. os.release()
  // is the Darwin kernel version and is available before the app is ready.
  const forceCoreAudioTap = (() => {
    if (process.platform !== 'darwin') return false;
    const [maj, min] = require('os').release().split('.').map(n => parseInt(n, 10) || 0);
    return maj > 23 || (maj === 23 && min >= 4);
  })();
  initAudioLoopback({ forceCoreAudioTap });
  logToFile(`Audio loopback initialized (forceCoreAudioTap=${forceCoreAudioTap})`);
} catch (e) {
  logToFile('Failed to init audio loopback: ' + (e && e.message));
}

app.whenReady().then(async () => {
  const { Menu } = require('electron');
  Menu.setApplicationMenu(null);
  logToFile('App is ready. Authentication is now non-blocking...');
  logToFile(installTokenAdoptedAtStartup
    ? 'Startup: adopted freshly-installed session token from temp.'
    : 'Startup: no fresh install token in temp (using existing/none).');

  // Load the server-controlled runtime config (models, mode pinning, timeouts,
  // STT parameters) before any window opens. Reads the on-disk copy
  // synchronously and refreshes in the background, so this never blocks startup
  // and never fails: an unreachable server just leaves the previous copy in
  // place. This is what lets provider and model changes ship from the website
  // alone, without users installing an update.
  remoteConfig.init();

  // OS-specific permission and dependency checks
  if (process.platform === 'darwin') {
    await ensureMacPermissions();
  } else if (process.platform === 'linux') {
    const { execSync } = require('child_process');
    try {
      execSync('which xdotool', { stdio: 'ignore' });
      logToFile('xdotool already installed.');
    } catch (_) {
      logToFile('xdotool not found. Auto-installing...');
      const cmds = [
        'pkexec apt-get install -y xdotool',
        'pkexec dnf install -y xdotool',
        'pkexec pacman -S --noconfirm xdotool',
        'sudo apt-get install -y xdotool',
        'sudo dnf install -y xdotool',
      ];
      for (const c of cmds) {
        try {
          execSync(c, { stdio: 'ignore', timeout: 60000 });
          execSync('which xdotool', { stdio: 'ignore' });
          logToFile('xdotool installed successfully.');
          break;
        } catch (__) { continue; }
      }
    }
  }

  logToFile('Starting initialization...');
  try {
    // Initialize services
    const tempDir = path.join(app.getPath('userData'), 'electron-app-screenshots');
    logToFile(`Temp directory for screenshots: ${tempDir}`);

    logToFile('Initializing AIService...');
    if (AIService) {
      aiService = new AIService();
      logToFile('AIService initialized successfully');

      // Prompt for user key on startup
      // promptForUserKey(); // Temporarily disabled for testing
    } else {
      logToFile('ERROR: AIService class not available');
    }

    logToFile('Initializing ScreenshotService...');
    if (ScreenshotService) {
      screenshotService = new ScreenshotService(tempDir);
      logToFile('ScreenshotService initialized successfully');
    } else {
      logToFile('ERROR: ScreenshotService class not available');
    }


    logToFile('Initializing StealthService...');
    if (StealthService) {
      stealthService = new StealthService();
      logToFile('StealthService initialized successfully');

      // Start stealth monitoring
      stealthService.startMonitoring();
      logToFile('Stealth monitoring started');

      // Monitor for screen sharing (detection only - no auto-hide)
      stealthService.onScreenShareChange((isActive) => {
        if (isActive) {
          logToFile('Screen sharing detected - stealth protection is active');
        } else {
          logToFile('Screen sharing stopped');
        }
      });
    } else {
      logToFile('ERROR: StealthService class not available');
    }

    logToFile('Initializing LocalStorageService...');
    if (LocalStorageService) {
      localStorageService = new LocalStorageService();
      logToFile('LocalStorageService initialized successfully');
      logToFile(`Local storage directory: ${localStorageService.getBaseDirectory()}`);
    } else {
      logToFile('ERROR: LocalStorageService class not available');
    }

    logToFile('Creating window...');
    createWindow();
    // Setup interview bridge IPC handlers
    interviewBridge.setupIpcHandlers();
    logToFile('Window created successfully');

    if (mainWindow && stealthService) {
      logToFile('Initializing auto stealth...');
      stealthService.initializeAutoStealth(mainWindow);
      logToFile('Auto stealth initialized');
    }

    logToFile('Creating tray...');
    createTray();
    logToFile('Tray created successfully');

    logToFile('Registering shortcuts...');
    registerShortcuts();
    logToFile('Shortcuts registered successfully');

    // Keep the stored session token from ever reaching its expiry.
    startSessionKeepAlive();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });

    // Initialize Auto-Updater
    //
    // The 'error' listener must be attached BEFORE any check runs. autoUpdater is
    // an EventEmitter, and an 'error' with no listener is re-thrown by Node as an
    // uncaught exception — so any offline start, DNS hiccup or GitHub 5xx during
    // the update check took the app down at launch.
    //
    // autoDownload is ON: the update downloads silently in the background once
    // detected. It installs silently after the next PC restart, and never when the
    // app closes (see scheduleUpdateAfterRestart).
    //
    // A normal update also gets a "ready to install" banner, where the user can
    // install now or cancel. A forced update (FORCE_UPDATE_BELOW) shows nothing,
    // can't be cancelled, and finishes downloading even if the app is closed.
    if (!autoUpdater) {
      logToFile('Auto-updater not available (dev mode)');
    } else {
    autoUpdater.autoDownload = true;
    // Windows installs after the next PC restart instead (scheduleUpdateAfterRestart).
    // Other platforms have no such thing, so they keep installing when the app closes.
    if (process.platform === 'win32') autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('error', (err) => {
      const msg = err && err.message ? err.message : String(err);
      logToFile(`Auto-updater error (non-fatal): ${msg}`);
      sendToRenderer('update-error', { message: msg });
      // A failed download isn't running any more, so closing the app has nothing to
      // wait for. The next check starts it again.
      if (pendingUpdateState && pendingUpdateState.phase === 'downloading') pendingUpdateState = null;
      endBackgroundUpdate('download failed');
    });

    autoUpdater.on('update-available', (info) => {
      const version = info && info.version ? info.version : '';
      const forced = isForceUpdate();
      logToFile(`Update available: ${version} (forced=${forced}) — downloading in background`);
      pendingUpdateState = { phase: 'downloading', version, forced };
      sendToRenderer('update-available', { version, forced });
    });

    autoUpdater.on('download-progress', (progress) => {
      lastUpdateDownloadProgress = {
        percent: progress && typeof progress.percent === 'number' ? progress.percent : 0,
        transferred: progress ? progress.transferred : 0,
        total: progress ? progress.total : 0,
        bytesPerSecond: progress ? progress.bytesPerSecond : 0
      };
      sendToRenderer('update-download-progress', lastUpdateDownloadProgress);
    });

    autoUpdater.on('update-downloaded', (info) => {
      const version = info && info.version ? info.version : '';
      const forced = isForceUpdate();
      logToFile(`Update downloaded: ${version} (forced=${forced})`);
      pendingUpdateState = { phase: 'downloaded', version, forced };
      sendToRenderer('update-downloaded', { version, forced });
      scheduleUpdateAfterRestart(() => endBackgroundUpdate('downloaded'));
    });

    logToFile('Checking for updates...');
    const runUpdateCheck = () => {
      Promise.resolve(autoUpdater.checkForUpdates()).then((result) => {
        // A failed download is already reported through the 'error' event above.
        if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
      }).catch((err) => {
        logToFile(`Update check failed (non-fatal): ${err && err.message ? err.message : err}`);
      });
    };
    runUpdateCheck();
    setInterval(() => {
      // A new download mustn't compete with a live call for bandwidth. It can
      // wait for the next check.
      if (aiService && aiService.getCurrentMode() === 'interview') return;
      runUpdateCheck();
    }, 10 * 60 * 1000);
    } // end if (autoUpdater)

    // No first-run walkthrough. The app opens straight into coding mode
    // (config.app.defaultMode) with the welcome screen, which already lists the
    // Quick Start shortcuts and the full shortcut reference -- the walkthrough
    // was three clicks in front of the same information.

    logToFile('App initialization completed successfully');
  } catch (error) {
    logToFile(`CRITICAL ERROR during app initialization: ${error.stack}`);
  }
});

app.on('window-all-closed', () => {
  logToFile('All windows closed, quitting app');
  // Always quit the app when all windows are closed, regardless of platform
  app.quit();
});

// GPU / utility process crashes leave the window painted but frozen. Electron
// respawns the GPU process on its own; logging it is what makes the resulting
// "the app just froze" reports diagnosable.
app.on('child-process-gone', (event, details) => {
  if (details.reason === 'clean-exit') return;
  logToFile(`Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

app.on('will-quit', () => {
  logToFile('App is quitting...');
  flushLogBufferSync();
  // Unregister all shortcuts
  globalShortcut.unregisterAll();

  // Stop stealth monitoring
  if (stealthService) {
    stealthService.stopMonitoring();
  }

  // Clean up interview bridge
  interviewBridge.destroyInterviewView();
  interviewBridge.stopInterviewServer();

  // Stop the native keyboard-listener helper process (WinKeyServer.exe on
  // Windows). Left running, it keeps the install directory's files locked,
  // which makes the NSIS auto-updater/uninstaller fail with
  // "Solvro cannot be closed" / "Failed to uninstall old application files".
  if (keyboardListener) {
    try {
      keyboardListener.kill();
    } catch (error) {
      logToFile(`Error stopping GlobalKeyboardListener: ${error.message}`);
    }
    keyboardListener = null;
  }

  // Clean up main window
  if (mainWindow) {
    mainWindow.destroy();
    mainWindow = null;
  }

  // Clean up tray
  if (tray) {
    tray.destroy();
    tray = null;
  }

  logToFile('App quit complete');
});

// Handle app quit requests more aggressively
app.on('before-quit', (event) => {
  if (backgroundUpdate === 'running') {
    event.preventDefault();
    return;
  }
  if (shouldFinishUpdateInBackground()) {
    event.preventDefault();
    startBackgroundUpdate();
    return;
  }
  logToFile('Before quit event triggered');
  // Force cleanup of all resources
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      logToFile('Destroying main window in before-quit');
      mainWindow.destroy();
    }
    if (tray) {
      logToFile('Destroying tray in before-quit');
      tray.destroy();
    }
  } catch (error) {
    logToFile(`Error during before-quit cleanup: ${error.message}`);
  }
  // Don't prevent quit
});

// Handle SIGTERM and SIGINT for proper cleanup
process.on('SIGTERM', () => {
  logToFile('SIGTERM received, quitting app');
  app.quit();
});

process.on('SIGINT', () => {
  logToFile('SIGINT received, quitting app');
  app.quit();
});
