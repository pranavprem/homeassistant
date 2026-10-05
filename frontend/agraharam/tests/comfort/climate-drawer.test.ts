/** Climate drawer (§5.3, §7.2; §12.1 rows 5 and 8): choice groups never act on arrows, one activation = one call,
 *  busy while pending, the stepper drafts through ActionController on the step grid, bed devices are read-only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgrClimateDrawer } from '../../src/components/comfort/agr-climate-drawer.ts';
import '../../src/components/comfort/agr-climate-drawer.ts';
import type { AgrChoiceGroup } from '../../src/components/primitives/agr-choice-group.ts';
import type { AgrStepper } from '../../src/components/primitives/agr-stepper.ts';
import { STEPPER_COMMIT_DEBOUNCE_MS } from '../../src/ha/actions/types.ts';
import { CLIMATE_FEATURE, FAN_FEATURE } from '../../src/ha/features.ts';
import { deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import { lockingGateway, mountElement, NAVIGATION_KEYS, pressKey, requestsOf, servicesFor } from './support.ts';

const CLIMATE = 'climate.demo_bedroom';
const FAN = 'fan.demo_purifier';
const BED = 'climate.demo_bed_left_side';
const CONFIG = {
  climate: [{ entity: CLIMATE, name: 'Bedroom' }],
  air: [{ entity: FAN, name: 'Purifier' }],
  bed_comfort: [{ entity: BED, name: 'Bed, left side' }],
};

function states(climateAttributes: Record<string, unknown> = {}) {
  return [
    testEntity(CLIMATE, 'cool', {
      current_temperature: 74,
      temperature: 72,
      hvac_modes: ['off', 'cool', 'heat'],
      hvac_action: 'cooling',
      min_temp: 60,
      max_temp: 76,
      target_temp_step: 1,
      supported_features: CLIMATE_FEATURE.TARGET_TEMPERATURE,
      ...climateAttributes,
    }),
    testEntity(FAN, 'on', {
      percentage: 40,
      percentage_step: 20,
      preset_mode: 'Sleep',
      preset_modes: ['Auto', 'Sleep'],
      supported_features: FAN_FEATURE.SET_SPEED | FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF,
    }),
    testEntity(BED, 'heat_cool', { current_temperature: 81, temperature: 79 }),
  ];
}

async function mountDrawer(entity: string | undefined, climateAttributes: Record<string, unknown> = {}, unit = '°F') {
  const gateway = lockingGateway();
  const services = servicesFor(states(climateAttributes), { config: CONFIG, gateway, unit });
  const drawer = await mountElement<AgrClimateDrawer>('agr-climate-drawer', (element) => {
    element.services = services;
    element.request = entity === undefined ? { id: 'climate' } : { id: 'climate', entity: entityId(entity) };
  });
  return { drawer, gateway, services };
}

function modeButtons(drawer: AgrClimateDrawer): HTMLButtonElement[] {
  const group = deepQuery<AgrChoiceGroup>(
    drawer.shadowRoot as ShadowRoot,
    'agr-choice-group[focus-key-prefix$=":mode"]',
  );
  return [...(group?.shadowRoot?.querySelectorAll('button') ?? [])];
}

function stepperButtons(drawer: AgrClimateDrawer): { down: HTMLButtonElement; up: HTMLButtonElement } {
  const stepper = deepQuery<AgrStepper>(drawer.shadowRoot as ShadowRoot, 'agr-stepper');
  const [down, up] = [...(stepper?.shadowRoot?.querySelectorAll('button') ?? [])];
  if (down === undefined || up === undefined) throw new Error('stepper buttons missing');
  return { down, up };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agr-climate-drawer', () => {
  it('heads a single-device drawer with the device name and requests nothing on mount', async () => {
    const { drawer, gateway } = await mountDrawer(CLIMATE);
    expect(drawer.shadowRoot?.querySelector('agr-drawer')?.heading).toBe('Bedroom');
    expect(gateway.calls).toEqual([]);
  });

  it('sends nothing for arrow, Home, End and page keys across the HVAC modes', async () => {
    const { drawer, gateway } = await mountDrawer(CLIMATE);
    const buttons = modeButtons(drawer);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Off', 'Cool', 'Heat']);
    for (const button of buttons) {
      for (const key of NAVIGATION_KEYS) expect(pressKey(button, key)).toBe(false);
    }
    await settle();
    expect(gateway.calls).toEqual([]);
  });

  it('sends exactly one set_hvac_mode for one activation of a non-current mode, then disables every option', async () => {
    const { drawer, gateway } = await mountDrawer(CLIMATE);
    const heat = modeButtons(drawer)[2];
    pressKey(heat as HTMLButtonElement, 'Enter');
    heat?.click();
    await settle();
    expect(requestsOf(gateway)).toEqual([{ kind: 'climate.set_hvac_mode', entity: CLIMATE, mode: 'heat' }]);
    for (const button of modeButtons(drawer)) expect(button.getAttribute('aria-disabled')).toBe('true');
    modeButtons(drawer)[0]?.click();
    expect(gateway.calls).toHaveLength(1);
  });

  it('sends nothing for the current mode', async () => {
    const { drawer, gateway } = await mountDrawer(CLIMATE);
    modeButtons(drawer)[1]?.click();
    await settle();
    expect(gateway.calls).toEqual([]);
  });

  it('coalesces stepper taps into one set_temperature after the debounce, clamped at max_temp', async () => {
    vi.useFakeTimers();
    const { drawer, gateway } = await mountDrawer(CLIMATE);
    for (let tap = 0; tap < 6; tap += 1) {
      stepperButtons(drawer).up.click();
      await drawer.updateComplete;
    }
    vi.advanceTimersByTime(STEPPER_COMMIT_DEBOUNCE_MS - 1);
    expect(gateway.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(requestsOf(gateway)).toEqual([{ kind: 'climate.set_temperature', entity: CLIMATE, temperature: 76 }]);
  });

  it('snaps an off-grid observed target onto the °C grid', async () => {
    vi.useFakeTimers();
    const { drawer, gateway } = await mountDrawer(
      CLIMATE,
      { temperature: 22.3, target_temp_step: undefined, min_temp: 7.2, max_temp: 30 },
      '°C',
    );
    stepperButtons(drawer).up.click();
    vi.advanceTimersByTime(STEPPER_COMMIT_DEBOUNCE_MS);
    expect(requestsOf(gateway)).toEqual([{ kind: 'climate.set_temperature', entity: CLIMATE, temperature: 22.5 }]);
  });

  it('drops a pending stepper draft as "Not sent" when the epoch changes, sending nothing', async () => {
    vi.useFakeTimers();
    const { drawer, gateway } = await mountDrawer(CLIMATE);
    stepperButtons(drawer).up.click();
    await drawer.updateComplete;
    gateway.advanceEpoch();
    vi.advanceTimersByTime(STEPPER_COMMIT_DEBOUNCE_MS * 2);
    await drawer.updateComplete;
    expect(gateway.calls).toEqual([]);
    const notes = drawer.shadowRoot?.querySelector('agr-control-notes')?.shadowRoot;
    expect(notes?.textContent).toContain('Not sent');
  });

  it('announces the pending target with its scale, as the stepper reads it ("Target 73°F"), visually hidden, without Dismiss', async () => {
    vi.useFakeTimers();
    const { drawer } = await mountDrawer(CLIMATE);
    stepperButtons(drawer).up.click();
    await drawer.updateComplete;
    const controlNotes = drawer.shadowRoot?.querySelector('agr-control-notes');
    await controlNotes?.updateComplete;
    const note = controlNotes?.shadowRoot?.querySelector('[role="status"] > div');
    expect(note?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/^Bedroom Target \d+(\.\d+)?°[FC]$/);
    // The stepper's own status line reads the same value the same way.
    const stepper = drawer.shadowRoot?.querySelector('agr-stepper');
    const status = stepper?.shadowRoot?.querySelector('#status')?.textContent?.trim();
    expect(note?.textContent).toContain(status?.replace('Setting ', '') ?? 'missing status');
    expect(note?.classList.contains('visually-hidden')).toBe(true);
    expect(note?.querySelector('agr-button')).toBeNull();
    expect(controlNotes?.hasAttribute('quiet')).toBe(true);
  });

  it('applies fan controls through its own ActionController', async () => {
    const { drawer, gateway } = await mountDrawer(FAN);
    const controls = deepQuery(drawer.shadowRoot as ShadowRoot, 'agr-fan-controls');
    const power = deepQuery(controls?.shadowRoot as ShadowRoot, 'agr-button');
    power?.shadowRoot?.querySelector('button')?.click();
    await settle();
    expect(requestsOf(gateway)).toEqual([{ kind: 'fan.turn_off', entity: FAN }]);
  });

  it('lists every device with its own heading when opened without an entity; the bed has no control', async () => {
    const { drawer } = await mountDrawer(undefined);
    const root = drawer.shadowRoot as ShadowRoot;
    expect(root.querySelector('agr-drawer')?.heading).toBe('Climate');
    expect([...root.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual([
      'Bedroom',
      'Purifier',
      'Bed, left side',
    ]);
    const bed = [...root.querySelectorAll('section.device')][2] as Element;
    expect(deepQueryAll(bed, 'button, input')).toEqual([]);
    expect(bed.textContent).toContain('Set to 79°');
  });

  it('states a reason every control shares once, as a drawer notice; controls keep it for screen readers', async () => {
    const { drawer, gateway } = await mountDrawer(undefined);
    const off = 'Controls are turned off in the dashboard configuration.';
    gateway.availability = { enabled: false, reason: 'controls-off', message: off };
    drawer.requestUpdate();
    await settle();
    const root = drawer.shadowRoot as ShadowRoot;
    expect(root.querySelectorAll('.notice')).toHaveLength(1);
    expect(root.querySelector('.notice')?.textContent).toContain(off);
    // Every stepper, slider and fan button hides its own copy visually but still points to it.
    const hosts = deepQueryAll<HTMLElement>(root, 'agr-stepper, agr-slider, agr-fan-controls');
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host.getAttribute('reason-display')).toBe('hidden');
    const reasons = deepQueryAll<HTMLElement>(root, '#reason');
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason.classList.contains('t-meta')).toBe(false);
  });

  it('renders a skeleton shell before services carry a store', async () => {
    const drawer = await mountElement<AgrClimateDrawer>('agr-climate-drawer', (element) => {
      element.services = { mode: 'demo', theme: 'dark' } as AgrClimateDrawer['services'];
    });
    const shell = drawer.shadowRoot?.querySelector('agr-drawer');
    expect(shell?.heading).toBe('Climate');
    expect(drawer.shadowRoot?.querySelector('.skeleton')).not.toBeNull();
  });
});
