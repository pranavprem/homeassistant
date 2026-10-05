/**
 * ACCEPTANCE check 6 (§12.1 row 6): security labels route to the configured guarded scripts, never to raw arm or
 * disarm services or helper writes; silencing the sound and the persistent disarm are different actions; the
 * actual alarm state and the requested policy are displayed independently.
 *
 * Driven through the header pill, the security drawer and the confirm dialog of the live card.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SecurityActionRole } from '../../src/config/schema.ts';
import {
  advance,
  buttonNamed,
  confirmDialog,
  control,
  liveInput,
  mountLive,
  press,
  renderedText,
  section,
  serviceCalls,
  settle,
  shadowOf,
  topOverlay,
  useAcceptanceTimers,
  type LiveCard,
} from './support.ts';

const ALARM = 'alarm_control_panel.demo_home';
const POLICY = 'input_select.demo_security_policy';
const ROLE_LABELS: Readonly<Record<SecurityActionRole, string>> = Object.freeze({
  silence_sound: 'Silence sound',
  disarm_hold: 'Disarm & hold',
  hold_night: 'Hold Night',
  hold_away: 'Hold Away',
  hold_vacation: 'Hold Vacation',
  resume_auto: 'Resume Auto arming',
  prepare_departure: 'Prepare garage departure',
});
const ROLES = Object.keys(ROLE_LABELS) as SecurityActionRole[];
/** Long enough for a script ticket to confirm (or time out at 10 s) and clear its "Requested" line. */
const SECURITY_SETTLE_MS = 15_000;

beforeEach(() => {
  useAcceptanceTimers();
});

function configuredScripts(input: Record<string, unknown> = liveInput('normal')): Record<SecurityActionRole, string> {
  return (input['security'] as { actions: Record<SecurityActionRole, string> }).actions;
}

async function openSecurity(card: LiveCard): Promise<ShadowRoot> {
  await press(control(shadowOf(section(card, 'agr-header')), 'header:security'));
  const drawer = topOverlay(card);
  expect(drawer?.tagName).toBe('AGR-SECURITY-DRAWER');
  return shadowOf(drawer);
}

function roleButton(drawer: ShadowRoot, role: SecurityActionRole): HTMLElement {
  return control(drawer, `security:${role}`);
}

/** The confirm dialog's own title, body and confirm-button text. */
function confirmCopy(card: LiveCard): { title: string; body: string; confirmLabel: string } {
  const dialog = shadowOf(confirmDialog(card));
  return {
    title: renderedText(dialog.querySelector('h2') as Element),
    body: renderedText(dialog.querySelector('.dialog-body') as Element),
    confirmLabel: renderedText(dialog.querySelector('button.confirm') as Element),
  };
}

async function confirm(card: LiveCard): Promise<void> {
  await press(shadowOf(confirmDialog(card)).querySelector('button.confirm') as HTMLButtonElement);
}

describe('every security label routes to its configured guarded script', () => {
  it.each(ROLES)(
    '%s: the button asks for confirmation with the same label, then runs only its script',
    async (role) => {
      const card = await mountLive();
      const drawer = await openSecurity(card);
      await press(roleButton(drawer, role));
      expect(serviceCalls(card.fake)).toEqual([]); // the tap alone sends nothing (alarm is disarmed)
      expect(confirmDialog(card)).not.toBeNull();
      expect(confirmCopy(card).confirmLabel).toBe(ROLE_LABELS[role]);
      await confirm(card);
      expect(serviceCalls(card.fake)).toEqual([
        { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: configuredScripts()[role] } },
      ]);
    },
  );

  it('routing follows the configuration, not the script names: swapped holds run the swapped scripts', async () => {
    const input = liveInput('normal');
    const scripts = configuredScripts(input);
    const swapped = { ...scripts, hold_night: scripts.hold_away, hold_away: scripts.hold_night };
    const card = await mountLive({
      input: { ...input, security: { ...(input['security'] as object), actions: swapped } },
    });
    const drawer = await openSecurity(card);
    await press(roleButton(drawer, 'hold_night'));
    await confirm(card);
    expect(serviceCalls(card.fake)[0]?.target).toEqual({ entity_id: scripts.hold_away });
  });

  it('Cancel, closing the dialog (what Escape does natively) and the 60 s auto-cancel send nothing', async () => {
    const card = await mountLive();
    const drawer = await openSecurity(card);
    await press(roleButton(drawer, 'disarm_hold'));
    await press(shadowOf(confirmDialog(card)).querySelector('button.cancel') as HTMLButtonElement);
    await press(roleButton(drawer, 'resume_auto'));
    (confirmDialog(card) as Element & { close(): void }).close();
    await press(roleButton(drawer, 'hold_away'));
    await advance(70_000); // unanswered: the dialog cancels itself
    expect(serviceCalls(card.fake)).toEqual([]);
  });

  it('running every role sends only script.turn_on, never an alarm, helper, select or automation service', async () => {
    const card = await mountLive();
    const drawer = await openSecurity(card);
    for (const role of ROLES) {
      await press(roleButton(drawer, role));
      if (confirmDialog(card) !== null) await confirm(card);
      await advance(SECURITY_SETTLE_MS);
    }
    const calls = serviceCalls(card.fake);
    expect(calls).toHaveLength(ROLES.length);
    for (const call of calls) expect(call).toMatchObject({ domain: 'script', service: 'turn_on', data: {} });
    expect(new Set(calls.map((call) => JSON.stringify(call.target))).size).toBe(ROLES.length);
  });
});

describe('silencing the sound is not the persistent disarm', () => {
  it('the two buttons have different labels, consequences and scripts', async () => {
    const card = await mountLive();
    const drawer = await openSecurity(card);
    const silence = renderedText(roleButton(drawer, 'silence_sound'));
    const disarm = renderedText(roleButton(drawer, 'disarm_hold'));
    expect(disarm.toLowerCase()).not.toContain('silence');
    expect(silence.toLowerCase()).not.toContain('disarm');
    expect(renderedText(drawer)).toContain('Protection and the current policy stay the same.');
    expect(renderedText(drawer)).toContain('keeps it off until you resume Auto arming');
    expect(configuredScripts().silence_sound).not.toBe(configuredScripts().disarm_hold);
  });

  it('while the alarm sounds, Silence Sound acts at once (no confirm) and runs the silence script only', async () => {
    const card = await mountLive({ scenario: 'alert' });
    const drawer = await openSecurity(card);
    await press(roleButton(drawer, 'silence_sound'));
    expect(confirmDialog(card)).toBeNull();
    expect(serviceCalls(card.fake)).toEqual([
      expect.objectContaining({
        domain: 'script',
        service: 'turn_on',
        target: { entity_id: configuredScripts(liveInput('alert')).silence_sound },
      }),
    ]);
  });

  it('while the alarm sounds, Disarm & Hold still needs its own confirmation that says it is not silencing', async () => {
    const card = await mountLive({ scenario: 'alert' });
    const drawer = await openSecurity(card);
    await press(roleButton(drawer, 'disarm_hold'));
    expect(serviceCalls(card.fake)).toEqual([]);
    expect(confirmCopy(card).body).toContain('This is not the same as silencing the sound.');
  });

  it('Silence Sound confirms when the alarm is not sounding', async () => {
    const card = await mountLive();
    const drawer = await openSecurity(card);
    await press(roleButton(drawer, 'silence_sound'));
    expect(confirmCopy(card).title).toBe('Silence sound?');
    expect(serviceCalls(card.fake)).toEqual([]);
  });
});

describe('actual state and requested policy are shown independently', () => {
  it('armed away with policy Auto: the pill and the drawer show both, each as itself', async () => {
    const card = await mountLive();
    card.fake.setState(ALARM, 'armed_away');
    await settle();
    const header = renderedText(shadowOf(section(card, 'agr-header')));
    expect(header).toContain('Alarm: Armed away');
    expect(header).toContain('Policy: Auto');
    const drawer = await openSecurity(card);
    const text = renderedText(drawer);
    expect(text).toMatch(/Alarm Armed away/);
    expect(text).toMatch(/Arming policy Auto/);
  });

  it('disarmed with policy Auto never reads as armed', async () => {
    const card = await mountLive();
    const header = renderedText(shadowOf(section(card, 'agr-header')));
    expect(header).toContain('Alarm: Disarmed');
    expect(header).not.toMatch(/Armed/);
    expect(renderedText(await openSecurity(card))).toMatch(/Alarm Disarmed/);
  });

  it('a policy change alone never changes the alarm label, and an alarm change never changes the policy', async () => {
    const card = await mountLive();
    card.fake.setState(POLICY, 'Hold Away');
    await settle();
    let header = renderedText(shadowOf(section(card, 'agr-header')));
    expect(header).toContain('Alarm: Disarmed');
    expect(header).toContain('Policy: Hold Away');
    card.fake.setState(ALARM, 'triggered');
    await settle();
    header = renderedText(shadowOf(section(card, 'agr-header')));
    expect(header).toContain('Alarm: Alarm triggered');
    expect(header).toContain('Policy: Hold Away');
  });

  it('the security drawer never offers commissioning, walk-test or raw arm controls', async () => {
    const card = await mountLive();
    const drawer = await openSecurity(card);
    const labels = [...drawer.querySelectorAll('agr-button')].map((button) => renderedText(button));
    expect(labels).toEqual(expect.arrayContaining(Object.values(ROLE_LABELS)));
    expect(labels.join(' ')).not.toMatch(/commission|walk|siren|test|arm away|arm home|disarm$/i);
    expect(() => buttonNamed(drawer, /^Arm\b/)).toThrow();
  });
});
