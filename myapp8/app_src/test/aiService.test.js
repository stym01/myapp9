import { describe, it, expect, beforeEach, vi } from 'vitest';

// The desktop app fetches its model catalogue from the website at runtime; in
// tests we pin a deterministic catalogue that mirrors the baked defaults so the
// resolution logic is exercised without any network.
const CATALOGUE = [
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', icon: '⚡', tier: 0 },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', icon: '🧠', tier: 1 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', icon: '🧠', tier: 1 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', icon: '🧠', tier: 2 },
  { id: 'claude-fable-5', name: 'Claude Fable 5', icon: '🧠', tier: 2 },
];
const MODES = {
  interview: { fixedModel: 'gemini-3.7-flash' },
  mcq: { fixedModel: 'gemini-3.7-flash' },
  query: { models: ['gemini-3.7-flash', 'gemini-3.1-pro'] },
};

vi.mock('../src/utils/remoteConfig', () => {
  const byId = Object.fromEntries(CATALOGUE.map((m) => [m.id, m]));
  return {
    default: {
      API_BASE: 'https://solvro.in',
      getModels: () => CATALOGUE,
      getModelIds: () => CATALOGUE.map((m) => m.id),
      getModelInfo: (id) => byId[id] || { name: id, icon: '🤖', tier: 0 },
      getDefaultModel: () => 'gemini-3.7-flash',
      getFallbackModel: () => 'gemini-3.1-pro',
      get: () => ({ modes: MODES }),
      getFixedModelForMode: (mode) => MODES[mode]?.fixedModel || null,
      getModeModels: (mode) => MODES[mode]?.models || null,
      getTimeoutMs: () => 60000,
      getGenerationConfig: () => undefined,
      getMaxScreenshots: (mode) => (['coding', 'mcq', 'query'].includes(mode) ? 20 : null),
      onChange: () => {},
    },
  };
});

// aiService lazily require()s electron only inside getUserKey; stub it so nothing
// touches the Electron runtime.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

const AIService = (await import('../src/utils/aiService.js')).default;

let ai;
beforeEach(() => {
  ai = new AIService();
});

describe('construction', () => {
  it('loads the remote catalogue and a sane default model/mode', () => {
    expect(ai.models).toEqual(CATALOGUE.map((m) => m.id));
    expect(ai.getCurrentModel()).toBe('gemini-3.7-flash');
    expect(ai.getCurrentMode()).toBe('coding');
    expect(ai.getCurrentLanguage()).toBe('cpp');
  });
});

describe('normalizeLanguage', () => {
  it('accepts known languages and common aliases', () => {
    expect(ai.normalizeLanguage('Python')).toBe('python');
    expect(ai.normalizeLanguage('py')).toBe('python');
    expect(ai.normalizeLanguage('c++')).toBe('cpp');
    expect(ai.normalizeLanguage('cxx')).toBe('cpp');
    expect(ai.normalizeLanguage('sql')).toBe('mysql');
    expect(ai.normalizeLanguage('postgres')).toBe('postgresql');
    expect(ai.normalizeLanguage('jaava')).toBe('java');
    expect(ai.normalizeLanguage('sh')).toBe('bash');
    expect(ai.normalizeLanguage('shell')).toBe('bash');
    expect(ai.normalizeLanguage('zsh')).toBe('bash');
  });
  it('falls back to cpp for anything unrecognised', () => {
    expect(ai.normalizeLanguage('klingon')).toBe('cpp');
    expect(ai.normalizeLanguage('')).toBe('cpp');
    expect(ai.normalizeLanguage(null)).toBe('cpp');
  });
});

describe('language selection', () => {
  it('sets and reports the current language, normalising input', () => {
    ai.setLanguage('Rust');
    expect(ai.getCurrentLanguage()).toBe('rust');
  });
  it('marks the current language in the options list', () => {
    ai.setLanguage('go');
    const current = ai.getLanguageOptions().find((o) => o.current);
    expect(current.id).toBe('go');
  });
  it('lists languages by assessment popularity, with bash available', () => {
    const ids = ai.getLanguageOptions().map((o) => o.id);
    expect(ids.slice(0, 3)).toEqual(['cpp', 'java', 'python']);
    expect(ids).toContain('bash');
  });
});

describe('mode & model resolution', () => {
  it('pins interview and mcq to their fixed model', () => {
    expect(ai.isModelLocked('interview')).toBe(true);
    expect(ai.getFixedModelForMode('interview')).toBe('gemini-3.7-flash');
    expect(ai.getAvailableModels('interview')).toEqual(['gemini-3.7-flash']);
  });

  it('restricts query mode to its whitelist', () => {
    expect(ai.getAvailableModels('query')).toEqual(['gemini-3.7-flash', 'gemini-3.1-pro']);
    expect(ai.isModelAllowedForMode('claude-opus-4-8', 'query')).toBe(false);
    expect(ai.isModelAllowedForMode('gemini-3.1-pro', 'query')).toBe(true);
  });

  it('offers every model in an unrestricted mode', () => {
    expect(ai.getAvailableModels('coding')).toEqual(CATALOGUE.map((m) => m.id));
  });

  it('only accepts a model that is allowed in the current mode', () => {
    ai.setMode('query');
    ai.setModel('claude-opus-4-8'); // not in query whitelist
    expect(ai.getCurrentModel()).not.toBe('claude-opus-4-8');
    ai.setModel('gemini-3.1-pro'); // allowed
    expect(ai.getCurrentModel()).toBe('gemini-3.1-pro');
  });

  it('switches off a model the new mode does not offer', () => {
    ai.setMode('query');
    ai.setModel('gemini-3.1-pro');
    ai.setMode('coding'); // coding offers everything, so choice survives
    expect(ai.getCurrentModel()).toBe('gemini-3.1-pro');
  });
});

describe('screenshot queue', () => {
  it('adds, lists, removes and clears screenshots', () => {
    const a = ai.addScreenshotToQueue('imgA', null, '2026-01-01');
    const b = ai.addScreenshotToQueue('imgB', null, '2026-01-02');
    expect(ai.getQueue()).toHaveLength(2);

    ai.removeScreenshotFromQueue(a.id);
    expect(ai.getQueue()).toHaveLength(1);
    expect(ai.getQueue()[0].id).toBe(b.id);

    ai.clearQueue();
    expect(ai.getQueue()).toHaveLength(0);
  });

  it('resetConversation clears queue, history and interview state', () => {
    ai.addScreenshotToQueue('img', null, 't');
    ai.conversationHistory.push({ role: 'user', content: 'hi' });
    ai.setInterviewSummary('some summary');
    ai.resetConversation();
    expect(ai.getQueue()).toHaveLength(0);
    expect(ai.conversationHistory).toHaveLength(0);
    expect(ai.interviewSummary).toBe('');
  });
});

describe('interview context & prompt building', () => {
  it('stores interview context fields', () => {
    ai.setInterviewContext({ interviewTopic: 'Backend Engineer', resumeText: 'RESUME_X' });
    const ctx = ai.getInterviewContext();
    expect(ctx.interviewTopic).toBe('Backend Engineer');
    expect(ctx.resumeText).toBe('RESUME_X');
  });

  it('weaves context, summary and transcript into the interview prompt', () => {
    ai.setInterviewContext({
      interviewTopic: 'SRE',
      resumeText: 'RESUME_X',
      jobDescription: 'JD_Y',
      extraInstructions: 'be concise',
    });
    ai.setInterviewSummary('SUMMARY_Z');
    const prompt = ai._buildInterviewPrompt('SYSTEM_BASE', 'candidate said hello');
    expect(prompt).toContain('SYSTEM_BASE');
    expect(prompt).toContain('SRE');
    expect(prompt).toContain('RESUME_X');
    expect(prompt).toContain('JD_Y');
    expect(prompt).toContain('be concise');
    expect(prompt).toContain('SUMMARY_Z');
    expect(prompt).toContain('candidate said hello');
    expect(prompt).toContain('JSON');
  });

  it('omits empty context blocks', () => {
    const prompt = ai._buildInterviewPrompt('SYSTEM_BASE', 'q');
    expect(prompt).not.toContain('Resume:');
    expect(prompt).not.toContain('Interview summary:');
  });
});

describe('screenshot queue cap', () => {
  const fill = (n) => {
    for (let i = 0; i < n; i++) ai.addScreenshotToQueue(`img${i}`, null);
  };

  for (const mode of ['coding', 'mcq', 'query']) {
    it(`stops at 20 screenshots in ${mode} mode`, () => {
      ai.setMode(mode);
      fill(20);
      expect(ai.isQueueFull()).toBe(true);
      expect(ai.addScreenshotToQueue('one-too-many', null)).toBeNull();
      expect(ai.getQueue()).toHaveLength(20);
      // The rejected shot is not swapped in for an old one
      expect(ai.getQueue().map((s) => s.image)).not.toContain('one-too-many');
    });
  }

  it('leaves interview mode uncapped', () => {
    ai.setMode('interview');
    fill(25);
    expect(ai.getMaxScreenshots()).toBeNull();
    expect(ai.isQueueFull()).toBe(false);
    expect(ai.getQueue()).toHaveLength(25);
  });

  it('frees a slot when a screenshot is removed', () => {
    fill(20);
    ai.removeScreenshotFromQueue(ai.getQueue()[0].id);
    expect(ai.isQueueFull()).toBe(false);
    expect(ai.addScreenshotToQueue('again', null)).not.toBeNull();
  });

  it('allows a fresh 20 after clearing or resetting', () => {
    fill(20);
    ai.clearQueue();
    fill(20);
    expect(ai.getQueue()).toHaveLength(20);
    ai.resetConversation();
    expect(ai.isQueueFull()).toBe(false);
  });
});
