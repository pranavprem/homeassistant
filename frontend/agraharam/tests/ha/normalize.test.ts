import { describe, expect, it } from 'vitest';
import {
  normalizeEntity,
  numericDisplay,
  parseNumericValue,
  textDisplay,
  type NormalizedEntity,
} from '../../src/ha/normalize.ts';
import { entityId, fakeStore, testEntity } from '../helpers/fake-store.ts';

const SENSOR = entityId('sensor.demo_temperature');
const formatNumber = (v: number): string => `${v}°`;
const readState = (e: { state: string }): string => e.state;

function normalized(state: string | undefined, options: Parameters<typeof fakeStore>[1] = {}): NormalizedEntity {
  const states = state === undefined ? [] : [testEntity(SENSOR, state, { friendly_name: 'Demo temperature' })];
  return normalizeEntity(fakeStore(states, options), SENSOR);
}

describe('normalizeEntity precedence (§4.6)', () => {
  it('is loading before the first ingest', () => {
    expect(normalized('21', { ready: false })).toEqual({ id: SENSOR, status: 'loading', stale: false });
  });

  it('reports an absent entity as disconnected, loading or missing depending on the connection and HA state', () => {
    expect(normalized(undefined, { connected: false }).status).toBe('disconnected');
    expect(normalized(undefined, { haState: 'STARTING' }).status).toBe('loading');
    expect(normalized(undefined, { haState: 'NOT_RUNNING' }).status).toBe('loading');
    expect(normalized(undefined, { haState: 'RUNNING' }).status).toBe('missing-binding');
    expect(normalized(undefined).status).toBe('missing-binding');
  });

  it('keeps the last known entity as stale while disconnected or resyncing', () => {
    for (const options of [{ connected: false }, { connected: false, resyncing: true }]) {
      const result = normalized('21', options);
      expect(result.status).toBe('disconnected');
      expect(result.stale).toBe(true);
      expect(result.entity?.state).toBe('21');
    }
  });

  it('treats an entity the reconnect snapshot did not replace as stale (§16.10)', () => {
    const result = normalized('21', { notFresh: [SENSOR] });
    expect(result).toMatchObject({ status: 'disconnected', stale: true });
  });

  it('distinguishes unavailable, unknown and available', () => {
    expect(normalized('unavailable')).toEqual({ id: SENSOR, status: 'unavailable', stale: false });
    expect(normalized('unknown')).toMatchObject({ status: 'unknown', stale: false });
    expect(normalized('')).toMatchObject({ status: 'unknown', stale: false });
    expect(normalized('21')).toMatchObject({ status: 'available', stale: false });
  });
});

describe('numericDisplay', () => {
  it.each([null, undefined, '', 'unknown', 'unavailable', Number.NaN, Number.POSITIVE_INFINITY, '1e3', '2,5'])(
    'renders %j as "No data", never 0',
    (raw) => {
      const display = numericDisplay(normalized('21'), () => raw, formatNumber);
      expect(display).toEqual({ kind: 'absent', reason: 'no-data', label: 'No data' });
    },
  );

  it('formats numbers and plain numeric strings, including a real zero', () => {
    expect(numericDisplay(normalized('21.5'), readState, formatNumber)).toEqual({
      kind: 'value',
      text: '21.5°',
      stale: false,
    });
    expect(numericDisplay(normalized('0'), readState, formatNumber)).toMatchObject({
      kind: 'value',
      text: '0°',
    });
    expect(numericDisplay(normalized('-3'), readState, formatNumber)).toMatchObject({ text: '-3°' });
  });

  it('marks last known values stale and labels missing ones Offline while disconnected', () => {
    expect(numericDisplay(normalized('21', { connected: false }), readState, formatNumber)).toEqual({
      kind: 'value',
      text: '21°',
      stale: true,
    });
    expect(numericDisplay(normalized(undefined, { connected: false }), readState, formatNumber)).toEqual({
      kind: 'absent',
      reason: 'disconnected',
      label: 'Offline',
    });
  });

  it('uses the status label for unavailable, unknown and missing entities', () => {
    expect(numericDisplay(normalized('unavailable'), readState, formatNumber)).toMatchObject({
      label: 'Unavailable',
    });
    expect(numericDisplay(normalized('unknown'), readState, formatNumber)).toMatchObject({
      label: 'Unknown',
    });
    expect(numericDisplay(normalized(undefined), readState, formatNumber)).toMatchObject({
      label: 'Not found',
    });
  });
});

describe('textDisplay', () => {
  it('renders text, and an empty or missing value as "No data"', () => {
    expect(textDisplay(normalized('Washing'), readState)).toEqual({
      kind: 'value',
      text: 'Washing',
      stale: false,
    });
    expect(textDisplay(normalized('Washing'), () => undefined)).toMatchObject({ reason: 'no-data' });
    expect(textDisplay(normalized('Washing'), () => '')).toMatchObject({ reason: 'no-data' });
  });
});

describe('parseNumericValue', () => {
  it('accepts finite numbers and plain decimal strings only', () => {
    expect(parseNumericValue(4)).toBe(4);
    expect(parseNumericValue('-4.25')).toBe(-4.25);
    expect(parseNumericValue(' 4')).toBeNull();
    expect(parseNumericValue(true)).toBeNull();
    expect(parseNumericValue({})).toBeNull();
  });
});
