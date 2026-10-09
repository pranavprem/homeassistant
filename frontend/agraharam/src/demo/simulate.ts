/**
 * Service-call simulation shared by DemoHost and FakeHass (§10.2): the timed state transitions every §7.1 service
 * produces, and the device simulator that applies them after a simulated latency, so the browser preview and the
 * unit tests can never disagree. Nothing here touches the network.
 *
 * Dev-boundary note (§10.3): FakeHass imports this file, so it imports only types and src/config.
 */
import type { EntityId } from '../config/schema.ts';
import type { ServiceCall } from '../ha/host.ts';
import type { HassEntityLike } from '../ha/types.ts';
import type { DemoBehavior } from './fixture-types.ts';

interface SimulatedStep {
  readonly atMs: number;
  readonly state: HassEntityLike;
}

type Simulator = (entity: HassEntityLike, data: Readonly<Record<string, unknown>>, now: number) => SimulatedStep[];

/** Delays in ms after the call is applied; long enough to see "Sending" and motion states in the preview. */
const DELAY = Object.freeze({
  quick: 300,
  settle: 600,
  coverTravel: 5_000,
  scriptRun: 200,
  scriptEnd: 1_500,
  dockReturn: 8_000,
});
const HA_BRIGHTNESS_MAX = 255;
const PERCENT_TO_BRIGHTNESS = HA_BRIGHTNESS_MAX / 100;
const VOLUME_STEP = 100; // volume_level is rounded to 0.01
/** A fictional playlist for next and previous track. */
const DEMO_TRACKS = ['Evening raga', 'Monsoon theme', 'Morning raga', 'Courtyard rain', 'Lantern song'] as const;

const HVAC_ACTION_FOR_MODE: Readonly<Record<string, string>> = Object.freeze({
  off: 'off',
  cool: 'cooling',
  heat: 'heating',
  dry: 'drying',
  fan_only: 'fan',
});

/** The context id a simulated call resolves with; scripts carry it, so context matching works in demo mode. */
export function demoContextId(now: number): string {
  return `demo-call-${now}`;
}

const SIMULATORS = {
  'light.turn_on': (entity, data, now) => {
    const pct = typeof data['brightness_pct'] === 'number' ? data['brightness_pct'] : undefined;
    const current = entity.attributes['brightness'];
    const brightness =
      pct !== undefined
        ? Math.round(pct * PERCENT_TO_BRIGHTNESS)
        : typeof current === 'number'
          ? current
          : HA_BRIGHTNESS_MAX;
    return [step(entity, now + DELAY.quick, 'on', { brightness, color_mode: 'brightness' })];
  },
  'light.turn_off': (entity, _data, now) => [
    step(entity, now + DELAY.quick, 'off', { brightness: null, color_mode: null }),
  ],
  // Room lighting switches (§18). HA stamps a state change caused by a call with that call's context.
  'switch.turn_on': (entity, _data, now) => [step(entity, now + DELAY.quick, 'on', {}, callContext(now))],
  'switch.turn_off': (entity, _data, now) => [step(entity, now + DELAY.quick, 'off', {}, callContext(now))],
  'climate.set_temperature': (entity, data, now) => [
    step(entity, now + DELAY.settle, entity.state, { temperature: data['temperature'] }),
  ],
  'climate.set_hvac_mode': (entity, data, now) => {
    const mode = String(data['hvac_mode']);
    return [step(entity, now + DELAY.settle, mode, { hvac_action: HVAC_ACTION_FOR_MODE[mode] ?? 'idle' })];
  },
  'fan.turn_on': (entity, _data, now) => [step(entity, now + DELAY.quick, 'on')],
  'fan.turn_off': (entity, _data, now) => [step(entity, now + DELAY.quick, 'off')],
  'fan.set_percentage': (entity, data, now) => [
    step(entity, now + DELAY.quick, 'on', { percentage: data['percentage'] }),
  ],
  'fan.set_preset_mode': (entity, data, now) => [
    step(entity, now + DELAY.quick, entity.state, { preset_mode: data['preset_mode'] }),
  ],
  'vacuum.start': (entity, _data, now) => [step(entity, now + DELAY.settle, 'cleaning')],
  'vacuum.pause': (entity, _data, now) => [step(entity, now + DELAY.settle, 'paused')],
  'vacuum.return_to_base': (entity, _data, now) =>
    chain(entity, [
      [now + DELAY.settle, 'returning'],
      [now + DELAY.dockReturn, 'docked'],
    ]),
  'cover.open_cover': (entity, _data, now) =>
    chain(entity, [
      [now + DELAY.settle, 'opening'],
      [now + DELAY.coverTravel, 'open', { current_position: 100 }],
    ]),
  'cover.close_cover': (entity, _data, now) =>
    chain(entity, [
      [now + DELAY.settle, 'closing'],
      [now + DELAY.coverTravel, 'closed', { current_position: 0 }],
    ]),
  'media_player.media_play': (entity, _data, now) => [step(entity, now + DELAY.quick, 'playing')],
  'media_player.media_pause': (entity, _data, now) => [step(entity, now + DELAY.quick, 'paused')],
  'media_player.media_next_track': (entity, _data, now) => [
    step(entity, now + DELAY.quick, entity.state, { media_title: adjacentTrack(entity, 1) }),
  ],
  'media_player.media_previous_track': (entity, _data, now) => [
    step(entity, now + DELAY.quick, entity.state, { media_title: adjacentTrack(entity, -1) }),
  ],
  'media_player.volume_set': (entity, data, now) => [
    step(entity, now + DELAY.quick, entity.state, {
      volume_level: Math.round(Number(data['volume_level']) * VOLUME_STEP) / VOLUME_STEP,
    }),
  ],
  'media_player.volume_mute': (entity, data, now) => [
    step(entity, now + DELAY.quick, entity.state, { is_volume_muted: data['is_volume_muted'] === true }),
  ],
  'media_player.select_source': (entity, data, now) => [
    step(entity, now + DELAY.quick, entity.state, { source: data['source'] }),
  ],
  'script.turn_on': (entity, _data, now) => {
    const running = step(
      entity,
      now + DELAY.scriptRun,
      'on',
      { last_triggered: iso(now + DELAY.scriptRun) },
      callContext(now),
    );
    return [running, step(running.state, now + DELAY.scriptEnd, 'off')];
  },
} as const satisfies Readonly<Record<string, Simulator>>;

type SimulatedService = keyof typeof SIMULATORS;

/** Every §7.1 service, as 'domain.service'. Demo and fake hosts offer exactly these in hass.services. */
export const SIMULATED_SERVICES: readonly SimulatedService[] = Object.freeze(
  Object.keys(SIMULATORS) as SimulatedService[],
);

/** Timed state transitions for `call`; an unknown service or a missing target produces none. */
export function simulateServiceCall(
  call: ServiceCall,
  states: ReadonlyMap<EntityId, HassEntityLike>,
  now: number,
): readonly { atMs: number; state: HassEntityLike }[] {
  const key = `${call.domain}.${call.service}`;
  const simulator: Simulator | undefined = isSimulatedService(key) ? SIMULATORS[key] : undefined;
  if (simulator === undefined) return [];
  const targets = typeof call.target.entity_id === 'string' ? [call.target.entity_id] : [...call.target.entity_id];
  return targets.flatMap((id) => {
    const entity = states.get(id);
    return entity === undefined ? [] : simulator(entity, call.data, now);
  });
}

/** hass.services shape for every simulated service, minus a scenario's missing ones ('starting', §10.2). */
export function simulatedServiceRegistry(
  missing: readonly string[],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const services: Record<string, Record<string, unknown>> = {};
  for (const name of SIMULATED_SERVICES) {
    if (missing.includes(name)) continue;
    const [domain = '', service = ''] = name.split('.');
    services[domain] = { ...services[domain], [service]: {} };
  }
  return Object.freeze(services);
}

function isSimulatedService(key: string): key is SimulatedService {
  return Object.hasOwn(SIMULATORS, key);
}

/** The context of the simulated call made at `now`, as HA puts it on the states that call changes. */
function callContext(now: number): HassEntityLike['context'] {
  return { id: demoContextId(now), parent_id: null, user_id: null };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A new state object, as HA delivers: last_changed moves only when the state string changes. */
function step(
  entity: HassEntityLike,
  atMs: number,
  state: string,
  attributes: Readonly<Record<string, unknown>> = {},
  context: HassEntityLike['context'] = entity.context,
): SimulatedStep {
  const at = iso(atMs);
  return {
    atMs,
    state: Object.freeze({
      ...entity,
      state,
      attributes: Object.freeze({ ...entity.attributes, ...attributes }),
      last_changed: state === entity.state ? entity.last_changed : at,
      last_updated: at,
      context,
    }),
  };
}

/** Multi-step transitions; each step starts from the previous one's state. */
function chain(
  entity: HassEntityLike,
  steps: readonly (readonly [atMs: number, state: string, attributes?: Readonly<Record<string, unknown>>])[],
): SimulatedStep[] {
  const result: SimulatedStep[] = [];
  let current = entity;
  for (const [atMs, state, attributes] of steps) {
    const next = step(current, atMs, state, attributes);
    result.push(next);
    current = next.state;
  }
  return result;
}

function adjacentTrack(entity: HassEntityLike, direction: 1 | -1): string {
  const index = DEMO_TRACKS.findIndex((title) => title === entity.attributes['media_title']);
  const next = (index + direction + DEMO_TRACKS.length) % DEMO_TRACKS.length;
  return DEMO_TRACKS[index === -1 ? 0 : next] ?? DEMO_TRACKS[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Device simulator shared by DemoHost and FakeHass

/** HA-shaped rejections, so the real gateway's error mapping runs against them (§4.7). */
export const SIMULATED_REJECTIONS = Object.freeze({
  validation: Object.freeze({
    code: 'service_validation_error',
    message: 'The demo device rejected this request.',
  }),
  unauthorized: Object.freeze({ code: 'unauthorized', message: 'Unauthorized' }),
  /** home-assistant-js-websocket's ERR_CONNECTION_LOST. */
  connectionLost: 3,
});

interface ScenarioDevicesOptions {
  readonly states: readonly HassEntityLike[];
  readonly behaviors: ReadonlyMap<EntityId, DemoBehavior>;
  readonly defaultInvoke?: DemoBehavior['onInvoke'];
  /** Uniform latency range in ms for a call to be applied (§10.1: 400–1200). */
  readonly latencyMs: readonly [number, number];
  readonly random: () => number;
  readonly now: () => number;
  /** Receives the new states map (a new object on every change, as hass.states is). */
  readonly onChange: (states: Readonly<Record<string, HassEntityLike>>) => void;
}

/** In-memory devices: applies simulated calls after a latency and per-entity behaviors. */
export class ScenarioDevices {
  readonly #options: ScenarioDevicesOptions;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #states: Readonly<Record<string, HassEntityLike>>;

  constructor(options: ScenarioDevicesOptions) {
    this.#options = options;
    this.#states = Object.freeze(Object.fromEntries(options.states.map((state) => [state.entity_id, state])));
  }

  get states(): Readonly<Record<string, HassEntityLike>> {
    return this.#states;
  }

  /** Resolves like hass.callService, or rejects with an HA-shaped error per the target's behavior. */
  invoke(call: ServiceCall): Promise<{ readonly contextId: string }> {
    const behavior = this.#behaviorFor(call);
    return new Promise((resolve, reject) => {
      this.#after(this.#latency(), () => {
        const now = this.#options.now();
        if (behavior === 'reject-validation') reject(SIMULATED_REJECTIONS.validation);
        else if (behavior === 'reject-unauthorized') reject(SIMULATED_REJECTIONS.unauthorized);
        else if (behavior === 'connection-lost') reject(SIMULATED_REJECTIONS.connectionLost);
        else {
          if (behavior !== 'never-confirm') this.#apply(call, now);
          resolve({ contextId: demoContextId(now) });
        }
      });
    });
  }

  /** Replaces one entity with a new object and publishes a new states map. */
  put(entity: HassEntityLike): void {
    this.#states = Object.freeze({ ...this.#states, [entity.entity_id]: entity });
    this.#options.onChange(this.#states);
  }

  /** Replaces the whole map (FakeHass's reconnect snapshot). */
  replaceAll(states: Readonly<Record<string, HassEntityLike>>): void {
    this.#states = Object.freeze({ ...states });
    this.#options.onChange(this.#states);
  }

  /** Clears every timer; calls still in flight never settle, as with a closed socket. */
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #behaviorFor(call: ServiceCall): DemoBehavior['onInvoke'] {
    const targets = typeof call.target.entity_id === 'string' ? [call.target.entity_id] : call.target.entity_id;
    for (const target of targets) {
      const onInvoke = this.#options.behaviors.get(target)?.onInvoke;
      if (onInvoke !== undefined) return onInvoke;
    }
    return this.#options.defaultInvoke ?? 'apply';
  }

  #latency(): number {
    const [min, max] = this.#options.latencyMs;
    return min + Math.round(this.#options.random() * (max - min));
  }

  #apply(call: ServiceCall, now: number): void {
    const states = new Map(Object.entries(this.#states) as [EntityId, HassEntityLike][]);
    for (const { atMs, state } of simulateServiceCall(call, states, now)) {
      this.#after(Math.max(0, atMs - now), () => this.put(state));
    }
  }

  #after(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, delayMs);
    this.#timers.add(timer);
  }
}

/** Snapshot behavior for a camera: its own, else the scenario default, else ok. */
export function snapshotBehavior(
  behaviors: ReadonlyMap<EntityId, DemoBehavior>,
  id: EntityId,
  fallback: DemoBehavior['snapshot'],
): NonNullable<DemoBehavior['snapshot']> {
  return behaviors.get(id)?.snapshot ?? fallback ?? 'ok';
}

/** One fictional scene's colors: sky, ground and the shade of its hills and shed. */
type ScenePalette = readonly [sky: string, ground: string, shade: string];

/**
 * Mid-tone, low-contrast day scenes: a fictional still should read as a picture without becoming the heaviest mass
 * on a cream page. Each has a night variant of the same hue for the dark theme, so a still never becomes the
 * brightest object on a dark page either.
 */
const SCENE_PALETTES = [
  { day: ['#9aa294', '#b3af99', '#727b6a'], night: ['#3b4139', '#4b4a40', '#2a2f28'] },
  { day: ['#a39a88', '#b8ae97', '#7a705f'], night: ['#413c34', '#4d483e', '#2f2b25'] },
  { day: ['#939fa4', '#b0b4ad', '#6b767c'], night: ['#363d40', '#474a45', '#272d30'] },
  { day: ['#a19d8b', '#bab39d', '#7a7562'], night: ['#3f3d35', '#4c4a40', '#2d2c26'] },
] as const satisfies readonly { readonly day: ScenePalette; readonly night: ScenePalette }[];

/**
 * A generated SVG scene standing in for a camera still: never a photo, and no text. The night palette applies when
 * the picture is shown in a dark color scheme: an SVG image follows its <img> element's used `color-scheme`, which the
 * card sets per theme (Chromium; elsewhere the day palette shows, dimmed by the dark theme's --agr-media-filter).
 */
export function demoSnapshotSvg(id: EntityId): string {
  const hash = [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const { day, night } = SCENE_PALETTES[hash % SCENE_PALETTES.length] ?? SCENE_PALETTES[0];
  const horizon = 150 + (hash % 50);
  const fills = (palette: ScenePalette): string =>
    `.sky{fill:${palette[0]}}.ground{fill:${palette[1]}}.shade{fill:${palette[2]}}`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">',
    `<style>${fills(day)}@media (prefers-color-scheme: dark){${fills(night)}}</style>`,
    '<rect class="sky" width="400" height="300"/>',
    `<rect class="ground" y="${horizon}" width="400" height="${300 - horizon}"/>`,
    `<path class="shade" d="M0 ${horizon} L120 ${horizon - 60} L220 ${horizon - 10} L320 ${horizon - 70} L400 ${horizon} Z" opacity="0.45"/>`,
    `<rect class="shade" x="${40 + (hash % 200)}" y="${horizon - 50}" width="70" height="50" opacity="0.6"/>`,
    '</svg>',
  ].join('');
}
