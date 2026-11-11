// interviewPreload.js — Preload for the interview BrowserView
// Provides window.electronAPI for the React interview app
// Routes all calls through IPC to the main process

const { contextBridge, ipcRenderer } = require('electron');

// In-window tooltips + fixed cursor so hover feedback isn't visible in captures.
require('./stealthUi').installStealthUi({
  edges: ['bottom', 'left', 'right', 'bottom-left', 'bottom-right'],
});

// --- Listener management ---
let transcriptListener = null;
let sttStatusListener = null;
let aiChunkListener = null;
let aiDoneListener = null;
let aiErrorListener = null;
let themeListener = null;
let shortcutsListener = null;

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Deepgram STT ---
  startDeepgram: (options) => {
    return ipcRenderer.invoke('interview-deepgram-start', options);
  },

  sendAudioChunk: (chunk, role) => {
    // chunk is an ArrayBuffer from the AudioWorklet; role is 'mic' or 'sys'
    // (which speaker stream it belongs to).
    ipcRenderer.send('interview-deepgram-audio', chunk, role);
  },

  stopDeepgram: () => {
    return ipcRenderer.invoke('interview-deepgram-stop');
  },

  onTranscript: (callback) => {
    if (transcriptListener) {
      ipcRenderer.removeListener('interview-deepgram-transcript', transcriptListener);
    }
    transcriptListener = (_event, data) => callback(data);
    ipcRenderer.on('interview-deepgram-transcript', transcriptListener);
  },

  removeTranscriptListener: () => {
    if (transcriptListener) {
      ipcRenderer.removeListener('interview-deepgram-transcript', transcriptListener);
      transcriptListener = null;
    }
  },

  // Connection state of the STT socket: connected / reconnecting / error.
  // Nothing listened for the main process's STT errors before, so a dropped
  // socket left the UI showing "recording" while nothing was transcribed.
  onSttStatus: (callback) => {
    if (sttStatusListener) {
      ipcRenderer.removeListener('interview-deepgram-status', sttStatusListener);
    }
    sttStatusListener = (_event, data) => callback(data);
    ipcRenderer.on('interview-deepgram-status', sttStatusListener);
  },

  removeSttStatusListener: () => {
    if (sttStatusListener) {
      ipcRenderer.removeListener('interview-deepgram-status', sttStatusListener);
      sttStatusListener = null;
    }
  },


  // LiveCoach
  sendTranscriptUpdate: (speaker, text) => ipcRenderer.send('interview-transcript-update', { speaker, text }),
  sendLiveCoachAction: (action) => ipcRenderer.send('interview-livecoach-action', action),
  onLiveCoachUpdate: (callback) => {
    ipcRenderer.on('live-coach-update', (_event, payload) => callback(payload));
  },
  removeLiveCoachListener: () => {
    ipcRenderer.removeAllListeners('live-coach-update');
  },

  // --- AI Requests ---
  sendAIRequest: (params) => {
    return ipcRenderer.invoke('interview-ai-request', params);
  },

  cancelAIRequest: () => {
    ipcRenderer.send('interview-ai-cancel');
  },

  detectQuestion: (payload) => {
    return ipcRenderer.invoke('interview-detect', payload);
  },

  onAIChunk: (callback) => {
    if (aiChunkListener) {
      ipcRenderer.removeListener('interview-ai-chunk', aiChunkListener);
    }
    aiChunkListener = (_event, data) => callback(data);
    ipcRenderer.on('interview-ai-chunk', aiChunkListener);
  },

  onAIDone: (callback) => {
    if (aiDoneListener) {
      ipcRenderer.removeListener('interview-ai-done', aiDoneListener);
    }
    aiDoneListener = (_event, data) => callback(data);
    ipcRenderer.on('interview-ai-done', aiDoneListener);
  },

  onAIError: (callback) => {
    if (aiErrorListener) {
      ipcRenderer.removeListener('interview-ai-error', aiErrorListener);
    }
    aiErrorListener = (_event, data) => callback(data);
    ipcRenderer.on('interview-ai-error', aiErrorListener);
  },

  removeAIListeners: () => {
    if (aiChunkListener) {
      ipcRenderer.removeListener('interview-ai-chunk', aiChunkListener);
      aiChunkListener = null;
    }
    if (aiDoneListener) {
      ipcRenderer.removeListener('interview-ai-done', aiDoneListener);
      aiDoneListener = null;
    }
    if (aiErrorListener) {
      ipcRenderer.removeListener('interview-ai-error', aiErrorListener);
      aiErrorListener = null;
    }
  },

  // Shows the sign-in prompt in the main window (this view can't show it).
  requireSignIn: () => {
    ipcRenderer.send('interview-require-sign-in');
  },

  // --- User Context ---
  getSessionToken: () => {
    return ipcRenderer.invoke('interview-get-token');
  },

  getUserSettings: () => {
    return ipcRenderer.invoke('interview-get-user-settings');
  },

  // --- Audio Sources ---
  getAudioSources: () => {
    return ipcRenderer.invoke('interview-get-sources');
  },

  // Driverless system-audio loopback (electron-audio-loopback, initMain in
  // main.js registers these handlers). Enable, call getDisplayMedia in the page,
  // then disable to restore normal display-media behaviour.
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),

  // --- Screenshot ---
  takeScreenshot: () => {
    return ipcRenderer.invoke('interview-take-screenshot');
  },

  // --- Interview Ping (usage tracking) ---
  interviewPing: () => {
    return ipcRenderer.invoke('interview-ping');
  },

  // --- Clipboard ---
  writeClipboardText: (text) => {
    if (typeof text !== 'string') return Promise.resolve(false);
    return ipcRenderer.invoke('interview-write-clipboard', text);
  },

  // --- Window ---
  setOpacity: (value) => {
    if (typeof value === 'number') ipcRenderer.send('interview-set-opacity', value);
  },

  setContentProtection: (value) => {
    ipcRenderer.send('interview-set-content-protection', value);
  },

  // --- Theme ---
  getTheme: () => {
    return ipcRenderer.invoke('interview-get-theme');
  },

  onThemeChanged: (callback) => {
    if (themeListener) {
      ipcRenderer.removeListener('interview-theme-changed', themeListener);
    }
    themeListener = (_event, theme) => callback(theme);
    ipcRenderer.on('interview-theme-changed', themeListener);
  },

  // --- Keyboard shortcuts ---
  getShortcuts: () => {
    return ipcRenderer.invoke('interview-get-shortcuts');
  },

  onShortcutsChanged: (callback) => {
    if (shortcutsListener) {
      ipcRenderer.removeListener('interview-shortcuts-changed', shortcutsListener);
    }
    shortcutsListener = (_event, shortcuts) => callback(shortcuts);
    ipcRenderer.on('interview-shortcuts-changed', shortcutsListener);
  },
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (transcriptListener) {
    ipcRenderer.removeListener('interview-deepgram-transcript', transcriptListener);
    transcriptListener = null;
  }
  if (sttStatusListener) {
    ipcRenderer.removeListener('interview-deepgram-status', sttStatusListener);
    sttStatusListener = null;
  }
  if (aiChunkListener) {
    ipcRenderer.removeListener('interview-ai-chunk', aiChunkListener);
    aiChunkListener = null;
  }
  if (aiDoneListener) {
    ipcRenderer.removeListener('interview-ai-done', aiDoneListener);
    aiDoneListener = null;
  }
  if (aiErrorListener) {
    ipcRenderer.removeListener('interview-ai-error', aiErrorListener);
    aiErrorListener = null;
  }
  if (themeListener) {
    ipcRenderer.removeListener('interview-theme-changed', themeListener);
    themeListener = null;
  }
  if (shortcutsListener) {
    ipcRenderer.removeListener('interview-shortcuts-changed', shortcutsListener);
    shortcutsListener = null;
  }
});

console.log('[InterviewPreload] electronAPI exposed for React interview app');
