import { describe, expect, it } from 'vitest';
import { hostErrorFromFetchFailure, hostErrorFromStatus, hostErrorFromWs, isHostError } from '../../src/ha/errors.ts';

describe('HostError mapping (§4.4)', () => {
  it.each([
    [401, 'permission-denied'],
    [403, 'permission-denied'],
    [404, 'not-found'],
    [503, 'unavailable'],
    [400, 'bad-response'],
    [500, 'network'],
  ])('HTTP %i → %s, keeping the status', (status, code) => {
    expect(hostErrorFromStatus(status)).toEqual({ code, status });
  });

  it('maps fetch failures: abort, network and already-mapped errors', () => {
    expect(hostErrorFromFetchFailure(new DOMException('Aborted', 'AbortError'))).toEqual({ code: 'aborted' });
    expect(hostErrorFromFetchFailure(new TypeError('Failed to fetch'))).toEqual({ code: 'network' });
    expect(hostErrorFromFetchFailure({ code: 'not-found', status: 404 })).toEqual({ code: 'not-found', status: 404 });
    expect(hostErrorFromFetchFailure('weird')).toEqual({ code: 'unknown' });
  });

  it('maps WebSocket rejections, never keeping HA messages', () => {
    expect(hostErrorFromWs(3)).toEqual({ code: 'disconnected' });
    expect(hostErrorFromWs({ code: 'forecast_not_supported', message: 'raw HA text' })).toEqual({
      code: 'unsupported',
      haCode: 'forecast_not_supported',
    });
    expect(hostErrorFromWs({ code: 'invalid_entity_id', message: 'x' })).toEqual({
      code: 'unknown',
      haCode: 'invalid_entity_id',
    });
    expect(hostErrorFromWs(new Error('boom'))).toEqual({ code: 'unknown' });
  });

  it('recognizes HostErrors by their code', () => {
    expect(isHostError({ code: 'aborted' })).toBe(true);
    expect(isHostError({ code: 'not_a_code' })).toBe(false);
    expect(isHostError(null)).toBe(false);
  });
});
