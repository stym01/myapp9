import { describe, it, expect } from 'vitest';
import lc from '../src/utils/liveCoachRuntime.js';

const {
  normalizeWhitespace,
  extractFirstJsonObject,
  coerceBulletList,
  normalizeQuestionType,
} = lc;

describe('normalizeWhitespace', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normalizeWhitespace('  a\n\t  b   c ')).toBe('a b c');
  });
  it('returns "" for non-strings', () => {
    expect(normalizeWhitespace(null)).toBe('');
    expect(normalizeWhitespace(42)).toBe('');
  });
});

describe('extractFirstJsonObject', () => {
  it('parses clean JSON', () => {
    expect(extractFirstJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });
  it('strips ```json code fences', () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('tolerates trailing commas and unquoted keys', () => {
    expect(extractFirstJsonObject('{ action: "ignore", a: 1, }')).toEqual({ action: 'ignore', a: 1 });
  });
  it('tolerates single-quoted strings and smart quotes', () => {
    expect(extractFirstJsonObject("{'a': 'hello'}")).toEqual({ a: 'hello' });
  });
  it('returns the first object from a JSON array', () => {
    expect(extractFirstJsonObject('[{"a":1},{"b":2}]')).toEqual({ a: 1 });
  });
  it('returns null for input with no JSON', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
    expect(extractFirstJsonObject('')).toBeNull();
    expect(extractFirstJsonObject(null)).toBeNull();
  });
});

describe('coerceBulletList', () => {
  it('passes arrays through as strings', () => {
    expect(coerceBulletList(['a', 1, null])).toEqual(['a', '1', '']);
  });
  it('splits multi-line strings into bullets', () => {
    expect(coerceBulletList('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
  });
  it('splits a single line on semicolons', () => {
    expect(coerceBulletList('one; two; three')).toEqual(['one', 'two', 'three']);
  });
  it('reads a nested points/items object', () => {
    expect(coerceBulletList({ points: ['x', 'y'] })).toEqual(['x', 'y']);
  });
  it('returns [] for unusable input', () => {
    expect(coerceBulletList(42)).toEqual([]);
    expect(coerceBulletList('')).toEqual([]);
  });
});

describe('normalizeQuestionType', () => {
  it('keeps the four known types', () => {
    for (const t of ['behavioral', 'system_design', 'coding', 'other']) {
      expect(normalizeQuestionType(t)).toBe(t);
    }
  });
  it('normalises case/whitespace', () => {
    expect(normalizeQuestionType('  Behavioral ')).toBe('behavioral');
  });
  it('falls back to "other" for anything unknown', () => {
    expect(normalizeQuestionType('trivia')).toBe('other');
    expect(normalizeQuestionType(null)).toBe('other');
  });
});
