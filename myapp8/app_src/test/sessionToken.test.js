import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readTokenFile,
  writeTokenFile,
  sanitizeSessionToken,
  TOKEN_FILENAME,
} from '../src/utils/sessionToken.js';

// A per-run userData directory, so these tests never touch a real install.
// readTokenFile/writeTokenFile take the path explicitly, which is what lets
// these run without an Electron runtime.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'solvro-token-test-'));
const TOKEN_PATH = path.join(USER_DATA, TOKEN_FILENAME);
const tokenPath = () => TOKEN_PATH;
const readSessionToken = () => readTokenFile(TOKEN_PATH);
const writeSessionToken = (t) => writeTokenFile(TOKEN_PATH, t);

// A JWT-shaped value; the real token is three base64url segments.
const TOKEN = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.abc-DEF_123.xyz';

beforeEach(() => {
  try { fs.unlinkSync(tokenPath()); } catch (_) { }
});

afterEach(() => {
  try { fs.unlinkSync(tokenPath()); } catch (_) { }
});

describe('sanitizeSessionToken', () => {
  // The token goes out as a Cookie header. Node rejects a header value that
  // contains a newline with ERR_INVALID_CHAR, so a token read with the
  // installer's trailing CRLF made every request throw before it left the
  // machine — which looked exactly like being signed out.
  it('strips the trailing CRLF PowerShell leaves behind', () => {
    expect(sanitizeSessionToken(`${TOKEN}\r\n`)).toBe(TOKEN);
    expect(sanitizeSessionToken(`${TOKEN}\n`)).toBe(TOKEN);
    expect(sanitizeSessionToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it('strips a UTF-8 BOM', () => {
    expect(sanitizeSessionToken(`﻿${TOKEN}`)).toBe(TOKEN);
    expect(sanitizeSessionToken(`﻿${TOKEN}\r\n`)).toBe(TOKEN);
  });

  it('rejects a value that would still corrupt the Cookie header', () => {
    // Embedded (not trailing) control characters mean the file is corrupt.
    // Returning '' sends the user to a recoverable login instead of failing
    // every request for the life of the install.
    expect(sanitizeSessionToken('abc\r\ndef')).toBe('');
    expect(sanitizeSessionToken('abc def')).toBe('');
    expect(sanitizeSessionToken('abc;def')).toBe('');
  });

  it('treats empty and missing input as no token', () => {
    expect(sanitizeSessionToken('')).toBe('');
    expect(sanitizeSessionToken('   \r\n')).toBe('');
    expect(sanitizeSessionToken(null)).toBe('');
    expect(sanitizeSessionToken(undefined)).toBe('');
  });
});

describe('readSessionToken', () => {
  it('returns an empty string when no token file exists', () => {
    expect(readSessionToken()).toBe('');
  });

  it('reads a token written by the installer, CRLF and BOM included', () => {
    fs.writeFileSync(tokenPath(), `﻿${TOKEN}\r\n`, 'utf8');
    expect(readSessionToken()).toBe(TOKEN);
  });

  // An interrupted write leaves a zero-byte file. existsSync() says "signed in"
  // while every request 401s, so presence alone is not a usable auth check.
  it('treats a zero-byte token file as signed out', () => {
    fs.writeFileSync(tokenPath(), '', 'utf8');
    expect(readSessionToken()).toBe('');
  });
});

describe('writeSessionToken', () => {
  it('round-trips through the sanitiser', () => {
    expect(writeSessionToken(`${TOKEN}\r\n`)).toBe(true);
    expect(fs.readFileSync(tokenPath(), 'utf8')).toBe(TOKEN);
    expect(readSessionToken()).toBe(TOKEN);
  });

  it('refuses to overwrite a good token with an empty one', () => {
    writeSessionToken(TOKEN);
    expect(writeSessionToken('')).toBe(false);
    expect(readSessionToken()).toBe(TOKEN);
  });

  it('leaves no temp file behind', () => {
    writeSessionToken(TOKEN);
    expect(fs.existsSync(`${tokenPath()}.tmp`)).toBe(false);
  });
});
