const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const defaultShortcuts = {
  screenshot: { label: 'Take Screenshot', keys: 'CommandOrControl+Shift+S' },
  sendQueue: { label: 'Answer Generation / Assist', keys: 'CommandOrControl+Return' },
  resetConversation: { label: 'Reset Conversation / New Conversation', keys: 'CommandOrControl+R' },
  toggleWindow: { label: 'App Hiding', keys: 'CommandOrControl+Space' },
  transparencyIncrease: { label: 'Transparency Increasing', keys: 'CommandOrControl+Shift+]' },
  transparencyDecrease: { label: 'Transparency Decreasing', keys: 'CommandOrControl+Shift+[' },
  scrollUp: { label: 'Scroll Up', keys: 'CommandOrControl+Up' },
  scrollDown: { label: 'Scroll Down', keys: 'CommandOrControl+Down' },
  stopAutotyping: { label: 'Stop Autotyping', keys: 'F8' },
  startAutotyping: { label: 'Start Autotyping', keys: 'CommandOrControl+Shift+T' },
  resumeAutotyping: { label: 'Resume Autotyping', keys: 'CommandOrControl+Shift+Y' },
  moveUp: { label: 'Move App Up', keys: 'CommandOrControl+Shift+Up' },
  moveDown: { label: 'Move App Down', keys: 'CommandOrControl+Shift+Down' },
  moveLeft: { label: 'Move App Left', keys: 'CommandOrControl+Shift+Left' },
  moveRight: { label: 'Move App Right', keys: 'CommandOrControl+Shift+Right' },
  languageSwitch: { label: 'Language Switching', keys: 'CommandOrControl+Shift+L' },
  modelSwitch: { label: 'Models Switching', keys: 'CommandOrControl+Shift+M' },
  modeSwitch: { label: 'Modes Switching', keys: 'CommandOrControl+Shift+Space' },
  toggleTheme: { label: 'Toggle Theme (Dark / Light)', keys: 'CommandOrControl+Shift+D' },
  quit: { label: 'Quit Application', keys: 'CommandOrControl+Shift+Q' },
  // One key toggles the interview mic (start / stop). The id stays
  // `startInterview` so users' saved custom keys still apply.
  startInterview: { label: 'Start / Stop Mic (Interview mic · Query voice input)', keys: 'CommandOrControl+Shift+A' },
  newQuestion: { label: 'New Question', keys: 'CommandOrControl+Shift+N' }
};

// Returns an error message if the accelerator breaks the app's shortcut rules, otherwise null.
// Rules: no Alt/Meta, and Ctrl is required unless the key is F1–F24 (a bare key or Shift+key
// registered globally would block normal typing in every other app).
const checkAcceleratorRules = (keys) => {
  if (typeof keys !== 'string' || !keys.trim()) return 'Shortcut is empty.';
  const parts = keys.split('+').map(p => p.trim().toLowerCase());
  const modifiers = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  if (!key) return 'Shortcut is missing a key.';
  if (modifiers.some(m => ['alt', 'option', 'altgr', 'meta', 'super', 'command', 'cmd'].includes(m))) {
    return 'Alt and Windows keys are not allowed.';
  }
  const hasCtrl = modifiers.some(m => ['commandorcontrol', 'cmdorctrl', 'control', 'ctrl'].includes(m));
  if (!hasCtrl && !/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return 'Shortcut must include Ctrl (F1–F24 can be used alone).';
  }
  return null;
};

class ShortcutManager {
  getShortcutsFilePath() {
    let userId = 'default';
    const profilePath = path.join(require('electron').app.getPath('userData'), 'solvro-profile.json');
    if (fs.existsSync(profilePath)) {
      try {
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        if (profile && profile.email) {
          userId = profile.email.replace(/[^a-zA-Z0-9]/g, '_');
        }
      } catch (err) {}
    }
    return path.join(app.getPath('userData'), `custom-shortcuts-${userId}.json`);
  }

  getShortcuts() {
    const filePath = this.getShortcutsFilePath();
    let customShortcuts = {};
    if (fs.existsSync(filePath)) {
      try {
        customShortcuts = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        console.error('Error reading custom shortcuts file:', err);
      }
    }

    // Merge defaults with custom. Saved values that break the current rules (e.g. old Alt or
    // Shift-only shortcuts) or that collide with an earlier shortcut fall back to the default.
    const currentShortcuts = {};
    for (const [id, config] of Object.entries(defaultShortcuts)) {
      const custom = customShortcuts[id];
      currentShortcuts[id] = {
        label: config.label,
        keys: custom && !checkAcceleratorRules(custom) ? custom : config.keys
      };
    }
    this._resolveCollisions(currentShortcuts, customShortcuts);
    return currentShortcuts;
  }

  // A custom key can end up equal to another shortcut's default (e.g. after defaults change in an
  // update). Two identical accelerators can't both register, so the custom entry that caused the
  // clash is dropped back to its own default.
  _resolveCollisions(current, customShortcuts) {
    for (let pass = 0; pass < 3; pass++) {
      const seen = new Map();
      let changed = false;
      for (const [id, cfg] of Object.entries(current)) {
        const norm = cfg.keys.toLowerCase();
        if (!seen.has(norm)) { seen.set(norm, id); continue; }
        const otherId = seen.get(norm);
        const loser = customShortcuts[id] === cfg.keys ? id : (customShortcuts[otherId] === current[otherId].keys ? otherId : null);
        if (!loser) continue;
        console.warn(`Custom shortcut for ${loser} (${current[loser].keys}) collides; using default`);
        current[loser].keys = defaultShortcuts[loser].keys;
        changed = true;
      }
      if (!changed) break;
    }
  }

  saveShortcut(id, keys) {
    const filePath = this.getShortcutsFilePath();
    let customShortcuts = {};
    if (fs.existsSync(filePath)) {
      try {
        customShortcuts = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        console.error('Error reading custom shortcuts file:', err);
      }
    }

    customShortcuts[id] = keys;
    fs.writeFileSync(filePath, JSON.stringify(customShortcuts, null, 2), 'utf8');
  }

  resetAllShortcuts() {
    const filePath = this.getShortcutsFilePath();
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error('Error deleting custom shortcuts file:', err);
      }
    }
    return this.getShortcuts(); // Returns fresh defaults
  }
}

const shortcutManagerInstance = new ShortcutManager();
shortcutManagerInstance.defaultShortcuts = defaultShortcuts;
shortcutManagerInstance.checkAcceleratorRules = checkAcceleratorRules;

module.exports = shortcutManagerInstance;
