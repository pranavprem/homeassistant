/**
 * Cameras selector (§4.8, §9.3). Pure: one CameraTileVM per configured camera, the overview cut to the §6.2.1
 * budget, and live-view availability from domain/live-view.ts.
 */
import { liveAvailability } from '../domain/live-view.ts';
import { cameraBindingKey, cameraGateFor, type CameraBinding } from '../ha/camera-gate.ts';
import { CONTENT_BUDGET } from './budget.ts';
import type { CamerasVM, CameraTileVM, SelectorInput } from './types.ts';

interface CamerasOptions {
  /** DashboardServices.preview: the dashboard is being edited, so no stream starts (§9.4). */
  readonly preview: boolean;
}

export function selectCameras(input: SelectorInput, options: CamerasOptions): CamerasVM {
  const all = selectAllCameraTiles(input, options);
  const tiles = all.slice(0, CONTENT_BUDGET.cameras);
  return Object.freeze({
    tiles,
    overflow: all.length - tiles.length,
    privateCount: countPrivate(all),
  });
}

/** Every configured camera, in config order (the cameras drawer shows all of them). */
export function selectAllCameraTiles(input: SelectorInput, options: CamerasOptions): readonly CameraTileVM[] {
  const phaseConnected = input.reader.connection().phase === 'connected';
  return Object.freeze(input.config.cameras.map((camera) => selectCameraTile(input, camera, options, phaseConnected)));
}

function selectCameraTile(
  input: SelectorInput,
  camera: CameraBinding,
  options: CamerasOptions,
  phaseConnected = input.reader.connection().phase === 'connected',
): CameraTileVM {
  const gate = cameraGateFor(input.store, camera, phaseConnected);
  return Object.freeze({
    key: camera.entity,
    name: camera.name,
    binding: cameraBindingKey(camera),
    gate,
    thumbnails: camera.thumbnails,
    intervalMs: camera.snapshotIntervalMs,
    ...(camera.live && { live: liveAvailability(camera, gate, options.preview) }),
  });
}

/**
 * Cameras whose privacy is known to be on: the "N private" pill counts these only. A privacy state that is unknown
 * keeps its camera closed too, but is not claimed as private.
 */
export function countPrivate(tiles: readonly CameraTileVM[]): number {
  return tiles.filter((tile) => tile.gate.kind === 'privacy' && tile.gate.certainty === 'on').length;
}
