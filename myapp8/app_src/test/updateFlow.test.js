import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// What a user sees when an update is ready, and the rules that keep it out of their
// way. The real install is covered by running real builds; these pin the decisions.
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rendererSource = read('../src/renderer/renderer.js');
const mainSource = read('../main.js');
const installerSource = read('../build/installer.nsh');
const html = read('../index.html');

let elements;
let api;
let handlers;

const sandbox = {
  document: {
    addEventListener() {},
    getElementById: (id) => elements[id] || null,
  },
  window: {},
  navigator: { platform: 'Win32', userAgent: '' },
  setTimeout: () => 0,
  requestAnimationFrame: () => 0,
};
vm.runInNewContext(`${rendererSource}\n;globalThis.AppRenderer = AppRenderer;`, sandbox);

function launch(pending = null) {
  api.getPendingUpdate = vi.fn(() => Promise.resolve(pending));
  const r = Object.create(sandbox.AppRenderer.prototype);
  r._wireUpdateEvents();
  return r;
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });
const bannerShown = () => elements['update-banner'].hidden === false;

beforeEach(() => {
  handlers = {};
  elements = {
    'update-banner': { hidden: true },
    'update-banner-text': { textContent: '' },
    'update-banner-install': { textContent: 'Install & restart', disabled: false },
    'update-banner-dismiss': {},
  };
  api = {
    onUpdateAvailable: vi.fn(),
    onUpdateDownloaded: (fn) => { handlers.downloaded = fn; },
    onUpdateError: vi.fn(),
    installUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
  };
  sandbox.window.electronAPI = api;
});

describe('a forced update', () => {
  it('shows the user nothing and asks nothing', async () => {
    launch(null);
    await flush();
    handlers.downloaded({}, { version: '3.2.7', forced: true });
    expect(bannerShown()).toBe(false);
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('shows nothing when the renderer learns about it by asking, either', async () => {
    launch({ phase: 'downloaded', version: '3.2.7', forced: true });
    await flush();
    expect(bannerShown()).toBe(false);
  });

  it('has no blocking screen left to get in the way', () => {
    expect(html).not.toContain('update-gate');
    expect(rendererSource).not.toContain('_showUpdateGate');
  });
});

describe('a normal update', () => {
  it('offers to install, with a way to cancel', async () => {
    launch(null);
    await flush();
    handlers.downloaded({}, { version: '3.2.7', forced: false });
    expect(bannerShown()).toBe(true);
    expect(elements['update-banner-text'].textContent).toContain('3.2.7');
    expect(elements['update-banner-dismiss'].onclick).toBeTypeOf('function');
    expect(elements['update-banner-install'].onclick).toBeTypeOf('function');
    expect(html).toMatch(/id="update-banner-dismiss"[^>]*aria-label="Cancel"/);
  });

  it('is offered when the renderer learns about it by asking', async () => {
    launch({ phase: 'downloaded', version: '3.2.7', forced: false });
    await flush();
    expect(bannerShown()).toBe(true);
  });

  it('shows nothing while it is still downloading', async () => {
    launch({ phase: 'downloading', version: '3.2.7', forced: false });
    await flush();
    expect(bannerShown()).toBe(false);
  });

  it('shows nothing when the app is up to date', async () => {
    launch(null);
    await flush();
    expect(bannerShown()).toBe(false);
  });

  it('installs when asked', async () => {
    launch(null);
    await flush();
    handlers.downloaded({}, { version: '3.2.7', forced: false });
    elements['update-banner-install'].onclick();
    expect(api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('cancel tells the main process, and stays cancelled at the next 10-minute check', async () => {
    launch(null);
    await flush();
    handlers.downloaded({}, { version: '3.2.7', forced: false });
    elements['update-banner-dismiss'].onclick();
    expect(bannerShown()).toBe(false);
    expect(api.dismissUpdate).toHaveBeenCalledTimes(1);

    handlers.downloaded({}, { version: '3.2.7', forced: false });
    expect(bannerShown()).toBe(false);
  });

  it('a newer version than the cancelled one is offered again', async () => {
    launch(null);
    await flush();
    handlers.downloaded({}, { version: '3.2.7', forced: false });
    elements['update-banner-dismiss'].onclick();

    handlers.downloaded({}, { version: '3.2.8', forced: false });
    expect(bannerShown()).toBe(true);
  });
});

describe('main process', () => {
  const compareVersions = new Function(
    `${mainSource.match(/function compareVersions[\s\S]*?\n}\n/)[0]}\nreturn compareVersions;`,
  )();

  it.each([
    ['3.2.5', '3.2.6', -1],
    ['3.2.6', '3.2.6', 0],
    ['3.2.7', '3.2.6', 1],
    ['3.10.0', '3.2.6', 1],
    ['2.9.9', '3.2.6', -1],
  ])('compares %s with %s as numbers', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('installs without the wizard and reopens the app when "Install & restart" is clicked', () => {
    expect(mainSource).toContain('autoUpdater.quitAndInstall(true, true)');
    expect(mainSource).not.toContain('autoUpdater.quitAndInstall(false');
  });

  it('never installs because the app closed, which is also how the overlay opens', () => {
    expect(mainSource).toContain("if (process.platform === 'win32') autoUpdater.autoInstallOnAppQuit = false;");
    expect(mainSource).not.toContain('autoInstallOnAppQuit = true');
  });

  it('leaves other platforms installing on close, since they have no restart install', () => {
    const setup = mainSource.slice(mainSource.indexOf('autoUpdater.autoDownload = true'));
    expect(setup.slice(0, 400).match(/autoInstallOnAppQuit = false/g)).toHaveLength(1);
    expect(setup.slice(0, 400)).toContain("process.platform === 'win32'");
    const schedule = mainSource.slice(mainSource.indexOf('function scheduleUpdateAfterRestart'));
    expect(schedule.slice(0, 300)).toContain("process.platform !== 'win32'");
  });

  it('a cancel removes the scheduled install, which a forced update ignores', () => {
    const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('dismiss-update'"));
    expect(handler.indexOf('isForceUpdate()')).toBeLessThan(handler.indexOf('updateCancelled = true'));
    expect(handler.slice(0, 300)).toContain('cancelUpdateAfterRestart()');
    const schedule = mainSource.slice(mainSource.indexOf('function scheduleUpdateAfterRestart'));
    expect(schedule.slice(0, 300)).toContain('(updateCancelled && !isForceUpdate())');
  });

  it('lets a forced update finish downloading after the app is closed', () => {
    const quit = mainSource.slice(mainSource.indexOf("app.on('before-quit'"));
    expect(quit.indexOf('shouldFinishUpdateInBackground()')).toBeLessThan(quit.indexOf('Before quit event triggered'));
    expect(quit.indexOf('event.preventDefault()')).toBeLessThan(quit.indexOf('Before quit event triggered'));
  });

  it('schedules that download before quitting, and never installs it there', () => {
    const downloaded = mainSource.slice(mainSource.indexOf("autoUpdater.on('update-downloaded'"));
    expect(downloaded.slice(0, 500)).toContain("scheduleUpdateAfterRestart(() => endBackgroundUpdate('downloaded'))");
    const end = mainSource.slice(mainSource.indexOf('function endBackgroundUpdate'));
    expect(end.slice(0, end.indexOf('\n}\n'))).not.toContain('quitAndInstall');
  });

  it('gives that up on success, failure and timeout, so nothing can linger', () => {
    const failed = mainSource.slice(mainSource.indexOf("autoUpdater.on('error'"));
    expect(failed.slice(0, 600)).toContain("endBackgroundUpdate('download failed')");
    expect(mainSource).toContain("setTimeout(() => endBackgroundUpdate('timed out'), BACKGROUND_UPDATE_TIMEOUT_MS)");
  });

  it('has nothing to wait for on close after a download has failed', () => {
    const failed = mainSource.slice(mainSource.indexOf("autoUpdater.on('error'"));
    expect(failed.indexOf('pendingUpdateState = null')).toBeGreaterThan(-1);
    expect(failed.indexOf('pendingUpdateState = null')).toBeLessThan(failed.indexOf("endBackgroundUpdate('download failed')"));
    expect(mainSource).toMatch(/shouldFinishUpdateInBackground\(\) \{[\s\S]*?pendingUpdateState\.phase === 'downloading'/);
  });

  it('does not let a forced exit cut that off', () => {
    // The only unguarded exits left: the tray's Force Quit, the second instance
    // bailing out at startup, and after the background update has already ended.
    const unguarded = mainSource.match(/process\.exit\(0\)/g) || [];
    expect(unguarded).toHaveLength(4);
    expect(mainSource.match(/setTimeout\(forceExitUnlessUpdating, \d+\)/g)).toHaveLength(4);
  });

  it('schedules a downloaded update for after a PC restart', () => {
    const schedule = mainSource.slice(mainSource.indexOf('function scheduleUpdateAfterRestart'));
    expect(schedule.slice(0, 500)).toContain('`"${installer}" --updated /S --at-restart`');
  });

  it('reopening during that starts a fresh app', () => {
    const secondInstance = mainSource.slice(mainSource.indexOf("app.on('second-instance'"));
    expect(secondInstance.slice(0, 600)).toMatch(/backgroundUpdate === 'running'[\s\S]*app\.relaunch\(\)[\s\S]*app\.exit\(0\)/);
  });

  it('does not start a new download in the middle of an interview', () => {
    expect(mainSource).toMatch(/setInterval\(\(\) => \{[\s\S]{0,200}getCurrentMode\(\) === 'interview'\) return;\s+runUpdateCheck\(\);/);
  });
});

describe('installer', () => {
  const start = installerSource.indexOf('!macro customInit');
  const init = installerSource.slice(start, installerSource.indexOf('!macroend', start));
  const updatePart = init.slice(init.indexOf('${if} ${isUpdated}'), init.indexOf('${else}'));

  it('never shows the wizard on an update, from the very start', () => {
    const pre = installerSource.slice(installerSource.indexOf('!macro preInit'));
    expect(pre.slice(0, pre.indexOf('!macroend'))).toMatch(/\$\{if\} \$\{isUpdated\}\s+SetSilent silent/);
  });

  it('only installs at a PC restart or when asked to: anything else stops right there', () => {
    const rule = updatePart.slice(updatePart.indexOf('ClearErrors'), updatePart.indexOf('hope.exe'));
    expect(rule).toContain('"--at-restart"');
    expect(rule).toMatch(/\$\{if\} \$\{Errors\}\s+\$\{andIfNot\} \$\{isForceRun\}\s+!insertmacro deferUpdateUntilRestart/);
  });

  it('leaves the overlay alone on an update, and tries again after a restart', () => {
    const overlay = updatePart.slice(updatePart.indexOf('hope.exe'));
    expect(overlay.slice(0, 120)).toContain('deferUpdateUntilRestart');
    expect(updatePart).not.toContain('taskkill');
    expect(installerSource).toMatch(/macro deferUpdateUntilRestart\s+WriteRegStr HKCU[^\n]*`"\$EXEPATH" --updated \/S --at-restart`\s+Quit/);
  });

  it('does not wait around while the overlay is in use', () => {
    const overlay = updatePart.slice(updatePart.indexOf('hope.exe'), updatePart.indexOf('CreateFileW'));
    expect(overlay).not.toContain('Sleep');
  });

  it('leaves the app alone if the user reopened it, and tries again after a restart', () => {
    expect(updatePart).toMatch(/CreateFileW[\s\S]*\$\{exitdo\}[\s\S]*\$1 != 32[\s\S]*\$\{exitdo\}[\s\S]*deferUpdateUntilRestart[\s\S]*Sleep 1000/);
  });

  it('does not bring back an app that was uninstalled', () => {
    const guard = updatePart.indexOf('FileExists');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(updatePart.indexOf('--at-restart'));
    const uninstall = installerSource.slice(installerSource.indexOf('!macro customUnInit'));
    expect(uninstall).toContain('DeleteRegValue HKCU');
  });

  it('clears the scheduled run once it has installed', () => {
    const install = installerSource.slice(installerSource.indexOf('!macro customInstall'));
    expect(install.slice(0, 200)).toContain('DeleteRegValue HKCU');
  });

  it('still clears the overlay for an install the user started themselves', () => {
    const manualPart = init.slice(init.indexOf('${else}'));
    expect(manualPart).toContain("taskkill /F /IM hope.exe");
  });
});
