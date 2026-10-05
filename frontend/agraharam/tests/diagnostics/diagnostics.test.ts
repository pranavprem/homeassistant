import { describe, expect, it } from 'vitest';
import '../../src/components/diagnostics/agr-diagnostics-drawer.ts';
import type { AgrDiagnosticsDrawer } from '../../src/components/diagnostics/agr-diagnostics-drawer.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { ConfigIssue } from '../../src/config/validate.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import type { ActionStatus } from '../../src/ha/actions/types.ts';
import type { StoreView } from '../../src/ha/entity-store.ts';
import type { HostReader } from '../../src/ha/host.ts';
import { createStatusBoard } from '../../src/ha/status-board.ts';
import { diagnosticsEntityIds, selectDiagnostics } from '../../src/model/diagnostics.ts';
import { deepQuery, settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, fakeStore, testEntity } from '../helpers/fake-store.ts';
import { FakeHass, mountCard } from '../helpers/mount.ts';
import { configFrom } from '../helpers/services.ts';
import { headerConfig, MEERA, mountInContainer, shadowText, testInput, testServices } from '../header/support.ts';

const FAN = 'fan.demo_purifier';
const LIGHT = 'light.demo_lamp';
const VACUUM = 'vacuum.demo_pebble';
const BATTERY = 'sensor.demo_pebble_battery';
const CAMERA = 'camera.demo_front_gate';
const PRIVACY = 'switch.demo_front_gate_privacy';
const PEBBLE_DEVICE = 'device-pebble';

const config = configFrom({
  diagnostics: true,
  controls: true,
  people: [MEERA],
  air: [FAN],
  rooms: [{ name: 'Courtyard', lights: [LIGHT] }],
  vacuums: [{ entity: VACUUM }],
  cameras: [{ entity: CAMERA, name: 'Front gate', privacy_entity: PRIVACY }],
});

const WARNING: ConfigIssue = {
  path: 'controls',
  code: 'ignored-in-demo',
  message: 'controls is ignored in demo mode.',
};

function store(privacy = 'off'): StoreView {
  const base = fakeStore([
    testEntity(MEERA, 'home'),
    testEntity(FAN, 'on', { supported_features: 57 }),
    testEntity(LIGHT, 'off', { supported_color_modes: ['brightness'] }),
    testEntity(VACUUM, 'docked', { supported_features: 8212 }),
    testEntity(BATTERY, '82', { device_class: 'battery' }),
    testEntity(CAMERA, 'idle'),
    testEntity(PRIVACY, privacy),
  ]);
  return { ...base, isDerived: (id) => id === BATTERY };
}

function input(overrides: { admin?: boolean; privacy?: string; diagnostics?: boolean } = {}) {
  const cfg = overrides.diagnostics === false ? configFrom({ people: [MEERA] }) : config;
  const status = createStatusBoard();
  status.set('forecast', 'hourly live');
  status.set('live-view', 'fallback (helpers-failed)');
  status.set('bundle', 'version-conflict ignored 0.0.9');
  const base = testInput(cfg, store(overrides.privacy), {
    admin: overrides.admin ?? true,
    connection: () => ({ phase: 'connected', haState: 'RUNNING', haVersion: '2026.9.2' }),
  });
  const onPebble = [entityId(VACUUM), entityId(BATTERY)];
  const reader: HostReader = {
    ...base.reader,
    registry: (id) => (onPebble.includes(id) ? { entity_id: id, device_id: PEBBLE_DEVICE } : undefined),
    entitiesOnDevice: (device) => (device === PEBBLE_DEVICE ? onPebble : []),
  };
  return { ...base, reader, status, warnings: [WARNING], version: '0.1.0', gitSha: 'abc123def456' };
}

describe('selectDiagnostics (§4.8)', () => {
  it('is unavailable, and carries no entity-bearing lists, for non-admins or with diagnostics off', () => {
    for (const vm of [selectDiagnostics(input({ admin: false })), selectDiagnostics(input({ diagnostics: false }))]) {
      expect(vm.available).toBe(false);
      expect(vm.bindings).toEqual([]);
      expect(vm.cameras).toEqual([]);
      expect(vm.configWarnings).toEqual([]);
      expect(JSON.stringify(vm)).not.toContain('demo_');
    }
  });

  it('reads the build, HA version, controls and controller status lines', () => {
    const vm = selectDiagnostics(input());
    expect(vm).toMatchObject({
      available: true,
      version: '0.1.0',
      gitSha: 'abc123def456',
      hostKind: 'hass',
      haVersion: '2026.9.2',
      controls: true,
      forecast: 'hourly live',
      liveView: 'fallback',
      liveViewDetail: 'fallback (helpers-failed)',
      bundle: 'version-conflict ignored 0.0.9',
      configWarnings: [WARNING],
    });
  });

  it('never reads HA config beyond the version (no time zone, units or location fields)', () => {
    const keys = Object.keys(selectDiagnostics(input()));
    for (const banned of ['time_zone', 'unit_system', 'latitude', 'longitude', 'location_name', 'config']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('lists every configured binding with status and named capabilities, and derived batteries as derived', () => {
    const vm = selectDiagnostics(input());
    expect(vm.bindings).toEqual(
      expect.arrayContaining([
        { role: 'person', entity: MEERA, status: 'available', derived: false },
        {
          role: 'air',
          entity: FAN,
          status: 'available',
          derived: false,
          features: '57 (SET_SPEED, PRESET_MODE, TURN_OFF, TURN_ON)',
        },
        { role: 'room_light', entity: LIGHT, status: 'available', derived: false, features: 'color modes brightness' },
        {
          role: 'vacuum',
          entity: VACUUM,
          status: 'available',
          derived: false,
          features: '8212 (PAUSE, RETURN_HOME, START)',
        },
        { role: 'vacuum_battery', entity: BATTERY, status: 'available', derived: true },
      ]),
    );
  });

  it.each([
    ['off', 'allowed'],
    ['on', 'closed: Privacy on'],
    ['On', 'closed: Privacy status unavailable'],
    ['unavailable', 'closed: Privacy status unavailable'],
  ])('reports the shared camera gate for a privacy entity reading %j as %j', (privacy, summary) => {
    expect(selectDiagnostics(input({ privacy })).cameras).toEqual([{ name: 'Front gate', gate: summary }]);
  });

  it('reports the gate as closed while the reader phase is not connected, exactly as the camera tiles do', () => {
    const base = input();
    const reader: HostReader = { ...base.reader, connection: () => ({ phase: 'disconnected' }) };
    expect(selectDiagnostics({ ...base, reader }).cameras).toEqual([
      { name: 'Front gate', gate: 'closed: Paused while disconnected' },
    ]);
  });

  it('names a camera with no privacy entity and thumbnails off', () => {
    const bare = configFrom({
      diagnostics: true,
      cameras: [{ entity: CAMERA, name: 'Front gate', thumbnails: false }],
    });
    const vm = selectDiagnostics({ ...input(), config: bare });
    expect(vm.cameras).toEqual([{ name: 'Front gate', gate: 'allowed, no privacy entity, thumbnails off' }]);
  });

  it('subscribes to the configured bindings and the derived batteries, once each', () => {
    const base = input();
    const ids = diagnosticsEntityIds(config, base.reader, base.store);
    expect(ids).toEqual(expect.arrayContaining([MEERA, FAN, LIGHT, VACUUM, CAMERA, PRIVACY, BATTERY]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps gateway.recent() to kind, phase, code and duration', () => {
    const base = input();
    const recent: ActionStatus[] = [
      {
        id: 2,
        key: `entity:${FAN}`,
        kind: 'fan.turn_off',
        phase: 'uncertain',
        startedAt: 100,
        settledAt: 20_100,
        error: { code: 'timeout', message: 'x' },
      },
      { id: 1, key: `entity:${LIGHT}`, kind: 'light.turn_on', phase: 'confirmed', startedAt: 10, settledAt: 350.4 },
    ];
    const gateway = Object.assign(new FakeGateway(), { recent: () => recent });
    expect(selectDiagnostics({ ...base, gateway }).recentActions).toEqual([
      { kind: 'fan.turn_off', phase: 'uncertain', code: 'timeout', ms: 20_000 },
      { kind: 'light.turn_on', phase: 'confirmed', ms: 340 },
    ]);
  });
});

describe('agr-diagnostics-drawer (§5.3)', () => {
  async function mountDrawer(services: DashboardServices) {
    const drawer = document.createElement('agr-diagnostics-drawer') as AgrDiagnosticsDrawer;
    drawer.services = services;
    drawer.request = { id: 'diagnostics' };
    mountInContainer(drawer);
    await settle();
    return drawer;
  }

  function servicesFor(admin: boolean) {
    const services = testServices(headerConfig({ controls: false }), fakeStore([testEntity(MEERA, 'home')]), { admin });
    return { ...services, warnings: [WARNING] };
  }

  it('shows only the access note to non-admins: no entity IDs', async () => {
    const drawer = await mountDrawer(servicesFor(false));
    const text = shadowText(drawer);
    expect(text).toContain('Diagnostics are shown to Home Assistant administrators');
    expect(text).not.toContain('demo_');
    expect(text).not.toContain('ignored-in-demo');
  });

  it('shows controls on or off, config warnings and the bindings to admins', async () => {
    const drawer = await mountDrawer(servicesFor(true));
    const text = shadowText(drawer);
    expect(text).toContain('Controls Off (controls: false)');
    expect(text).toContain('ignored-in-demo');
    expect(text).toContain('controls is ignored in demo mode.');
    expect(text).toContain(MEERA);
  });

  it('follows the status board and gateway tickets while open', async () => {
    const services = servicesFor(true);
    const drawer = await mountDrawer(services);
    // Status values read in sentence case like every other value in the drawer.
    expect(shadowText(drawer)).toContain('Forecast Not started');
    services.status.set('forecast', 'daily fallback');
    services.status.set('bundle', 'version-conflict ignored 0.0.9');
    await settle();
    expect(shadowText(drawer)).toContain('Forecast Daily fallback');
    expect(shadowText(drawer)).toContain('version-conflict ignored 0.0.9');

    const recent: ActionStatus[] = [];
    services.gateway.recent = () => recent;
    recent.push({
      id: 1,
      key: 'garage',
      kind: 'garage.open',
      phase: 'failed',
      startedAt: 0,
      settledAt: 5,
      error: { code: 'rejected', message: 'x' },
    });
    services.gateway.request({ kind: 'garage.open' });
    await settle();
    expect(shadowText(drawer)).toContain('garage.open Failed, rejected, 5 ms');
  });

  it('stops listening when it closes', async () => {
    const base = servicesFor(true);
    let listeners = 0;
    const status = {
      ...base.status,
      subscribe(listener: () => void) {
        listeners += 1;
        const unsubscribe = base.status.subscribe(listener);
        return () => {
          listeners -= 1;
          unsubscribe();
        };
      },
    };
    const drawer = await mountDrawer({ ...base, status });
    expect(listeners).toBe(1);
    drawer.remove();
    expect(listeners).toBe(0);
  });
});

describe('diagnostics in the live card (FakeHass, real HassHost)', () => {
  it('opens from the header for an admin and never renders HA config such as the time zone', async () => {
    const fake = new FakeHass('normal');
    const { root, stopPushes } = await mountCard({ config: { ...demoCardInput('normal'), diagnostics: true }, fake });
    const header = root.querySelector('agr-header') as HTMLElement;
    expect(shadowText(header)).not.toContain('demo_');
    const diagnostics = header.shadowRoot?.querySelector('.diagnostics') as HTMLElement;
    diagnostics.shadowRoot?.querySelector('button')?.click();
    await settle();
    const drawer = deepQuery(root, 'agr-diagnostics-drawer') as HTMLElement;
    const text = shadowText(drawer);
    expect(text).toContain('Home Assistant version 2026.9.2');
    expect(text).toContain('person.demo_meera');
    expect(text).not.toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(text).not.toContain('unit_system');
    stopPushes();
  });
});
