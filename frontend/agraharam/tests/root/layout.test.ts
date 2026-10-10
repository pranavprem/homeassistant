import { describe, expect, it } from 'vitest';
import { BREAKPOINTS, HYSTERESIS_PX, layoutFor, PANEL_CQ } from '../../src/styles/breakpoints.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { demoCardInput } from '../../src/demo/configs.ts';
import { DEMO_SCENARIO_IDS } from '../../src/demo/scenarios.ts';
import { panelHeightEstimates, PANEL_HEIGHT_TARGET_PX } from '../../src/model/budget.ts';
import {
  columnsFor,
  emptySections,
  NARROW_ORDER,
  ALIGN_SNAP_PX,
  MAX_ABSORBED_SLACK_PX,
  nextComfortTileBudget,
  slackAllowances,
  stretchedSections,
  visibleSections,
  WIDE_COLUMNS,
  type MeasuredColumn,
  type SectionId,
} from '../../src/styles/layout.ts';
import { CONTENT_BUDGET } from '../../src/model/budget.ts';
import { configFrom } from '../helpers/services.ts';

/**
 * Every section that existed before the optional sky, in the narrow order. The column tests below keep testing
 * exactly what they tested then; the sky placement tests add the sky to these sets explicitly.
 */
const LEGACY_ORDER: readonly SectionId[] = Object.freeze<SectionId[]>([
  'today',
  'comfort',
  'home',
  'cameras',
  'garage',
  'media',
  'health',
  'upcoming',
]);
const ALL: ReadonlySet<SectionId> = new Set(LEGACY_ORDER);
const withSky = (sections: Iterable<SectionId>): ReadonlySet<SectionId> => new Set<SectionId>([...sections, 'sky']);

describe('layoutFor (§6.1)', () => {
  it.each([
    [1384, 'wide'],
    [1184, 'wide'],
    [1138, 'wide'],
    [1080, 'wide'],
    [938, 'medium'],
    [720, 'medium'],
    [700, 'medium'],
    [699, 'narrow'],
    [640, 'narrow'],
    [390, 'narrow'],
  ])('a %i px card host is %s', (width, mode) => {
    expect(layoutFor(width)).toBe(mode);
  });

  it('steps down only below the threshold minus the hysteresis, and steps up at the threshold', () => {
    expect(layoutFor(BREAKPOINTS.wide - 1, 'wide')).toBe('wide');
    expect(layoutFor(BREAKPOINTS.wide - HYSTERESIS_PX, 'wide')).toBe('wide');
    expect(layoutFor(BREAKPOINTS.wide - HYSTERESIS_PX - 1, 'wide')).toBe('medium');
    expect(layoutFor(BREAKPOINTS.wide - 1, 'medium')).toBe('medium');
    expect(layoutFor(BREAKPOINTS.wide, 'medium')).toBe('wide');
    expect(layoutFor(BREAKPOINTS.medium - HYSTERESIS_PX, 'medium')).toBe('medium');
    expect(layoutFor(BREAKPOINTS.medium - HYSTERESIS_PX - 1, 'medium')).toBe('narrow');
    expect(layoutFor(BREAKPOINTS.medium - 1, 'narrow')).toBe('narrow');
    expect(layoutFor(BREAKPOINTS.medium, 'narrow')).toBe('medium');
  });

  it('shows 8 forecast cells only from a 360 px content box, so 328–334 px boxes get 6 roomier cells (§16.14)', () => {
    expect(PANEL_CQ.forecast8).toBe(360);
    expect(PANEL_CQ.forecast6).toBeLessThan(328);
  });

  it('keeps the 2×2 cameras at the narrowest medium panel, where chips and tiles go one-up (§16.14)', () => {
    // The narrowest medium panel content box: the card at the threshold minus hysteresis, frame padding 2 × 20,
    // the 16 px gap, and panel padding 2 × 18.
    const narrowestMediumBox = (BREAKPOINTS.medium - HYSTERESIS_PX - 40 - 16) / 2 - 36;
    expect(narrowestMediumBox).toBeGreaterThanOrEqual(PANEL_CQ.cameraGrid);
    expect(narrowestMediumBox).toBeLessThan(PANEL_CQ.twoUp);
  });
});

describe('column membership (§6.2, §16.10)', () => {
  it('wide: home column, today column, visibility column', () => {
    expect(columnsFor('wide', ALL)).toEqual([
      ['home', 'upcoming', 'health'],
      ['today', 'comfort', 'media'],
      ['cameras', 'garage'],
    ]);
  });

  it('medium: the raised panels split as a prefix, then the quiet panels go largest first to the shorter column', () => {
    expect(columnsFor('medium', ALL)).toEqual([
      ['today', 'comfort', 'home', 'upcoming'],
      ['cameras', 'garage', 'media', 'health'],
    ]);
  });

  it('medium keeps the narrow order inside each column', () => {
    const subsets: SectionId[][] = [
      [...LEGACY_ORDER],
      ['today', 'comfort', 'home', 'media', 'health'],
      ['today', 'comfort', 'home', 'cameras', 'garage', 'media', 'health'],
      ['today', 'comfort', 'home', 'health', 'upcoming'],
    ];
    for (const subset of subsets) {
      const columns = columnsFor('medium', new Set(subset));
      expect(columns.flat().sort()).toEqual([...subset].sort());
      for (const column of columns) expect(column).toEqual(NARROW_ORDER.filter((id) => column.includes(id)));
    }
  });

  it('medium keeps Today and Climate together when a later split costs at most one gap more', () => {
    const visible = new Set<SectionId>(['today', 'comfort', 'home', 'health']);
    expect(columnsFor('medium', visible)).toEqual([
      ['today', 'comfort'],
      ['home', 'health'],
    ]);
  });

  it('medium balances a large Home with the rest of the panels (estimated from the configuration)', () => {
    const heights = { ...PANEL_HEIGHT_TARGET_PX, home: 680 };
    expect(columnsFor('medium', ALL, heights)).toEqual([
      ['today', 'comfort', 'home'],
      ['cameras', 'garage', 'media', 'health', 'upcoming'],
    ]);
  });

  it('wide keeps the reference columns for a configuration near the targets', () => {
    const reference = columnsFor('wide', ALL);
    expect(columnsFor('wide', ALL, PANEL_HEIGHT_TARGET_PX)).toEqual(reference);
    // A somewhat larger Home (one more chip row) is not worth moving a panel for.
    expect(columnsFor('wide', ALL, { ...PANEL_HEIGHT_TARGET_PX, home: PANEL_HEIGHT_TARGET_PX.home + 56 })).toEqual(
      reference,
    );
  });

  it('wide moves the quiet panels under shorter columns when a large Home makes column 1 far taller (§16.13)', () => {
    const heights = { ...PANEL_HEIGHT_TARGET_PX, home: 680 };
    const columns = columnsFor('wide', ALL, heights);
    // The raised panels never move, a moved quiet panel follows its column's raised ones, and Today's column keeps
    // the spare height it can centre its content in.
    expect(columns).toEqual([
      ['home', 'upcoming'],
      ['today', 'comfort', 'media'],
      ['cameras', 'garage', 'health'],
    ]);
  });

  it('wide rebalancing applies to the dense demo, whose Home holds the whole overview budget', () => {
    const dense = validateConfig(demoCardInput('dense'));
    if (!dense.ok) throw new Error('the dense demo config must validate');
    const estimates = panelHeightEstimates(dense.config);
    const columns = columnsFor('wide', visibleSections(dense.config), estimates);
    // Raised panels never move; a near-tie keeps Today uncluttered and a quiet panel under Home.
    expect(columns.map((column) => column.filter((id) => id !== 'upcoming' && id !== 'health'))).toEqual([
      ['home'],
      ['today', 'comfort', 'media'],
      ['cameras', 'garage'],
    ]);
    expect(columns[0]?.filter((id) => id === 'upcoming' || id === 'health')).toHaveLength(1);
    const tallest = (cols: readonly (readonly string[])[]) =>
      Math.max(...cols.map((column) => column.reduce((sum, id) => sum + estimates[id as SectionId], 0)));
    expect(tallest(columns)).toBeLessThanOrEqual(tallest(WIDE_COLUMNS));
    // §18: shortcuts grow Home to 720 px and collections grow House to 176 px. A 16 px estimated gain
    // must not pack House under Today: wrapped text makes that column much taller in the browser.
    expect(columns).toEqual([
      ['home', 'health'],
      ['today', 'comfort', 'media'],
      ['cameras', 'garage', 'upcoming'],
    ]);
  });

  it('narrow: one column in priority order', () => {
    expect(columnsFor('narrow', ALL)).toEqual([LEGACY_ORDER]);
  });

  it('omits hidden optional panels and falls back to the medium template when a wide column would be empty', () => {
    const visible = new Set<SectionId>(['today', 'comfort', 'home', 'health']);
    const columns = columnsFor('wide', visible);
    expect(columns).toHaveLength(2);
    expect(columns.flat()).toEqual(['today', 'comfort', 'home', 'health']);
  });

  it("gives each column's slack to the preferred absorber (Today, then Garage), else its last raised panel, never a quiet one", () => {
    expect([...stretchedSections(columnsFor('wide', ALL))].sort()).toEqual(['garage', 'home', 'today']);
    expect([...stretchedSections(columnsFor('medium', ALL))].sort()).toEqual(['garage', 'today']);
    expect(
      [
        ...stretchedSections([
          ['home', 'upcoming', 'health'],
          ['media', 'health'],
        ]),
      ].sort(),
    ).toEqual(['home', 'media']);
    expect([...stretchedSections([['upcoming', 'health']])]).toEqual([]);
  });

  it('never stretches a panel that shows its empty state: that column ends where its content does', () => {
    const empty = emptySections(configFrom({}));
    expect([...empty].sort()).toEqual(['comfort', 'home', 'today']);
    expect([
      ...stretchedSections(
        [
          ['home', 'health'],
          ['today', 'comfort'],
        ],
        empty,
      ),
    ]).toEqual([]);
    const withHome = new Set<SectionId>(['comfort']);
    expect(
      [
        ...stretchedSections(
          [
            ['home', 'health'],
            ['today', 'comfort'],
          ],
          withHome,
        ),
      ].sort(),
    ).toEqual(['home', 'today']);
    const normal = validateConfig(demoCardInput('normal'));
    if (!normal.ok) throw new Error('the normal demo config must validate');
    expect([...emptySections(normal.config)]).toEqual([]);
  });

  it('counts a Home with only whole-house shortcuts (or only studio monitors) as content, and an empty Home as empty (§18)', () => {
    expect(emptySections(configFrom({})).has('home')).toBe(true);
    expect(
      emptySections(configFrom({ shortcuts: { lights_toggle: 'script.demo_house_lights_toggle' } })).has('home'),
    ).toBe(false);
    expect(
      emptySections(configFrom({ shortcuts: { curtains_toggle: 'script.demo_house_curtains_toggle' } })).has('home'),
    ).toBe(false);
    expect(emptySections(configFrom({ studio_monitors_script: 'script.demo_monitors' })).has('home')).toBe(false);
    // Collections live in House health, so they never make Home non-empty.
    expect(
      emptySections(configFrom({ collections: [{ name: 'Car', entities: ['sensor.demo_odometer'] }] })).has('home'),
    ).toBe(true);
  });

  it('shows optional panels only when configured', () => {
    expect([...visibleSections(configFrom({}))].sort()).toEqual(['comfort', 'health', 'home', 'today']);
    const full = configFrom({
      cameras: [{ entity: 'camera.demo_a', name: 'A' }],
      vehicle: { name: 'Demo sedan', battery_sensor: 'sensor.demo_b', range_sensor: 'sensor.demo_r' },
      media: ['media_player.demo_tv'],
      calendars: ['calendar.demo_household'],
    });
    expect([...visibleSections(full)].sort()).toEqual([...ALL].sort());
  });
});

describe('the optional sky panel is a satellite (AIRSPACE.md §7)', () => {
  it('sits in the narrow order after Media and before the quiet panels', () => {
    expect(NARROW_ORDER).toEqual([
      'today',
      'comfort',
      'home',
      'cameras',
      'garage',
      'media',
      'sky',
      'health',
      'upcoming',
    ]);
    expect(columnsFor('narrow', withSky(ALL))).toEqual([NARROW_ORDER]);
  });

  it('is visible only when an airspace entity is configured, and changes nothing else', () => {
    expect(visibleSections(configFrom({})).has('sky')).toBe(false);
    const sky = configFrom({ airspace: { entity: 'sensor.demo_sky_airspace' } });
    expect([...visibleSections(sky)].sort()).toEqual(['comfort', 'health', 'home', 'sky', 'today']);
  });

  it('joins the shortest wide column after its raised panels and before its quiet ones', () => {
    // No calendars, with cameras and garage: column 1 (Home, House) is the shortest by far.
    const legacy: SectionId[] = ['today', 'comfort', 'home', 'cameras', 'garage', 'media', 'health'];
    expect(columnsFor('wide', new Set(legacy))).toEqual([
      ['home', 'health'],
      ['today', 'comfort', 'media'],
      ['cameras', 'garage'],
    ]);
    expect(columnsFor('wide', withSky(legacy))).toEqual([
      ['home', 'sky', 'health'],
      ['today', 'comfort', 'media'],
      ['cameras', 'garage'],
    ]);
  });

  it('takes the rightmost column on a tie: the full household, whose three columns all meet the 700 px budget', () => {
    expect(columnsFor('wide', withSky(ALL))).toEqual([
      ['home', 'upcoming', 'health'],
      ['today', 'comfort', 'media'],
      ['cameras', 'garage', 'sky'],
    ]);
  });

  it('never decides wide versus medium: an empty wide column is not rescued by the sky', () => {
    const fewer: SectionId[] = ['today', 'comfort', 'home', 'health'];
    const columns = columnsFor('wide', withSky(fewer));
    expect(columns).toHaveLength(2);
    expect(columns.map((column) => column.filter((id) => id !== 'sky'))).toEqual(columnsFor('wide', new Set(fewer)));
  });

  it('never moves another panel: removing the sky gives the columns without it, in every mode', () => {
    const households: SectionId[][] = [
      [...LEGACY_ORDER],
      ['today', 'comfort', 'home', 'cameras', 'garage', 'media', 'health'],
      ['today', 'comfort', 'home', 'health', 'upcoming'],
      ['today', 'comfort', 'home', 'health'],
    ];
    const heights = [PANEL_HEIGHT_TARGET_PX, { ...PANEL_HEIGHT_TARGET_PX, home: 680 }];
    for (const household of households) {
      for (const mode of ['wide', 'medium', 'narrow'] as const) {
        for (const estimate of heights) {
          const columns = columnsFor(mode, withSky(household), estimate);
          expect(columns.flat().filter((id) => id === 'sky')).toHaveLength(1);
          expect(columns.map((column) => column.filter((id) => id !== 'sky'))).toEqual(
            columnsFor(mode, new Set(household), estimate),
          );
        }
      }
    }
  });

  it('medium: joins the shorter column before its quiet panels, keeping the narrow order inside each column', () => {
    expect(columnsFor('medium', ALL)).toEqual([
      ['today', 'comfort', 'home', 'upcoming'],
      ['cameras', 'garage', 'media', 'health'],
    ]);
    const columns = columnsFor('medium', withSky(ALL));
    expect(columns).toEqual([
      ['today', 'comfort', 'home', 'upcoming'],
      ['cameras', 'garage', 'media', 'sky', 'health'],
    ]);
    for (const column of columns) expect(column).toEqual(NARROW_ORDER.filter((id) => column.includes(id)));
  });

  it('never stretches: a column ends with its last raised panel taking the slack, not the sky', () => {
    expect([...stretchedSections([['home', 'sky', 'health']])]).toEqual(['home']);
    expect([...stretchedSections([['cameras', 'garage', 'sky']])]).toEqual(['garage']);
    expect([...stretchedSections([['media', 'sky']])]).toEqual(['media']);
    expect([...stretchedSections([['sky', 'health']])]).toEqual([]);
    expect([...stretchedSections(columnsFor('wide', withSky(ALL)))].sort()).toEqual(['garage', 'home', 'today']);
  });

  it('places the sky scenario like the full household: below Garage in column 3', () => {
    const sky = validateConfig(demoCardInput('sky'));
    if (!sky.ok) throw new Error('the sky demo config must validate');
    const visible = visibleSections(sky.config);
    expect(visible.has('sky')).toBe(true);
    expect(columnsFor('wide', visible, panelHeightEstimates(sky.config))[2]).toEqual(['cameras', 'garage', 'sky']);
  });
});

describe('panel height estimates for medium balancing (§16.10)', () => {
  const homeConfig = (rooms: number, vacuums: number, appliances: number, studio: boolean) =>
    configFrom({
      rooms: Array.from({ length: rooms }, (_, index) => ({ name: `Room ${index}`, lights: [`light.demo_l${index}`] })),
      vacuums: Array.from({ length: vacuums }, (_, index) => ({ entity: `vacuum.demo_v${index}` })),
      appliances: Array.from({ length: appliances }, (_, index) => ({
        name: `Appliance ${index}`,
        status_sensor: `sensor.demo_a${index}`,
      })),
      ...(studio && { studio_monitors_script: 'script.demo_monitors' }),
    });

  it('matches the Home target for the composition the target was set for', () => {
    expect(panelHeightEstimates(homeConfig(4, 1, 1, true)).home).toBe(PANEL_HEIGHT_TARGET_PX.home);
  });

  it('grows with chip rows, vacuums, device rows and the overflow link, within the overview budget', () => {
    const base = panelHeightEstimates(homeConfig(4, 1, 1, true)).home;
    expect(panelHeightEstimates(homeConfig(6, 1, 1, true)).home).toBe(base + 56);
    expect(panelHeightEstimates(homeConfig(4, 2, 1, true)).home).toBe(base + 60);
    expect(panelHeightEstimates(homeConfig(4, 1, 3, true)).home).toBe(base + 2 * 49);
    // Beyond the budget: six chips, two vacuums, three active rows plus one idle row, and the link.
    expect(panelHeightEstimates(homeConfig(12, 4, 5, true)).home).toBe(base + 56 + 60 + 3 * 49 + 56);
    expect(panelHeightEstimates(homeConfig(4, 1, 1, false)).home).toBe(base - 49);
  });

  it('one Whole-house shortcuts row counts as one more device row, whichever shortcuts are configured (§18)', () => {
    const base = panelHeightEstimates(homeConfig(4, 1, 1, true)).home;
    const withShortcuts = (shortcuts: Record<string, string>) =>
      panelHeightEstimates(
        configFrom({
          rooms: Array.from({ length: 4 }, (_, index) => ({ name: `Room ${index}`, lights: [`light.demo_l${index}`] })),
          vacuums: [{ entity: 'vacuum.demo_v0' }],
          appliances: [{ name: 'Appliance 0', status_sensor: 'sensor.demo_a0' }],
          studio_monitors_script: 'script.demo_monitors',
          shortcuts,
        }),
      ).home;
    expect(withShortcuts({ lights_toggle: 'script.demo_house_lights' })).toBe(base + 49);
    expect(
      withShortcuts({ lights_toggle: 'script.demo_house_lights', curtains_toggle: 'script.demo_house_curtains' }),
    ).toBe(base + 49);
  });

  it('room switches add no height: chips are capped and counts sit inside them (§18)', () => {
    const lightOnly = panelHeightEstimates(homeConfig(4, 1, 1, true)).home;
    const withSwitches = configFrom({
      rooms: Array.from({ length: 4 }, (_, index) => ({
        name: `Room ${index}`,
        lights: [`light.demo_l${index}`],
        switches: [`switch.demo_s${index}`],
      })),
      vacuums: [{ entity: 'vacuum.demo_v0' }],
      appliances: [{ name: 'Appliance 0', status_sensor: 'sensor.demo_a0' }],
      studio_monitors_script: 'script.demo_monitors',
    });
    expect(panelHeightEstimates(withSwitches).home).toBe(lightOnly);
  });

  it('House health grows by the 40 px readings fact only when collections are configured (§18)', () => {
    expect(panelHeightEstimates(configFrom({})).health).toBe(PANEL_HEIGHT_TARGET_PX.health);
    const withReadings = configFrom({ collections: [{ name: 'Printer', entities: ['sensor.demo_ink'] }] });
    expect(panelHeightEstimates(withReadings).health).toBe(PANEL_HEIGHT_TARGET_PX.health + 40);
    const manyGroups = configFrom({
      collections: Array.from({ length: 12 }, (_, index) => ({
        name: `Group ${index}`,
        entities: [`sensor.demo_g${index}`],
      })),
    });
    expect(panelHeightEstimates(manyGroups).health).toBe(PANEL_HEIGHT_TARGET_PX.health + 40);
  });

  it('Home changes with rooms, vacuums, appliances and shortcuts, health with collections only; every other panel keeps its target', () => {
    // Deliberate §18 update (review Q1): this test was "changes only Home".
    for (const scenario of DEMO_SCENARIO_IDS) {
      const result = validateConfig(demoCardInput(scenario));
      if (!result.ok) throw new Error(`the ${scenario} demo config must validate`);
      const estimates = panelHeightEstimates(result.config);
      for (const id of LEGACY_ORDER.filter((panel) => panel !== 'home' && panel !== 'health')) {
        expect(estimates[id], `${scenario} ${id}`).toBe(PANEL_HEIGHT_TARGET_PX[id]);
      }
      const readings = result.config.collections.length > 0 ? 40 : 0;
      expect(estimates.health, `${scenario} health`).toBe(PANEL_HEIGHT_TARGET_PX.health + readings);
    }
    const dense = validateConfig(demoCardInput('dense'));
    if (!dense.ok) throw new Error('the dense demo config must validate');
    expect(panelHeightEstimates(dense.config).home).toBeGreaterThan(PANEL_HEIGHT_TARGET_PX.home);
  });

  it('normal (the 1440×900 hard-gate reference) has no shortcuts or collections, so its estimates are unchanged', () => {
    const normal = validateConfig(demoCardInput('normal'));
    if (!normal.ok) throw new Error('the normal demo config must validate');
    expect(normal.config.shortcuts).toEqual({});
    expect(normal.config.collections).toEqual([]);
    expect(panelHeightEstimates(normal.config).health).toBe(PANEL_HEIGHT_TARGET_PX.health);
    expect(panelHeightEstimates(normal.config).home).toBe(PANEL_HEIGHT_TARGET_PX.home);
  });
});

describe('spare column height becomes Climate tiles (§16.14)', () => {
  const comfort = (devices: number) =>
    configFrom({ air: Array.from({ length: devices }, (_, index) => `fan.demo_air_${index}`) });
  const columns = (comfortColumn: number, tallestOther: number): MeasuredColumn[] => [
    { sections: ['agr-home', 'agr-upcoming'], naturalHeight: tallestOther },
    { sections: ['agr-today', 'agr-comfort', 'agr-media'], naturalHeight: comfortColumn },
    { sections: ['agr-cameras', 'agr-garage'], naturalHeight: tallestOther - 40 },
  ];
  const { comfortTiles: base, comfortTilesRoomy: roomy } = CONTENT_BUDGET;

  it('adds a second row once the Climate column is a tile row shorter than its tallest neighbour', () => {
    expect(nextComfortTileBudget(base, comfort(5), columns(700, 795))).toBe(base);
    expect(nextComfortTileBudget(base, comfort(5), columns(700, 796))).toBe(roomy);
  });

  it('keeps the second row until that column has become the tallest, so it never flips on one measurement', () => {
    expect(nextComfortTileBudget(roomy, comfort(5), columns(796, 796))).toBe(roomy);
    expect(nextComfortTileBudget(roomy, comfort(5), columns(797, 796))).toBe(base);
  });

  it('never raises the budget without devices to fill it, or in a single column', () => {
    expect(nextComfortTileBudget(base, comfort(2), columns(400, 900))).toBe(base);
    expect(nextComfortTileBudget(roomy, comfort(5), [{ sections: ['agr-comfort'], naturalHeight: 200 }])).toBe(base);
    expect(nextComfortTileBudget(roomy, comfort(5), [{ sections: ['agr-home'], naturalHeight: 200 }])).toBe(base);
  });
});

describe('how much column slack a stretched panel takes (§16.14)', () => {
  const column = (naturalHeight: number, stretchable = true) => ({ naturalHeight, stretchable });

  it('takes all of a small slack, so normal columns still align', () => {
    expect(slackAllowances(700, [column(700), column(661), column(687)])).toEqual([0, 39, 13]);
  });

  it(`takes at most ${MAX_ABSORBED_SLACK_PX} px of a large slack and leaves the rest below the column`, () => {
    expect(slackAllowances(1000, [column(1000), column(700)])).toEqual([0, MAX_ABSORBED_SLACK_PX]);
  });

  it(`takes the rest when the column would end within ${ALIGN_SNAP_PX} px of the tallest, never a near miss`, () => {
    const nearMiss = 1000 - MAX_ABSORBED_SLACK_PX - ALIGN_SNAP_PX;
    expect(slackAllowances(1000, [column(1000), column(nearMiss)])).toEqual([0, 1000 - nearMiss]);
    expect(slackAllowances(1000, [column(1000), column(nearMiss - 1)])).toEqual([0, MAX_ABSORBED_SLACK_PX]);
  });

  it('ends short columns that nearly meet at the lower bottom, so their voids only shrink', () => {
    // degraded at 1440: Today's column and Garage's column would end 29 px apart, both far above column 1.
    const [, today, garage] = slackAllowances(1052, [column(1052), column(753), column(724)]);
    expect(753 + (today ?? 0)).toBe(724 + (garage ?? 0));
    expect(today).toBeLessThan(MAX_ABSORBED_SLACK_PX);
    expect(garage).toBe(MAX_ABSORBED_SLACK_PX);
  });

  it('never stretches a column without a stretching panel, and keeps short columns apart when they differ clearly', () => {
    expect(slackAllowances(1000, [column(1000), column(900, false), column(600)])).toEqual([
      0,
      0,
      MAX_ABSORBED_SLACK_PX,
    ]);
    expect(slackAllowances(1000, [column(1000), column(700), column(600)])).toEqual([
      0,
      MAX_ABSORBED_SLACK_PX,
      MAX_ABSORBED_SLACK_PX,
    ]);
  });
});
