/** Climate panel (§5.1, §6.2.1, §7.2, §16.10): budget and "+N more", sibling buttons, bed tiles without controls,
 *  one toggle tap = one request, the panel notice, the live region and Dismiss. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgrComfort } from '../../src/components/comfort/agr-comfort.ts';
import '../../src/components/comfort/agr-comfort.ts';
import type { AgrComfortTile } from '../../src/components/comfort/agr-comfort-tile.ts';
import type { OpenDrawerDetail } from '../../src/components/shell/overlay-types.ts';
import { actionKeyFor } from '../../src/ha/actions/types.ts';
import { CLIMATE_FEATURE, FAN_FEATURE } from '../../src/ha/features.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { deepQueryAll, settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import {
  listenOnBody,
  lockingGateway,
  mountElement,
  removeBodyListeners,
  requestsOf,
  servicesFor,
  type SupportOptions,
} from './support.ts';

afterEach(removeBodyListeners);
const CLIMATE = 'climate.demo_bedroom';
const FAN = 'fan.demo_purifier';
const HALL = 'fan.demo_hall_air_mover';
const BED = 'climate.demo_bed_left_side';

const climate = testEntity(CLIMATE, 'cool', {
  current_temperature: 74,
  temperature: 72,
  hvac_action: 'cooling',
  supported_features: CLIMATE_FEATURE.TARGET_TEMPERATURE,
});
const purifier = testEntity(FAN, 'on', {
  preset_mode: 'Sleep',
  supported_features: FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF,
});
const hall = testEntity(HALL, 'off', { supported_features: FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF });
const bed = testEntity(BED, 'heat_cool', { current_temperature: 80, temperature: 78 });

async function mountComfort(states = [climate, purifier], options: SupportOptions = { config: {} }) {
  const config = Object.keys(options.config).length > 0 ? options.config : { climate: [CLIMATE], air: [FAN] };
  const gateway = options.gateway ?? lockingGateway();
  const services = servicesFor(states, { ...options, config, gateway });
  const section = await mountElement<AgrComfort>('agr-comfort', (element) => {
    element.services = services;
  });
  return { section, gateway, root: section.shadowRoot as ShadowRoot };
}

function tiles(root: ShadowRoot): AgrComfortTile[] {
  return [...root.querySelectorAll('agr-comfort-tile')];
}

function toggleButton(tile: AgrComfortTile): HTMLButtonElement | null | undefined {
  return tile.shadowRoot?.querySelector('agr-icon-button')?.shadowRoot?.querySelector('button');
}

describe('agr-comfort', () => {
  it('renders the panel skeleton before services exist, and skeleton tiles before the first state', async () => {
    const bare = await mountElement<AgrComfort>('agr-comfort', () => undefined);
    expect(bare.shadowRoot?.querySelector('.skeleton[aria-hidden="true"]')).not.toBeNull();
    const { root } = await mountComfort([climate, purifier], {
      config: { climate: [CLIMATE], air: [FAN] },
      store: { ready: false },
    });
    expect(root.querySelectorAll('.tile-skeleton')).toHaveLength(2);
    expect(tiles(root)).toHaveLength(0);
  });

  it('shows two tiles with the indoor-temperature pill and requests nothing on mount or re-render', async () => {
    const { section, gateway, root } = await mountComfort();
    expect(tiles(root).map((tile) => tile.tile.kind)).toEqual(['climate', 'air']);
    expect(root.querySelector('agr-panel')?.pill).toEqual({ label: '74° inside', tone: 'neutral' });
    section.requestUpdate();
    await settle();
    expect(gateway.calls).toEqual([]);
  });

  it('cuts to the budget and opens the all-devices drawer from "+N more"', async () => {
    const { root } = await mountComfort([climate, purifier, hall, bed], {
      config: { climate: [CLIMATE], air: [FAN, HALL], bed_comfort: [BED] },
    });
    expect(tiles(root)).toHaveLength(2);
    const more = root.querySelector<HTMLButtonElement>('.more');
    expect(more?.textContent).toContain('2 more');
    const opened = vi.fn();
    listenOnBody('agr-open-drawer', opened);
    more?.click();
    const detail = (opened.mock.calls[0]?.[0] as CustomEvent<OpenDrawerDetail>).detail;
    expect(detail.request).toEqual({ id: 'climate' });
    expect(detail.trigger).toBe(more);
    expect(more?.textContent?.replace(/\s+/g, ' ')).toContain('2 more climate devices');
  });

  it('shows a second row of tiles when the root raises the budget for spare column height (§16.14)', async () => {
    const { section, root } = await mountComfort([climate, purifier, hall, bed], {
      config: { climate: [CLIMATE], air: [FAN, HALL], bed_comfort: [BED] },
    });
    section.tileBudget = 4;
    await settle();
    expect(tiles(root).map((tile) => tile.tile.kind)).toEqual(['climate', 'air', 'air', 'bed']);
    expect(root.querySelector('.more')).toBeNull();
  });

  it('names a single overflow device in the singular', async () => {
    const { root } = await mountComfort([climate, purifier, hall], {
      config: { climate: [CLIMATE], air: [FAN, HALL] },
    });
    const name = root.querySelector('.more')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(name).toBe('1 more climate device');
  });

  it('opens a tile drawer from its own button, as a sibling of the toggle, never nested', async () => {
    const { root } = await mountComfort();
    const [climateTile, airTile] = tiles(root);
    const open = airTile?.shadowRoot?.querySelector<HTMLButtonElement>('.body');
    expect(open?.querySelector('button, agr-icon-button')).toBeNull();
    const opened = vi.fn();
    listenOnBody('agr-open-drawer', opened);
    climateTile?.shadowRoot?.querySelector<HTMLButtonElement>('.body')?.click();
    const detail = (opened.mock.calls[0]?.[0] as CustomEvent<OpenDrawerDetail>).detail;
    expect(detail.request).toEqual({ id: 'climate', entity: CLIMATE });
    expect(detail.trigger.dataset['focusKey']).toBe(`comfort:${CLIMATE}:open`);
  });

  it('renders bed tiles as text with no button or control', async () => {
    const { root } = await mountComfort([bed], { config: { bed_comfort: [BED] } });
    const [tile] = tiles(root);
    expect(tile?.shadowRoot?.querySelector('button, agr-icon-button, input')).toBeNull();
    expect(tile?.shadowRoot?.textContent).toContain('Set to 78°');
  });

  it('sends exactly one fan.turn_off per tap, and the next tap is refused while it is pending', async () => {
    const { gateway, root } = await mountComfort();
    const air = tiles(root)[1] as AgrComfortTile;
    toggleButton(air)?.click();
    await settle();
    toggleButton(air)?.click();
    await settle();
    expect(requestsOf(gateway)).toEqual([{ kind: 'fan.turn_off', entity: FAN }]);
  });

  it('announces tickets in its one live region and dismisses a failed one', async () => {
    const { gateway, root } = await mountComfort();
    toggleButton(tiles(root)[1] as AgrComfortTile)?.click();
    await settle();
    const notes = root.querySelector('agr-control-notes')?.shadowRoot?.querySelector('.notes');
    expect(notes?.getAttribute('role')).toBe('status');
    expect(notes?.textContent).toContain('Air purifier');
    expect(notes?.textContent).toContain('Sending');
    const key = actionKeyFor({ kind: 'fan.turn_off', entity: entityId(FAN) });
    gateway.settle(key, 'sent');
    await settle();
    // §7.2 copy names the device once: "Waiting for <name>".
    expect(notes?.querySelector('.text')?.textContent?.trim()).toBe('Waiting for Air purifier');
    const dismiss = vi.spyOn(gateway, 'dismiss');
    gateway.settle(key, 'failed', {
      code: 'rejected',
      message: "Home Assistant didn't accept the request: busy.",
    });
    await settle();
    expect(notes?.textContent).toContain("Home Assistant didn't accept the request");
    notes?.querySelector('agr-button')?.shadowRoot?.querySelector('button')?.click();
    await settle();
    expect(dismiss).toHaveBeenCalledWith(`entity:${FAN}`);
    expect(notes?.textContent?.trim()).toBe('');
  });

  it('keeps reporting an overflow device, so an outcome from the drawer stays visible after it closes', async () => {
    const { gateway, root } = await mountComfort([climate, purifier, hall], {
      config: { climate: [CLIMATE], air: [FAN, HALL] },
    });
    gateway.request({ kind: 'fan.turn_on', entity: entityId(HALL) });
    gateway.settle(`entity:${HALL}`, 'uncertain', {
      code: 'timeout',
      message: "Hall fan didn't confirm within 20 seconds. It may still respond. Check it before trying again.",
    });
    await settle();
    expect(tiles(root).map((tile) => tile.tile.vm.key)).not.toContain(HALL);
    expect(root.querySelector('agr-control-notes')?.shadowRoot?.textContent).toContain(
      "Hall fan didn't confirm within 20 seconds.",
    );
  });

  it('shows one panel notice instead of per-control lines when controls are off', async () => {
    const gateway = new FakeGateway();
    gateway.availability = {
      enabled: false,
      reason: 'controls-off',
      message: 'Controls are turned off in the dashboard configuration.',
    };
    const { root } = await mountComfort([climate, purifier], { config: { climate: [CLIMATE], air: [FAN] }, gateway });
    expect(root.querySelector('.notice')?.textContent).toContain('Controls are turned off');
    const toggle = toggleButton(tiles(root)[1] as AgrComfortTile);
    expect(toggle?.getAttribute('aria-disabled')).toBe('true');
    expect(toggle?.getAttribute('aria-describedby')).toBe('reason');
  });

  it('omits the quick toggle while the power state is unknown or the purifier is unavailable', async () => {
    const { root } = await mountComfort([climate, testEntity(FAN, 'unavailable')]);
    expect(toggleButton(tiles(root)[1] as AgrComfortTile)).toBeUndefined();
    expect(tiles(root)[1]?.shadowRoot?.textContent).toContain('Unavailable');
  });

  it('renders device names as literal text, never markup', async () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { root } = await mountComfort([testEntity(CLIMATE, 'cool', { friendly_name: payload })], {
      config: { climate: [CLIMATE] },
    });
    const tile = tiles(root)[0];
    expect(tile?.shadowRoot?.querySelector('.name')?.textContent).toBe(payload);
    expect(deepQueryAll(root, 'img, script')).toEqual([]);
  });

  it('shows an intentional empty state when nothing is configured', async () => {
    const { root } = await mountComfort([], { config: { title: 'Home' } });
    expect(root.querySelector('agr-empty-state')).not.toBeNull();
  });
});
