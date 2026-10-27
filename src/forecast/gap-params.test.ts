import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE, parseGapParams, serializeGapParams } from './gap-params';

describe('gap page params', () => {
  it('uses defaults for an empty or invalid query', () => {
    expect(parseGapParams('')).toEqual(DEFAULT_STATE);
    expect(parseGapParams('?lookback=99&source=foo&x=abc&hours=10&safety=-1')).toEqual(DEFAULT_STATE);
  });

  it('parses every supported parameter', () => {
    expect(parseGapParams('?lookback=yesterday&source=manual&manual=800&x=1.3&hours=168&safety=5')).toEqual({
      lookback: 'yesterday',
      source: 'manual',
      manualPerHour: 800,
      multiplier: 1.3,
      hours: 168,
      safetyAccounts: 5,
    });
    expect(parseGapParams('?lookback=12').lookback).toBe(12);
  });

  it('clamps the multiplier into the supported range', () => {
    expect(parseGapParams('?x=50').multiplier).toBe(20);
    expect(parseGapParams('?x=0.01').multiplier).toBe(0.1);
  });

  it('only writes parameters that differ from the defaults and round-trips', () => {
    expect(serializeGapParams(DEFAULT_STATE)).toBe('');
    const state = { ...DEFAULT_STATE, lookback: 'yesterday' as const, multiplier: 1.5, hours: 120 };
    const query = serializeGapParams(state);
    expect(query).toBe('?lookback=yesterday&x=1.5&hours=120');
    expect(parseGapParams(query)).toEqual(state);
  });

  it('keeps the manual demand only for the manual source', () => {
    expect(serializeGapParams({ ...DEFAULT_STATE, manualPerHour: 600 })).toBe('');
    expect(serializeGapParams({ ...DEFAULT_STATE, source: 'manual', manualPerHour: 600 })).toBe('?source=manual&manual=600');
  });
});
