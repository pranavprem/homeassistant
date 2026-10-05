/** Media selectors and panel (§4.8, §7.1; §12.1 row 8): controls only for supported bits, the active-player
 *  rule, exact sources, null volume never 0, the compact "Off" row, plum primary, no artwork, debounced volume. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observedVolumePercent, type AgrMediaPlayer } from '../../src/components/media/agr-media-player.ts';
import type { AgrMedia } from '../../src/components/media/agr-media.ts';
import '../../src/components/media/agr-media.ts';
import type { OpenDrawerDetail } from '../../src/components/shell/overlay-types.ts';
import { SLIDER_COMMIT_DEBOUNCE_MS } from '../../src/ha/actions/types.ts';
import { MEDIA_PLAYER_FEATURE as MEDIA } from '../../src/ha/features.ts';
import { activePlayer, selectMedia, selectMediaPlayer } from '../../src/model/media.ts';
import { deepQueryAll, settle } from '../helpers/dom.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import {
  listenOnBody,
  lockingGateway,
  mountElement,
  removeBodyListeners,
  requestsOf,
  selectorInputFor,
  servicesFor,
} from '../comfort/support.ts';

afterEach(removeBodyListeners);
const LIVING = 'media_player.demo_living_room';
const STUDIO = 'media_player.demo_studio';
const ALL =
  MEDIA.PAUSE |
  MEDIA.PLAY |
  MEDIA.PREVIOUS_TRACK |
  MEDIA.NEXT_TRACK |
  MEDIA.VOLUME_SET |
  MEDIA.VOLUME_MUTE |
  MEDIA.SELECT_SOURCE;

function player(id: string, state: string, attributes: Record<string, unknown> = {}) {
  return testEntity(id, state, {
    media_title: 'Evening raga',
    media_artist: 'Demo ensemble',
    source: 'Demo Music',
    source_list: ['Demo Music', 'TV', 'line_in'],
    volume_level: 0.35,
    is_volume_muted: false,
    supported_features: ALL,
    ...attributes,
  });
}

function vmFor(state: ReturnType<typeof player> | undefined, store = {}) {
  const input = selectorInputFor(state === undefined ? [] : [state], { config: { media: [LIVING] }, store });
  return selectMediaPlayer(input, { entity: entityId(LIVING), name: 'Living room' });
}

describe('media player selector', () => {
  it('reads title, subtitle, source and volume, with every supported control', () => {
    const vm = vmFor(player(LIVING, 'playing'));
    expect(vm).toMatchObject({
      name: 'Living room',
      status: 'available',
      playback: 'playing',
      playbackLabel: 'Playing',
      title: 'Evening raga',
      subtitle: 'Demo ensemble',
      source: 'Demo Music',
      volume: { level: 0.35 },
      mute: { muted: false },
    });
    for (const control of ['play', 'pause', 'next', 'previous'] as const) expect(vm[control]).toBeDefined();
  });

  it.each([
    [MEDIA.PLAY, ['play']],
    [MEDIA.PAUSE, ['pause']],
    [MEDIA.NEXT_TRACK | MEDIA.PREVIOUS_TRACK, ['next', 'previous']],
    [0, []],
  ] as const)('offers transport only for its feature bits (%i)', (bits, offered) => {
    const vm = vmFor(player(LIVING, 'playing', { supported_features: bits }));
    for (const control of ['play', 'pause', 'next', 'previous'] as const) {
      expect(vm[control] !== undefined, control).toBe((offered as readonly string[]).includes(control));
    }
    expect(vm.volume).toBeUndefined();
    expect(vm.mute).toBeUndefined();
    expect(vm.sources).toBeUndefined();
  });

  it('lists sources exactly as reported, with the current one disabled', () => {
    const sources = vmFor(player(LIVING, 'playing')).sources;
    expect(sources?.options.map((option) => [option.value, option.label, option.pressed])).toEqual([
      ['Demo Music', 'Demo Music', true],
      ['TV', 'TV', false],
      ['line_in', 'line_in', false],
    ]);
    expect(sources?.options[0]?.availability).toEqual({
      enabled: false,
      reason: 'not-applicable',
      message: 'Current source',
    });
  });

  it('never shows a missing or out-of-range volume as 0', () => {
    expect(vmFor(player(LIVING, 'playing', { volume_level: null })).volume?.level).toBeNull();
    expect(vmFor(player(LIVING, 'playing', { volume_level: 7 })).volume?.level).toBeNull();
    expect(vmFor(player(LIVING, 'playing', { is_volume_muted: 'yes' })).mute?.muted).toBeNull();
  });

  it.each([
    ['unavailable', player(LIVING, 'unavailable'), {}, 'Unavailable'],
    ['unknown', player(LIVING, 'unknown'), {}, 'Unknown'],
    ['missing-binding', undefined, {}, 'Not found'],
    ['loading', undefined, { ready: false }, 'Loading'],
  ] as const)('%s offers no controls and keeps its own label', (status, state, store, label) => {
    const vm = vmFor(state, store);
    expect(vm).toMatchObject({ status, playbackLabel: label });
    expect(vm.play ?? vm.pause ?? vm.volume ?? vm.sources).toBeUndefined();
  });

  it('keeps the last known playback while disconnected', () => {
    expect(vmFor(player(LIVING, 'playing'), { connected: false })).toMatchObject({
      status: 'disconnected',
      playback: 'playing',
    });
  });

  it('caps runaway titles', () => {
    expect(vmFor(player(LIVING, 'playing', { media_title: 'x'.repeat(500) })).title).toHaveLength(200);
  });

  it.each([
    [0.35, 35],
    ['0.5', 50],
    [1.4, null],
    [-0.1, null],
    [null, null],
  ])('reads the observed volume_level %s for a held draft as %s percent, never out of range', (level, percent) => {
    const store = selectorInputFor([player(LIVING, 'playing', { volume_level: level })], {
      config: { media: [LIVING] },
    }).store;
    expect(observedVolumePercent(store, entityId(LIVING))).toBe(percent);
  });
});

describe('active-player rule (§4.8)', () => {
  const pick = (states: ReturnType<typeof player>[], ids = [LIVING, STUDIO]) =>
    selectMedia(selectorInputFor(states, { config: { media: ids } })).activeKey;

  it('prefers the first playing, then paused, then available, then the first configured', () => {
    expect(pick([player(LIVING, 'paused'), player(STUDIO, 'playing')])).toBe(STUDIO);
    expect(pick([player(LIVING, 'idle'), player(STUDIO, 'paused')])).toBe(STUDIO);
    expect(pick([player(LIVING, 'unavailable'), player(STUDIO, 'off')])).toBe(STUDIO);
    expect(pick([player(LIVING, 'unavailable'), player(STUDIO, 'unavailable')])).toBe(LIVING);
    expect(activePlayer([])).toBeUndefined();
  });
});

async function mountMedia(states: ReturnType<typeof player>[], ids = [LIVING, STUDIO]) {
  const gateway = lockingGateway();
  const services = servicesFor(states, {
    config: { media: ids.map((entity) => ({ entity, name: entity === LIVING ? 'Living room' : 'Studio' })) },
    gateway,
  });
  const section = await mountElement<AgrMedia>('agr-media', (element) => {
    element.services = services;
  });
  const root = section.shadowRoot as ShadowRoot;
  const playerElement = root.querySelector<AgrMediaPlayer>('agr-media-player');
  return { section, gateway, root, playerRoot: playerElement?.shadowRoot as ShadowRoot };
}

function transportLabels(playerRoot: ShadowRoot): string[] {
  return [...playerRoot.querySelectorAll('agr-icon-button')].map((button) => button.label);
}

describe('agr-media', () => {
  it('shows only the active player, with plum primary transport, and requests nothing on mount', async () => {
    const { gateway, root, playerRoot } = await mountMedia([player(LIVING, 'off'), player(STUDIO, 'playing')]);
    expect(root.querySelectorAll('agr-media-player')).toHaveLength(1);
    expect(root.querySelector('.chip')?.textContent).toContain('Studio');
    expect(transportLabels(playerRoot)).toEqual(['Previous track', 'Pause', 'Next track', 'Mute Studio']);
    expect(playerRoot.querySelector('agr-icon-button[variant="primary"]')?.getAttribute('label')).toBe('Pause');
    expect(gateway.calls).toEqual([]);
  });

  it('renders transport buttons only for the bits the player supports', async () => {
    const { playerRoot } = await mountMedia(
      [player(LIVING, 'paused', { supported_features: MEDIA.PLAY | MEDIA.VOLUME_SET })],
      [LIVING],
    );
    expect(transportLabels(playerRoot)).toEqual(['Play']);
    expect(playerRoot.querySelector('agr-slider')).not.toBeNull();
  });

  it('collapses a switched-off player into the compact "Off" row with no controls', async () => {
    const { playerRoot } = await mountMedia([player(LIVING, 'off'), player(STUDIO, 'off')]);
    expect(playerRoot.querySelector('.title')?.textContent).toBe('Off');
    expect(playerRoot.querySelector('agr-icon-button, agr-slider')).toBeNull();
  });

  it('never renders artwork, even when the player reports a picture', async () => {
    const { root } = await mountMedia(
      [player(LIVING, 'playing', { entity_picture: '/api/media_player_proxy/x' })],
      [LIVING],
    );
    expect(deepQueryAll(root, 'img, image, picture')).toEqual([]);
  });

  it('sends one play request per tap and refuses a second tap while it is pending', async () => {
    const { gateway, playerRoot } = await mountMedia([player(LIVING, 'paused')], [LIVING]);
    const play = () =>
      playerRoot.querySelector('agr-icon-button[variant="primary"]')?.shadowRoot?.querySelector('button')?.click();
    play();
    await settle();
    play();
    expect(requestsOf(gateway)).toEqual([{ kind: 'media.play', entity: LIVING }]);
  });

  it('commits a volume change once, after the slider debounce, as a 0–1 level', async () => {
    vi.useFakeTimers();
    const { gateway, playerRoot } = await mountMedia([player(LIVING, 'playing')], [LIVING]);
    const input = playerRoot.querySelector('agr-slider')?.shadowRoot?.querySelector('input') as HTMLInputElement;
    for (const value of ['40', '55', '60']) {
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS - 1);
    expect(gateway.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(requestsOf(gateway)).toEqual([{ kind: 'media.volume_set', entity: LIVING, level: 0.6 }]);
  });

  it('keeps the volume label for assistive technology while hiding it visually', async () => {
    const { playerRoot } = await mountMedia([player(LIVING, 'playing')], [LIVING]);
    const slider = playerRoot.querySelector('agr-slider');
    const label = slider?.shadowRoot?.querySelector('label');
    expect(label?.textContent).toBe('Volume for Living room');
    expect(label?.classList.contains('visually-hidden')).toBe(true);
    expect(slider?.shadowRoot?.querySelector('input')?.getAttribute('aria-valuetext')).toBe('Volume 35 percent');
  });

  it('renders media text and source names as literal text, never markup', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { root, playerRoot } = await mountMedia(
      [player(LIVING, 'playing', { media_title: payload, media_artist: payload, friendly_name: payload })],
      [LIVING],
    );
    expect(playerRoot.querySelector('.title')?.textContent).toBe(payload);
    expect(deepQueryAll(root, 'img, script')).toEqual([]);
  });

  it('opens the media drawer for the shown player from the chip', async () => {
    const { root } = await mountMedia([player(LIVING, 'playing'), player(STUDIO, 'off')]);
    const opened = vi.fn();
    listenOnBody('agr-open-drawer', opened);
    const chip = root.querySelector<HTMLButtonElement>('.chip');
    chip?.click();
    const detail = (opened.mock.calls[0]?.[0] as CustomEvent<OpenDrawerDetail>).detail;
    expect(detail).toEqual({ request: { id: 'media', entity: LIVING }, trigger: chip });
  });

  it('shows one panel notice when every control is paused for the same reason', async () => {
    const gateway = lockingGateway();
    gateway.availability = {
      enabled: false,
      reason: 'disconnected',
      message: 'Paused while Home Assistant is disconnected.',
    };
    const services = servicesFor([player(LIVING, 'playing')], { config: { media: [LIVING] }, gateway });
    const section = await mountElement<AgrMedia>('agr-media', (element) => {
      element.services = services;
    });
    expect(section.shadowRoot?.querySelector('.notice')?.textContent).toContain('Paused while Home Assistant');
  });
});
