/** Media drawer (§5.3, §7.2; §12.1 row 5): the source list never acts on arrows, one activation of a non-current
 *  source is exactly one select_source, every option is disabled while it is pending, and the player picker is
 *  local view state that sends nothing. */
import { describe, expect, it } from 'vitest';
import type { AgrMediaDrawer } from '../../src/components/media/agr-media-drawer.ts';
import '../../src/components/media/agr-media-drawer.ts';
import type { AgrChoiceGroup } from '../../src/components/primitives/agr-choice-group.ts';
import { MEDIA_PLAYER_FEATURE as MEDIA } from '../../src/ha/features.ts';
import { settle } from '../helpers/dom.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import {
  lockingGateway,
  mountElement,
  NAVIGATION_KEYS,
  pressKey,
  requestsOf,
  servicesFor,
} from '../comfort/support.ts';

const LIVING = 'media_player.demo_living_room';
const STUDIO = 'media_player.demo_studio';
const SOURCES = ['Demo Music', 'Demo Radio', 'TV'];

const states = [
  testEntity(LIVING, 'playing', {
    media_title: 'Evening raga',
    source: 'Demo Music',
    source_list: SOURCES,
    volume_level: 0.35,
    supported_features: MEDIA.PLAY | MEDIA.PAUSE | MEDIA.VOLUME_SET | MEDIA.SELECT_SOURCE,
  }),
  testEntity(STUDIO, 'off', {
    source: 'Line in',
    source_list: ['Line in', 'Bluetooth'],
    supported_features: MEDIA.PLAY | MEDIA.SELECT_SOURCE,
  }),
];

async function mountDrawer(entity = LIVING) {
  const gateway = lockingGateway();
  const services = servicesFor(states, {
    config: {
      media: [
        { entity: LIVING, name: 'Living room' },
        { entity: STUDIO, name: 'Studio' },
      ],
    },
    gateway,
  });
  const drawer = await mountElement<AgrMediaDrawer>('agr-media-drawer', (element) => {
    element.services = services;
    element.request = { id: 'media', entity: entityId(entity) };
  });
  return { drawer, gateway, root: drawer.shadowRoot as ShadowRoot };
}

function sourceButtons(root: ShadowRoot): HTMLButtonElement[] {
  const group = root.querySelector<AgrChoiceGroup>('agr-choice-group:not([label="Players"])');
  expect(group?.orientation).toBe('vertical');
  return [...(group?.shadowRoot?.querySelectorAll('button') ?? [])];
}

describe('agr-media-drawer', () => {
  it('lists the exact source list with the current source pressed, and requests nothing on mount', async () => {
    const { gateway, root } = await mountDrawer();
    const buttons = sourceButtons(root);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(SOURCES);
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(gateway.calls).toEqual([]);
  });

  it('sends nothing for arrow, Home, End and page keys across the sources', async () => {
    const { gateway, root } = await mountDrawer();
    for (const button of sourceButtons(root)) {
      for (const key of NAVIGATION_KEYS) expect(pressKey(button, key)).toBe(false);
    }
    await settle();
    expect(gateway.calls).toEqual([]);
  });

  it('sends exactly one select_source for one activation, then disables every option while pending', async () => {
    const { gateway, root } = await mountDrawer();
    const radio = sourceButtons(root)[1] as HTMLButtonElement;
    pressKey(radio, 'Enter');
    radio.click();
    await settle();
    expect(requestsOf(gateway)).toEqual([{ kind: 'media.select_source', entity: LIVING, source: 'Demo Radio' }]);
    for (const button of sourceButtons(root)) expect(button.getAttribute('aria-disabled')).toBe('true');
    sourceButtons(root)[2]?.click();
    expect(gateway.calls).toHaveLength(1);
  });

  it('switches the shown player locally from the picker, sending nothing', async () => {
    const { gateway, root } = await mountDrawer();
    const picker = root.querySelector('agr-choice-group[label="Players"]');
    const picks = [...(picker?.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    expect(picks.map((pick) => pick.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    // The shown player is the current option: disabled as "Current player", like every choice group's pressed one.
    expect(picks.map((pick) => pick.getAttribute('aria-disabled'))).toEqual(['true', null]);
    picks[0]?.click();
    await settle();
    expect(root.querySelector('section.group h3.t-strong')?.textContent).toBe('Living room');
    expect(picks[0]?.textContent).toContain('Living room');
    picks[1]?.click();
    await settle();
    expect(root.querySelector('section.group h3.t-strong')?.textContent).toBe('Studio');
    expect(sourceButtons(root).map((button) => button.textContent?.trim())).toEqual(['Line in', 'Bluetooth']);
    expect(gateway.calls).toEqual([]);
  });

  it('still offers sources for a switched-off player', async () => {
    const { root } = await mountDrawer(STUDIO);
    expect(sourceButtons(root)).toHaveLength(2);
  });

  it('states a reason every control shares once, as a drawer notice, not under each control (§16.10)', async () => {
    const { drawer, gateway, root } = await mountDrawer();
    const off = 'Controls are turned off in the dashboard configuration.';
    gateway.availability = { enabled: false, reason: 'controls-off', message: off };
    drawer.requestUpdate();
    await settle();
    const visibleText = (node: ParentNode): string =>
      [...node.querySelectorAll('.notice, p.t-meta')].map((element) => element.textContent ?? '').join('|');
    expect(root.querySelectorAll('.notice')).toHaveLength(1);
    expect(root.querySelector('.notice')?.textContent).toContain(off);
    expect(visibleText(root).split(off)).toHaveLength(2); // exactly one visible occurrence in the drawer
    const player = root.querySelector('agr-media-player');
    expect(player?.hasAttribute('show-reason')).toBe(false);
  });
});
