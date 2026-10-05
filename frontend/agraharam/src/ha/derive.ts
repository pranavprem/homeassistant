/**
 * Derived bindings (§4.2 rule 10, §4.4). Core 2026.9 removed the vacuum `battery_level` attribute, so a vacuum
 * configured without `battery_sensor` takes the battery sensor of its own device, as HA's more-info does. Derived
 * IDs live in the store's separate derived set and are never actionable: the gateway allowlist reads only
 * config.bindings.
 */
import { domainOf } from '../config/entity-id.ts';
import type { EntityId } from '../config/schema.ts';
import type { HassEntityLike, RegistryEntryLike } from './types.ts';

export interface DeriveSources {
  registry(id: EntityId): RegistryEntryLike | undefined;
  entitiesOnDevice(deviceId: string): readonly EntityId[];
  state(id: EntityId): HassEntityLike | undefined;
}

/** vacuum → its device's battery sensor, for each vacuum that has one. */
export function deriveVacuumBatteries(vacuums: readonly EntityId[], sources: DeriveSources): Map<EntityId, EntityId> {
  const batteries = new Map<EntityId, EntityId>();
  for (const vacuum of vacuums) {
    const battery = batterySensorOnSameDevice(vacuum, sources);
    if (battery !== undefined) batteries.set(vacuum, battery);
  }
  return batteries;
}

/** The entities on the devices of `vacuums`: a state first appearing for any of them triggers re-derivation. */
export function vacuumDeviceEntities(vacuums: readonly EntityId[], sources: DeriveSources): EntityId[] {
  return vacuums.flatMap((vacuum) => {
    const deviceId = sources.registry(vacuum)?.device_id;
    return deviceId ? sources.entitiesOnDevice(deviceId) : [];
  });
}

// `battery` is a state attribute, not a registry field, so a sensor whose state has not arrived yet is invisible.
function batterySensorOnSameDevice(vacuum: EntityId, sources: DeriveSources): EntityId | undefined {
  const deviceId = sources.registry(vacuum)?.device_id;
  if (!deviceId) return undefined;
  return sources
    .entitiesOnDevice(deviceId)
    .find((id) => domainOf(id) === 'sensor' && sources.state(id)?.attributes['device_class'] === 'battery');
}

/** deviceId → entity IDs, built once per registry object. */
export function indexEntitiesByDevice(
  entries: Readonly<Record<string, RegistryEntryLike>> | readonly RegistryEntryLike[] | undefined,
): Map<string, EntityId[]> {
  const byDevice = new Map<string, EntityId[]>();
  const list = entries === undefined ? [] : Array.isArray(entries) ? entries : Object.values(entries);
  for (const entry of list as readonly RegistryEntryLike[]) {
    if (!entry.device_id) continue;
    const ids = byDevice.get(entry.device_id) ?? [];
    ids.push(entry.entity_id as EntityId);
    byDevice.set(entry.device_id, ids);
  }
  return byDevice;
}
