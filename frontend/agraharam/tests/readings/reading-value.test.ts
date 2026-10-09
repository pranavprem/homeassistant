/**
 * Reading value text (§18, design §7.3–§7.5 with review S1, S3 and S5): HA's own words where the frontend provides
 * them, compact household wording for durations, timestamps, uptime, dates, input_datetime and events, and an English
 * fallback with registry display precision and HA's binary-sensor words. Times are worded in the formatter's zone;
 * calendar dates and wall times are never shifted. Every value is capped. Fictional IDs only.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFormatter } from '../../src/ha/format.ts';
import type { LocaleLike } from '../../src/ha/types.ts';
import { capText, readingValue, type ReadingValueContext } from '../../src/model/reading-value.ts';
import { testEntity } from '../helpers/fake-store.ts';

const SERVER_ZONE = 'America/Los_Angeles';
/** e2e's pinned clock (§12.2): Wednesday 30 September 2026, 5:51 PM in the server zone. */
const NOW = new Date('2026-09-30T17:51:00-07:00');

function locale(overrides: Partial<LocaleLike> = {}): LocaleLike {
  return { language: 'en', number_format: 'language', time_format: '12', time_zone: 'server', ...overrides };
}

function context(options: { locale?: Partial<LocaleLike>; zone?: string; now?: Date; precision?: number } = {}) {
  const formatter = createFormatter({
    locale: locale(options.locale),
    serverTimeZone: options.zone ?? SERVER_ZONE,
    temperatureUnit: '°F',
  });
  const ctx: ReadingValueContext = {
    formatter,
    now: options.now ?? NOW,
    ...(options.precision !== undefined && { displayPrecision: options.precision }),
  };
  return ctx;
}

/** ICU differs on the space before AM/PM (U+0020 or U+202F); the assertions are about content. */
function value(id: string, state: string, attributes: Readonly<Record<string, unknown>> = {}, ctx = context()) {
  const result = readingValue(testEntity(id, state, attributes), ctx);
  return result.valid ? result.text.replace(/\s/g, ' ') : undefined;
}

describe('durations (§7.4): sensor and number rows with device_class duration and a numeric state', () => {
  it.each([
    ['sensor.demo_washer_time_left', '5100', 's', '1 h 25 min'],
    ['sensor.demo_router_uptime', '273600', 's', '3 d 4 h'],
    ['sensor.demo_hub_heartbeat', '45', 's', '45 s'],
    ['sensor.demo_pebble_main_brush_left', '112', 'h', '4 d 16 h'],
    ['sensor.demo_water_filter_days', '41', 'd', '41 d'],
    ['number.demo_sedan_charge_time_left', '1.25', 'h', '1 h 15 min'],
  ])('%s %s %s → %s', (id, state, unit, expected) => {
    expect(value(id, state, { device_class: 'duration', unit_of_measurement: unit })).toBe(expected);
  });

  it('a non-numeric state on a duration row is not reinterpreted (HA cannot produce one; shown as written)', () => {
    expect(value('sensor.demo_odd', '1:25:00', { device_class: 'duration', unit_of_measurement: 'h' })).toBe('1:25:00');
  });

  it('a numeric duration in an unknown unit is shown as HA would, not converted', () => {
    expect(value('sensor.demo_odd', '3', { device_class: 'duration', unit_of_measurement: 'weeks' })).toBe('3 weeks');
  });

  it('a time-of-day text without the duration class stays text, and a plain number stays a number', () => {
    expect(value('sensor.demo_alarm_time', '07:30:00')).toBe('07:30:00');
    expect(value('sensor.demo_seconds', '5100', { unit_of_measurement: 's' })).toBe('5,100 s');
  });

  it('only sensor and number rows are read as durations', () => {
    expect(value('input_text.demo_note', '5100', { device_class: 'duration', unit_of_measurement: 's' })).toBe('5100');
  });
});

describe('timestamps (§7.5 whenText, in the formatter zone)', () => {
  const at = (iso: string) => value('sensor.demo_printer_finish', iso, { device_class: 'timestamp' });

  it.each([
    ['2026-09-30T18:26:00-07:00', '6:26 PM'],
    ['2026-09-30T00:05:00-07:00', '12:05 AM'],
    ['2026-10-01T07:40:00-07:00', 'Tomorrow, 7:40 AM'],
    ['2026-09-29T19:40:00-07:00', 'Yesterday, 7:40 PM'],
    ['2026-10-03T19:40:00-07:00', 'Oct 3, 7:40 PM'],
    ['2026-09-24T08:00:00-07:00', 'Sep 24, 8:00 AM'],
    ['2026-09-12T07:40:00-07:00', 'Sep 12'],
    ['2026-12-25T09:00:00-08:00', 'Dec 25'],
    ['2025-09-12T07:40:00-07:00', 'Sep 12, 2025'],
    ['2027-01-02T07:40:00-08:00', 'Jan 2, 2027'],
  ])('%s → %s', (iso, expected) => {
    expect(at(iso)).toBe(expected);
  });

  it('accepts UTC and fractional seconds, as HA writes them', () => {
    expect(at('2026-10-01T01:26:00.123456+00:00')).toBe('6:26 PM');
    expect(at('2026-10-01T01:26:00Z')).toBe('6:26 PM');
  });

  it.each(['garbage', '2026-09-30', '2026-09-30T17:00:00', '2026-09-30 17:00:00', '', 'unknown', '1727740260'])(
    'refuses %j as no reading (never a guessed local time)',
    (state) => {
      expect(at(state)).toBeUndefined();
    },
  );

  it('rolls over at midnight in the server zone, not the device zone', () => {
    const lateEvening = new Date('2026-09-30T23:59:00-07:00');
    const ctx = context({ now: lateEvening });
    expect(value('sensor.demo_t', '2026-10-01T00:01:00-07:00', { device_class: 'timestamp' }, ctx)).toBe(
      'Tomorrow, 12:01 AM',
    );
    // 05:30 UTC on 1 October is 10:30 PM on 30 September in Los Angeles, but 11:00 AM on 1 October in Kolkata.
    expect(value('sensor.demo_t', '2026-10-01T05:30:00Z', { device_class: 'timestamp' })).toBe('10:30 PM');
    const kolkata = context({ zone: 'Asia/Kolkata' });
    expect(value('sensor.demo_t', '2026-10-01T05:30:00Z', { device_class: 'timestamp' }, kolkata)).toBe('11:00 AM');
  });

  it('words a time across the DST change by its own wall time (both 1:30 AMs on 1 November)', () => {
    const ctx = context({ now: new Date('2026-10-31T21:00:00-07:00') });
    expect(value('sensor.demo_t', '2026-11-01T08:30:00Z', { device_class: 'timestamp' }, ctx)).toBe(
      'Tomorrow, 1:30 AM',
    );
    expect(value('sensor.demo_t', '2026-11-01T09:30:00Z', { device_class: 'timestamp' }, ctx)).toBe(
      'Tomorrow, 1:30 AM',
    );
    const after = context({ now: new Date('2026-11-01T12:00:00-08:00') });
    expect(value('sensor.demo_t', '2026-11-01T20:00:00Z', { device_class: 'timestamp' }, after)).toBe('12:00 PM');
  });

  it('follows the 24-hour profile setting', () => {
    const ctx = context({ locale: { time_format: '24' } });
    expect(value('sensor.demo_t', '2026-10-01T07:40:00-07:00', { device_class: 'timestamp' }, ctx)).toBe(
      'Tomorrow, 07:40',
    );
  });
});

describe('uptime (core 2026.9 device class, review S3)', () => {
  it('reads "Since …" from the ISO moment the device came up', () => {
    expect(value('sensor.demo_hub_up_since', '2026-09-21T07:40:00-07:00', { device_class: 'uptime' })).toBe(
      'Since Sep 21',
    );
    expect(value('sensor.demo_hub_up_since', '2026-09-28T07:40:00-07:00', { device_class: 'uptime' })).toBe(
      'Since Sep 28, 7:40 AM',
    );
    expect(value('sensor.demo_hub_up_since', '2026-09-30T06:00:00-07:00', { device_class: 'uptime' })).toBe(
      'Since 6:00 AM',
    );
  });

  it('refuses an unreadable uptime state, never raw ISO text', () => {
    expect(value('sensor.demo_hub_up_since', 'sometime', { device_class: 'uptime' })).toBeUndefined();
  });
});

describe('calendar dates (sensor device_class date), never parsed as UTC midnight', () => {
  const date = (state: string, ctx = context()) =>
    value('sensor.demo_next_bin_day', state, { device_class: 'date' }, ctx);

  it.each([
    ['2026-09-30', 'Today'],
    ['2026-10-01', 'Tomorrow'],
    ['2026-09-29', 'Yesterday'],
    ['2026-07-06', 'Jul 6'],
    ['2025-12-31', 'Dec 31, 2025'],
  ])('%s → %s', (state, expected) => {
    expect(date(state)).toBe(expected);
  });

  it('keeps the calendar day in a zone west of UTC late in the evening', () => {
    const ctx = context({ now: new Date('2026-09-30T23:30:00-07:00') });
    expect(date('2026-10-01', ctx)).toBe('Tomorrow');
    expect(date('2026-09-30', ctx)).toBe('Today');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-9-3', '30/09/2026', '2026-09-30T00:00:00Z', ''])(
    'refuses %j as no reading',
    (state) => {
      expect(date(state)).toBeUndefined();
    },
  );
});

describe('input_datetime: wall time as set, never converted', () => {
  const both = { has_date: true, has_time: true };
  it('date and time, date only and time only', () => {
    expect(value('input_datetime.demo_reminder', '2026-10-01 07:30:00', both)).toBe('Tomorrow, 7:30 AM');
    expect(value('input_datetime.demo_reminder', '2026-07-06 18:00:00', both)).toBe('Jul 6, 6:00 PM');
    expect(value('input_datetime.demo_hvac_filter_changed', '2026-07-06', { has_date: true, has_time: false })).toBe(
      'Jul 6',
    );
    expect(value('input_datetime.demo_wake', '07:30:00', { has_date: false, has_time: true })).toBe('7:30 AM');
  });

  it('does not shift a wall time in any server zone, and follows the 24-hour setting', () => {
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      expect(value('input_datetime.demo_wake', '07:30:00', { has_time: true }, context({ zone })), zone).toBe(
        '7:30 AM',
      );
    }
    expect(
      value('input_datetime.demo_wake', '19:05:00', { has_time: true }, context({ locale: { time_format: '24' } })),
    ).toBe('19:05');
  });

  it.each([
    ['2026-10-01', both],
    ['07:30:00', { has_date: true, has_time: false }],
    ['2026-10-01 07:30:00', { has_date: false, has_time: true }],
    ['24:00:00', { has_time: true }],
    ['2026-10-01 07:30:00', {}],
  ])('refuses %j with %j as no reading', (state, attributes) => {
    expect(value('input_datetime.demo_x', state, attributes)).toBeUndefined();
  });
});

describe('events', () => {
  it('reads the event type, then when it last fired', () => {
    expect(value('event.demo_doorbell_button', '2026-09-30T17:39:00-07:00', { event_type: 'single_press' })).toBe(
      'Single press, 5:39 PM',
    );
    expect(value('event.demo_doorbell_button', '2026-09-30T17:39:00-07:00')).toBe('5:39 PM');
  });

  it('uses HA’s translated event type when the frontend provides one', () => {
    const formatter = createFormatter({
      locale: locale(),
      serverTimeZone: SERVER_ZONE,
      temperatureUnit: '°F',
      formatEntityAttributeValue: (_entity, attribute) => (attribute === 'event_type' ? 'Pressed once' : ''),
    });
    expect(
      value(
        'event.demo_doorbell_button',
        '2026-09-30T17:39:00-07:00',
        { event_type: 'single_press' },
        { formatter, now: NOW },
      ),
    ).toBe('Pressed once, 5:39 PM');
  });

  it('caps a long event type at 40 characters and refuses a state that is not a time', () => {
    const long = value('event.demo_x', '2026-09-30T17:39:00-07:00', { event_type: 'x'.repeat(80) });
    expect(long?.split(',')[0]).toHaveLength(40);
    expect(value('event.demo_x', 'single_press', { event_type: 'single_press' })).toBeUndefined();
  });
});

describe('device domains (§7.3)', () => {
  it.each([
    ['light.demo_lamp', 'on', { brightness: 181 }, 'On, 71%'],
    ['light.demo_lamp', 'on', {}, 'On'],
    ['light.demo_lamp', 'off', { brightness: 181 }, 'Off'],
    ['fan.demo_attic_fan', 'on', { percentage: 40 }, 'On, 40%'],
    ['fan.demo_attic_fan', 'off', { percentage: 40 }, 'Off'],
    ['cover.demo_skylight', 'open', { current_position: 40 }, 'Open 40%'],
    ['cover.demo_skylight', 'open', { current_position: 100 }, 'Open'],
    ['cover.demo_skylight', 'open', {}, 'Open'],
    ['cover.demo_skylight', 'closed', { current_position: 0 }, 'Closed'],
    ['cover.demo_skylight', 'opening', {}, 'Opening'],
    ['cover.demo_skylight', 'closing', {}, 'Closing'],
    ['climate.demo_garage_heater', 'heat', { current_temperature: 55 }, 'Heat, 55° now'],
    ['climate.demo_garage_heater', 'heat_cool', {}, 'Heat cool'],
    ['input_text.demo_house_note', 'Recycling goes out Thursday', {}, 'Recycling goes out Thursday'],
    ['switch.demo_aquarium_pump', 'off', {}, 'Off'],
    ['input_boolean.demo_guest_mode', 'on', {}, 'On'],
    ['update.demo_hub_firmware', 'on', {}, 'Update available'],
    ['update.demo_router_firmware', 'off', {}, 'Up to date'],
    ['lock.demo_side_door', 'locked', {}, 'Locked'],
    ['media_player.demo_garage_radio', 'off', {}, 'Off'],
    ['vacuum.demo_pebble', 'docked', {}, 'Docked'],
    ['select.demo_dryer_mode', 'Delicate', {}, 'Delicate'],
    ['input_select.demo_house_mode', 'Evening', {}, 'Evening'],
  ])('%s %s %j → %s', (id, state, attributes, expected) => {
    expect(value(id, state, attributes)).toBe(expected);
  });

  it('spaces percentages as HA does for the profile language (S5)', () => {
    const de = context({ locale: { language: 'de' } });
    expect(value('light.demo_lamp', 'on', { brightness: 181 }, de)).toBe('On, 71 %');
    expect(value('cover.demo_skylight', 'open', { current_position: 40 }, de)).toBe('Open 40 %');
  });
});

describe('the English fallback for sensors, numbers and binary sensors', () => {
  it.each([
    ['sensor.demo_printer_progress', '42', { unit_of_measurement: '%' }, '42%'],
    ['sensor.demo_study_co2', '1180', { unit_of_measurement: 'ppm' }, '1,180 ppm'],
    ['sensor.demo_loft_pm25', '6.125', { unit_of_measurement: 'µg/m³' }, '6.13 µg/m³'],
    ['sensor.demo_fridge_temperature', '38', { unit_of_measurement: '°F' }, '38 °F'],
    ['number.demo_sedan_charge_limit', '80', { unit_of_measurement: '%' }, '80%'],
    ['sensor.demo_count', '7', {}, '7'],
    ['sensor.demo_printer_status', 'printing', {}, 'Printing'],
    ['sensor.demo_dishwasher_rinse_aid', 'low', {}, 'Low'],
    ['sensor.demo_status', 'out_of_paper', {}, 'Out of paper'],
  ])('%s %s %j → %s', (id, state, attributes, expected) => {
    expect(value(id, state, attributes)).toBe(expected);
  });

  it('uses the registry display precision exactly when set', () => {
    expect(value('sensor.demo_pm25', '6.125', { unit_of_measurement: 'µg/m³' }, context({ precision: 1 }))).toBe(
      '6.1 µg/m³',
    );
    expect(value('sensor.demo_tire', '41.6', { unit_of_measurement: 'psi' }, context({ precision: 0 }))).toBe('42 psi');
    expect(value('sensor.demo_tire', '41', { unit_of_measurement: 'psi' }, context({ precision: 2 }))).toBe(
      '41.00 psi',
    );
  });

  it.each([
    ['door', 'on', 'Open'],
    ['door', 'off', 'Closed'],
    ['window', 'off', 'Closed'],
    ['garage_door', 'on', 'Open'],
    ['moisture', 'on', 'Wet'],
    ['occupancy', 'on', 'Detected'],
    ['motion', 'off', 'Clear'],
    ['smoke', 'on', 'Detected'],
    ['battery', 'on', 'Low'],
    ['problem', 'off', 'OK'],
    ['problem', 'on', 'Problem'],
    ['connectivity', 'off', 'Disconnected'],
    ['lock', 'on', 'Unlocked'],
    ['plug', 'on', 'Plugged in'],
    ['running', 'off', 'Not running'],
    ['safety', 'on', 'Unsafe'],
    ['update', 'on', 'Update available'],
    [undefined, 'on', 'On'],
    ['unheard_of', 'off', 'Off'],
  ])('binary_sensor %s %s → %s', (deviceClass, state, expected) => {
    const attributes = deviceClass === undefined ? {} : { device_class: deviceClass };
    expect(value('binary_sensor.demo_x', state, attributes)).toBe(expected);
  });

  it('defers to HA’s own words when the frontend provides formatEntityState', () => {
    const formatEntityState = vi.fn(() => 'Geöffnet');
    const formatter = createFormatter({ locale: locale(), temperatureUnit: '°F', formatEntityState });
    expect(value('binary_sensor.demo_fridge_door', 'on', { device_class: 'door' }, { formatter, now: NOW })).toBe(
      'Geöffnet',
    );
    expect(formatEntityState).toHaveBeenCalledTimes(1);
  });
});

describe('read-only and bounded by construction', () => {
  it('never reads pictures, URLs, release notes or media fields, whatever the entity carries', () => {
    const hostile = {
      entity_picture: 'https://example.invalid/x.png',
      release_url: 'https://example.invalid/notes',
      release_summary: '<script>alert(1)</script>',
      media_title: '<img src=x onerror=alert(1)>',
      icon: 'mdi:skull',
      title: 'Firmware',
    };
    for (const [id, state] of [
      ['update.demo_hub_firmware', 'on'],
      ['media_player.demo_garage_radio', 'playing'],
      ['sensor.demo_x', 'printing'],
    ] as const) {
      const text = value(id, state, hostile) ?? '';
      expect(text, id).not.toMatch(/example\.invalid|script|onerror|mdi:|Firmware/);
    }
  });

  it('caps every value at 120 characters with an ellipsis, counting characters, not code units', () => {
    const long = value('input_text.demo_house_note', 'a'.repeat(300)) ?? '';
    expect([...long]).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
    const emoji = value('input_text.demo_house_note', '🪔'.repeat(200)) ?? '';
    expect([...emoji]).toHaveLength(120);
    expect(capText('short', 120)).toBe('short');
  });
});
