import { describe, expect, it } from 'vitest';
import { isPoolActive } from '../src/bitflow';

describe('isPoolActive', () => {
  it('respects an explicit boolean status', () => {
    expect(isPoolActive(true)).toBe(true);
    expect(isPoolActive(false)).toBe(false);
  });

  it('treats known inactive strings as inactive (case-insensitive)', () => {
    for (const s of ['inactive', 'Paused', 'DISABLED', 'closed', 'halted', 'false']) {
      expect(isPoolActive(s)).toBe(false);
    }
  });

  it('treats active/unknown truthy strings as active', () => {
    expect(isPoolActive('active')).toBe(true);
    expect(isPoolActive('open')).toBe(true);
    expect(isPoolActive('something_new')).toBe(true);
  });

  it('falls back to the app-pool flag when status is missing', () => {
    expect(isPoolActive(undefined, false)).toBe(false);
    expect(isPoolActive(undefined, true)).toBe(true);
  });

  it('defaults to active when nothing is known', () => {
    expect(isPoolActive(undefined)).toBe(true);
  });
});
