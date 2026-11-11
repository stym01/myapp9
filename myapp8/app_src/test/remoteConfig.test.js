import { describe, it, expect, beforeEach, vi } from 'vitest';

// remoteConfig is the app's whole defence against being un-redeployable: if the
// server sends junk, is down, or is unreachable, an installed build must keep
// working exactly as it shipped. These tests pin that.
vi.mock('electron', () => {
  throw new Error('not running under electron');
});

let rc;
beforeEach(async () => {
  vi.resetModules();
  rc = (await import('../src/utils/remoteConfig.js')).default
    ?? (await import('../src/utils/remoteConfig.js'));
});

describe('baked defaults', () => {
  it('starts on the baked config when nothing has been fetched', () => {
    expect(rc.get()).toEqual(rc.BAKED_DEFAULTS);
  });

  it('exposes a default model that actually exists in the catalogue', () => {
    expect(rc.getModelIds()).toContain(rc.getDefaultModel());
  });

  it('exposes a fallback model that actually exists', () => {
    expect(rc.getModelIds()).toContain(rc.getFallbackModel());
  });

  it('pins interview and mcq to a real model', () => {
    for (const mode of ['interview', 'mcq']) {
      const pinned = rc.getFixedModelForMode(mode);
      expect(pinned).toBeTruthy();
      expect(rc.getModelIds()).toContain(pinned);
    }
  });

  it('restricts query mode to models that exist', () => {
    for (const id of rc.getModeModels('query')) {
      expect(rc.getModelIds()).toContain(id);
    }
  });

  it('returns null for a mode with no pin and no whitelist', () => {
    expect(rc.getFixedModelForMode('coding')).toBeNull();
    expect(rc.getModeModels('coding')).toBeNull();
  });

  it('derives API_BASE from the env, defaulting to the live site', () => {
    expect(rc.API_BASE).toBe(process.env.SOLVRO_API_BASE || 'https://solvro.in');
  });
});

describe('model lookup', () => {
  it('finds a known model', () => {
    expect(rc.getModelInfo('gemini-3.1-pro').id).toBe('gemini-3.1-pro');
  });

  it('falls back to the default rather than returning undefined', () => {
    const info = rc.getModelInfo('a-model-that-was-retired');
    expect(info).toBeTruthy();
    expect(info.id).toBe(rc.getDefaultModel());
  });

  it('tags every model with a plan tier the UI can grey out', () => {
    for (const m of rc.getModels()) {
      expect([0, 1, 2]).toContain(m.tier);
      expect(typeof m.name).toBe('string');
    }
  });
});

describe('request config', () => {
  it('uses the default timeout for an unlisted model', () => {
    expect(rc.getTimeoutMs('gemini-3.7-flash')).toBe(60000);
  });

  it('applies a per-model timeout override', () => {
    expect(rc.getTimeoutMs('gemini-3.1-pro')).toBe(120000);
  });

  it('never returns a zero/NaN timeout (that would hang a request forever)', () => {
    for (const id of [...rc.getModelIds(), 'unknown-model']) {
      expect(rc.getTimeoutMs(id)).toBeGreaterThan(0);
    }
  });

  it('exposes a thinking config only where one is configured', () => {
    // Gemini 3.1 Pro is a Gemini 3 model: low thinkingLevel (fast), not a token
    // budget, and no base maxOutputTokens (it is set per mode).
    const gen = rc.getGenerationConfig('gemini-3.1-pro');
    expect(gen.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    expect(gen.maxOutputTokens).toBeUndefined();
    expect(rc.getGenerationConfig('gemini-3.7-flash')).toBeNull();
  });

  it('applies per-mode output caps for Gemini 3.1 Pro', () => {
    // Query: short answers; coding: a generous cap so a full solution is never
    // truncated. Thinking stays low in both.
    const query = rc.getGenerationConfig('gemini-3.1-pro', 'query');
    expect(query.maxOutputTokens).toBe(4096);
    expect(query.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    const coding = rc.getGenerationConfig('gemini-3.1-pro', 'coding');
    expect(coding.maxOutputTokens).toBe(16384);
    expect(coding.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    // The internal `modes` grouping is never leaked into the request config.
    expect(rc.getRequestConfig('gemini-3.1-pro', 'query').modes).toBeUndefined();
  });
});

describe('STT profiles', () => {
  it('builds a websocket url with the profile params', () => {
    const url = rc.buildSttUrl('diarized');
    expect(url.startsWith('wss://')).toBe(true);
    expect(url).toContain('model=nova-3');
    expect(url).toContain('diarize=true');
  });

  it('falls back to the default profile for an unknown name', () => {
    expect(rc.getSttProfile('nope').profile).toBe(rc.BAKED_DEFAULTS.stt.defaultProfile);
  });

  it('always sends the PCM shape the AudioWorklet actually produces', () => {
    for (const name of Object.keys(rc.BAKED_DEFAULTS.stt.profiles)) {
      const { params } = rc.getSttProfile(name);
      expect(params.encoding).toBe('linear16');
      expect(params.sample_rate).toBe(16000);
      expect(params.channels).toBe(1);
    }
  });
});

describe('flags', () => {
  it('returns the supplied fallback for an unknown flag', () => {
    expect(rc.getFlag('nothing_here', 'fb')).toBe('fb');
    expect(rc.getFlag('nothing_here')).toBeUndefined();
  });
});

describe('listeners', () => {
  it('unsubscribes cleanly', () => {
    const fn = vi.fn();
    const off = rc.onChange(fn);
    expect(typeof off).toBe('function');
    off();
  });
});

describe('refresh resilience (the app must never be bricked by the server)', () => {
  // Drive https.get by hand: no real request ever leaves the test.
  async function withServerResponse(handler) {
    vi.resetModules();
    const https = (await import('node:https')).default;
    const spy = vi.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const req = { on: () => req, setTimeout: () => req, destroy: () => {} };
      handler(callback, req);
      return req;
    });
    const mod = await import('../src/utils/remoteConfig.js');
    return { rc: mod.default ?? mod, spy };
  }

  function respond(status, body) {
    return (cb) => {
      const res = {
        statusCode: status,
        resume: () => {},
        on: (event, fn) => {
          if (event === 'data' && body !== undefined) fn(body);
          if (event === 'end') fn();
          return res;
        },
      };
      cb(res);
    };
  }

  it('adopts a well-formed served config', async () => {
    const served = {
      version: 42,
      models: [{ id: 'new-model', name: 'New', icon: 'x', tier: 0 }],
      defaults: { model: 'new-model' },
    };
    const { rc: mod } = await withServerResponse(respond(200, JSON.stringify(served)));
    await mod.refresh({ force: true });
    expect(mod.get().version).toBe(42);
    expect(mod.getModelIds()).toEqual(['new-model']);
  });

  it('REPLACES the model list rather than merging (retired models must vanish)', async () => {
    const { rc: mod } = await withServerResponse(
      respond(200, JSON.stringify({ models: [{ id: 'only-one', name: 'O', icon: 'x', tier: 0 }] })),
    );
    await mod.refresh({ force: true });
    expect(mod.getModelIds()).toEqual(['only-one']);
    expect(mod.getModelIds()).not.toContain('gemini-3.7-flash');
  });

  it('falls back for sections the server omits', async () => {
    const { rc: mod } = await withServerResponse(respond(200, JSON.stringify({ version: 7 })));
    await mod.refresh({ force: true });
    expect(mod.get().version).toBe(7);
    expect(mod.getTimeoutMs('gemini-3.1-pro')).toBe(120000); // baked requests survive
    expect(mod.getSttProfile('dual').params.sample_rate).toBe(16000);
  });

  it('ignores a served config with an EMPTY model list', async () => {
    const { rc: mod } = await withServerResponse(respond(200, JSON.stringify({ models: [] })));
    await mod.refresh({ force: true });
    // No models at all would leave the picker blank and the app unusable.
    expect(mod.getModelIds().length).toBeGreaterThan(0);
  });

  it('keeps the baked config when the server returns malformed JSON', async () => {
    const { rc: mod } = await withServerResponse(respond(200, 'not json at all'));
    const before = mod.get();
    await mod.refresh({ force: true });
    expect(mod.get()).toEqual(before);
  });

  it('keeps the baked config on a non-200 response', async () => {
    const { rc: mod } = await withServerResponse(respond(500));
    const before = mod.get();
    await mod.refresh({ force: true });
    expect(mod.get()).toEqual(before);
    expect(mod.getModels().length).toBeGreaterThan(0);
  });

  it('keeps the baked config when the socket errors (offline launch)', async () => {
    const { rc: mod } = await withServerResponse((cb, req) => {
      req.on = (event, fn) => {
        if (event === 'error') setImmediate(() => fn(new Error('ENOTFOUND')));
        return req;
      };
    });
    const before = mod.get();
    await mod.refresh({ force: true });
    expect(mod.get()).toEqual(before);
    expect(mod.getModelIds()).toContain(mod.getDefaultModel());
  });

  it('never throws out of refresh, whatever the server does', async () => {
    const { rc: mod } = await withServerResponse(() => { throw new Error('boom'); });
    await expect(mod.refresh({ force: true })).resolves.toBeTruthy();
  });

  it('stays usable after a failed refresh', async () => {
    const { rc: mod } = await withServerResponse(respond(503));
    await mod.refresh({ force: true });
    expect(mod.getModelIds()).toContain(mod.getDefaultModel());
    expect(mod.getTimeoutMs(mod.getDefaultModel())).toBeGreaterThan(0);
  });
});

describe('screenshot cap', () => {
  it('caps coding, mcq and query at 20 by default', () => {
    for (const mode of ['coding', 'mcq', 'query']) {
      expect(rc.getMaxScreenshots(mode)).toBe(20);
    }
  });

  it('leaves interview (and unknown modes) uncapped', () => {
    expect(rc.getMaxScreenshots('interview')).toBeNull();
    expect(rc.getMaxScreenshots('something-else')).toBeNull();
  });

  async function withServed(served) {
    vi.resetModules();
    const https = (await import('node:https')).default;
    vi.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      const req = { on: () => req, setTimeout: () => req, destroy: () => {} };
      const res = {
        statusCode: 200,
        resume: () => {},
        on: (event, fn) => {
          if (event === 'data') fn(JSON.stringify(served));
          if (event === 'end') fn();
          return res;
        },
      };
      callback(res);
      return req;
    });
    const mod = await import('../src/utils/remoteConfig.js');
    const loaded = mod.default ?? mod;
    await loaded.refresh({ force: true });
    return loaded;
  }

  it('adopts a served limit without an app release', async () => {
    const mod = await withServed({ limits: { maxScreenshots: 10, limitedModes: ['coding'] } });
    expect(mod.getMaxScreenshots('coding')).toBe(10);
    expect(mod.getMaxScreenshots('query')).toBeNull();
  });

  it('falls back to the baked limit when the served one is junk', async () => {
    const mod = await withServed({ limits: { maxScreenshots: 'lots', limitedModes: ['coding'] } });
    expect(mod.getMaxScreenshots('coding')).toBe(20);
  });

  it('keeps the baked limit when the server omits the section', async () => {
    const mod = await withServed({ version: 3 });
    expect(mod.getMaxScreenshots('mcq')).toBe(20);
  });
});
