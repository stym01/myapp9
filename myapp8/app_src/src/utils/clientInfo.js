// Identifies this build to the Solvro backend so the admin dashboard can show
// which app versions and platforms are in use. No personal data: just the app
// version and the OS family (win32 / darwin / linux).

let cached;

function appVersion() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch {
    // not in the Electron main process
  }
  try {
    return require('../../package.json').version;
  } catch {
    return 'unknown';
  }
}

function clientHeaders() {
  if (!cached) {
    cached = {
      'x-solvro-version': String(appVersion()),
      'x-solvro-platform': process.platform,
    };
  }
  return cached;
}

module.exports = { clientHeaders };
