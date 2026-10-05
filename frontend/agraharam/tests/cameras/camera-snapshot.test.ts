/**
 * fetchSnapshot (§4.4): the session's own fetchWithAuth, an encoded path, a no-store read, and HostError codes only
 * (never a URL or message) for every failure.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import { fetchSnapshot } from '../../src/ha/hass/camera.ts';
import type { HassLike } from '../../src/ha/types.ts';

const CAMERA = 'camera.demo_front_gate' as EntityId;

function hassWith(fetchWithAuth: HassLike['fetchWithAuth']): HassLike {
  return { fetchWithAuth } as unknown as HassLike;
}

function imageResponse(type = 'image/jpeg', status = 200): Response {
  return new Response(new Blob(['pixels'], { type }), { status, headers: { 'content-type': type } });
}

function request(signal = new AbortController().signal) {
  return { width: 320.4, height: 240, signal };
}

describe('fetchSnapshot (§4.4)', () => {
  it('GETs the camera proxy with an encoded id, rounded size, the caller signal and no-store', async () => {
    const fetchWithAuth = vi.fn(() => Promise.resolve(imageResponse()));
    const controller = new AbortController();
    const blob = await fetchSnapshot(hassWith(fetchWithAuth), CAMERA, request(controller.signal));
    expect(blob.type).toBe('image/jpeg');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/camera_proxy/camera.demo_front_gate?width=320&height=240', {
      signal: controller.signal,
      cache: 'no-store',
    });
  });

  it('encodes characters that could change the path or query', async () => {
    const fetchWithAuth = vi.fn(() => Promise.resolve(imageResponse()));
    await fetchSnapshot(hassWith(fetchWithAuth), 'camera.demo_a?b=c/../d#e' as EntityId, request());
    const firstCall = fetchWithAuth.mock.calls[0] as unknown as [string];
    expect(firstCall[0]).toBe('/api/camera_proxy/camera.demo_a%3Fb%3Dc%2F..%2Fd%23e?width=320&height=240');
  });

  it.each([
    [401, { code: 'permission-denied', status: 401 }],
    [403, { code: 'permission-denied', status: 403 }],
    [404, { code: 'not-found', status: 404 }],
    [503, { code: 'unavailable', status: 503 }],
    [500, { code: 'network', status: 500 }],
    [400, { code: 'bad-response', status: 400 }],
  ])('maps HTTP %i to a HostError', async (status, expected) => {
    const fetchWithAuth = vi.fn(() => Promise.resolve(new Response('denied', { status })));
    await expect(fetchSnapshot(hassWith(fetchWithAuth), CAMERA, request())).rejects.toEqual(expected);
  });

  it('rejects a body that is not an image as bad-response', async () => {
    const fetchWithAuth = vi.fn(() => Promise.resolve(imageResponse('text/html')));
    await expect(fetchSnapshot(hassWith(fetchWithAuth), CAMERA, request())).rejects.toEqual({ code: 'bad-response' });
  });

  it('maps an abort to aborted and a network failure to network, never leaking the error object', async () => {
    const aborted = vi.fn(() => Promise.reject(new DOMException('The user aborted', 'AbortError')));
    await expect(fetchSnapshot(hassWith(aborted), CAMERA, request())).rejects.toEqual({ code: 'aborted' });
    const offline = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(fetchSnapshot(hassWith(offline), CAMERA, request())).rejects.toEqual({ code: 'network' });
  });

  it('turns a synchronous throw into a rejection', async () => {
    const throwing = vi.fn(() => {
      throw new TypeError('boom');
    });
    await expect(fetchSnapshot(hassWith(throwing), CAMERA, request())).rejects.toEqual({ code: 'network' });
  });
});
