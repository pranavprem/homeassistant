/**
 * The camera session probe (§4.4, §9.3): until one still has loaded in the current session, one request at a time,
 * so a broken session costs one counted 401. A session is a socket generation and a user.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '../../src/config/schema.ts';
import type { CameraSnapshotRequest, HostReader } from '../../src/ha/host.ts';
import { snapshotSourceFor } from '../../src/ha/snapshot-controller.ts';
import { ManualStore } from '../today/controller-host.ts';
import { fakeReader } from '../helpers/services.ts';

const CAMERA = 'camera.demo_front_gate' as EntityId;

function rig() {
  const manual = new ManualStore([], []);
  const pending: { resolve(blob: Blob): void }[] = [];
  let generation = 1;
  const reader: HostReader = {
    ...fakeReader(manual.view),
    connectionGeneration: () => generation,
    fetchCameraSnapshot: () =>
      new Promise<Blob>((resolve) => {
        pending.push({ resolve });
      }),
  };
  const source = snapshotSourceFor(reader);
  const request = (): CameraSnapshotRequest => ({ width: 320, height: 240, signal: new AbortController().signal });
  return {
    manual,
    pending,
    fetch: () => source.fetch(CAMERA, request()).catch(() => undefined),
    reconnect: () => {
      generation += 1;
    },
    async loadNext() {
      pending.shift()?.resolve(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    },
  };
}

describe('camera session probe', () => {
  it('serializes until a still loads, then fetches concurrently', async () => {
    const t = rig();
    void t.fetch();
    void t.fetch();
    expect(t.pending).toHaveLength(1);
    await t.loadNext();
    expect(t.pending).toHaveLength(1); // the waiting request went out after the proof
    void t.fetch();
    void t.fetch();
    expect(t.pending).toHaveLength(3);
  });

  it('a user change starts a new probe, as a reconnect does', async () => {
    const t = rig();
    void t.fetch();
    await t.loadNext();
    t.manual.touchUser();
    void t.fetch();
    void t.fetch();
    expect(t.pending).toHaveLength(1);
    await t.loadNext();
    t.reconnect();
    void t.fetch();
    void t.fetch();
    expect(t.pending).toHaveLength(2); // the one still waiting from before, plus the new probe
  });
});
