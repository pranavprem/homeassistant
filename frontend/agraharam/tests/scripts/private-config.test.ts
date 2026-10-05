/**
 * Private config generator (§13.4, §12.1 row 9) on the fictional candidates fixture: mapping rules, the camera
 * privacy rules with a round trip through validateConfig and cameraGate, the exactly-one security and vehicle
 * rules, the exact label map, rendering, and the CLI's output guards in a temp git repo.
 */
import { lstatSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateConfig, OUTPUT_FILE_NAME, PrivateConfigError } from '../../scripts/lib/private-config.mjs';
import { validateConfig } from '../../src/config/validate.ts';
import { cameraGate } from '../../src/ha/camera-gate.ts';
import { createTempRepo, runNodeScript, type TempRepo } from './support/temp-repo.ts';

type Entry = { entity_id: string; known_in_saved_inventory?: boolean };
type Fixture = {
  groups: Record<string, Entry[]>;
  camera_candidates: Array<Record<string, unknown>>;
  guarded_actions: Array<Record<string, unknown> & { invocation: Record<string, unknown> }>;
  known_ambiguities: string[];
};
/** Generated config is plain JSON; the assertions index into it freely. */
type Card = Record<string, any>;

const FIXTURE_TEXT = readFileSync(new URL('./fixtures/candidates.fictional.json', import.meta.url), 'utf8');
const OVERRIDES_EXAMPLE: unknown = JSON.parse(
  readFileSync(new URL('../../install/overrides.example.json', import.meta.url), 'utf8'),
);
const NOW = '2026-09-30T17:51:00.000Z';

function fixture(mutate?: (candidates: Fixture) => void): Fixture {
  const candidates = JSON.parse(FIXTURE_TEXT) as Fixture;
  mutate?.(candidates);
  return candidates;
}

function generate(candidates: Fixture = fixture(), overrides?: unknown) {
  return generatePrivateConfig({ candidatesData: candidates, overridesData: overrides, generatedAt: NOW });
}

function cardOf(candidates?: Fixture, overrides?: unknown): Card {
  return generate(candidates, overrides).card as Card;
}

/** The generator's error message; also asserts it names no entity ID. */
function failure(candidates: Fixture, overrides?: unknown): string {
  try {
    generate(candidates, overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateConfigError);
    const message = (error as Error).message;
    expect(message, 'messages name paths, tokens and counts only').not.toMatch(/demo_[a-z]/);
    return message;
  }
  throw new Error('the generator unexpectedly succeeded');
}

const removeEntity = (group: string, id: string) => (candidates: Fixture) => {
  candidates.groups[group] = (candidates.groups[group] ?? []).filter((entry) => entry.entity_id !== id);
};
const addEntity = (group: string, id: string) => (candidates: Fixture) => {
  (candidates.groups[group] ??= []).push({ entity_id: id, known_in_saved_inventory: true });
};

describe('generator: mapping the fictional candidates', () => {
  const result = generate();
  const card = result.card as Card;

  it('emits one panel view at path home with one card, demo false and controls false', () => {
    expect(result.dashboard).toMatchObject({
      title: 'Agraharam',
      views: [{ title: 'Home', path: 'home', type: 'panel' }],
    });
    expect((result.dashboard as Card).views[0].cards).toEqual([card]);
    expect(card).toMatchObject({ type: 'custom:agraharam-dashboard', demo: false, controls: false });
  });

  it('validates with no issues and no warnings', () => {
    const validation = validateConfig(card);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.warnings).toEqual([]);
  });

  it('binds people, weather and sun by domain, climate, air, bed comfort, media and calendars; ignores todo', () => {
    expect(card.people).toEqual(['person.demo_asha', 'person.demo_ravi']);
    expect(card.weather).toBe('weather.demo_home');
    expect(card.sun).toBe('sun.sun');
    expect(card.climate).toEqual(['climate.demo_hallway']);
    expect(card.air).toEqual(['fan.demo_bedroom_purifier', 'fan.demo_study_purifier']);
    expect(card.bed_comfort).toEqual(['climate.demo_bed_left']);
    expect(card.media).toEqual(['media_player.demo_lounge', 'media_player.demo_kitchen_speaker']);
    expect(card.calendars).toEqual(['calendar.demo_family']);
    expect(JSON.stringify(card)).not.toContain('todo.');
  });

  it('puts every light and curtain candidate into one default "Lights" room, with a header note', () => {
    expect(card.rooms).toEqual([
      {
        name: 'Lights',
        lights: ['light.demo_lounge_lamp', 'light.demo_kitchen_pendant', 'light.demo_porch'],
        curtains: ['cover.demo_lounge_curtain', 'cover.demo_study_blind'],
      },
    ]);
    expect(result.text).toMatch(/^# {3}- One default room "Lights" holds every light and curtain candidate/m);
  });

  it('pairs <p>_current_status with <p>_remaining_time', () => {
    expect(card.appliances).toEqual([
      {
        name: 'Demo Washer',
        status_sensor: 'sensor.demo_washer_current_status',
        remaining_sensor: 'sensor.demo_washer_remaining_time',
      },
      { name: 'Demo Dryer', status_sensor: 'sensor.demo_dryer_current_status' },
    ]);
  });

  it('binds vehicle fields by suffix', () => {
    expect(card.vehicle).toEqual({
      name: 'Demo Sedan',
      battery_sensor: 'sensor.demo_sedan_battery_level',
      range_sensor: 'sensor.demo_sedan_battery_range',
      charger_status: 'binary_sensor.demo_sedan_charger_status',
      charger_power: 'sensor.demo_sedan_charger_power',
      session_energy: 'sensor.demo_sedan_session_energy',
    });
  });

  it('binds the alarm, one helper per token (ignoring wrong-domain look-alikes), the perimeter and every action', () => {
    expect(card.security).toEqual({
      alarm: 'alarm_control_panel.demo_house',
      policy: 'input_select.demo_security_policy',
      suggested_mode: 'sensor.demo_suggested_mode',
      commissioning: 'input_boolean.demo_security_commissioning',
      health_text: 'input_text.demo_security_health',
      perimeter: [
        'binary_sensor.demo_front_door_contact',
        'binary_sensor.demo_back_door_contact',
        'cover.demo_garage_door',
      ],
      actions: {
        disarm_hold: 'script.demo_disarm_and_hold',
        silence_sound: 'script.demo_silence_sound',
        resume_auto: 'script.demo_resume_auto',
        hold_night: 'script.demo_hold_night',
        hold_away: 'script.demo_hold_away',
        hold_vacation: 'script.demo_hold_vacation',
        prepare_departure: 'script.demo_prepare_departure',
      },
    });
    expect(card.studio_monitors_script).toBe('script.demo_studio_monitors');
    expect(card.garage).toEqual({ cover: 'cover.demo_garage_door' });
  });

  it('lists every vacuum, and every ID missing from the saved inventory, under "verify before enabling"', () => {
    expect(card.vacuums).toEqual([{ entity: 'vacuum.demo_upstairs' }, { entity: 'vacuum.demo_downstairs' }]);
    const verify = result.text.slice(result.text.indexOf('# Verify before enabling:'));
    expect(verify).toMatch(/^# {3}- vacuum\.demo_upstairs \(vacuum candidates may be renamed/m);
    expect(verify).toMatch(/^# {3}- vacuum\.demo_downstairs \(not in the saved inventory\)/m);
  });
});

describe('generator: cameras (§13.4)', () => {
  it('maps privacy_entity and privacy_enabled_value exactly, and writes thumbnails and live for every camera', () => {
    expect(cardOf().cameras).toEqual([
      {
        entity: 'camera.demo_front_gate',
        name: 'Front Gate',
        privacy_entity: 'switch.demo_front_gate_privacy',
        privacy_on_value: 'on',
        thumbnails: true,
        live: false,
      },
      {
        entity: 'camera.demo_nursery',
        name: 'Nursery',
        privacy_entity: 'input_boolean.demo_nursery_privacy',
        privacy_on_value: 'off',
        thumbnails: true,
        live: false,
      },
      { entity: 'camera.demo_side_path', name: 'Side Path', thumbnails: false, live: true },
      { entity: 'camera.demo_driveway', name: 'Driveway', thumbnails: false, live: true },
    ]);
  });

  it('lists the cameras emitted with thumbnails: false in the header', () => {
    const header = generate().text;
    const section = header.slice(
      header.indexOf('# Cameras with thumbnails: false'),
      header.indexOf('# Cameras with live'),
    );
    expect(section.match(/camera\.demo_\w+/g)).toEqual(['camera.demo_side_path', 'camera.demo_driveway']);
  });

  it('lists every live: false camera in the header with its reason', () => {
    const header = generate().text;
    const section = header.slice(header.indexOf('# Cameras with live: false'), header.indexOf('# Notes:'));
    expect(section).toContain('Live view stays on only for a camera with an outdoor word');
    expect(section.match(/camera\.demo_\w+/g)).toEqual(['camera.demo_front_gate', 'camera.demo_nursery']);
    expect(section).toMatch(/^# {3}- camera\.demo_front_gate \(privacy binding: treated as indoor\)$/m);
  });

  describe('live view fails closed', () => {
    /** The fixture plus one camera candidate without a privacy binding. */
    const withCamera = (entity_id: string, role: string) =>
      fixture((c) => {
        c.camera_candidates.push({ entity_id, role });
      });
    const liveOf = (candidates: Fixture, entity: string, overrides?: unknown) =>
      (cardOf(candidates, overrides).cameras as Card[]).find((camera) => camera.entity === entity)?.live;
    const reasonOf = (candidates: Fixture, entity: string, overrides?: unknown) =>
      generatePrivateConfig({
        candidatesData: candidates,
        overridesData: overrides,
        generatedAt: NOW,
      }).notes.liveOff.find((line) => line.startsWith(`${entity} `));

    it('keeps live view for a camera with outdoor evidence and no indoor evidence or privacy binding', () => {
      expect(liveOf(fixture(), 'camera.demo_driveway')).toBe(true);
      expect(liveOf(withCamera('camera.demo_cam_7', 'front_door'), 'camera.demo_cam_7')).toBe(true);
      expect(liveOf(withCamera('camera.demo_backyard_cam', 'cam_8'), 'camera.demo_backyard_cam')).toBe(true);
    });

    it('turns it off when the indoor evidence is only in the entity ID', () => {
      const candidates = withCamera('camera.demo_living_room_cam', 'porch_view');
      expect(liveOf(candidates, 'camera.demo_living_room_cam')).toBe(false);
      expect(reasonOf(candidates, 'camera.demo_living_room_cam')).toContain(
        'indoor word in its role, name or entity ID',
      );
    });

    it.each(['loft', 'upper_loft', 'mezzanine', 'family_room', 'mudroom', 'entryway', 'studio'])(
      'turns it off for the indoor role %s',
      (role) => {
        expect(liveOf(withCamera('camera.demo_cam_9', role), 'camera.demo_cam_9')).toBe(false);
      },
    );

    it('never pairs words across texts: a role ending "front" and a name starting "Door" are no front door', () => {
      const candidates = withCamera('camera.demo_cam_11', 'upper_front');
      expect(liveOf(candidates, 'camera.demo_cam_11', { names: { 'camera.demo_cam_11': 'Door cam' } })).toBe(false);
    });

    it('turns it off for a camera with no outdoor word at all', () => {
      const candidates = withCamera('camera.demo_cam_10', 'cam_10');
      expect(liveOf(candidates, 'camera.demo_cam_10')).toBe(false);
      expect(reasonOf(candidates, 'camera.demo_cam_10')).toContain('no outdoor word');
    });

    it('treats a privacy-bound camera as indoor, even with an outdoor role', () => {
      expect(liveOf(fixture(), 'camera.demo_front_gate')).toBe(false);
      expect(reasonOf(fixture(), 'camera.demo_front_gate')).toContain('privacy binding');
    });

    it('an indoor name given in overrides vetoes an outdoor role', () => {
      const overrides = { names: { 'camera.demo_driveway': 'Living room' } };
      expect(liveOf(fixture(), 'camera.demo_driveway', overrides)).toBe(false);
    });

    it('camera_live opts a checked camera in or out explicitly', () => {
      const overrides = { camera_live: { 'camera.demo_front_gate': true, 'camera.demo_driveway': false } };
      expect(liveOf(fixture(), 'camera.demo_front_gate', overrides)).toBe(true);
      expect(liveOf(fixture(), 'camera.demo_driveway', overrides)).toBe(false);
      expect(reasonOf(fixture(), 'camera.demo_driveway', overrides)).toContain('overrides.camera_live');
      expect(reasonOf(fixture(), 'camera.demo_front_gate', overrides)).toBeUndefined();
    });

    it('fails on a camera_live key that is not a candidate camera, or a non-boolean value', () => {
      expect(failure(fixture(), { camera_live: { 'camera.demo_typo': true } })).toContain(
        'camera_live: 1 key(s) are not candidate cameras',
      );
      expect(failure(fixture(), { camera_live: { 'camera.demo_driveway': 'no' } })).toContain(
        'the value must be true or false',
      );
    });
  });

  it('camera_thumbnails true opts a camera without privacy in; false turns any camera off', () => {
    const cameras = cardOf(fixture(), {
      camera_thumbnails: { 'camera.demo_side_path': true, 'camera.demo_front_gate': false },
    }).cameras as Card[];
    expect(cameras.find((camera) => camera.entity === 'camera.demo_side_path')?.thumbnails).toBe(true);
    const gate = cameras.find((camera) => camera.entity === 'camera.demo_front_gate');
    expect(gate).toMatchObject({ thumbnails: false, privacy_entity: 'switch.demo_front_gate_privacy' });
  });

  it('fails on a camera_thumbnails key that is not a candidate camera, or a non-boolean value', () => {
    expect(failure(fixture(), { camera_thumbnails: { 'camera.demo_typo': true } })).toContain(
      'camera_thumbnails: 1 key(s) are not candidate cameras',
    );
    expect(failure(fixture(), { camera_thumbnails: { 'camera.demo_side_path': 'yes' } })).toContain(
      'the value must be true or false',
    );
  });

  it.each([['On'], ['ON'], [' on'], ['true'], [true], ['enabled'], [1]])(
    'fails on privacy_enabled_value %j (exactly "on" or "off" only)',
    (value) => {
      const candidates = fixture((c) => {
        (c.camera_candidates[0] as Record<string, unknown>).privacy_enabled_value = value;
      });
      expect(failure(candidates)).toContain('camera_candidates[0].privacy_enabled_value must be exactly "on" or "off"');
    },
  );

  it('fails on a privacy entity outside DOMAINS_BY_ROLE.camera_privacy', () => {
    const candidates = fixture((c) => {
      (c.camera_candidates[1] as Record<string, unknown>).privacy_entity = 'light.demo_nursery_lamp';
    });
    expect(failure(candidates)).toContain(
      'camera_candidates[1].privacy_entity must be a switch, binary_sensor, input_boolean entity',
    );
  });

  it.each([
    ['only privacy_entity', { privacy_enabled_value: null }],
    ['only privacy_enabled_value', { privacy_entity: undefined }],
  ])('fails on half a privacy binding (%s)', (_label, patch) => {
    const candidates = fixture((c) => Object.assign(c.camera_candidates[0] as object, patch));
    expect(failure(candidates)).toContain('camera_candidates[0]: privacy_entity and privacy_enabled_value must be set');
  });

  it('fails when a privacy entity is excluded while its camera stays', () => {
    expect(failure(fixture(), { exclude: ['switch.demo_front_gate_privacy'] })).toContain(
      'camera_candidates[0]: its privacy entity is excluded while the camera stays',
    );
  });

  it('removes an excluded camera together with its privacy entity', () => {
    const card = cardOf(fixture(), { exclude: ['camera.demo_front_gate'] });
    expect(JSON.stringify(card)).not.toContain('front_gate');
    expect(card.cameras).toHaveLength(3);
  });

  it('round trip: the generated config, validated and fed to cameraGate, honours each privacy binding', () => {
    const validation = validateConfig(cardOf());
    if (!validation.ok) throw new Error('generated config failed validation');
    const gated = validation.config.cameras.filter((camera) => camera.privacy !== undefined);
    expect(gated).toHaveLength(2);
    for (const camera of gated) {
      const privacy = camera.privacy as { readonly onValue: 'on' | 'off' };
      const offValue = privacy.onValue === 'on' ? 'off' : 'on';
      const gate = (state: string) =>
        cameraGate({
          ready: true,
          live: true,
          resyncing: false,
          camera: 'available',
          privacy: { state, onValue: privacy.onValue, fresh: true },
        });
      expect(gate(privacy.onValue)).toMatchObject({ kind: 'privacy', certainty: 'on' });
      expect(gate('unavailable')).toMatchObject({ kind: 'privacy', certainty: 'unknown' });
      expect(gate(offValue)).toEqual({ kind: 'allowed' });
    }
  });
});

describe('generator: security helpers and actions', () => {
  it.each([
    ['policy', 'policy', removeEntity('security_read_only', 'input_select.demo_security_policy'), 0],
    ['policy', 'policy', addEntity('security_read_only', 'select.demo_alarm_policy'), 2],
    ['suggested', 'suggested', removeEntity('security_read_only', 'sensor.demo_suggested_mode'), 0],
    ['suggested', 'suggested', addEntity('security_read_only', 'input_select.demo_suggested_next'), 2],
    [
      'commissioning',
      '(^|_)commissioning$',
      removeEntity('security_read_only', 'input_boolean.demo_security_commissioning'),
      0,
    ],
    [
      'commissioning',
      '(^|_)commissioning$',
      addEntity('security_read_only', 'binary_sensor.demo_annex_commissioning'),
      2,
    ],
    ['health', 'health', removeEntity('security_read_only', 'input_text.demo_security_health'), 0],
    ['health', 'health', addEntity('security_read_only', 'sensor.demo_health_summary'), 2],
  ])('security helper %s: an ambiguous match exits naming the token and count (%#)', (_name, token, mutate, count) => {
    expect(failure(fixture(mutate))).toContain(`security helper token "${token}": ${count} candidates match`);
  });

  it.each([
    [removeEntity('security_read_only', 'alarm_control_panel.demo_house'), 0],
    [addEntity('security_read_only', 'alarm_control_panel.demo_annex'), 2],
  ])('fails unless exactly one alarm (%#)', (mutate, count) => {
    expect(failure(fixture(mutate))).toContain(`security alarm: ${count} alarm_control_panel candidates`);
  });

  it('resolves a helper ambiguity through overrides.exclude', () => {
    const candidates = fixture(addEntity('security_read_only', 'select.demo_alarm_policy'));
    expect(cardOf(candidates, { exclude: ['select.demo_alarm_policy'] }).security.policy).toBe(
      'input_select.demo_security_policy',
    );
  });

  it('fails on a label outside the exact label map', () => {
    const candidates = fixture((c) => {
      (c.guarded_actions[1] as Record<string, unknown>).label = 'Silence';
    });
    expect(failure(candidates)).toContain('guarded_actions[1].label is not in the label map');
  });

  it.each([
    ['service turn_off', (a: Fixture['guarded_actions'][number]) => (a.invocation.service = 'turn_off')],
    ['an automation domain', (a: Fixture['guarded_actions'][number]) => (a.invocation.domain = 'automation')],
    ['data with variables', (a: Fixture['guarded_actions'][number]) => ((a.invocation.data as Card).variables = {})],
    [
      'a different data.entity_id',
      (a: Fixture['guarded_actions'][number]) => ((a.invocation.data as Card).entity_id = 'script.demo_other'),
    ],
    ['an extra invocation key', (a: Fixture['guarded_actions'][number]) => (a.invocation.target = {})],
    [
      'a non-script entity',
      (a: Fixture['guarded_actions'][number]) => {
        a.entity_id = 'alarm_control_panel.demo_house';
        (a.invocation.data as Card).entity_id = 'alarm_control_panel.demo_house';
      },
    ],
  ])('fails on an invocation with %s', (_label, mutate) => {
    const candidates = fixture((c) => {
      mutate(c.guarded_actions[0] as Fixture['guarded_actions'][number]);
    });
    expect(failure(candidates)).toContain('guarded_actions[0].invocation must be exactly');
  });

  it('fails when two guarded actions carry the same label', () => {
    const candidates = fixture((c) => {
      c.guarded_actions.push({
        label: 'Silence Sound',
        entity_id: 'script.demo_second_silence',
        invocation: { domain: 'script', service: 'turn_on', data: { entity_id: 'script.demo_second_silence' } },
      });
    });
    expect(failure(candidates)).toContain('guarded_actions[8]: role "silence_sound" is already held');
  });

  it('leaves an excluded guarded script unbound, with a note', () => {
    const result = generate(fixture(), { exclude: ['script.demo_hold_vacation'] });
    expect((result.card as Card).security.actions.hold_vacation).toBeUndefined();
    expect(result.text).toContain('guarded_actions[5] (hold_vacation) is excluded by overrides');
  });
});

describe('generator: vehicle, rooms and overrides', () => {
  it('fails when a vehicle suffix matches several candidates, naming the suffix and count', () => {
    const candidates = fixture(addEntity('vehicle_read_only', 'sensor.demo_sedan_climate_status'));
    expect(failure(candidates)).toContain('vehicle suffix "_status": 2 candidates match');
  });

  it('omits the vehicle with a header note when battery or range has no match', () => {
    const result = generate(fixture(removeEntity('vehicle_read_only', 'sensor.demo_sedan_battery_range')));
    expect((result.card as Card).vehicle).toBeUndefined();
    expect(result.text).toContain('Vehicle omitted: no single battery-level and battery-range candidate.');
  });

  it('omits an optional vehicle field with no match, and applies the vehicle overrides', () => {
    const candidates = fixture(removeEntity('vehicle_read_only', 'sensor.demo_sedan_session_energy'));
    const vehicle = cardOf(candidates, { vehicle_name: 'Sedan', charge_limit_pct: 80 }).vehicle;
    expect(vehicle.session_energy).toBeUndefined();
    expect(vehicle).toMatchObject({ name: 'Sedan', charge_limit_pct: 80 });
  });

  it('with overrides.rooms, lists lights and curtains no room places as unassigned instead of dropping them', () => {
    const rooms = [{ name: 'Lounge', lights: ['light.demo_lounge_lamp'], curtains: ['cover.demo_lounge_curtain'] }];
    const result = generate(fixture(), { rooms });
    expect((result.card as Card).rooms).toEqual(rooms);
    const section = result.text.slice(result.text.indexOf('# Unassigned'));
    expect(section).toContain('cover.demo_study_blind (unassigned curtain)');
    expect(section).toContain('light.demo_porch (unassigned light)');
  });

  it('applies names as {entity, name} refs and vacuum battery sensors', () => {
    const card = cardOf(fixture(), {
      names: { 'person.demo_ravi': 'Ravi', 'vacuum.demo_upstairs': 'Upstairs' },
      vacuum_battery_sensors: { 'vacuum.demo_upstairs': 'sensor.demo_upstairs_battery' },
    });
    expect(card.people).toEqual(['person.demo_asha', { entity: 'person.demo_ravi', name: 'Ravi' }]);
    expect(card.vacuums[0]).toEqual({
      entity: 'vacuum.demo_upstairs',
      name: 'Upstairs',
      battery_sensor: 'sensor.demo_upstairs_battery',
    });
  });

  it.each([
    ['an unknown key', { colour: 'olive' }, 'unknown key "colour"'],
    ['a names key that is not emitted', { names: { 'light.demo_unknown': 'X' } }, 'overrides.names: 1 key(s)'],
    [
      'an exclude that is not a candidate',
      { exclude: ['light.demo_unknown'] },
      'overrides.exclude[0] is not a candidate',
    ],
    [
      'a vacuum battery key that is not a vacuum',
      { vacuum_battery_sensors: { 'vacuum.demo_x': 'sensor.demo_y' } },
      '1 key(s) are not emitted vacuums',
    ],
  ])('fails on %s in the overrides', (_label, overrides, message) => {
    expect(failure(fixture(), overrides)).toContain(message);
  });

  it('accepts install/overrides.example.json and still emits controls: false', () => {
    const card = cardOf(fixture(), OVERRIDES_EXAMPLE);
    expect(card.controls).toBe(false);
    expect(card.rooms.map((room: Card) => room.name)).toEqual(['Lounge', 'Study']);
    expect(card.rooms[1].purifier).toBe('fan.demo_study_purifier');
    expect(card.cameras.find((camera: Card) => camera.entity === 'camera.demo_front_gate').live).toBe(true);
    expect(validateConfig(card).ok).toBe(true);
  });

  it.each([
    [
      'an excluded light',
      { exclude: ['light.demo_porch'], rooms: [{ name: 'Porch', lights: ['light.demo_porch'] }] },
      'overrides.rooms[0].lights[0] is excluded by overrides.exclude',
    ],
    [
      'an unknown curtain',
      { rooms: [{ name: 'Lounge', lights: [], curtains: ['cover.demo_lounge_curtain', 'cover.demo_typo'] }] },
      'overrides.rooms[0].curtains[1] is not a curtain candidate',
    ],
    [
      'a light listed as a curtain',
      { rooms: [{ name: 'Lounge', lights: [], curtains: ['light.demo_lounge_lamp'] }] },
      'overrides.rooms[0].curtains[0] is not a curtain candidate',
    ],
    [
      'a purifier that is not an air candidate',
      { rooms: [{ name: 'A' }, { name: 'Study', lights: [], purifier: 'fan.demo_attic_fan' }] },
      'overrides.rooms[1].purifier is not a purifier candidate (groups.air)',
    ],
    [
      'an excluded purifier',
      {
        exclude: ['fan.demo_study_purifier'],
        rooms: [{ name: 'Study', lights: [], purifier: 'fan.demo_study_purifier' }],
      },
      'overrides.rooms[0].purifier is excluded by overrides.exclude',
    ],
  ])('fails on a room that binds %s', (_label, overrides, message) => {
    expect(failure(fixture(), overrides)).toContain(message);
  });

  it('refuses to write when validateConfig reports issues, listing each path and code', () => {
    const candidates = fixture((c) => {
      for (let index = 0; index < 7; index += 1) addEntity('media_candidates', `media_player.demo_extra_${index}`)(c);
    });
    expect(failure(candidates)).toMatch(/failed validation[\s\S]*media: too-many/);
  });

  it('fails on several weather candidates', () => {
    expect(failure(fixture(addEntity('today', 'weather.demo_backup')))).toContain('today: 2 weather candidates');
  });
});

describe('generator: rendering', () => {
  it('every line before the JSON body is a comment, and stripping them gives the dashboard JSON', () => {
    const { text, dashboard } = generate();
    const lines = text.split('\n');
    const bodyStart = lines.indexOf('{');
    expect(bodyStart).toBeGreaterThan(0);
    expect(lines.slice(0, bodyStart).every((line) => line.startsWith('#'))).toBe(true);
    expect(JSON.parse(lines.filter((line) => !line.startsWith('#')).join('\n'))).toEqual(dashboard);
    expect(text).toContain('# Candidates only. Verify every ID in live HA before enabling actions.');
    expect(text).toContain('set "controls": true in the raw configuration editor');
  });

  it('keeps hostile known_ambiguities inside the comment header', () => {
    const candidates = fixture((c) => {
      c.known_ambiguities = [
        'line one\n{"views": []}',
        'separator\u2028"controls": true',
        'cr\rreturn',
        'tab\u0007bell',
      ];
    });
    const { text, dashboard } = generate(candidates);
    const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
    const bodyStart = lines.indexOf('{');
    expect(lines.slice(0, bodyStart).every((line) => line.startsWith('#'))).toBe(true);
    expect(text).not.toContain('\u0007');
    expect(
      JSON.parse(
        text
          .split('\n')
          .filter((line) => !line.startsWith('#'))
          .join('\n'),
      ),
    ).toEqual(dashboard);
  });
});

describe('generate-private-config CLI', () => {
  let repo: TempRepo;
  const output = () => join(repo.privateDir, OUTPUT_FILE_NAME);
  const listFiles = (): string[] =>
    readdirSync(repo.root, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => relative(repo.root, join(entry.parentPath, entry.name)))
      .filter((path) => !path.startsWith('.git/'))
      .sort();

  beforeEach(() => {
    repo = createTempRepo('agr-private-config-');
    repo.write('.dashboard-local/bindings.candidates.json', FIXTURE_TEXT);
  });

  afterEach(() => repo.remove());

  it('writes only .dashboard-local/agraharam-next.dashboard.yaml, mode 0600, and prints counts only', () => {
    const before = listFiles();
    const result = runNodeScript('generate-private-config.mjs', [], repo.root);
    expect(result.status).toBe(0);
    expect(listFiles()).toEqual([...before, `.dashboard-local/${OUTPUT_FILE_NAME}`].sort());
    expect(statSync(output()).mode & 0o777).toBe(0o600);
    expect(readFileSync(output(), 'utf8')).toContain('"controls": false');
    expect(result.stdout).toContain('cameras 4: 2 privacy-gated, 2 with thumbnails off, 2 with live view off.');
    expect(result.stdout + result.stderr).not.toMatch(/demo_[a-z]/);
  });

  it('exits 1 and writes nothing when the candidates file is missing', () => {
    rmSync(join(repo.privateDir, 'bindings.candidates.json'));
    const before = listFiles();
    const result = runNodeScript('generate-private-config.mjs', [], repo.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bindings.candidates.json is required and was not found');
    expect(listFiles()).toEqual(before);
  });

  it('exits 1 without echoing content when a private file is not valid JSON', () => {
    repo.write('.dashboard-local/agraharam.overrides.json', '{"names": {"person.demo_secret_name": ');
    const result = runNodeScript('generate-private-config.mjs', [], repo.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agraharam.overrides.json is not valid JSON');
    expect(result.stderr).not.toContain('demo_secret_name');
  });

  it('exits 1 on a rule failure and leaves an earlier output untouched', () => {
    writeFileSync(output(), 'earlier output\n', { mode: 0o600 });
    const broken = fixture((c) => {
      (c.camera_candidates[0] as Record<string, unknown>).privacy_enabled_value = 'On';
    });
    repo.write('.dashboard-local/bindings.candidates.json', JSON.stringify(broken));
    const result = runNodeScript('generate-private-config.mjs', [], repo.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing was written');
    expect(readFileSync(output(), 'utf8')).toBe('earlier output\n');
  });

  it('refuses a symlinked output and leaves the link target untouched', () => {
    const target = repo.write('elsewhere.txt', 'do not touch\n');
    symlinkSync(target, output());
    const result = runNodeScript('generate-private-config.mjs', [], repo.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a regular file');
    expect(lstatSync(output()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('do not touch\n');
  });

  it('refuses when the output would not be gitignored', () => {
    repo.write('.gitignore', 'node_modules/\n');
    const result = runNodeScript('generate-private-config.mjs', [], repo.root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not gitignored');
    expect(() => statSync(output())).toThrow();
  });
});
