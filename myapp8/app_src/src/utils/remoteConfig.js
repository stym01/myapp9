// Runtime configuration fetched from the website, so the desktop app does not
// have to be rebuilt to change what it offers or how it talks to providers.
//
// Users ignore update prompts, so any value baked into a build is effectively
// permanent. Everything that might realistically change -- the model list, which
// model a mode pins, request timeouts, STT endpoint and parameters -- is served
// by GET /api/app-config instead, and this module is the app's view of it.
//
// Three layers, first hit wins:
//   1. the copy fetched this session
//   2. the last copy written to disk (survives restarts and offline launches)
//   3. BAKED_DEFAULTS below -- byte-for-byte today's hardcoded behaviour, so a
//      server that is down or a brand-new install behaves exactly as before.

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_BASE = process.env.SOLVRO_API_BASE || 'https://solvro.in';
const CONFIG_PATH = '/api/app-config';
const CACHE_FILE = 'solvro-app-config.json';

const FETCH_TIMEOUT_MS = 8000;
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

// Mirrors exactly what the app used to hardcode. Changing anything here is a
// release; changing it on the server is not. Prefer the server.
const BAKED_DEFAULTS = {
  version: 0,
  ttlSeconds: 900,
  // `tier` mirrors the server's plan gate: 0 = everyone incl. Free Trial,
  // 1 = Pro, 2 = Pro+. The UI greys out anything above the user's tier.
  models: [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', icon: '⚡', tier: 0 },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', icon: '🧠', tier: 1 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', icon: '🧠', tier: 2 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', icon: '🧠', tier: 2 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', icon: '🧠', tier: 2 },
  ],
  defaults: {
    model: 'gemini-3.7-flash',
    fallbackModel: 'gemini-3.1-pro',
    language: 'cpp',
  },
  modes: {
    interview: { fixedModel: 'gemini-3.7-flash' },
    mcq: { fixedModel: 'gemini-3.7-flash' },
    query: { models: ['gemini-3.7-flash', 'gemini-3.1-pro'] },
  },
  requests: {
    default: { timeoutMs: 60000 },
    'gemini-3.1-pro': {
      timeoutMs: 120000,
      // Gemini 3.1 Pro is a Gemini 3 model: it uses thinkingLevel (low|medium|
      // high, default medium), NOT thinkingBudget, and rejects a request that
      // carries both. The old 32768 thinking budget with no output cap let
      // thinking eat the whole budget and return NO answer. 'low' keeps it fast;
      // the per-mode caps bound the answer. Kept in sync with the server's
      // /api/app-config (website/src/lib/appConfig.js) — the served copy wins,
      // this is the offline/fallback mirror.
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
      modes: {
        // Chat: short + fast (the query prompt also asks for brevity).
        query: { generationConfig: { maxOutputTokens: 4096 } },
        // Coding: generous cap so a full solution is never truncated.
        coding: { generationConfig: { maxOutputTokens: 16384 } },
      },
    },
  },
  stt: {
    provider: 'deepgram',
    wsBase: 'wss://api.deepgram.com/v1/listen',
    protocolPrefix: 'token',
    defaultProfile: 'dual',
    profiles: {
      dual: {
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        model: 'nova-2',
        punctuate: true,
        interim_results: true,
      },
      diarized: {
        model: 'nova-3',
        language: 'en',
        smart_format: true,
        diarize: true,
        interim_results: true,
        endpointing: 300,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
      },
    },
  },
  // Cap on queued screenshots per request. Only `limitedModes` are capped;
  // interview mode is deliberately left unlimited.
  limits: {
    maxScreenshots: 20,
    limitedModes: ['coding', 'mcq', 'query'],
  },
  // SEB session time limit per tier (ms). Index = tier (0=free, 1=pro, 2=pro+).
  // 0 = unlimited. hope.exe reads this to enforce auto-close.
  sebSessionMs: [900000, 900000, 0],
  forceUpdateBelow: null,
  flags: {},
};

let current = BAKED_DEFAULTS;
let source = 'baked';
let lastFetchAt = 0;
let refreshTimer = null;
let inFlight = null;
const listeners = new Set();

function cacheFilePath() {
  try {
    // Lazily required: this module is also loadable from plain Node in tests.
    const { app } = require('electron');
    return path.join(app.getPath('userData'), CACHE_FILE);
  } catch (err) {
    return null;
  }
}

// A served config replaces whole subtrees rather than merging into the defaults.
// Merging would keep resurrecting entries the server deliberately removed --
// exactly the "why is this retired model still in the picker" bug we are
// trying to make impossible. Missing top-level sections do fall back, so the
// server can omit anything it has no opinion about.
function withFallbacks(config) {
  if (!config || typeof config !== 'object') return BAKED_DEFAULTS;
  const merged = { ...BAKED_DEFAULTS };
  for (const key of Object.keys(BAKED_DEFAULTS)) {
    if (config[key] !== undefined && config[key] !== null) merged[key] = config[key];
  }
  // A config with no usable models is worse than no config at all.
  if (!Array.isArray(merged.models) || merged.models.length === 0) {
    merged.models = BAKED_DEFAULTS.models;
  }
  return merged;
}

function readCache() {
  const file = cacheFilePath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('[remoteConfig] cache read failed:', err.message);
    return null;
  }
}

function writeCache(config) {
  const file = cacheFilePath();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(config), 'utf8');
  } catch (err) {
    console.error('[remoteConfig] cache write failed:', err.message);
  }
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (err) {
      console.error('[remoteConfig] listener failed:', err.message);
    }
  }
}

function fetchConfig() {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG_PATH, API_BASE);
    const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`app-config responded ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('app-config returned malformed JSON'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('app-config request timed out'));
    });
  });
}

// Pulls a fresh copy. Never throws and never leaves the app worse off than it
// was: on any failure the previously resolved config stays in place.
async function refresh({ force = false } = {}) {
  if (!force && Date.now() - lastFetchAt < MIN_REFRESH_INTERVAL_MS) return current;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const fetched = await fetchConfig();
      current = withFallbacks(fetched);
      source = 'remote';
      lastFetchAt = Date.now();
      writeCache(fetched);
      scheduleRefresh();
      notify();
      console.log(`[remoteConfig] refreshed (version ${current.version})`);
    } catch (err) {
      console.error('[remoteConfig] refresh failed, keeping', source, 'config:', err.message);
    } finally {
      inFlight = null;
    }
    return current;
  })();

  return inFlight;
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const ttl = Math.max(60, Number(current.ttlSeconds) || 900);
  refreshTimer = setTimeout(() => refresh({ force: true }), ttl * 1000);
  if (refreshTimer.unref) refreshTimer.unref();
}

// Call once at startup. Loads the on-disk copy synchronously so the first
// window already has the right model list, then refreshes in the background.
function init() {
  const cached = readCache();
  if (cached) {
    current = withFallbacks(cached);
    source = 'cache';
  }
  scheduleRefresh();
  refresh({ force: true });
  return current;
}

// -- Accessors ---------------------------------------------------------------

function get() {
  return current;
}

function getModels() {
  return current.models;
}

function getModelIds() {
  return current.models.map((m) => m.id);
}

function getModelInfo(id) {
  const fallbackId = getDefaultModel();
  return (
    current.models.find((m) => m.id === id) ||
    current.models.find((m) => m.id === fallbackId) ||
    current.models[0]
  );
}

function getDefaultModel() {
  const preferred = current.defaults?.model;
  const ids = getModelIds();
  return ids.includes(preferred) ? preferred : ids[0];
}

function getFallbackModel() {
  const preferred = current.defaults?.fallbackModel;
  return getModelIds().includes(preferred) ? preferred : getDefaultModel();
}

// The model a mode is pinned to, or null when the mode lets the user choose.
function getFixedModelForMode(mode) {
  return current.modes?.[mode]?.fixedModel || null;
}

// The subset of models a mode offers, or null for "all of them".
function getModeModels(mode) {
  const list = current.modes?.[mode]?.models;
  return Array.isArray(list) ? list : null;
}

// Per-request settings, merged default < per-model < per-model-per-mode. The
// `modes` subtree on a model lets one model use different settings in different
// app modes (e.g. short answers in query, a big cap for full code in coding).
// generationConfig is merged across the levels so a mode can override just
// maxOutputTokens / thinkingBudget without restating the rest.
function getRequestConfig(model, mode) {
  const base = current.requests?.default || {};
  const forModel = current.requests?.[model] || {};
  const forMode = (mode && forModel.modes && forModel.modes[mode]) || {};
  const merged = { ...base, ...forModel, ...forMode };
  const generationConfig = {
    ...(base.generationConfig || {}),
    ...(forModel.generationConfig || {}),
    ...(forMode.generationConfig || {}),
  };
  if (Object.keys(generationConfig).length > 0) {
    merged.generationConfig = generationConfig;
  }
  delete merged.modes; // internal grouping, never sent as part of the request
  return merged;
}

function getTimeoutMs(model, mode) {
  return Number(getRequestConfig(model, mode).timeoutMs) || 60000;
}

function getGenerationConfig(model, mode) {
  return getRequestConfig(model, mode).generationConfig || null;
}

function getSttProfile(profileName) {
  const stt = current.stt || BAKED_DEFAULTS.stt;
  const profiles = stt.profiles || {};
  const name = profiles[profileName] ? profileName : stt.defaultProfile;
  return { stt, profile: name, params: profiles[name] || {} };
}

// Local reconstruction of the WebSocket URL. The server normally sends a ready
// built `url` with the key response and that is what callers should use; this
// is the offline path, and the path for app builds talking to a server that
// predates the richer key response.
function buildSttUrl(profileName) {
  const { stt, params } = getSttProfile(profileName);
  const url = new URL(stt.wsBase);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// How many screenshots `mode` may queue, or null when the mode is uncapped.
// A missing or nonsensical served value falls back to the baked default rather
// than silently removing the cap.
function getMaxScreenshots(mode) {
  const limits = current.limits || BAKED_DEFAULTS.limits;
  const modes = Array.isArray(limits.limitedModes)
    ? limits.limitedModes
    : BAKED_DEFAULTS.limits.limitedModes;
  if (!modes.includes(mode)) return null;
  const max = Number(limits.maxScreenshots);
  return Number.isInteger(max) && max > 0 ? max : BAKED_DEFAULTS.limits.maxScreenshots;
}

function getFlag(name, fallback = undefined) {
  const flags = current.flags || {};
  return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : fallback;
}

function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  API_BASE,
  BAKED_DEFAULTS,
  init,
  refresh,
  get,
  getModels,
  getModelIds,
  getModelInfo,
  getDefaultModel,
  getFallbackModel,
  getFixedModelForMode,
  getModeModels,
  getRequestConfig,
  getTimeoutMs,
  getGenerationConfig,
  getSttProfile,
  buildSttUrl,
  getMaxScreenshots,
  getFlag,
  onChange,
};
