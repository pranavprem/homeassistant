/** Shared fan controls (§16.10 seam shared with the room drawer): composed intents, the unknown-state pair, preset choices that never
 *  act on arrows, no timers in the leaf, and applyFanIntent's one-request-per-gesture mapping. */
import { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgrChoiceGroup } from '../../src/components/primitives/agr-choice-group.ts';
import type { AgrSlider } from '../../src/components/primitives/agr-slider.ts';
import {
  applyFanIntent,
  fanActionKey,
  type AgrFanControls,
  type FanIntent,
} from '../../src/components/shared/agr-fan-controls.ts';
import '../../src/components/shared/agr-fan-controls.ts';
import { ActionController } from '../../src/ha/actions/action-controller.ts';
import { SLIDER_COMMIT_DEBOUNCE_MS } from '../../src/ha/actions/types.ts';
import { FAN_FEATURE } from '../../src/ha/features.ts';
import { selectAirTile } from '../../src/model/air.ts';
import type { AirTileVM } from '../../src/model/types.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { entityId, testEntity } from '../helpers/fake-store.ts';
import {
  listenOnBody,
  mountElement,
  NAVIGATION_KEYS,
  pressKey,
  removeBodyListeners,
  requestsOf,
  selectorInputFor,
  servicesFor,
} from './support.ts';

const FAN = 'fan.demo_purifier';
const FEATURES = FAN_FEATURE.SET_SPEED | FAN_FEATURE.PRESET_MODE | FAN_FEATURE.TURN_ON | FAN_FEATURE.TURN_OFF;

function tile(state: string, attributes: Record<string, unknown> = {}, gateway = new FakeGateway()): AirTileVM {
  const fan = testEntity(FAN, state, {
    percentage: 40,
    percentage_step: 20,
    preset_mode: 'Sleep',
    preset_modes: ['Auto', 'Sleep'],
    supported_features: FEATURES,
    ...attributes,
  });
  return selectAirTile(
    selectorInputFor([fan], { config: { air: [FAN] }, gateway }),
    { entity: entityId(FAN) },
    'room_purifier',
  );
}

afterEach(removeBodyListeners);

async function mountControls(vm: AirTileVM) {
  const controls = await mountElement<AgrFanControls>('agr-fan-controls', (element) => {
    element.tile = vm;
    element.focusKeyPrefix = 'room:2:purifier';
  });
  const intents: CustomEvent<FanIntent>[] = [];
  listenOnBody('agr-fan-intent', (event) => intents.push(event as CustomEvent<FanIntent>));
  return { controls, root: controls.shadowRoot as ShadowRoot, intents };
}

function innerButton(host: Element | null | undefined): HTMLButtonElement | null | undefined {
  return host?.shadowRoot?.querySelector('button');
}

describe('agr-fan-controls', () => {
  it('dispatches one composed, bubbling power intent per activation', async () => {
    const { root, intents } = await mountControls(tile('on'));
    innerButton(root.querySelector('agr-button'))?.click();
    expect(intents).toHaveLength(1);
    expect(intents[0]?.composed).toBe(true);
    expect(intents[0]?.bubbles).toBe(true);
    expect(intents[0]?.detail).toEqual({ kind: 'power', entity: FAN, next: 'off' });
  });

  it('is one "Power" toggle whose pressed state is the observed power, never a solid "Turn off" (§16.14)', async () => {
    const on = await mountControls(tile('on'));
    const onButton = innerButton(on.root.querySelector('agr-button'));
    expect(onButton?.textContent?.trim()).toBe('Power');
    expect(onButton?.getAttribute('aria-pressed')).toBe('true');
    expect(onButton?.hasAttribute('data-powered')).toBe(false);
    const off = await mountControls(tile('off'));
    const offButton = innerButton(off.root.querySelector('agr-button'));
    expect(offButton?.getAttribute('aria-pressed')).toBe('false');
    offButton?.click();
    expect(off.intents.at(-1)?.detail).toEqual({ kind: 'power', entity: FAN, next: 'on' });
  });

  it('offers explicit On and Off buttons while the power state is unknown', async () => {
    const { root, intents } = await mountControls(tile('unknown'));
    const buttons = [...root.querySelectorAll('agr-button')];
    expect(buttons.map((button) => button.label)).toEqual(['On', 'Off']);
    innerButton(buttons[1])?.click();
    expect(intents.map((intent) => intent.detail)).toEqual([{ kind: 'power', entity: FAN, next: 'off' }]);
  });

  it('turns a speed change into one speed intent and a preset activation into one preset intent', async () => {
    const { root, intents } = await mountControls(tile('on'));
    const input = root.querySelector<AgrSlider>('agr-slider')?.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = '60';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const group = root.querySelector<AgrChoiceGroup>('agr-choice-group');
    group?.shadowRoot?.querySelectorAll('button')[0]?.click();
    expect(intents.map((intent) => intent.detail)).toEqual([
      { kind: 'speed', entity: FAN, percentage: 60 },
      { kind: 'preset', entity: FAN, preset: 'Auto' },
    ]);
  });

  it('sends the whole percentage HA uses for a three-speed position, and names it in aria-valuetext', async () => {
    const { root, intents } = await mountControls(tile('on', { percentage: 100, percentage_step: 100 / 3 }));
    const slider = root.querySelector<AgrSlider>('agr-slider');
    const input = slider?.shadowRoot?.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-valuetext')).toBe('100 percent');
    for (const position of ['99.999999', '66.666666']) {
      input.value = position;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(intents.map((intent) => intent.detail)).toEqual([
      { kind: 'speed', entity: FAN, percentage: 100 },
      { kind: 'speed', entity: FAN, percentage: 66 },
    ]);
  });

  it('shows a power ticket only on the button that sent it while the state is unknown', async () => {
    const gateway = new FakeGateway();
    gateway.request({ kind: 'fan.turn_off', entity: entityId(FAN) });
    const { root } = await mountControls(tile('unknown', {}, gateway));
    const [on, off] = [...root.querySelectorAll('agr-button')];
    expect(on?.status).toBeUndefined();
    expect(off?.status?.kind).toBe('fan.turn_off');
  });

  it('never acts on navigation keys across presets, and owns no timers', async () => {
    vi.useFakeTimers();
    const { root, intents } = await mountControls(tile('on'));
    const buttons = [...(root.querySelector('agr-choice-group')?.shadowRoot?.querySelectorAll('button') ?? [])];
    for (const button of buttons) for (const key of NAVIGATION_KEYS) pressKey(button, key);
    expect(intents).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the shared reason under the presets when every other preset is paused', async () => {
    const gateway = new FakeGateway();
    gateway.availability = { enabled: false, reason: 'disconnected', message: 'Paused while disconnected.' };
    const fan = testEntity(FAN, 'on', {
      preset_mode: 'Sleep',
      preset_modes: ['Auto', 'Sleep'],
      supported_features: FEATURES,
    });
    const vm = selectAirTile(
      selectorInputFor([fan], { config: { air: [FAN] }, gateway }),
      { entity: entityId(FAN) },
      'air',
    );
    const { root } = await mountControls(vm);
    expect(root.querySelector('.field p')?.textContent).toBe('Paused while disconnected.');
  });
});

class HostElement extends LitElement {}
customElements.define('test-fan-holder', HostElement);

describe('applyFanIntent', () => {
  async function holder() {
    const gateway = new FakeGateway();
    const services = servicesFor([], { config: { air: [FAN] }, gateway });
    const host = await mountElement<HostElement>('test-fan-holder', () => undefined);
    // A connected host runs hostConnected() as soon as the controller is added.
    const actions = new ActionController(
      host,
      () => services,
      () => [fanActionKey(entityId(FAN))],
    );
    return { gateway, actions };
  }

  it('maps power and preset to exactly one request each', async () => {
    const { gateway, actions } = await holder();
    applyFanIntent(actions, { kind: 'power', entity: entityId(FAN), next: 'on' }, () => null);
    applyFanIntent(actions, { kind: 'preset', entity: entityId(FAN), preset: 'Auto' }, () => null);
    expect(requestsOf(gateway)).toEqual([
      { kind: 'fan.turn_on', entity: FAN },
      { kind: 'fan.set_preset_mode', entity: FAN, preset: 'Auto' },
    ]);
  });

  it("debounces speed into one set_percentage on HA's percentage, and sends 0 as turn_off", async () => {
    vi.useFakeTimers();
    const { gateway, actions } = await holder();
    applyFanIntent(actions, { kind: 'speed', entity: entityId(FAN), percentage: 100 / 3 }, () => 0);
    applyFanIntent(actions, { kind: 'speed', entity: entityId(FAN), percentage: 200 / 3 }, () => 0);
    expect(gateway.calls).toEqual([]);
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS);
    expect(requestsOf(gateway)).toEqual([{ kind: 'fan.set_percentage', entity: FAN, percentage: 66 }]);
    gateway.settle(fanActionKey(entityId(FAN)), 'confirmed');
    applyFanIntent(actions, { kind: 'speed', entity: entityId(FAN), percentage: 0 }, () => 66);
    vi.advanceTimersByTime(SLIDER_COMMIT_DEBOUNCE_MS);
    expect(requestsOf(gateway).at(-1)).toEqual({ kind: 'fan.turn_off', entity: FAN });
  });
});
