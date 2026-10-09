/** DashboardServices over a fake store, reader and gateway, for section-level component tests. */
import type { DashboardServices } from '../../src/components/services.ts';
import type { ResolvedConfig } from '../../src/config/schema.ts';
import { validateConfig } from '../../src/config/validate.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import type { ConnectionPhase, HostReader } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import { createFormatter } from '../../src/ha/format.ts';
import { fakeStore } from './fake-store.ts';
import { FakeGateway } from './fake-gateway.ts';

export interface FakeServicesOptions {
  readonly config?: ResolvedConfig;
  readonly store?: StoreView;
  readonly gateway?: FakeGateway;
  /** Read live by reader.connection(), so a test can change it between steps. */
  readonly phase?: () => ConnectionPhase;
  readonly mode?: DashboardServices['mode'];
  readonly theme?: DashboardServices['theme'];
}

export function configFrom(input: Record<string, unknown>): ResolvedConfig {
  const result = validateConfig({ type: 'custom:agraharam-dashboard', ...input });
  if (!result.ok) throw new Error(`test config invalid: ${JSON.stringify(result.issues)}`);
  return result.config;
}

export function fakeReader(store: StoreView, phase: () => ConnectionPhase = () => 'connected'): HostReader {
  return {
    kind: 'hass',
    store,
    connection: () => ({ phase: phase() }),
    connectionGeneration: () => 1,
    registry: () => undefined,
    // HA's entity registry has arrived (§18 registry-pending gate); tests of the gate override this.
    registryLoaded: () => true,
    entitiesOnDevice: () => [],
    hasService: () => true,
    formatter: () => createFormatter({ temperatureUnit: '°F' }),
    isDarkMode: () => false,
    isAdmin: () => true,
    subscribeForecast: () => () => undefined,
    fetchCameraSnapshot: () => Promise.reject({ code: 'unsupported' }),
    openLiveStream: () => Promise.resolve({ kind: 'unsupported', reason: 'no-helpers' }),
    fetchCalendarEvents: () => Promise.reject({ code: 'unsupported' }),
  };
}

export function fakeServices(options: FakeServicesOptions = {}): DashboardServices & { gateway: FakeGateway } {
  const store = options.store ?? fakeStore([]);
  const gateway = options.gateway ?? new FakeGateway();
  return {
    config: options.config ?? configFrom({}),
    reader: fakeReader(store, options.phase),
    store,
    gateway,
    status: createStatusBoard(),
    warnings: [],
    mode: options.mode ?? 'live',
    preview: false,
    theme: options.theme ?? 'light',
  };
}
