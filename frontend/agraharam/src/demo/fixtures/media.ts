/**
 * Media fixture (§10.2). Fictional players and titles only, and no artwork: `entity_picture` is never set or
 * read (§1.3). `normal` has one player playing and one off, so the overview shows the playing one; `degraded` has
 * every player off and the first rejecting calls with a lost connection; `dense` has four players with long names
 * and titles for truncation.
 */
import type { CardConfigInput, DemoScenarioId, EntityId } from '../../config/schema.ts';
import { MEDIA_PLAYER_FEATURE as MEDIA } from '../../ha/features.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { demoEntity, type DemoBehavior, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

const MAIN_PLAYER = 'media_player.demo_living_room';
const STUDIO = 'media_player.demo_studio';
const KITCHEN = 'media_player.demo_kitchen_speaker';
const VERANDA = 'media_player.demo_veranda_speaker';

const PLAYER_FEATURES =
  MEDIA.PAUSE |
  MEDIA.PLAY |
  MEDIA.PREVIOUS_TRACK |
  MEDIA.NEXT_TRACK |
  MEDIA.VOLUME_SET |
  MEDIA.VOLUME_MUTE |
  MEDIA.SELECT_SOURCE;
/** A simple speaker: play, pause and volume only, so transport shows just what it supports. */
const SPEAKER_FEATURES = MEDIA.PAUSE | MEDIA.PLAY | MEDIA.VOLUME_SET;
const MAIN_PLAYER_SOURCES = ['Demo Music', 'Demo Radio', 'TV', 'Turntable', 'Bluetooth'];
/** Minutes since a switched-off player last changed. */
const OFF_FOR_MIN = 600;

function mainPlayer(clock: FixtureClock, scenario: DemoScenarioId): HassEntityLike {
  if (scenario === 'degraded') {
    // Off, but still offering its sources: choosing one reaches the connection-lost behavior below.
    return demoEntity(clock, MAIN_PLAYER, 'off', {
      friendly_name: 'Living room',
      source: 'TV',
      source_list: MAIN_PLAYER_SOURCES,
      supported_features: PLAYER_FEATURES,
    });
  }
  const dense = scenario === 'dense';
  return demoEntity(clock, MAIN_PLAYER, 'playing', {
    friendly_name: 'Living room',
    media_title: dense
      ? 'An unusually long evening raga recording that keeps going well past the edge'
      : 'Evening raga',
    media_artist: dense ? 'The fictional courtyard ensemble and friends' : 'Demo ensemble',
    app_name: 'Demo Music',
    source: 'Demo Music',
    source_list: MAIN_PLAYER_SOURCES,
    volume_level: 0.35,
    is_volume_muted: false,
    supported_features: PLAYER_FEATURES,
  });
}

function studio(clock: FixtureClock, scenario: DemoScenarioId): HassEntityLike {
  if (scenario === 'dense') {
    return demoEntity(clock, STUDIO, 'paused', {
      friendly_name: 'Studio',
      media_title: 'Monsoon theme',
      media_artist: 'Demo quartet',
      app_name: 'Demo Music',
      source: 'Demo Music',
      source_list: ['Demo Music', 'Line in'],
      volume_level: 0.2,
      is_volume_muted: true,
      supported_features: PLAYER_FEATURES,
    });
  }
  return demoEntity(
    clock,
    STUDIO,
    'off',
    { friendly_name: 'Studio', supported_features: PLAYER_FEATURES },
    OFF_FOR_MIN,
  );
}

function denseExtras(clock: FixtureClock): readonly HassEntityLike[] {
  return [
    demoEntity(clock, KITCHEN, 'idle', {
      friendly_name: 'Kitchen speaker',
      volume_level: 0.5,
      supported_features: SPEAKER_FEATURES,
    }),
    demoEntity(
      clock,
      VERANDA,
      'off',
      { friendly_name: 'Veranda speaker', supported_features: SPEAKER_FEATURES },
      OFF_FOR_MIN,
    ),
  ];
}

function config(scenario: DemoScenarioId): Partial<CardConfigInput> {
  if (scenario === 'empty') return {};
  const media = [
    { entity: MAIN_PLAYER, name: 'Living room' },
    { entity: STUDIO, name: 'Studio' },
  ];
  if (scenario !== 'dense') return { media };
  return {
    media: [
      ...media,
      { entity: KITCHEN, name: 'Kitchen speaker beside the long pantry shelf' },
      { entity: VERANDA, name: 'Veranda speaker' },
    ],
  };
}

function states(scenario: DemoScenarioId, clock: FixtureClock): readonly HassEntityLike[] {
  switch (scenario) {
    case 'empty':
      return [];
    case 'dense':
      return [mainPlayer(clock, scenario), studio(clock, scenario), ...denseExtras(clock)];
    default:
      return [mainPlayer(clock, scenario), studio(clock, scenario)];
  }
}

function behaviors(scenario: DemoScenarioId): readonly DemoBehavior[] {
  // degraded: the first player drops the connection mid-call, so a tap ends uncertain('connection-lost').
  return scenario === 'degraded' ? [{ entity: MAIN_PLAYER as EntityId, onInvoke: 'connection-lost' }] : [];
}

export const mediaFixture: SectionFixture = { config, states, behaviors };
