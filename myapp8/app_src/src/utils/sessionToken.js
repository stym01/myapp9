// Single place that knows how to read and write the desktop session token.
//
// The token is a NextAuth JWT and it goes out as a Cookie header on every AI,
// STT and profile request. Node validates header values, so a stray newline in
// the file makes https.request throw ERR_INVALID_CHAR and EVERY request fails —
// which the UI can only report as an auth failure, i.e. the user looks silently
// logged out. That is not hypothetical: the token file is written by the
// PowerShell installer, and PowerShell's Set-Content/Out-File append a trailing
// CRLF and (in Windows PowerShell 5.1) can prepend a UTF-8 BOM.
//
// Every reader must go through readSessionToken() so the sanitising is uniform.
// main.js used to .trim() while aiService.js did not, so the desktop app's own
// login worked and installer-provisioned logins failed on the AI routes only.
//
// The file-level functions take an explicit path and never touch Electron, so
// the sanitising rules are testable without an Electron runtime; the exported
// readSessionToken/writeSessionToken resolve userData and delegate to them.

const fs = require('fs');
const path = require('path');

const TOKEN_FILENAME = 'solvro-token.txt';

function tokenPath() {
  return path.join(require('electron').app.getPath('userData'), TOKEN_FILENAME);
}

// Strips a UTF-8 BOM and any surrounding whitespace, then rejects anything that
// still contains a character illegal in an HTTP header value.
function sanitize(raw) {
  if (!raw) return '';
  let value = String(raw);
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
  value = value.trim();
  if (!value) return '';
  // Control characters (and the separators a cookie value can't carry) mean the
  // file is corrupt. Treating it as "no token" sends the user to a login screen,
  // which is recoverable; sending it would throw on every request forever.
  if (/[\x00-\x20\x7f;,]/.test(value)) return '';
  return value;
}

function readTokenFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[Token] File not found: ${filePath}`);
      return '';
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    console.error(`[Token] Read ${raw.length} bytes from ${filePath}`);
    const clean = sanitize(raw);
    console.error(`[Token] After sanitize: ${clean ? clean.slice(0, 20) + '...' : '(empty)'}`);
    return clean;
  } catch (err) {
    console.error(`[Token] Read error: ${err.message}`);
    return '';
  }
}

// Writes via a temp file + rename so an interrupted or crashed write can never
// leave a truncated token behind — the old one stays valid until the new one is
// complete. A half-written token is indistinguishable from an expired one at
// request time, and costs the user a re-login.
function writeTokenFile(filePath, token) {
  const clean = sanitize(token);
  if (!clean) {
    console.error(`[Token] writeTokenFile: sanitize returned empty for token length=${token ? token.length : 0}`);
    return false;
  }
  const tmp = `${filePath}.tmp`;
  try {
    console.error(`[Token] writeTokenFile: writing ${clean.length} bytes to ${filePath}`);
    fs.writeFileSync(tmp, clean, 'utf8');
    fs.renameSync(tmp, filePath);
    console.error(`[Token] writeTokenFile: SUCCESS via rename`);
    return true;
  } catch (err) {
    console.error(`[Token] writeTokenFile: rename failed: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch (_) { }
    try {
      // Rename can fail on Windows if something holds the target open; a direct
      // write is still better than losing the login.
      fs.writeFileSync(filePath, clean, 'utf8');
      console.error(`[Token] writeTokenFile: SUCCESS via direct write`);
      return true;
    } catch (writeErr) {
      console.error(`[Token] writeTokenFile: FAILED completely: ${writeErr.message}`);
      return false;
    }
  }
}

function readSessionToken() {
  try {
    return readTokenFile(tokenPath());
  } catch (err) {
    return '';
  }
}

function writeSessionToken(token) {
  try {
    return writeTokenFile(tokenPath(), token);
  } catch (err) {
    return false;
  }
}

module.exports = {
  readSessionToken,
  writeSessionToken,
  readTokenFile,
  writeTokenFile,
  sanitizeSessionToken: sanitize,
  tokenPath,
  TOKEN_FILENAME,
};
