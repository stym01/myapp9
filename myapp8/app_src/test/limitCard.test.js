import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// What a user sees when a Claude cap runs out, and in the Usage panel. renderer.js
// is a plain browser script with no exports, so it is evaluated here and its real
// methods are called against a stub `this`.
const source = fs.readFileSync(new URL('../src/renderer/renderer.js', import.meta.url), 'utf8');

let elements;
const sandbox = {
  document: {
    addEventListener() {},
    getElementById: (id) => elements[id] || null,
    createElement: () => {
      let text = '';
      return {
        set textContent(value) { text = String(value); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
    },
  },
  window: { electronAPI: {} },
  navigator: { platform: 'Win32', userAgent: '' },
  setTimeout: () => 0,
  requestAnimationFrame: () => 0,
};
vm.runInNewContext(`${source}\n;globalThis.AppRenderer = AppRenderer;`, sandbox);

function renderer() {
  const r = Object.create(sandbox.AppRenderer.prototype);
  r.analysisText = { innerHTML: '' };
  r.statusElement = { textContent: '' };
  r.resizeWindowToContent = () => {};
  return r;
}

function limitCard(details) {
  const r = renderer();
  r.showLimitReached(details);
  return { html: r.analysisText.innerHTML, status: r.statusElement.textContent };
}

function usagePanel(monthly) {
  elements = { 'usage-body': { innerHTML: '', querySelectorAll: () => [] } };
  renderer()._renderUsage({
    plan: { tier: 2, tierName: 'Pro+', name: 'Sprint Pass (3 Days)' },
    monthly,
  });
  return elements['usage-body'].innerHTML;
}

const ALTERNATIVES = [
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
];

beforeEach(() => {
  elements = {};
});

describe('limit card on a Sprint Pass', () => {
  // The exact shape /api/ai/claude sends: `period` stays 'month' for older builds.
  const details = {
    code: 'daily_limit_reached',
    period: 'month',
    allowance: 'pass',
    planName: 'Sprint Pass (1 Day)',
    model: 'claude-opus-4-8',
    modelLabel: 'Claude Opus 5',
    limit: 10,
    alternatives: ALTERNATIVES,
    upgrade: {
      options: [
        { plan: 'sprint_pass_3d', name: 'Sprint Pass (3 Days)', limit: 25 },
        { plan: 'sprint_pass', name: 'Sprint Pass (7 Days)', limit: 50 },
        { plan: 'monthly_pro_plus', name: 'Monthly Pro+ Pass', limit: 100 },
      ],
    },
  };

  it('says the allowance is used up, on this pass', () => {
    const { html, status } = limitCard(details);
    expect(status).toBe('Pass Limit Reached');
    expect(html).toContain('Sprint Pass limit');
    expect(html).toContain('That’s all 10 on <em>your pass</em>');
    expect(html).toContain('used every Claude Opus 5 request on your Sprint Pass (1 Day)');
    expect(html).toContain('10 of 10 used');
  });

  it('offers the upgrade, naming what each plan gives', () => {
    const { html } = limitCard(details);
    expect(html).toContain('id="limit-upgrade-btn"');
    expect(html).toContain('Upgrade for more');
    expect(html).toContain('<b>Sprint Pass (3 Days)</b><span>25 requests</span>');
    expect(html).toContain('<b>Sprint Pass (7 Days)</b><span>50 requests</span>');
    expect(html).toContain('<b>Monthly Pro+ Pass</b><span>100 requests</span>');
  });

  it('still lets the user keep working with one click', () => {
    const { html } = limitCard(details);
    expect(html).toContain('id="limit-switch-btn"');
    expect(html).toContain('data-model="gemini-3.7-flash"');
    expect(html).toContain('Continue on Gemini 3.7 Flash');
    // The upgrade comes first: it's what this card is for.
    expect(html.indexOf('limit-upgrade-btn')).toBeLessThan(html.indexOf('limit-switch-btn'));
  });

  it('wires the buttons: upgrade opens the plans, continue switches model', async () => {
    const handlers = {};
    const button = (name, attribute) => ({
      addEventListener: (_event, handler) => { handlers[name] = handler; },
      getAttribute: () => attribute,
    });
    elements = {
      'limit-upgrade-btn': button('upgrade'),
      'limit-switch-btn': button('keepGoing', 'gemini-3.7-flash'),
    };
    const openExternal = vi.fn();
    sandbox.window.electronAPI.openExternal = openExternal;
    sandbox.setTimeout = (fn) => { fn(); return 0; };

    const r = renderer();
    r.cycleModel = vi.fn(async () => {});
    r.showToast = vi.fn();
    r._restoreQueueDisplay = vi.fn();
    r.showLimitReached(details);

    handlers.upgrade();
    expect(openExternal).toHaveBeenCalledWith('https://solvro.in/dashboard#plans');

    await handlers.keepGoing();
    expect(r.cycleModel).toHaveBeenCalledWith('gemini-3.7-flash');
    expect(r._restoreQueueDisplay).toHaveBeenCalled();

    sandbox.setTimeout = () => 0;
    delete sandbox.window.electronAPI.openExternal;
  });

  it('never promises a refill, because a pass does not get one', () => {
    const { html } = limitCard(details);
    expect(html).not.toMatch(/this month|today|refills|No daily cap/i);
  });

  it('escapes what the server sends', () => {
    const { html } = limitCard({
      ...details,
      upgrade: { options: [{ plan: 'x', name: '<img src=x>', limit: 1 }] },
    });
    expect(html).not.toContain('<img');
  });

  it('still shows the upgrade if the server sent no options or fallbacks', () => {
    const { html } = limitCard({ ...details, upgrade: undefined, alternatives: [] });
    expect(html).toContain('id="limit-upgrade-btn"');
    expect(html).not.toContain('paywall-options');
    expect(html).not.toContain('limit-switch-btn');
  });
});

describe('limit card on a monthly plan', () => {
  const resetsAt = new Date(Date.now() + 5 * 86400000).toISOString();
  const details = {
    code: 'daily_limit_reached',
    period: 'month',
    modelLabel: 'Claude Opus 5',
    limit: 100,
    resetsAt,
    alternatives: ALTERNATIVES,
  };

  it('stays a refill notice, with nothing to upgrade to', () => {
    const { html, status } = limitCard(details);
    expect(status).toBe('Monthly Limit Reached');
    expect(html).toContain('That’s all 100 for <em>this month</em>');
    expect(html).toContain('Refills ');
    expect(html).toContain('It refills in about');
    expect(html).toContain('Continue on Gemini 3.7 Flash');
    expect(html).not.toContain('Upgrade for more');
  });
});

describe('limit card on the free trial', () => {
  it('still sells the upgrade', () => {
    const { html, status } = limitCard({ code: 'free_trial_exhausted', limit: 10 });
    expect(status).toBe('Trial Complete');
    expect(html).toContain('id="limit-upgrade-btn"');
    expect(html).toContain('See plans');
  });
});

describe('Usage panel', () => {
  const meter = (id, label, used, limit) => ({ id, label, used, limit, unit: 'requests' });

  it('calls a pass allowance what it is', () => {
    const html = usagePanel({
      resetsAt: null,
      allowance: 'pass',
      meters: [meter('claude-fable-5', 'Claude Fable 5', 1, 10), meter('claude-opus-4-8', 'Claude Opus 5', 2, 25)],
    });
    expect(html).toContain('Pass limits');
    expect(html).toContain('One-time · doesn’t refill');
    expect(html).not.toContain('Monthly limits');
    expect(html).not.toContain('Starts with your next request');
    // Nothing has run out yet, so no sales pitch.
    expect(html).not.toContain('Upgrade for more');
  });

  it('offers the upgrade once a pass meter is full', () => {
    const html = usagePanel({
      resetsAt: null,
      allowance: 'pass',
      meters: [meter('claude-fable-5', 'Claude Fable 5', 10, 10), meter('claude-opus-4-8', 'Claude Opus 5', 2, 25)],
    });
    expect(html).toContain('All used');
    expect(html).toContain('data-usage-action="upgrade"');
    expect(html).toContain('Upgrade for more');
  });

  it('keeps the monthly layout for every other plan', () => {
    const html = usagePanel({
      resetsAt: new Date(Date.now() + 5 * 86400000).toISOString(),
      meters: [meter('claude-fable-5', 'Claude Fable 5', 50, 50)],
    });
    expect(html).toContain('Monthly limits');
    expect(html).toContain('Resets ');
    expect(html).toContain('Limit reached · back in about');
    expect(html).not.toContain('Upgrade for more');
  });
});
