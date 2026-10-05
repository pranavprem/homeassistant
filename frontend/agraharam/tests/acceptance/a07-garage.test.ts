/**
 * ACCEPTANCE check 7 (§12.1 row 7): garage open and close require explicit confirmation; cancel sends nothing;
 * preparing a departure is never confused with physically moving the garage door.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  advance,
  buttons,
  confirmDialog,
  control,
  liveInput,
  mountLive,
  overlays,
  press,
  renderedText,
  section,
  serviceCalls,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';

const GARAGE = 'cover.demo_garage';
const ALARM = 'alarm_control_panel.demo_home';
const ALARM_LINE = 'The alarm is Armed away. Opening the garage may set it off.';
const DEPARTURE_HINT = 'To leave without setting it off, use Prepare garage departure in Security first.';
const UNKNOWN_ALARM_LINE = "The alarm state isn't available right now.";
const GARAGE_TIMEOUT_MS = 60_000;

beforeEach(() => {
  useAcceptanceTimers();
});

function garage(card: LiveCard): ShadowRoot {
  return shadowOf(section(card, 'agr-garage'));
}

function dialogPart(card: LiveCard, selector: string): string {
  return renderedText(shadowOf(confirmDialog(card)).querySelector(selector) as Element);
}

async function answer(card: LiveCard, choice: 'confirm' | 'cancel'): Promise<void> {
  await press(shadowOf(confirmDialog(card)).querySelector(`button.${choice}`) as HTMLButtonElement);
}

describe('opening the garage needs an explicit confirmation', () => {
  it('"Open garage" only asks; Cancel sends nothing; Confirm sends exactly one open_cover to the configured door', async () => {
    const card = await mountLive();
    await press(control(garage(card), 'garage:open'));
    expect(serviceCalls(card.fake)).toEqual([]);
    expect(dialogPart(card, 'h2')).toBe('Open the garage door?');
    expect(dialogPart(card, '.confirm')).toBe('Open garage');
    await answer(card, 'cancel');
    await advance(5_000);
    expect(serviceCalls(card.fake)).toEqual([]);

    await press(control(garage(card), 'garage:open'));
    await answer(card, 'confirm');
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'cover', service: 'open_cover', data: {}, target: { entity_id: GARAGE } },
    ]);
    await advance(GARAGE_TIMEOUT_MS * 2);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });

  it('while the door is moving the buttons refuse, so the door cannot be confirmed twice', async () => {
    const card = await mountLive({ latencyMs: [5_000, 5_000] });
    await press(control(garage(card), 'garage:open'));
    await answer(card, 'confirm');
    await press(control(garage(card), 'garage:open'));
    expect(confirmDialog(card)).toBeNull();
    await advance(1_000);
    expect(serviceCalls(card.fake)).toHaveLength(1);
  });

  it('"Close garage" on an open door has its own confirmation and sends close_cover once', async () => {
    const card = await mountLive();
    card.fake.setState(GARAGE, 'open');
    await advance(0);
    await press(control(garage(card), 'garage:close'));
    expect(dialogPart(card, 'h2')).toBe('Close the garage door?');
    expect(dialogPart(card, '.confirm')).toBe('Close garage');
    expect(dialogPart(card, '.dialog-body')).not.toContain('alarm');
    await answer(card, 'confirm');
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'cover', service: 'close_cover', data: {}, target: { entity_id: GARAGE } },
    ]);
  });

  it('a position the door has not reported offers no door button at all, only a line to check the garage', async () => {
    const card = await mountLive({ scenario: 'degraded' });
    const root = garage(card);
    expect(() => control(root, 'garage:open')).toThrow();
    expect(() => control(root, 'garage:close')).toThrow();
    expect(buttons(root).map((button) => renderedText(button))).not.toContainEqual(expect.stringMatching(/garage/i));
    expect(renderedText(root)).toContain('Position unknown. Check the garage before using it from here.');
    expect(confirmDialog(card)).toBeNull();
    expect(serviceCalls(card.fake)).toEqual([]);
  });

  it('a disconnect while the confirmation is open cancels it ("Not sent") and a reconnect never reopens it', async () => {
    const card = await mountLive();
    await press(control(garage(card), 'garage:open'));
    card.fake.disconnect();
    await advance(0);
    expect(topOverlay(card)).toBeUndefined();
    expect(renderedText(overlays(card))).toContain('Not sent. The connection changed while this was open.');
    card.fake.reconnect({ snapshotDelayMs: 0 });
    await advance(5_000);
    expect(confirmDialog(card)).toBeNull();
    expect(serviceCalls(card.fake)).toEqual([]);
  });
});

describe('the Open confirmation warns about the alarm, and only warns', () => {
  it('armed away: the alarm line and the departure hint; confirming still sends one open_cover and no script', async () => {
    const card = await mountLive();
    card.fake.setState(ALARM, 'armed_away');
    await advance(0);
    await press(control(garage(card), 'garage:open'));
    const body = dialogPart(card, '.dialog-body');
    expect(body).toContain(ALARM_LINE);
    expect(body).toContain(DEPARTURE_HINT);
    await answer(card, 'confirm');
    await advance(GARAGE_TIMEOUT_MS);
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'cover', service: 'open_cover', data: {}, target: { entity_id: GARAGE } },
    ]);
  });

  it('the copy follows the alarm live while the dialog is open', async () => {
    const card = await mountLive();
    await press(control(garage(card), 'garage:open'));
    expect(dialogPart(card, '.dialog-body')).not.toContain('alarm');
    card.fake.setState(ALARM, 'armed_away');
    await advance(0);
    expect(dialogPart(card, '.dialog-body')).toContain(ALARM_LINE);
    card.fake.setState(ALARM, 'unknown');
    await advance(0);
    expect(dialogPart(card, '.dialog-body')).toContain(UNKNOWN_ALARM_LINE);
    card.fake.setState(ALARM, 'disarmed');
    await advance(0);
    expect(dialogPart(card, '.dialog-body')).not.toContain('alarm');
  });

  it('without a departure script configured, the hint is absent', async () => {
    const input = liveInput('normal');
    const security = input['security'] as { actions: Record<string, string> };
    const { prepare_departure: _departure, ...actions } = security.actions;
    const card = await mountLive({ input: { ...input, security: { ...security, actions } } });
    card.fake.setState(ALARM, 'armed_away');
    await advance(0);
    await press(control(garage(card), 'garage:open'));
    expect(dialogPart(card, '.dialog-body')).toContain(ALARM_LINE);
    expect(dialogPart(card, '.dialog-body')).not.toContain('Prepare garage departure');
  });
});

describe('preparing a departure is not moving the door', () => {
  it('"Prepare garage departure" runs only the departure script; the door gets no call, now or later', async () => {
    const card = await mountLive();
    await press(control(shadowOf(section(card, 'agr-header')), 'header:security'));
    const drawer = shadowOf(topOverlay(card));
    expect(renderedText(drawer)).toContain('It does not open the garage door.');
    await press(control(drawer, 'security:prepare_departure'));
    expect(dialogPart(card, '.dialog-body')).toContain('The garage door does not move.');
    await answer(card, 'confirm');
    await advance(GARAGE_TIMEOUT_MS * 2);
    const departure = (liveInput('normal')['security'] as { actions: Record<string, string> }).actions[
      'prepare_departure'
    ];
    expect(serviceCalls(card.fake)).toEqual([
      { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: departure } },
    ]);
    expect(renderedText(garage(card))).toContain('Closed');
  });

  it('the Garage panel offers no departure shortcut, and the departure button lives only in Security', async () => {
    const card = await mountLive();
    expect(renderedText(garage(card))).not.toContain('departure');
    await press(control(garage(card), 'garage:open'));
    const dialog = shadowOf(confirmDialog(card));
    expect([...dialog.querySelectorAll('button')].map((button) => renderedText(button))).toEqual([
      'Cancel',
      'Open garage',
    ]);
  });
});
