/**
 * Media selectors (§4.8, §7.1). Each configured player becomes a MediaPlayerVM whose controls exist only for
 * the feature bits the player reports; the gateway then decides whether each one is usable right now. The overview
 * shows one player, chosen by the active-player rule. No artwork: `entity_picture` is never read (§1.3).
 */
import type { EntityId, Ref } from '../config/schema.ts';
import type { ActionGateway, ActionKey, ActionRequest, Availability } from '../ha/actions/types.ts';
import { hasFeatures, MEDIA_PLAYER_FEATURE as MEDIA } from '../ha/features.ts';
import { ABSENT_LABELS, normalizeEntity, parseNumericValue, readableEntity } from '../ha/normalize.ts';
import type { HassEntityLike } from '../ha/types.ts';
import { humanizeOption, selectChoice, stringList } from './choice.ts';
import { entityActionKey } from './controls.ts';
import { friendlyName } from './display.ts';
import type { ChoiceVM, MediaPlayerVM, MediaVM, SelectorInput } from './types.ts';

const FALLBACK_NAME = 'Media player';
/** Media text comes from apps and broadcasts; it is capped so one runaway title cannot bloat the DOM. */
const MAX_TITLE_CHARS = 200;
const MAX_LABEL_CHARS = 80;
const VOLUME_PROBE = 0.5;

const PLAYBACK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  playing: 'Playing',
  paused: 'Paused',
  buffering: 'Buffering',
  idle: 'Idle',
  on: 'On',
  off: 'Off',
  standby: 'Standby',
});

/** Players that are switched off show the compact "Off" row instead of transport controls. */
export const OFF_PLAYBACK: ReadonlySet<string> = new Set(['off', 'standby']);

export function selectMedia(input: SelectorInput): MediaVM {
  const players = input.config.media.map((ref) => selectMediaPlayer(input, ref));
  const active = activePlayer(players);
  return { players, ...(active !== undefined && { activeKey: active.key }) };
}

/** §4.8: the first playing player, else the first paused, else the first available, else the first configured. */
export function activePlayer(players: readonly MediaPlayerVM[]): MediaPlayerVM | undefined {
  return (
    players.find((player) => player.playback === 'playing') ??
    players.find((player) => player.playback === 'paused') ??
    players.find((player) => player.status === 'available') ??
    players[0]
  );
}

export function mediaEntityIds(config: SelectorInput['config']): readonly EntityId[] {
  return config.media.map((ref) => ref.entity);
}

export function mediaActionKeys(config: SelectorInput['config']): readonly ActionKey[] {
  return config.media.map((ref) => entityActionKey(ref.entity));
}

export function selectMediaPlayer(input: SelectorInput, ref: Ref): MediaPlayerVM {
  const id = ref.entity;
  const normalized = normalizeEntity(input.store, id);
  const name = friendlyName(input.store, id, ref.name, FALLBACK_NAME);
  const pending = input.gateway.status(entityActionKey(id));
  const entity = readableEntity(normalized);
  const base = { key: id, name, status: normalized.status, ...(pending !== undefined && { pending }) };
  if (entity === undefined) {
    const label = normalized.status === 'available' ? ABSENT_LABELS['no-data'] : ABSENT_LABELS[normalized.status];
    return { ...base, playback: normalized.status, playbackLabel: label };
  }
  const features = entity.attributes['supported_features'];
  const supports = (bit: number): boolean => hasFeatures(features, [bit]);
  const transport = (bit: number, req: ActionRequest): Availability | undefined =>
    supports(bit) ? input.gateway.evaluate(req) : undefined;
  const title = textAttribute(entity, ['media_title'], MAX_TITLE_CHARS);
  const subtitle = textAttribute(
    entity,
    ['media_artist', 'media_album_artist', 'media_series_title', 'media_album_name'],
    MAX_TITLE_CHARS,
  );
  const app = textAttribute(entity, ['app_name'], MAX_LABEL_CHARS);
  const source = textAttribute(entity, ['source'], MAX_LABEL_CHARS);
  const play = transport(MEDIA.PLAY, { kind: 'media.play', entity: id });
  const pause = transport(MEDIA.PAUSE, { kind: 'media.pause', entity: id });
  const next = transport(MEDIA.NEXT_TRACK, { kind: 'media.next', entity: id });
  const previous = transport(MEDIA.PREVIOUS_TRACK, { kind: 'media.previous', entity: id });
  const volume = supports(MEDIA.VOLUME_SET) ? selectVolume(input.gateway, id, entity) : undefined;
  const mute = supports(MEDIA.VOLUME_MUTE) ? selectMute(input.gateway, id, entity) : undefined;
  const sources = supports(MEDIA.SELECT_SOURCE) ? selectSources(input, id, entity, name) : undefined;
  return {
    ...base,
    playback: entity.state,
    playbackLabel: PLAYBACK_LABELS[entity.state] ?? humanizeOption(entity.state),
    ...(title !== undefined && { title }),
    ...(subtitle !== undefined && { subtitle }),
    ...(app !== undefined && { app }),
    ...(source !== undefined && { source }),
    ...(play !== undefined && { play }),
    ...(pause !== undefined && { pause }),
    ...(next !== undefined && { next }),
    ...(previous !== undefined && { previous }),
    ...(volume !== undefined && { volume }),
    ...(mute !== undefined && { mute }),
    ...(sources !== undefined && { sources }),
  };
}

/** The first non-empty string among `keys`, trimmed and capped. */
function textAttribute(entity: HassEntityLike, keys: readonly string[], max: number): string | undefined {
  for (const key of keys) {
    const value = entity.attributes[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, max);
  }
  return undefined;
}

/** volume_level is 0–1; anything else (null, out of range) is "no data", never 0 (§4.6). */
export function volumeLevel(entity: HassEntityLike): number | null {
  const level = parseNumericValue(entity.attributes['volume_level']);
  return level !== null && level >= 0 && level <= 1 ? level : null;
}

function selectVolume(gateway: ActionGateway, entity: EntityId, state: HassEntityLike): MediaPlayerVM['volume'] {
  const level = volumeLevel(state);
  return { level, availability: gateway.evaluate({ kind: 'media.volume_set', entity, level: level ?? VOLUME_PROBE }) };
}

function selectMute(gateway: ActionGateway, entity: EntityId, state: HassEntityLike): MediaPlayerVM['mute'] {
  const raw = state.attributes['is_volume_muted'];
  const muted = typeof raw === 'boolean' ? raw : null;
  return { muted, availability: gateway.evaluate({ kind: 'media.volume_mute', entity, muted: muted !== true }) };
}

/** The player's own `source_list`, shown and sent exactly as reported (§7.1 "∈ source_list (exact)"). */
function selectSources(
  input: SelectorInput,
  entity: EntityId,
  state: HassEntityLike,
  name: string,
): ChoiceVM | undefined {
  const values = stringList(state.attributes['source_list']);
  if (values.length === 0) return undefined;
  const current = state.attributes['source'];
  return selectChoice(input.gateway, {
    label: 'Source',
    kind: 'source',
    values,
    current: typeof current === 'string' ? current : undefined,
    labelOf: (value) => value,
    request: (source) => ({ kind: 'media.select_source', entity, source }),
    deviceName: name,
    pending: input.gateway.status(entityActionKey(entity)),
  });
}
