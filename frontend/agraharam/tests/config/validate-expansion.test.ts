/**
 * Validation of the §18 additions (design §2): room switches (rules 11a–c, 4b), whole-house shortcuts (12a–b and
 * rule 4), the vehicle drawing (13) and read-only collections with their attention rules (14a–e, 15a–g), plus the
 * optional Sky binding (AIRSPACE.md §1). Every
 * issue is checked by path and code; where the design fixes the wording, the whole message is checked too. All IDs
 * are fictional (`*.demo_*`).
 */
import { describe, expect, it } from 'vitest';
import { COLLECTION_ICONS, SHORTCUT_ROLES, VEHICLE_MODELS, type EntityId } from '../../src/config/schema.ts';
import { validateConfig, type ConfigIssue, type ValidationResult } from '../../src/config/validate.ts';
import { CUSTOM_ICONS } from '../../src/icons/custom-icons.ts';
import { ICONS } from '../../src/icons/icons.ts';

const TYPE = 'custom:agraharam-dashboard';

function issuesOf(input: Record<string, unknown>): readonly ConfigIssue[] {
  const result = validateConfig({ type: TYPE, ...input });
  if (result.ok) throw new Error('expected issues');
  return result.issues;
}

function okConfig(input: Record<string, unknown>): Extract<ValidationResult, { ok: true }> {
  const result = validateConfig({ type: TYPE, ...input });
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result;
}

function codesAt(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(issuesOf(input).map((issue) => [issue.path, issue.code]));
}

/** The one issue `input` produces (fails if there are several, so a rule never hides behind another). */
function onlyIssue(input: Record<string, unknown>): ConfigIssue {
  const issues = issuesOf(input);
  expect(issues, JSON.stringify(issues)).toHaveLength(1);
  return issues[0] as ConfigIssue;
}

const id = (value: string): EntityId => value as EntityId;
const STUDY = 'Study';
const LAMP = 'switch.demo_study_desk_lamp';
const PLUG = 'switch.demo_loft_floor_lamp';
const CEILING = 'light.demo_study_ceiling';
const LIGHTS_SCRIPT = 'script.demo_house_lights_toggle';
const CURTAINS_SCRIPT = 'script.demo_house_curtains_toggle';
const VEHICLE = {
  name: 'Demo sedan',
  battery_sensor: 'sensor.demo_sedan_battery',
  range_sensor: 'sensor.demo_sedan_range',
};

/** One collection with the given rows, for the 14e/15x rules. */
function group(entities: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { collections: [{ name: 'Printer', entities, ...extra }] };
}

/** One sensor row with `attention`. */
function rule(attention: unknown, entity = 'sensor.demo_printer_black_ink'): Record<string, unknown> {
  return group([{ entity, attention }]);
}

const ROW = 'collections[0].entities[0]';

// ---------------------------------------------------------------------------------------------------------------
// Rooms: switches (rules 11a–11c, 4b)

describe('rooms[].switches (rules 11a–11c)', () => {
  it('accepts lighting switches beside lights, and a room with only switches (lights default to [])', () => {
    const { config, warnings } = okConfig({
      rooms: [
        { name: STUDY, lights: [CEILING], switches: [LAMP] },
        { name: 'Loft', switches: [PLUG] },
      ],
    });
    expect(warnings).toEqual([]);
    expect(config.rooms).toEqual([
      { name: STUDY, lights: [CEILING], switches: [LAMP], curtains: [] },
      { name: 'Loft', lights: [], switches: [PLUG], curtains: [] },
    ]);
    expect(Object.isFrozen(config.rooms[0]?.switches)).toBe(true);
    expect(config.bindings.get(id(LAMP))).toEqual(['room_switch']);
    expect(config.bindings.get(id(PLUG))).toEqual(['room_switch']);
  });

  it('defaults switches to [] for a light-only room, with no new binding', () => {
    const { config } = okConfig({ rooms: [{ name: STUDY, lights: [CEILING] }] });
    expect(config.rooms[0]?.switches).toEqual([]);
    expect([...config.bindings.keys()]).toEqual([CEILING]);
  });

  it('still requires lights when switches are absent, with the unchanged wording at rooms[i].lights', () => {
    expect(onlyIssue({ rooms: [{ name: STUDY }] })).toEqual({
      path: 'rooms[0].lights',
      code: 'required',
      message: 'rooms[0].lights: required.',
    });
  });

  it.each([
    ['not a list', LAMP, 'rooms[0].switches', 'wrong-type'],
    ['a light', [CEILING], 'rooms[0].switches[0]', 'wrong-domain'],
    ['an input_boolean', ['input_boolean.demo_lamp'], 'rooms[0].switches[0]', 'wrong-domain'],
    ['a malformed ID', ['switch.Demo Lamp'], 'rooms[0].switches[0]', 'invalid-entity-id'],
    ['a number', [7], 'rooms[0].switches[0]', 'wrong-type'],
  ])('rejects switches that are %s (rule 11a)', (_label, switches, path, code) => {
    expect(codesAt({ rooms: [{ name: STUDY, lights: [], switches }] })).toEqual({ [path]: code });
  });

  it('names the switch domain in a wrong-domain message', () => {
    expect(onlyIssue({ rooms: [{ name: STUDY, switches: [CEILING] }] }).message).toBe(
      `rooms[0].switches[0]: expected a switch entity, got "${CEILING}".`,
    );
  });

  it('allows 8 switches per room and rejects 9 (rule 11a)', () => {
    const switches = (count: number) => Array.from({ length: count }, (_, index) => `switch.demo_lamp_${index}`);
    expect(okConfig({ rooms: [{ name: STUDY, switches: switches(8) }] }).config.rooms[0]?.switches).toHaveLength(8);
    expect(codesAt({ rooms: [{ name: STUDY, switches: switches(9) }] })).toEqual({ 'rooms[0].switches': 'too-many' });
  });

  it('rejects the same switch twice in one room (rule 11b)', () => {
    expect(onlyIssue({ rooms: [{ name: STUDY, switches: [LAMP, PLUG, LAMP] }] })).toEqual({
      path: 'rooms[0].switches[2]',
      code: 'invalid-value',
      message: `rooms[0].switches[2]: ${LAMP} is already listed in this room.`,
    });
  });

  it("keeps today's behaviour for a light listed twice in one room (deployed configs must not break)", () => {
    expect(okConfig({ rooms: [{ name: STUDY, lights: [CEILING, CEILING] }] }).config.rooms[0]?.lights).toEqual([
      CEILING,
      CEILING,
    ]);
  });

  it('allows one switch in two rooms: rule 4 counts families, as it does for lights today', () => {
    const { config } = okConfig({
      rooms: [
        { name: STUDY, switches: [LAMP] },
        { name: 'Loft', switches: [LAMP] },
      ],
    });
    expect(config.bindings.get(id(LAMP))).toEqual(['room_switch']);
  });

  it('rejects a misspelled switches key with the did-you-mean hint, and then still requires lights', () => {
    // The typo means no switches were given, so a lamp-only room cannot silently become a room with nothing in it.
    expect(issuesOf({ rooms: [{ name: STUDY, switchs: [LAMP] }] })).toEqual([
      {
        path: 'rooms[0].switchs',
        code: 'unknown-key',
        message: 'rooms[0].switchs: unknown key. Did you mean "switches"?',
      },
      { path: 'rooms[0].lights', code: 'required', message: 'rooms[0].lights: required.' },
    ]);
  });
});

describe('a room switch that is a camera privacy switch (rule 4b)', () => {
  const privacy = 'switch.demo_front_gate_privacy';
  const cameras = [
    { entity: 'camera.demo_side_path', name: 'Side path' },
    { entity: 'camera.demo_front_gate', name: 'Front gate', privacy_entity: privacy },
  ];

  it('is a switch-conflict at the room switch, naming the camera binding', () => {
    expect(onlyIssue({ cameras, rooms: [{ name: STUDY, switches: [LAMP, privacy] }] })).toEqual({
      path: 'rooms[0].switches[1]',
      code: 'switch-conflict',
      message: `rooms[0].switches[1]: ${privacy} is the privacy switch for cameras[1] (cameras[1].privacy_entity). Room switches toggle without confirmation, so it can't also be a room switch.`,
    });
  });

  it('is reported whichever key comes first in the YAML', () => {
    expect(codesAt({ rooms: [{ name: STUDY, switches: [privacy] }], cameras })).toEqual({
      'rooms[0].switches[0]': 'switch-conflict',
    });
  });

  it('becomes an ignored-in-demo warning in demo mode', () => {
    const result = validateConfig({ type: TYPE, demo: true, cameras, rooms: [{ name: STUDY, switches: [privacy] }] });
    expect(result.ok && result.warnings.map((warning) => [warning.path, warning.code])).toEqual([
      ['rooms[0].switches[0]', 'ignored-in-demo'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Shortcuts (rules 12a, 12b, 4)

describe('shortcuts (rules 12a, 12b)', () => {
  it('accepts exactly the two roles, script only, and binds each as a house shortcut', () => {
    expect(SHORTCUT_ROLES).toEqual(['lights_toggle', 'curtains_toggle']);
    const { config } = okConfig({ shortcuts: { lights_toggle: LIGHTS_SCRIPT, curtains_toggle: CURTAINS_SCRIPT } });
    expect(config.shortcuts).toEqual({ lights_toggle: LIGHTS_SCRIPT, curtains_toggle: CURTAINS_SCRIPT });
    expect(Object.isFrozen(config.shortcuts)).toBe(true);
    expect(config.bindings.get(id(LIGHTS_SCRIPT))).toEqual(['house_shortcut']);
    expect(config.bindings.get(id(CURTAINS_SCRIPT))).toEqual(['house_shortcut']);
  });

  it('accepts one role alone and defaults to {} with no binding', () => {
    expect(okConfig({ shortcuts: { curtains_toggle: CURTAINS_SCRIPT } }).config.shortcuts).toEqual({
      curtains_toggle: CURTAINS_SCRIPT,
    });
    const empty = okConfig({});
    expect(empty.config.shortcuts).toEqual({});
    expect([...empty.config.bindings]).toEqual([]);
  });

  it.each([
    ['a list', [LIGHTS_SCRIPT], { shortcuts: 'wrong-type' }],
    ['a string', LIGHTS_SCRIPT, { shortcuts: 'wrong-type' }],
    ['a light', { lights_toggle: 'light.demo_hall' }, { 'shortcuts.lights_toggle': 'wrong-domain' }],
    ['a switch', { curtains_toggle: 'switch.demo_curtains' }, { 'shortcuts.curtains_toggle': 'wrong-domain' }],
    ['an automation', { lights_toggle: 'automation.demo_lights' }, { 'shortcuts.lights_toggle': 'wrong-domain' }],
    ['a scene', { lights_toggle: 'scene.demo_evening' }, { 'shortcuts.lights_toggle': 'wrong-domain' }],
    ['a malformed ID', { lights_toggle: 'script.' }, { 'shortcuts.lights_toggle': 'invalid-entity-id' }],
  ])('rejects shortcuts given as %s (rule 12a)', (_label, shortcuts, expected) => {
    expect(codesAt({ shortcuts })).toEqual(expected);
  });

  it.each(['confirmation', 'name', 'icon', 'service', 'data', 'variables', 'garage_toggle'])(
    'rejects shortcuts.%s as an unknown key, so no config can lower the confirmation or add arguments',
    (key) => {
      expect(codesAt({ shortcuts: { lights_toggle: LIGHTS_SCRIPT, [key]: false } })).toEqual({
        [`shortcuts.${key}`]: 'unknown-key',
      });
    },
  );

  it('rejects the same script under both roles (rule 12b)', () => {
    expect(onlyIssue({ shortcuts: { lights_toggle: LIGHTS_SCRIPT, curtains_toggle: LIGHTS_SCRIPT } })).toEqual({
      path: 'shortcuts.curtains_toggle',
      code: 'duplicate-actionable',
      message: `shortcuts.curtains_toggle: ${LIGHTS_SCRIPT} is already the lights_toggle shortcut (shortcuts.lights_toggle). Each shortcut needs its own script.`,
    });
  });

  it.each([
    [
      'a security script',
      {
        security: {
          alarm: 'alarm_control_panel.demo_home',
          policy: 'input_select.demo_policy',
          actions: { hold_night: LIGHTS_SCRIPT },
        },
      },
    ],
    ['the studio monitors script', { studio_monitors_script: LIGHTS_SCRIPT }],
  ])('rejects a shortcut script that is also %s (rule 4)', (_label, other) => {
    const issues = issuesOf({ ...other, shortcuts: { lights_toggle: LIGHTS_SCRIPT } });
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate-actionable']);
    expect(issues[0]?.message).toContain('An entity can be controlled from one place only.');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Vehicle drawing (rule 13)

describe('vehicle.model (rule 13)', () => {
  it('defaults to generic, and accepts exactly the listed models', () => {
    expect(VEHICLE_MODELS).toEqual(['generic', 'tesla-model-3']);
    expect(okConfig({ vehicle: VEHICLE }).config.vehicle?.model).toBe('generic');
    for (const model of VEHICLE_MODELS) {
      expect(okConfig({ vehicle: { ...VEHICLE, model } }).config.vehicle?.model).toBe(model);
    }
  });

  it.each(['Tesla-Model-3', 'tesla model 3', 'tesla', 'model-3', '', 3, true, null, ['tesla-model-3']])(
    'rejects %j without coercion',
    (model) => {
      const issue = onlyIssue({ vehicle: { ...VEHICLE, model } });
      expect(issue).toMatchObject({ path: 'vehicle.model', code: 'invalid-value' });
      expect(issue.message).toMatch(/^vehicle\.model: expected generic or tesla-model-3, got .+\.$/);
    },
  );

  it('quotes a string model in the message', () => {
    expect(onlyIssue({ vehicle: { ...VEHICLE, model: 'Tesla' } }).message).toBe(
      'vehicle.model: expected generic or tesla-model-3, got "Tesla".',
    );
  });

  it('adds no binding for the model', () => {
    const plain = okConfig({ vehicle: VEHICLE }).config.bindings;
    const drawn = okConfig({ vehicle: { ...VEHICLE, model: 'tesla-model-3' } }).config.bindings;
    expect([...drawn]).toEqual([...plain]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Collections (rules 14a–14e)

describe('collections: groups (rules 14a–14d)', () => {
  it('resolves names, icons and rows (shorthand and mapping), frozen, with the collection role bound', () => {
    const { config, warnings } = okConfig({
      collections: [
        {
          name: '  Printer ',
          icon: 'printer',
          entities: [
            'sensor.demo_printer_progress',
            { entity: 'sensor.demo_printer_black_ink', name: ' Black ink ', attention: { below: 15 } },
            { entity: 'sensor.demo_printer_status', attention: { equals: ['error', 'offline'] } },
            { entity: 'binary_sensor.demo_fridge_door', name: 'Fridge door', attention: { equals: 'on' } },
            { entity: 'sensor.demo_fridge_temperature', attention: { below: 33, above: 41 } },
          ],
        },
        { name: 'Car', entities: ['sensor.demo_sedan_odometer'] },
      ],
    });
    expect(warnings).toEqual([]);
    expect(config.collections).toEqual([
      {
        name: 'Printer',
        icon: 'printer',
        rows: [
          { entity: 'sensor.demo_printer_progress' },
          { entity: 'sensor.demo_printer_black_ink', name: 'Black ink', attention: { kind: 'range', below: 15 } },
          { entity: 'sensor.demo_printer_status', attention: { kind: 'equals', values: ['error', 'offline'] } },
          {
            entity: 'binary_sensor.demo_fridge_door',
            name: 'Fridge door',
            attention: { kind: 'equals', values: ['on'] },
          },
          { entity: 'sensor.demo_fridge_temperature', attention: { kind: 'range', below: 33, above: 41 } },
        ],
      },
      { name: 'Car', rows: [{ entity: 'sensor.demo_sedan_odometer' }] },
    ]);
    expect(Object.isFrozen(config.collections)).toBe(true);
    expect(Object.isFrozen(config.collections[0]?.rows)).toBe(true);
    expect(Object.isFrozen(config.collections[0]?.rows[2]?.attention)).toBe(true);
    expect(config.bindings.get(id('sensor.demo_printer_progress'))).toEqual(['collection']);
  });

  it('defaults to [] with no binding', () => {
    const { config } = okConfig({});
    expect(config.collections).toEqual([]);
    expect([...config.bindings]).toEqual([]);
  });

  it.each([
    ['a mapping', { name: 'Printer', entities: [] }],
    ['a string', 'Printer'],
  ])('rejects collections given as %s (rule 14a)', (_label, collections) => {
    expect(codesAt({ collections })).toEqual({ collections: 'wrong-type' });
  });

  it('allows 12 groups and rejects 13 (rule 14a)', () => {
    const groups = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ name: `Group ${index}`, entities: [`sensor.demo_g${index}`] }));
    expect(okConfig({ collections: groups(12) }).config.collections).toHaveLength(12);
    expect(codesAt({ collections: groups(13) })).toEqual({ collections: 'too-many' });
  });

  it.each([
    ['missing', undefined, 'required'],
    ['blank', '   ', 'invalid-value'],
    ['41 characters', 'n'.repeat(41), 'too-long'],
    ['a number', 7, 'wrong-type'],
  ])('rejects a group name that is %s (rule 14b)', (_label, name, code) => {
    const entry = { entities: ['sensor.demo_a'], ...(name !== undefined && { name }) };
    expect(codesAt({ collections: [entry] })).toEqual({ 'collections[0].name': code });
  });

  it('accepts a 40-character group name', () => {
    expect(okConfig(group(['sensor.demo_a'], { name: 'n'.repeat(40) })).config.collections[0]?.name).toHaveLength(40);
  });

  it('rejects a duplicate group name, case-insensitively after trimming (rule 14b)', () => {
    expect(
      onlyIssue({
        collections: [
          { name: 'Printer', entities: ['sensor.demo_a'] },
          { name: ' printer ', entities: ['sensor.demo_b'] },
        ],
      }),
    ).toEqual({
      path: 'collections[1].name',
      code: 'invalid-value',
      message: 'collections[1].name: another collection is already named "printer".',
    });
  });

  it('accepts every listed icon and rejects any other name (rule 14c)', () => {
    for (const icon of COLLECTION_ICONS) {
      expect(okConfig(group(['sensor.demo_a'], { icon })).config.collections[0]?.icon).toBe(icon);
    }
    const issue = onlyIssue(group(['sensor.demo_a'], { icon: 'rocket' }));
    expect(issue).toMatchObject({ path: 'collections[0].icon', code: 'invalid-value' });
    expect(issue.message).toMatch(/^collections\[0\]\.icon: expected one of house, lightbulb, .*, got "rocket"\.$/);
    expect(codesAt(group(['sensor.demo_a'], { icon: 'Printer' }))).toEqual({ 'collections[0].icon': 'invalid-value' });
  });

  it('names an icon that exists in the icon registry for every COLLECTION_ICONS entry', () => {
    const known = new Set([...Object.keys(ICONS), ...Object.keys(CUSTOM_ICONS)]);
    expect(COLLECTION_ICONS.filter((icon) => !known.has(icon))).toEqual([]);
  });

  it.each([
    ['missing', undefined, 'required'],
    ['a string', 'sensor.demo_a', 'wrong-type'],
    ['empty', [], 'invalid-value'],
  ])('rejects entities that are %s (rule 14d)', (_label, entities, code) => {
    const entry = { name: 'Printer', ...(entities !== undefined && { entities }) };
    expect(codesAt({ collections: [entry] })).toEqual({ 'collections[0].entities': code });
  });

  it('words an empty entity list as an action', () => {
    expect(onlyIssue(group([])).message).toBe('collections[0].entities: add at least one entity.');
  });

  it('allows 32 rows and rejects 33 (rule 14d)', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => `sensor.demo_row_${index}`);
    expect(okConfig(group(rows(32))).config.collections[0]?.rows).toHaveLength(32);
    expect(codesAt(group(rows(33)))).toEqual({ 'collections[0].entities': 'too-many' });
  });

  it('rejects unknown group and row keys with the did-you-mean hint', () => {
    expect(codesAt({ collections: [{ name: 'Printer', entities: ['sensor.demo_a'], entites: [] }] })).toEqual({
      'collections[0].entites': 'unknown-key',
    });
    expect(codesAt(group([{ entity: 'sensor.demo_a', attention: { below: 1 }, tap_action: 'more-info' }]))).toEqual({
      [`${ROW}.tap_action`]: 'unknown-key',
    });
    expect(codesAt(group([{ entity: 'sensor.demo_a', attention: { belw: 1 } }]))).toMatchObject({
      [`${ROW}.attention.belw`]: 'unknown-key',
    });
  });
});

describe('collections: rows (rule 14e) and the read-only domains', () => {
  /** The 18 domains a reading may show (design §1.1). */
  const READ_ONLY_DOMAINS = [
    'sensor',
    'binary_sensor',
    'number',
    'select',
    'light',
    'switch',
    'fan',
    'climate',
    'vacuum',
    'cover',
    'lock',
    'media_player',
    'update',
    'input_text',
    'input_datetime',
    'input_boolean',
    'input_select',
    'event',
  ];
  /** Excluded on purpose: other sections own them, they are private, or they invite actions. */
  const REFUSED_DOMAINS = [
    'camera',
    'alarm_control_panel',
    'person',
    'device_tracker',
    'zone',
    'script',
    'automation',
    'scene',
    'button',
    'input_button',
    'text',
    'input_number',
    'weather',
    'calendar',
    'siren',
  ];

  it.each(READ_ONLY_DOMAINS)('accepts a %s row', (domain) => {
    const entity = `${domain}.demo_reading`;
    const { config } = okConfig(group([entity]));
    expect(config.collections[0]?.rows).toEqual([{ entity }]);
    expect(config.bindings.get(id(entity))).toEqual(['collection']);
  });

  it.each(REFUSED_DOMAINS)('rejects a %s row as wrong-domain', (domain) => {
    expect(codesAt(group([`${domain}.demo_reading`]))).toEqual({ [ROW]: 'wrong-domain' });
  });

  it.each([
    ['a number', 7, ROW, 'wrong-type'],
    ['a list', ['sensor.demo_a'], ROW, 'wrong-type'],
    ['a mapping without entity', { name: 'Ink' }, `${ROW}.entity`, 'required'],
    ['a malformed ID', 'sensor.Demo', ROW, 'invalid-entity-id'],
    ['a 41-character name', { entity: 'sensor.demo_a', name: 'n'.repeat(41) }, `${ROW}.name`, 'too-long'],
  ])('rejects a row that is %s', (_label, row, path, code) => {
    expect(codesAt(group([row]))).toEqual({ [path]: code });
  });

  it('rejects the same entity twice in one group, and allows it across groups', () => {
    const issue = onlyIssue(group(['sensor.demo_a', { entity: 'sensor.demo_a', name: 'Again' }]));
    expect(issue.code).toBe('invalid-value');
    expect(issue.path).toMatch(/^collections\[0\]\.entities\[1\](?:\.entity)?$/);
    expect(issue.message).toBe(`${issue.path}: sensor.demo_a is already listed in this collection.`);
    const { config } = okConfig({
      collections: [
        { name: 'One', entities: ['sensor.demo_a'] },
        { name: 'Two', entities: ['sensor.demo_a'] },
      ],
    });
    expect(config.collections.map((entry) => entry.rows.length)).toEqual([1, 1]);
    expect(config.bindings.get(id('sensor.demo_a'))).toEqual(['collection']);
  });

  it('lets a reading overlap a control (read-only overlap is allowed) and never adds a family', () => {
    const { config } = okConfig({
      rooms: [{ name: STUDY, lights: [CEILING], switches: [LAMP] }],
      vacuums: [{ entity: 'vacuum.demo_pebble' }],
      collections: [{ name: 'Mixed', entities: [CEILING, LAMP, 'vacuum.demo_pebble'] }],
    });
    expect(config.bindings.get(id(CEILING))).toEqual(['room_light', 'collection']);
    expect(config.bindings.get(id(LAMP))).toEqual(['room_switch', 'collection']);
    expect(config.bindings.get(id('vacuum.demo_pebble'))).toEqual(['vacuum', 'collection']);
  });

  it('a camera privacy switch may be a reading (collections never act), but never a room switch', () => {
    const privacy = 'switch.demo_front_gate_privacy';
    const cameras = [{ entity: 'camera.demo_front_gate', name: 'Front gate', privacy_entity: privacy }];
    const { config } = okConfig({ cameras, collections: [{ name: 'Health', entities: [privacy] }] });
    expect(config.bindings.get(id(privacy))).toEqual(['camera_privacy', 'collection']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Attention rules (15a–15g)

describe('attention (rules 15a–15g)', () => {
  it.each([
    ['a number', 15, 'wrong-type'],
    ['a string', 'below 15', 'wrong-type'],
    ['a list', [15], 'wrong-type'],
    ['empty', {}, 'required'],
  ])('rejects attention that is %s (rule 15a)', (_label, attention, code) => {
    expect(codesAt(rule(attention))).toEqual({ [`${ROW}.attention`]: code });
  });

  it('words an empty rule as what to set', () => {
    expect(onlyIssue(rule({})).message).toBe(`${ROW}.attention: set below, above or equals.`);
  });

  it.each([
    ['below', '15'],
    ['above', '41'],
    ['below', true],
    ['above', null],
  ])('rejects %s given as %j (rule 15b)', (bound, value) => {
    const issue = onlyIssue(rule({ [bound]: value }));
    expect(issue).toMatchObject({ path: `${ROW}.attention.${bound}`, code: 'wrong-type' });
    expect(issue.message).toMatch(
      new RegExp(`^${ROW.replace(/[[\].]/g, '\\$&')}\\.attention\\.${bound}: expected a number, got `),
    );
  });

  it.each([
    ['below', Number.NaN],
    ['above', Number.POSITIVE_INFINITY],
    ['below', Number.NEGATIVE_INFINITY],
  ])('rejects %s = %s, as YAML .nan and .inf parse (rule 15b)', (bound, value) => {
    expect(onlyIssue(rule({ [bound]: value }))).toEqual({
      path: `${ROW}.attention.${bound}`,
      code: 'invalid-value',
      message: `${ROW}.attention.${bound}: expected a finite number.`,
    });
  });

  it('accepts negative, zero and fractional bounds', () => {
    const rows = okConfig(
      group([
        { entity: 'sensor.demo_freezer', attention: { above: -10.5 } },
        { entity: 'sensor.demo_ink', attention: { below: 0 } },
      ]),
    ).config.collections[0]?.rows;
    expect(rows?.map((row) => row.attention)).toEqual([
      { kind: 'range', above: -10.5 },
      { kind: 'range', below: 0 },
    ]);
  });

  it.each([
    [41, 33],
    [40, 40],
  ])('rejects below %s with above %s: below must be less than above (rule 15c)', (below, above) => {
    expect(onlyIssue(rule({ below, above }))).toEqual({
      path: `${ROW}.attention`,
      code: 'invalid-value',
      message: `${ROW}.attention: below must be less than above. Readings from below to above are in range.`,
    });
  });

  it.each(['binary_sensor', 'switch', 'light', 'select', 'input_text', 'climate'])(
    'refuses below or above on a %s row (rule 15d)',
    (domain) => {
      expect(onlyIssue(rule({ below: 1 }, `${domain}.demo_reading`))).toEqual({
        path: `${ROW}.attention`,
        code: 'invalid-value',
        message: `${ROW}.attention: below and above compare numeric readings; for a ${domain} entity use equals.`,
      });
    },
  );

  it.each(['sensor', 'number'])('allows below and above on a %s row', (domain) => {
    expect(okConfig(rule({ below: 1, above: 9 }, `${domain}.demo_reading`)).config.collections).toHaveLength(1);
  });

  it.each([true, false])('rejects equals: %s with the quoting hint (rule 15e)', (value) => {
    expect(onlyIssue(rule({ equals: value }, 'binary_sensor.demo_door'))).toEqual({
      path: `${ROW}.attention.equals`,
      code: 'wrong-type',
      message: `${ROW}.attention.equals: expected text; write 'on' or 'off' in quotes.`,
    });
  });

  it('rejects a boolean inside an equals list with the quoting hint too', () => {
    const issue = onlyIssue(rule({ equals: ['on', true] }, 'binary_sensor.demo_door'));
    expect(issue.code).toBe('wrong-type');
    expect(issue.message).toContain("write 'on' or 'off' in quotes.");
  });

  it.each([
    ['an empty string', '', ['invalid-value']],
    ['an empty list', [], ['invalid-value']],
    ['nine values', Array.from({ length: 9 }, (_, index) => `state_${index}`), ['too-many']],
    ['a 61-character value', 'x'.repeat(61), ['too-long']],
    ['a number', 3, ['wrong-type']],
    ['a mapping', { state: 'on' }, ['wrong-type']],
  ])('rejects equals given as %s (rule 15e)', (_label, equals, codes) => {
    const issue = onlyIssue(rule({ equals }, 'sensor.demo_printer_status'));
    expect(codes).toContain(issue.code);
    expect(issue.path).toMatch(/^collections\[0\]\.entities\[0\]\.attention\.equals(?:\[\d\])?$/);
  });

  it('rejects a duplicate equals value at its item path', () => {
    expect(onlyIssue(rule({ equals: ['error', 'offline', 'error'] }, 'sensor.demo_printer_status'))).toEqual({
      path: `${ROW}.attention.equals[2]`,
      code: 'invalid-value',
      message: `${ROW}.attention.equals[2]: "error" is already listed.`,
    });
  });

  it('accepts eight distinct values and a 60-character value, kept raw and case-sensitive', () => {
    const eight = ['Error', 'error', 'offline', 'jammed', 'door_open', 'no_paper', 'low', 'x'.repeat(60)];
    const rows = okConfig(rule({ equals: eight }, 'sensor.demo_printer_status')).config.collections[0]?.rows;
    expect(rows?.[0]?.attention).toEqual({ kind: 'equals', values: eight });
  });

  it.each(['unknown', 'unavailable'])('refuses %s in equals: it always counts as unavailable (rule 15f)', (state) => {
    const issue = onlyIssue(rule({ equals: ['error', state] }, 'sensor.demo_printer_status'));
    expect(issue.code).toBe('invalid-value');
    expect(issue.message).toBe(
      `${issue.path}: unknown and unavailable readings are always counted as unavailable; leave them out.`,
    );
  });

  it.each([
    [{ equals: 'error', below: 3 }],
    [{ equals: 'error', above: 3 }],
    [{ equals: ['error'], below: 1, above: 3 }],
  ])('refuses equals combined with a bound %j (rule 15g)', (attention) => {
    const issue = onlyIssue(rule(attention, 'sensor.demo_printer_status'));
    expect(issue.code).toBe('invalid-value');
    expect(issue.message).toBe(`${issue.path}: use either equals, or below and above.`);
  });

  it.each(['event', 'input_datetime'])('refuses equals on an %s row, whose state is a time (rule 15g)', (domain) => {
    const issue = onlyIssue(rule({ equals: 'single_press' }, `${domain}.demo_reading`));
    expect(issue.code).toBe('invalid-value');
    expect(issue.message).toBe(`${issue.path}: equals can't match a time; this row shows the time only.`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Demo mode, controls and the result

describe('the new keys in demo mode and with controls', () => {
  it('turns issues in every new key into ignored-in-demo warnings and keeps demo bindings empty', () => {
    const result = validateConfig({
      type: TYPE,
      demo: true,
      rooms: [{ name: STUDY, switches: [CEILING] }],
      shortcuts: { lights_toggle: 'light.demo_wrong' },
      collections: [{ name: 'Printer', entities: ['camera.demo_wrong'] }],
      vehicle: { ...VEHICLE, model: 'Tesla' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.config.bindings]).toEqual([]);
    expect(result.config.collections).toEqual([]);
    expect(result.config.shortcuts).toEqual({});
    expect(result.warnings.every((warning) => warning.code === 'ignored-in-demo')).toBe(true);
    expect(result.warnings.map((warning) => warning.path).sort()).toEqual(
      ['collections[0].entities[0]', 'rooms[0].switches[0]', 'shortcuts.lights_toggle', 'vehicle.model'].sort(),
    );
  });

  it('still defaults controls to false when every new key is configured', () => {
    const { config } = okConfig({
      rooms: [{ name: STUDY, switches: [LAMP] }],
      shortcuts: { lights_toggle: LIGHTS_SCRIPT },
      collections: [{ name: 'Printer', entities: ['sensor.demo_a'] }],
      vehicle: { ...VEHICLE, model: 'tesla-model-3' },
    });
    expect(config.controls).toBe(false);
  });

  it('does not let a new key stand in for a missing required one elsewhere', () => {
    expect(
      codesAt({ collections: [{ name: 'Car', entities: ['sensor.demo_a'] }], vehicle: { model: 'generic' } }),
    ).toEqual({
      'vehicle.name': 'required',
      'vehicle.battery_sensor': 'required',
      'vehicle.range_sensor': 'required',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Airspace (AIRSPACE.md §1): one read-only sensor binding

describe('airspace (AIRSPACE.md §1)', () => {
  const SKY = 'sensor.demo_sky_airspace';

  it('resolves { entity }, frozen, bound under the read-only airspace role only', () => {
    const { config } = okConfig({ airspace: { entity: SKY } });
    expect(config.airspace).toEqual({ entity: SKY });
    expect(Object.isFrozen(config.airspace)).toBe(true);
    expect(config.bindings.get(id(SKY))).toEqual(['airspace']);
  });

  it('adds no key and no binding when absent, so existing configs resolve unchanged', () => {
    const { config } = okConfig({});
    expect(Object.hasOwn(config, 'airspace')).toBe(false);
    expect(config.bindings.size).toBe(0);
  });

  it('accepts sensors only, naming the expected domain', () => {
    expect(onlyIssue({ airspace: { entity: 'binary_sensor.demo_sky' } })).toEqual({
      path: 'airspace.entity',
      code: 'wrong-domain',
      message: 'airspace.entity: expected a sensor entity, got "binary_sensor.demo_sky".',
    });
    expect(codesAt({ airspace: { entity: 'not an id' } })).toEqual({ 'airspace.entity': 'invalid-entity-id' });
  });

  it('must be a mapping with exactly the key entity', () => {
    expect(codesAt({ airspace: SKY })).toEqual({ airspace: 'wrong-type' });
    expect(codesAt({ airspace: {} })).toEqual({ 'airspace.entity': 'required' });
    expect(codesAt({ airspace: { entity: SKY, radius_km: 10 } })).toEqual({ 'airspace.radius_km': 'unknown-key' });
    expect(codesAt({ airspace: { entiy: SKY } })).toEqual({
      'airspace.entiy': 'unknown-key',
      'airspace.entity': 'required',
    });
    expect(issuesOf({ airspace: { entiy: SKY } })[0]?.message).toContain('Did you mean "entity"?');
  });

  it('may share its sensor with a reading: read-only roles overlap freely', () => {
    const { config } = okConfig({ airspace: { entity: SKY }, ...group([SKY]) });
    expect(config.bindings.get(id(SKY))).toEqual(['collection', 'airspace']);
  });

  it('is ignored with a warning in demo mode, where the sky scenario is accepted', () => {
    const result = validateConfig({
      type: TYPE,
      demo: true,
      demo_scenario: 'sky',
      airspace: { entity: 'light.demo_sky' },
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.config.demoScenario).toBe('sky');
    expect(Object.hasOwn(result.config, 'airspace')).toBe(false);
    expect(result.warnings.map((warning) => [warning.path, warning.code])).toEqual([
      ['airspace.entity', 'ignored-in-demo'],
    ]);
  });
});
