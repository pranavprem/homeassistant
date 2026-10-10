/**
 * Sky helpers for the cross-cutting acceptance suites (ARCHITECTURE.md §19). The real card runs the `sky` scenario
 * against FakeHass; the sky sensor is driven the way the collector drives it, by publishing a whole payload as the
 * entity's attributes (FakeHass merges attributes, so a full fictional payload replaces every envelope key).
 * Payloads come from the fictional builders in src/demo/fixtures/sky.ts, dated relative to the real clock: the
 * acceptance timers fake setTimeout and friends but not Date, which is what the sky's freshness reads.
 */
import type { AgrOverlayHost } from '../../src/components/shell/agr-overlay-host.ts';
import { fixtureClock } from '../../src/demo/fixture-types.ts';
import { DEMO_SKY_AIRSPACE, skyAttributes, type SkyFixtureKind } from '../../src/demo/fixtures/sky.ts';
import type { FakeHassObject } from '../../src/dev/fake-hass.ts';
import type { HassEntityLike, HassLike } from '../../src/ha/types.ts';
import { control, press, renderedText, section, settle, shadowOf, topOverlay, type LiveCard } from './support.ts';
import type { MountedCard } from '../helpers/mount.ts';

export const SKY = DEMO_SKY_AIRSPACE;
export type SkyPayload = Readonly<Record<string, unknown>>;

const MS_PER_MINUTE = 60_000;

/** A fictional payload whose snapshot is `minutesOld` (plus the builders' own 15 s lead) before the real clock. */
export function skyPayload(kind: SkyFixtureKind, minutesOld = 0): SkyPayload {
  return skyAttributes(kind, fixtureClock(Date.now() - minutesOld * MS_PER_MINUTE));
}

/** Publishes a payload as the collector does: state = the raw nearby count, attributes = the payload. */
export async function publishSky(card: LiveCard, payload: SkyPayload): Promise<void> {
  const aircraft = payload['aircraft'];
  card.fake.setState(SKY, String(Array.isArray(aircraft) ? aircraft.length : 0), payload);
  await settle();
}

/**
 * Rewrites each hass so the sky sensor carries no attributes at all: what HA restores after a restart before the
 * collector publishes again. `lastUpdatedMinAgo` dates HA's own last_updated (default: as FakeHass set it). The
 * stripped object is memoized per source object, so an unchanged entity keeps its identity across pushes exactly
 * as home-assistant-js-websocket keeps it.
 */
export function withoutSkyAttributes(lastUpdatedMinAgo?: number): (hass: FakeHassObject) => HassLike {
  const stripped = new WeakMap<HassEntityLike, HassEntityLike>();
  return (hass) => {
    const entity = hass.states[SKY];
    if (entity === undefined) return hass;
    let bare = stripped.get(entity);
    if (bare === undefined) {
      const lastUpdated =
        lastUpdatedMinAgo === undefined
          ? entity.last_updated
          : new Date(Date.now() - lastUpdatedMinAgo * MS_PER_MINUTE).toISOString();
      bare = Object.freeze({ ...entity, attributes: Object.freeze({}), last_updated: lastUpdated });
      stripped.set(entity, bare);
    }
    return { ...hass, states: Object.freeze({ ...hass.states, [SKY]: bare }) };
  };
}

export function skyRoot(card: MountedCard): ShadowRoot {
  return shadowOf(section(card, 'agr-sky'));
}

/** The panel's one line: the count label while live or empty, the §8 state sentence otherwise. */
export function skyPanelLine(card: MountedCard): string {
  const root = skyRoot(card);
  const line = root.querySelector('.state-line') ?? root.querySelector('.count-label');
  return renderedText(line ?? root);
}

export function skyPanelPill(card: MountedCard): unknown {
  return (skyRoot(card).querySelector('agr-panel') as (HTMLElement & { pill?: unknown }) | null)?.pill;
}

/** Opens the sky drawer through the panel's Details button and returns the drawer's shadow root. */
export async function openSkyDrawer(card: MountedCard): Promise<ShadowRoot> {
  await press(control(skyRoot(card), 'sky:details'));
  return openedDrawer(card, 'AGR-SKY-DRAWER');
}

/** Opens the weather drawer through Today's header Details button and returns the drawer's shadow root. */
export async function openWeatherDrawer(card: MountedCard): Promise<ShadowRoot> {
  await press(control(shadowOf(section(card, 'agr-today')), 'today:details'));
  return openedDrawer(card, 'AGR-WEATHER-DRAWER');
}

function openedDrawer(card: MountedCard, tag: string): ShadowRoot {
  const drawer = topOverlay(card);
  if (drawer?.tagName !== tag) throw new Error(`expected ${tag} on top, found ${drawer?.tagName ?? 'nothing'}`);
  return shadowOf(drawer);
}

/** Presses one of the drawer's local view controls: a Show choice ('sky:view:…') or a Sort choice ('sky:sort:…'). */
export async function chooseSky(drawer: ShadowRoot, group: 'view' | 'sort', value: string): Promise<void> {
  await press(control(drawer, `sky:${group}:${value}`));
}

export function skyRowButtons(drawer: ShadowRoot): HTMLButtonElement[] {
  return [...drawer.querySelectorAll<HTMLButtonElement>('button.aircraft-row')];
}

/** The drawer banner's fixed status sentence (empty while live). */
export function skyBanner(drawer: ShadowRoot): string {
  return renderedText(drawer.querySelector('.sentence') ?? drawer);
}

/** The radar's live flag ('true' / 'false'), or null when no radar is drawn. */
export function radarLive(drawer: ShadowRoot): string | null {
  const radar = drawer.querySelector('agr-sky-radar')?.shadowRoot;
  return radar?.querySelector('svg')?.getAttribute('data-live') ?? null;
}

/**
 * Closes every overlay the way the root does on detach. happy-dom fires no 'close' event for dialog.close(), so a
 * Close click would leave the drawer mounted here; real dialog closing is covered by e2e/keyboard.spec.ts.
 */
export async function closeOverlays(card: MountedCard): Promise<void> {
  (card.root.querySelector('agr-overlay-host') as AgrOverlayHost).closeAll();
  card.root.querySelector<HTMLElement>('.frame')?.focus();
  await settle();
}
