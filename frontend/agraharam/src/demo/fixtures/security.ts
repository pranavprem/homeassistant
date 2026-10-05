/**
 * Security fixture (§10.2). Fictional and clock-relative; every action role has its own guarded
 * script (§4.2 rule 6).
 *
 *   normal    alarm disarmed, policy "Auto", four entry points closed
 *   degraded  alarm state unknown (the longest pill label, §16.10); the back door open; suggested mode unavailable;
 *             commissioning interlock on
 *   alert     alarm triggered under policy "Hold Away"; Silence Sound runs without confirmation and its script never
 *             confirms, so the sent and then uncertain tickets can be captured
 *   dense     alarm armed vacation (the longest armed label) with a long controller health message
 *   empty     no security configured ("weather only"), so the header shows no alarm pill
 *   others    as normal
 */
import type { CardConfigInput, DemoScenarioId, EntityId, SecurityActionRole } from '../../config/schema.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { demoEntity, type DemoBehavior, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

const ALARM = 'alarm_control_panel.demo_home';
const POLICY = 'input_select.demo_security_policy';
const SUGGESTED_MODE = 'sensor.demo_security_suggested_mode';
const COMMISSIONING = 'input_boolean.demo_security_commissioning';
const HEALTH_TEXT = 'input_text.demo_security_health';

const PERIMETER = [
  { entity: 'binary_sensor.demo_front_door', name: 'Front door', deviceClass: 'door' },
  { entity: 'binary_sensor.demo_back_door', name: 'Back door', deviceClass: 'door' },
  { entity: 'binary_sensor.demo_patio_door', name: 'Patio door', deviceClass: 'door' },
  { entity: 'binary_sensor.demo_side_gate', name: 'Side gate', deviceClass: 'opening' },
] as const;
/** The entry point left open in 'degraded'. */
const DEGRADED_OPEN_ENTRY = 'binary_sensor.demo_back_door';

/** Each role has its own script (§4.2 rule 6). */
const ACTION_SCRIPTS: Readonly<Record<SecurityActionRole, { readonly entity: string; readonly name: string }>> = {
  silence_sound: { entity: 'script.demo_silence_sound', name: 'Silence sound' },
  disarm_hold: { entity: 'script.demo_disarm_hold', name: 'Disarm and hold' },
  resume_auto: { entity: 'script.demo_resume_auto', name: 'Resume auto arming' },
  hold_night: { entity: 'script.demo_hold_night', name: 'Hold night' },
  hold_away: { entity: 'script.demo_hold_away', name: 'Hold away' },
  hold_vacation: { entity: 'script.demo_hold_vacation', name: 'Hold vacation' },
  prepare_departure: { entity: 'script.demo_prepare_departure', name: 'Prepare garage departure' },
};

const POLICY_OPTIONS = ['Auto', 'Hold Night', 'Hold Away', 'Hold Vacation', 'Disarm Hold'] as const;

interface SecurityReadings {
  readonly alarm: string;
  readonly policy: (typeof POLICY_OPTIONS)[number];
  readonly suggested: string;
  readonly commissioning: 'on' | 'off';
  readonly health: string;
}

const NORMAL: SecurityReadings = {
  alarm: 'disarmed',
  policy: 'Auto',
  suggested: 'Disarmed',
  commissioning: 'off',
  health: 'Controller online',
};

const READINGS_BY_SCENARIO: Readonly<Partial<Record<DemoScenarioId, SecurityReadings>>> = Object.freeze({
  degraded: {
    alarm: 'unknown',
    policy: 'Auto',
    suggested: 'unavailable',
    commissioning: 'on',
    health: 'Back door contact reports open',
  },
  alert: {
    alarm: 'triggered',
    policy: 'Hold Away',
    suggested: 'Armed away',
    commissioning: 'off',
    // A controller status message, as health text is: never the alarm's cause (§8.1 keeps them apart).
    health: 'Controller online. Siren output active.',
  },
  dense: {
    alarm: 'armed_vacation',
    policy: 'Hold Vacation',
    suggested: 'Armed vacation',
    commissioning: 'off',
    health:
      'Controller online. Vacation hold active until resumed. Two entry sensors report low batteries and the patio ' +
      'contact last checked in 40 minutes ago, which is within its normal reporting window.',
  },
});

/** Minutes since the alarm last changed state. */
const ALARM_CHANGED_MIN_AGO = 180;
/** Minutes since each guarded script last ran, so last_triggered is a real timestamp. */
const SCRIPT_LAST_RUN_MIN_AGO = 1_440;

function readingsFor(scenario: DemoScenarioId): SecurityReadings {
  return READINGS_BY_SCENARIO[scenario] ?? NORMAL;
}

function hasSecurity(scenario: DemoScenarioId): boolean {
  return scenario !== 'empty';
}

function securityConfig(): NonNullable<CardConfigInput['security']> {
  return {
    alarm: ALARM,
    policy: POLICY,
    suggested_mode: SUGGESTED_MODE,
    commissioning: COMMISSIONING,
    health_text: HEALTH_TEXT,
    perimeter: PERIMETER.map(({ entity, name }) => ({ entity, name })),
    actions: Object.fromEntries(Object.entries(ACTION_SCRIPTS).map(([role, script]) => [role, script.entity])),
  };
}

function securityStates(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike[] {
  const readings = readingsFor(scenario);
  return [
    demoEntity(clock, ALARM, readings.alarm, { friendly_name: 'Home alarm' }, ALARM_CHANGED_MIN_AGO),
    demoEntity(clock, POLICY, readings.policy, { friendly_name: 'Security policy', options: [...POLICY_OPTIONS] }),
    demoEntity(clock, SUGGESTED_MODE, readings.suggested, { friendly_name: 'Suggested mode' }),
    demoEntity(clock, COMMISSIONING, readings.commissioning, { friendly_name: 'Commissioning interlock' }),
    demoEntity(clock, HEALTH_TEXT, readings.health, { friendly_name: 'Security health', max: 255 }),
    ...PERIMETER.map(({ entity, name, deviceClass }) =>
      demoEntity(clock, entity, scenario === 'degraded' && entity === DEGRADED_OPEN_ENTRY ? 'on' : 'off', {
        friendly_name: name,
        device_class: deviceClass,
      }),
    ),
    ...Object.values(ACTION_SCRIPTS).map(({ entity, name }) =>
      demoEntity(clock, entity, 'off', {
        friendly_name: name,
        last_triggered: clock.at(-SCRIPT_LAST_RUN_MIN_AGO),
        mode: 'single',
      }),
    ),
  ];
}

/** 'alert': the Silence Sound script never confirms, so its ticket goes sent → uncertain (§10.2). */
function securityBehaviors(scenario: DemoScenarioId): DemoBehavior[] {
  if (scenario !== 'alert') return [];
  return [{ entity: ACTION_SCRIPTS.silence_sound.entity as EntityId, onInvoke: 'never-confirm' }];
}

export const securityFixture: SectionFixture = {
  config: (scenario) => (hasSecurity(scenario) ? { security: securityConfig() } : {}),
  states: (scenario, clock) => (hasSecurity(scenario) ? securityStates(scenario, clock) : []),
  behaviors: securityBehaviors,
};
