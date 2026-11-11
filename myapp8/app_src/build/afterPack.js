// electron-builder afterPack hook: ad-hoc code-sign the macOS app.
//
// Why: build.mac.identity is null (no Apple Developer ID yet), so electron-builder
// skips signing. But packaging edits Electron's pre-signed bundle (rename,
// Info.plist, app.asar, MacKeyServer), which leaves a *broken* signature. A
// downloaded (quarantined) app with a broken signature is reported by Gatekeeper
// as "Solvro is damaged and can't be opened" with no way around it, and Apple
// Silicon refuses to run it at all.
//
// An ad-hoc signature ("-") makes the bundle internally consistent. Gatekeeper
// then shows the normal "Apple could not verify..." prompt instead, which users
// clear via System Settings -> Privacy & Security -> Open Anyway.
//
// electron-builder 24 has no identity:"-" option, and afterSign never fires when
// signing is skipped, so this runs in afterPack: the last step that touches the
// .app before the dmg is built.
//
// Replace this with real Developer ID signing + notarization once there is an
// Apple Developer account (remove identity:null, enable hardenedRuntime/notarize).

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (process.platform !== 'darwin') {
    // codesign only exists on macOS. Fail loudly: a mac build from here would
    // ship the "damaged" error again.
    throw new Error('macOS builds must run on macOS so the app can be ad-hoc signed (codesign is unavailable).');
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // node-global-key-listener spawns this helper; it must be executable.
  const keyServer = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked',
    'node_modules', 'node-global-key-listener', 'bin', 'MacKeyServer');
  if (fs.existsSync(keyServer)) fs.chmodSync(keyServer, 0o755);

  console.log(`  • ad-hoc signing  ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
};
