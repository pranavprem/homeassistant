/**
 * Home selectors (§4.8, §6.2.1, §7.1): the entry point for the Home section and its drawers over the rooms,
 * vacuums and appliances modules, plus the studio monitors script. Pure functions of SelectorInput: every
 * Availability comes from gateway.evaluate() and every ticket from gateway.status(), so the UI and the gateway can
 * never disagree about what a control does.
 *
 * The overview (selectHome) is cut to the content budget; the drawers use the uncut lists (selectHomeDetail,
 * selectRoom).
 */
import type { EntityId, ResolvedConfig } from '../config/schema.ts';
import type { ActionKey, ActionRequest, ActionStatus, Availability } from '../ha/actions/types.ts';
import type { HostReader } from '../ha/host.ts';
import { STUDIO_MONITORS_COPY } from './action-copy.ts';
import { CONTENT_BUDGET } from './budget.ts';
import { buildAppliance, cutAppliances } from './home/appliances.ts';
import { buildRoom, roomEntityIds, type HomeRoomVM } from './home/rooms.ts';
import { buildVacuum, vacuumEntityIds, vacuumPriority, type HomeVacuumVM } from './home/vacuums.ts';
import type { ApplianceVM, HomeVM, SelectorInput } from './types.ts';

export { applianceIcon } from './home/appliances.ts';
export {
  observedBrightnessPct,
  roomActionKeys,
  roomEntityIds,
  selectRoom,
  type HomeCurtainVM,
  type HomeLightVM,
  type HomeRoomVM,
} from './home/rooms.ts';
export type { HomeVacuumVM } from './home/vacuums.ts';

export interface HomeStudioMonitorsVM {
  readonly label: string;
  readonly availability: Availability;
  readonly pending?: ActionStatus;
}

export interface HomeOverviewVM extends HomeVM {
  readonly rooms: readonly HomeRoomVM[];
  readonly vacuums: readonly HomeVacuumVM[];
  readonly studioMonitors?: HomeStudioMonitorsVM;
  /** Active or not-reporting appliances beyond the budget (listed in the home drawer). */
  readonly appliancesOverflow: number;
  /** Lights reported on across every room, including rooms beyond the budget; null while not live. */
  readonly lightsOn: number | null;
  /** False when the configuration has no rooms, vacuums, appliances or studio monitors. */
  readonly configured: boolean;
}

export interface HomeDetailVM {
  readonly rooms: readonly HomeRoomVM[];
  readonly vacuums: readonly HomeVacuumVM[];
  readonly appliances: readonly ApplianceVM[];
}

/** Every entity Home reads (§2.2): rooms, vacuums with their devices' entities, appliances and the studio monitors. */
export function homeEntityIds(config: ResolvedConfig, reader: HostReader | undefined): EntityId[] {
  const ids: EntityId[] = [
    ...config.rooms.flatMap((_room, index) => roomEntityIds(config, index)),
    ...vacuumEntityIds(config, reader),
    ...config.appliances.flatMap((appliance) =>
      appliance.remaining === undefined ? [appliance.status] : [appliance.status, appliance.remaining],
    ),
  ];
  if (config.studioMonitors !== undefined) ids.push(config.studioMonitors);
  return [...new Set(ids)];
}

/** Ticket keys the overview and the home drawer watch: room quick toggles, vacuums and the studio monitors. */
export function homeActionKeys(config: ResolvedConfig): ActionKey[] {
  const keys: ActionKey[] = config.rooms.map((_room, index): ActionKey => `room:${index}`);
  for (const vacuum of config.vacuums) keys.push(`entity:${vacuum.entity}`);
  if (config.studioMonitors !== undefined) keys.push('studio_monitors');
  return keys;
}

export function selectHome(input: SelectorInput): HomeOverviewVM {
  const { config } = input;
  const rooms = config.rooms.map((_room, index) => buildRoom(input, index));
  const vacuums = config.vacuums.map((vacuum) => buildVacuum(input, vacuum));
  const appliances = config.appliances.map((appliance) => buildAppliance(input, appliance));
  const shownRooms = cutToBudget(rooms, CONTENT_BUDGET.rooms, (room) => (room.lightsOn > 0 ? 0 : 1));
  const shownVacuums = cutToBudget(vacuums, CONTENT_BUDGET.vacuums, vacuumPriority);
  const applianceCut = cutAppliances(appliances);
  const studioMonitors = buildStudioMonitors(input);
  return {
    rooms: shownRooms.map(({ item }) => item),
    roomsOverflow: rooms.length - shownRooms.length,
    vacuums: shownVacuums.map(({ item }) => item),
    vacuumsOverflow: vacuums.length - shownVacuums.length,
    appliances: applianceCut.shown,
    idleCount: applianceCut.idle,
    appliancesOverflow: applianceCut.overflow,
    ...(studioMonitors !== undefined && { studioMonitors }),
    lightsOn: input.store.isReady() && input.store.isConnected() ? sum(rooms.map((room) => room.lightsOn)) : null,
    configured:
      config.rooms.length + config.vacuums.length + config.appliances.length > 0 || config.studioMonitors !== undefined,
  };
}

/** Everything, uncut and in configuration order, for the "All rooms and devices" drawer. */
export function selectHomeDetail(input: SelectorInput): HomeDetailVM {
  const { config } = input;
  return {
    rooms: config.rooms.map((_room, index) => buildRoom(input, index)),
    vacuums: config.vacuums.map((vacuum) => buildVacuum(input, vacuum)),
    appliances: config.appliances.map((appliance) => buildAppliance(input, appliance)),
  };
}

/**
 * Picks at most `budget` items, lowest priority value first and configuration order within a priority, then
 * returns them in configuration order: the overview never reshuffles because one room's lights changed.
 */
function cutToBudget<T>(
  items: readonly T[],
  budget: number,
  priority: (item: T) => number,
): { item: T; index: number }[] {
  const indexed = items.map((item, index) => ({ item, index }));
  const chosen = [...indexed].sort((a, b) => priority(a.item) - priority(b.item) || a.index - b.index).slice(0, budget);
  return chosen.sort((a, b) => a.index - b.index);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Studio monitors

function buildStudioMonitors(input: SelectorInput): HomeStudioMonitorsVM | undefined {
  if (input.config.studioMonitors === undefined) return undefined;
  const request: ActionRequest = { kind: 'studio_monitors.run' };
  const pending = input.gateway.status('studio_monitors');
  return {
    label: STUDIO_MONITORS_COPY.label,
    availability: input.gateway.evaluate(request),
    ...(pending !== undefined && { pending }),
  };
}
