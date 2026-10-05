/**
 * Shared fixtures for the camera suites: a controllable SnapshotSource, tile view models, and DashboardServices
 * over a REAL HassHost driven by FakeHass (so the resync barrier, the live-socket guard and the camera session
 * denial are the production ones).
 */
import { vi } from 'vitest';
import type { DashboardServices } from '../../src/components/services.ts';
import type { CardConfigInput, EntityId } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { FakeHass } from '../../src/dev/fake-hass.ts';
import { HassHost } from '../../src/ha/hass-host.ts';
import type { CameraSnapshotRequest, HostError } from '../../src/ha/host.ts';
import type { SnapshotSource } from '../../src/ha/snapshot-controller.ts';
import type { CameraGate } from '../../src/ha/camera-gate.ts';
import type { CameraTileVM } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';

export const FRONT_GATE = 'camera.demo_front_gate' as EntityId;
export const SIDE_PATH = 'camera.demo_side_path' as EntityId;
export const HALL = 'camera.demo_hall' as EntityId;
export const HALL_PRIVACY = 'switch.demo_hall_camera_privacy' as EntityId;

interface PendingFetch {
  readonly id: EntityId;
  readonly request: CameraSnapshotRequest;
  resolve(blob: Blob): void;
  reject(error: HostError): void;
}

/** A SnapshotSource whose fetches the test settles by hand. */
export class FakeSnapshotSource implements SnapshotSource {
  readonly pending: PendingFetch[] = [];
  readonly calls: { readonly id: EntityId; readonly request: CameraSnapshotRequest }[] = [];
  currentGeneration = 1;
  readonly #userListeners = new Set<() => void>();

  fetch(id: EntityId, request: CameraSnapshotRequest): Promise<Blob> {
    this.calls.push({ id, request });
    return new Promise<Blob>((resolve, reject) => {
      const entry: PendingFetch = { id, request, resolve, reject };
      this.pending.push(entry);
      request.signal.addEventListener('abort', () => reject({ code: 'aborted' }), { once: true });
    });
  }

  generation(): number {
    return this.currentGeneration;
  }

  onUserChange(listener: () => void): () => void {
    this.#userListeners.add(listener);
    return () => this.#userListeners.delete(listener);
  }

  changeUser(): void {
    for (const listener of [...this.#userListeners]) listener();
  }

  get userListenerCount(): number {
    return this.#userListeners.size;
  }

  /** Settles the oldest unsettled fetch with an image. */
  resolveNext(): PendingFetch {
    const entry = this.#take();
    entry.resolve(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    return entry;
  }

  rejectNext(error: HostError): PendingFetch {
    const entry = this.#take();
    entry.reject(error);
    return entry;
  }

  #take(): PendingFetch {
    const entry = this.pending.shift();
    if (entry === undefined) throw new Error('no pending snapshot fetch');
    return entry;
  }
}

export function tileVm(overrides: Partial<CameraTileVM> = {}): CameraTileVM {
  return {
    key: FRONT_GATE,
    name: 'Front gate',
    binding: `${FRONT_GATE}||`,
    gate: { kind: 'allowed' },
    thumbnails: true,
    intervalMs: 10_000,
    live: { enabled: true, confirm: false },
    ...overrides,
  };
}

export function closedGate(kind: 'offline' | 'missing' | 'disconnected', label: string): CameraGate {
  return { kind, label };
}

export function createdUrls(): string[] {
  return vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value as string);
}

export function revokedUrls(): string[] {
  return vi.mocked(URL.revokeObjectURL).mock.calls.map((call) => call[0]);
}

/** URLs created and not yet revoked. */
export function liveUrls(): string[] {
  const revoked = new Set(revokedUrls());
  return createdUrls().filter((url) => !revoked.has(url));
}

export interface HassRuntime {
  readonly fake: FakeHass;
  readonly host: HassHost;
  readonly services: DashboardServices;
  readonly gateway: FakeGateway;
  stop(): void;
}

/** DashboardServices over a real HassHost that receives every FakeHass push, as the root wires it. */
export function hassRuntime(
  fake: FakeHass,
  input: CardConfigInput = demoCardInput('normal'),
  overrides: Partial<DashboardServices> = {},
): HassRuntime {
  const result = validateConfig(input);
  if (!result.ok) throw new Error(`invalid test config: ${JSON.stringify(result.issues)}`);
  const host = new HassHost(result.config.bindings.keys());
  host.update(fake.hass);
  const stop = fake.onPush((hass) => host.update(hass));
  const gateway = new FakeGateway();
  const services: DashboardServices = {
    config: result.config,
    reader: host.reader,
    store: host.reader.store,
    gateway,
    status: host.status,
    warnings: [],
    mode: 'live',
    preview: false,
    theme: 'light',
    ...overrides,
  };
  return { fake, host, services, gateway, stop };
}

export function fetchWithAuthCalls(fake: FakeHass): string[] {
  return fake.calls.filter((call) => call.method === 'fetchWithAuth').map((call) => String(call.args[0]));
}

export { FakeHass };
