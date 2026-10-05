/**
 * Cameras fixture (§10.2). Fictional cameras only; demo stills are generated SVG scenes, never photos, so no
 * image data lives here.
 *
 * - normal (and offline, alert, loading, restricted, starting): four cameras, Hall with privacy on and Courtyard
 *   bound to a privacy entity that reads off, so it is visible and the dev shell's "Outage change" can turn a
 *   visible camera private during an outage (§10.3, §12.2).
 * - degraded: every closed state at once: one camera offline, one privacy on, one privacy entity unknown, one
 *   privacy entity reporting an unexpected string ("enabled"), so the gate's fail-closed paths are reviewable.
 * - dense: eight cameras, two with privacy (one inverted: an "enabled" switch where off means private), one
 *   "Live view on request" camera, one slow cadence, a long name, and the second camera answering 403.
 * - empty: no cameras, so the panel is hidden.
 * The restricted scenario's session-level 401 comes from its ScenarioSpec, not from here.
 */
import type { CardConfigInput, DemoScenarioId } from '../../config/schema.ts';
import { demoEntity, type DemoBehavior, type FixtureClock, type SectionFixture } from '../fixture-types.ts';
import type { HassEntityLike } from '../../ha/types.ts';

type CameraInput = NonNullable<CardConfigInput['cameras']>[number];

interface DemoCamera {
  readonly input: CameraInput;
  readonly state: string;
  /** State of the camera's privacy entity, when it has one. */
  readonly privacyState?: string;
  readonly privacyName?: string;
}

const FRONT_GATE = 'camera.demo_front_gate';
const SIDE_PATH = 'camera.demo_side_path';
const COURTYARD = 'camera.demo_courtyard';
const HALL = 'camera.demo_hall';
const HALL_PRIVACY = 'switch.demo_hall_camera_privacy';
const SIDE_PATH_PRIVACY = 'switch.demo_side_path_camera_privacy';
const COURTYARD_PRIVACY = 'binary_sensor.demo_courtyard_camera_privacy';
const LANDING_ENABLED = 'switch.demo_landing_camera_enabled';
/** Slow cadence for the dense scenario's far camera, in seconds. */
const SLOW_SNAPSHOT_INTERVAL_S = 30;

const HALL_CAMERA: DemoCamera = {
  input: { entity: HALL, name: 'Hall', privacy_entity: HALL_PRIVACY, privacy_on_value: 'on' },
  state: 'idle',
  privacyState: 'on',
  privacyName: 'Hall camera privacy',
};

const FRONT_GATE_CAMERA: DemoCamera = { input: { entity: FRONT_GATE, name: 'Front gate' }, state: 'idle' };
const SIDE_PATH_CAMERA: DemoCamera = { input: { entity: SIDE_PATH, name: 'Side path' }, state: 'idle' };

/** Courtyard with its privacy binding; the scenario decides what the privacy entity reads. */
function courtyardCamera(privacyState: string): DemoCamera {
  return {
    input: { entity: COURTYARD, name: 'Courtyard', privacy_entity: COURTYARD_PRIVACY, privacy_on_value: 'on' },
    state: 'idle',
    privacyState,
    privacyName: 'Courtyard camera privacy',
  };
}

const NORMAL: readonly DemoCamera[] = [FRONT_GATE_CAMERA, SIDE_PATH_CAMERA, courtyardCamera('off'), HALL_CAMERA];

const DEGRADED: readonly DemoCamera[] = [
  { input: { entity: FRONT_GATE, name: 'Front gate' }, state: 'unavailable' },
  {
    input: { entity: SIDE_PATH, name: 'Side path', privacy_entity: SIDE_PATH_PRIVACY, privacy_on_value: 'on' },
    state: 'idle',
    privacyState: 'unknown',
    privacyName: 'Side path camera privacy',
  },
  // Not 'on' or 'off': the gate must treat any unexpected string as unknown and stay closed.
  courtyardCamera('enabled'),
  HALL_CAMERA,
];

/** Dense keeps two privacy bindings (§10.2), so its Courtyard is unbound. */
const DENSE: readonly DemoCamera[] = [
  FRONT_GATE_CAMERA,
  SIDE_PATH_CAMERA,
  { input: { entity: COURTYARD, name: 'Courtyard' }, state: 'idle' },
  HALL_CAMERA,
  { input: { entity: 'camera.demo_workshop_door', name: 'Workshop door', thumbnails: false }, state: 'idle' },
  {
    input: {
      entity: 'camera.demo_garden_path',
      name: 'Garden path along the north wall',
      snapshot_interval: SLOW_SNAPSHOT_INTERVAL_S,
    },
    state: 'idle',
  },
  { input: { entity: 'camera.demo_kitchen_yard', name: 'Kitchen yard' }, state: 'streaming' },
  {
    input: {
      entity: 'camera.demo_upstairs_landing',
      name: 'Upstairs landing',
      privacy_entity: LANDING_ENABLED,
      privacy_on_value: 'off',
    },
    state: 'idle',
    privacyState: 'on',
    privacyName: 'Landing camera enabled',
  },
];

function camerasFor(scenario: DemoScenarioId): readonly DemoCamera[] {
  switch (scenario) {
    case 'empty':
      return [];
    case 'degraded':
      return DEGRADED;
    case 'dense':
      return DENSE;
    default:
      return NORMAL;
  }
}

function cameraStates(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike[] {
  return camerasFor(scenario).flatMap((camera) => {
    const states = [demoEntity(clock, camera.input.entity, camera.state, { friendly_name: camera.input.name })];
    const privacy = camera.input.privacy_entity;
    if (privacy !== undefined && camera.privacyState !== undefined) {
      states.push(demoEntity(clock, privacy, camera.privacyState, { friendly_name: camera.privacyName ?? privacy }));
    }
    return states;
  });
}

/** dense: the second camera answers 403, so only that tile reads "No access" (§10.2). */
function cameraBehaviors(scenario: DemoScenarioId): DemoBehavior[] {
  if (scenario !== 'dense') return [];
  return [{ entity: SIDE_PATH as DemoBehavior['entity'], snapshot: 'forbidden' }];
}

export const camerasFixture: SectionFixture = {
  config: (scenario) => {
    const cameras = camerasFor(scenario);
    return cameras.length === 0 ? {} : { cameras: cameras.map((camera) => ({ ...camera.input })) };
  },
  states: cameraStates,
  behaviors: cameraBehaviors,
};
