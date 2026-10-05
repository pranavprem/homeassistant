/**
 * Acceptance item 6 (§12.1 row 6): security labels route to the right guarded scripts and never to raw arm/disarm;
 * Silence Sound and Disarm & Hold are different actions; actual alarm state and policy are shown independently.
 * Routing cases run the real gateway over a recording port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/primitives/agr-confirm-dialog.ts';
import type { AgrConfirmDialog } from '../../src/components/primitives/agr-confirm-dialog.ts';
import '../../src/components/security/agr-security-drawer.ts';
import type { AgrSecurityDrawer } from '../../src/components/security/agr-security-drawer.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { ConfirmDetail } from '../../src/components/shell/overlay-types.ts';
import type { SecurityActionRole } from '../../src/config/schema.ts';
import type { ActionGateway, ActionStatus } from '../../src/ha/actions/types.ts';
import { SECURITY_TICKET_COPY } from '../../src/ha/actions/messages.ts';
import { SECURITY_ACTION_COPY } from '../../src/model/action-copy.ts';
import { settle } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import {
  fakeGatewayServices,
  GARAGE_INPUT,
  GARAGE_STATES,
  IDS,
  realGateway,
  recordingPort,
  ROLE_SCRIPTS,
  SECURITY_INPUT,
  SECURITY_STATES,
  servicesFor,
  world,
  type RecordingPort,
  type World,
} from '../garage/world.ts';

const ROLES = Object.keys(ROLE_SCRIPTS) as SecurityActionRole[];

interface Mounted {
  readonly drawer: AgrSecurityDrawer;
  readonly root: ShadowRoot;
  readonly confirms: CustomEvent<ConfirmDetail>[];
  button(role: SecurityActionRole): HTMLButtonElement | null;
  host(role: SecurityActionRole): HTMLElement | null;
  text(): string;
}

async function mountDrawer(services: DashboardServices): Promise<Mounted> {
  const drawer = document.createElement('agr-security-drawer');
  drawer.services = services;
  drawer.request = { id: 'security' };
  const confirms: CustomEvent<ConfirmDetail>[] = [];
  document.body.addEventListener('agr-request-confirm', (event) => confirms.push(event));
  document.body.append(drawer);
  await settle();
  const root = drawer.shadowRoot as ShadowRoot;
  const host = (role: SecurityActionRole) =>
    root.querySelector<HTMLElement>(`agr-button[focus-key="security:${role}"]`);
  return {
    drawer,
    root,
    confirms,
    host,
    button: (role) => host(role)?.shadowRoot?.querySelector('button') ?? null,
    text: () => (root.textContent ?? '').replace(/\s+/g, ' '),
  };
}

async function confirmFrom(services: DashboardServices, detail: ConfirmDetail) {
  const dialog = document.createElement('agr-confirm-dialog') as AgrConfirmDialog;
  dialog.services = services;
  dialog.action = detail.action;
  document.body.append(dialog);
  await dialog.updateComplete;
  const root = dialog.shadowRoot as ShadowRoot;
  return {
    label: () => root.querySelector('button.confirm')?.textContent?.trim(),
    confirm: () => (root.querySelector('button.confirm') as HTMLButtonElement).click(),
    cancel: () => (root.querySelector('button.cancel') as HTMLButtonElement).click(),
  };
}

let w: World;
let port: RecordingPort;
let gateway: ActionGateway;

function liveWorld(states: Record<string, readonly [string, Record<string, unknown>?]> = {}, input = {}): void {
  w = world({ ...GARAGE_INPUT, ...SECURITY_INPUT, ...input }, { ...GARAGE_STATES, ...SECURITY_STATES, ...states });
  port = recordingPort();
  gateway = realGateway(w, port);
}

beforeEach(() => liveWorld());

afterEach(() => {
  gateway.dispose();
});

describe('agr-security-drawer: routing to guarded scripts (acceptance item 6)', () => {
  it.each(ROLES)('"%s" routes to exactly one script.turn_on on its configured script', async (role) => {
    const services = servicesFor(w, gateway);
    const mounted = await mountDrawer(services);
    expect(mounted.button(role)?.textContent?.trim()).toBe(SECURITY_ACTION_COPY[role].label);
    mounted.button(role)?.click();
    // With the alarm disarmed every role, Silence Sound included, asks for confirmation first.
    expect(mounted.confirms).toHaveLength(1);
    expect(mounted.confirms[0]?.detail.action).toEqual({ kind: 'security.run', role });
    expect(port.calls).toEqual([]);
    (await confirmFrom(services, mounted.confirms[0]!.detail)).confirm();
    expect(port.calls).toEqual([
      { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: ROLE_SCRIPTS[role] } },
    ]);
  });

  it.each(['triggered', 'pending'])('Silence Sound runs at once while the alarm is %s', async (state) => {
    liveWorld({ [IDS.alarm]: [state, {}] });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    mounted.button('silence_sound')?.click();
    expect(mounted.confirms).toEqual([]);
    expect(port.calls).toEqual([
      { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: IDS.silence } },
    ]);
  });

  it('every other role still asks for confirmation while the alarm sounds', async () => {
    liveWorld({ [IDS.alarm]: ['triggered', {}] });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    for (const role of ROLES.filter((r) => r !== 'silence_sound')) mounted.button(role)?.click();
    expect(mounted.confirms.map((event) => event.detail.action)).toEqual(
      ROLES.filter((r) => r !== 'silence_sound').map((role) => ({ kind: 'security.run', role })),
    );
    expect(port.calls).toEqual([]);
  });

  it.each(ROLES)('the confirm label for "%s" equals the drawer button label', async (role) => {
    const services = servicesFor(w, gateway);
    const mounted = await mountDrawer(services);
    mounted.button(role)?.click();
    const dialog = await confirmFrom(services, mounted.confirms[0]!.detail);
    expect(dialog.label()).toBe(mounted.button(role)?.textContent?.trim());
    dialog.cancel();
    expect(port.calls).toEqual([]);
  });

  it('keeps Disarm & hold and Silence sound apart: separate groups, labels and consequences', async () => {
    const mounted = await mountDrawer(servicesFor(w, gateway));
    const disarm = mounted.button('disarm_hold')?.textContent?.trim() ?? '';
    expect(disarm).toBe('Disarm & hold');
    expect(disarm.toLowerCase()).not.toContain('silence');
    expect(disarm.replace(/&|\s|hold|disarm/gi, '')).toBe('');
    const groupOf = (role: SecurityActionRole) =>
      mounted.host(role)?.closest('.group')?.querySelector('h4')?.textContent;
    expect(groupOf('silence_sound')).toBe('Sound');
    expect(groupOf('disarm_hold')).toBe('Disarm');
    expect(mounted.text()).toContain(SECURITY_ACTION_COPY.silence_sound.consequence);
    expect(mounted.text()).toContain(SECURITY_ACTION_COPY.disarm_hold.consequence);
  });

  it('renders only configured roles', async () => {
    liveWorld({}, { security: { ...SECURITY_INPUT.security, actions: { hold_night: IDS.holdNight } } });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    expect([...mounted.root.querySelectorAll('agr-button')].map((b) => b.getAttribute('focus-key'))).toEqual([
      'security:hold_night',
    ]);
    expect(mounted.text()).not.toContain(SECURITY_ACTION_COPY.silence_sound.label);
    expect(mounted.text().toLowerCase()).not.toContain('silence');
  });

  it('never calls the port on mount or state pushes', async () => {
    const mounted = await mountDrawer(servicesFor(w, gateway));
    for (const state of ['arming', 'armed_away', 'pending', 'triggered', 'disarmed']) {
      w.set(IDS.alarm, state);
      await mounted.drawer.updateComplete;
    }
    w.setConnected(false);
    w.setConnected(true);
    await settle();
    expect(port.calls).toEqual([]);
  });
});

describe('agr-security-drawer: status shows state and policy independently (§8.1)', () => {
  function row(mounted: Mounted, label: string): Element | undefined {
    return [...mounted.root.querySelectorAll('.row')].find((r) => r.querySelector('dt')?.textContent === label);
  }

  it('armed_away under policy "Auto" shows both rows, each with its helper text', async () => {
    liveWorld({ [IDS.alarm]: ['armed_away', {}] });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    expect(row(mounted, 'Alarm')?.querySelector('.value')?.textContent).toContain('Armed away');
    expect(row(mounted, 'Arming policy')?.querySelector('.value')?.textContent?.trim()).toBe('Auto');
    expect(row(mounted, 'Alarm')?.textContent).toContain('What the alarm panel reports right now.');
    expect(row(mounted, 'Arming policy')?.textContent).toContain(
      'How the house decides when to arm. It is not the alarm state.',
    );
  });

  it('names the Alarm row while HA starts and the alarm has not arrived (the skeleton is hidden from readers)', async () => {
    const { [IDS.alarm]: _alarm, ...withoutAlarm } = { ...GARAGE_STATES, ...SECURITY_STATES };
    w = world({ ...GARAGE_INPUT, ...SECURITY_INPUT }, withoutAlarm, { haState: 'STARTING' });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    const value = row(mounted, 'Alarm')?.querySelector('.value');
    expect(value?.querySelector('.skeleton')?.getAttribute('aria-hidden')).toBe('true');
    expect(value?.querySelector('.visually-hidden')?.textContent).toBe('Loading');
  });

  it('disarmed under policy "Auto" never renders "Armed"', async () => {
    const mounted = await mountDrawer(servicesFor(w, gateway));
    expect(row(mounted, 'Alarm')?.textContent).toContain('Disarmed');
    expect(mounted.text()).not.toMatch(/\bArmed\b/);
  });

  it('shows the suggested mode, commissioning and health as their own labelled rows', async () => {
    liveWorld({ [IDS.commissioning]: ['on', {}], [IDS.suggested]: ['Armed night', {}] });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    const labels = [...mounted.root.querySelectorAll('.row dt')].map((dt) => dt.textContent);
    expect(labels).toEqual(['Alarm', 'Arming policy', 'Would choose', 'Commissioning', 'Health']);
    expect(row(mounted, 'Would choose')?.textContent).toContain('Armed night');
    expect(row(mounted, 'Would choose')?.textContent).toContain('The mode the security controller would pick');
    expect(row(mounted, 'Commissioning')?.textContent).toContain('Setup mode on');
    expect(row(mounted, 'Commissioning')?.textContent).toContain('Changed outside this dashboard.');
    expect(row(mounted, 'Health')?.textContent).toContain(
      'A status message from the security controller, not a sensor test.',
    );
    // Commissioning is a read-only line: nothing in its row can be pressed.
    expect(row(mounted, 'Commissioning')?.querySelector('button, agr-button')).toBeNull();
    expect(mounted.text()).not.toMatch(/walk.?test|commission(?:ing)? (?:on|off) button/i);
  });

  it('keeps the health text in its own row and never under the Alarm row as a cause', async () => {
    liveWorld({ [IDS.alarm]: ['triggered', {}], [IDS.health]: ['Siren active on the side gate', {}] });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    expect(row(mounted, 'Health')?.textContent).toContain('Siren active on the side gate');
    expect(row(mounted, 'Alarm')?.textContent).not.toContain('Siren active');
  });

  it('pairs a stale alarm with a separate "Last known" element', async () => {
    w.setConnected(false);
    const mounted = await mountDrawer(servicesFor(w, gateway));
    const alarm = row(mounted, 'Alarm');
    expect(alarm?.querySelector('.alarm-value')?.textContent?.trim()).toBe('Disarmed');
    expect([...(alarm?.querySelectorAll('.t-meta') ?? [])].map((el) => el.textContent)).toContain('Last known');
  });

  it('lists monitored entry points with the coverage footer', async () => {
    liveWorld({ [IDS.backDoor]: ['on', { friendly_name: 'Back door' }] });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    const entries = [...mounted.root.querySelectorAll('.entry')].map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(entries).toEqual(['Front door Closed', 'Back door Open', 'Garage door Closed']);
    expect(mounted.text()).toContain(
      'Only the sensors listed here are shown. A camera picture is not a monitored entry point.',
    );
  });

  it('escapes the health text and entry-point names', async () => {
    liveWorld({
      [IDS.health]: ['<img src=x onerror=alert(1)>', {}],
      [IDS.backDoor]: ['off', { friendly_name: '<script>alert(1)</script>' }],
    });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    expect(mounted.text()).toContain('<img src=x onerror=alert(1)>');
    expect(mounted.text()).toContain('<script>alert(1)</script>');
    expect(mounted.root.querySelector('img, script')).toBeNull();
  });

  it('shows a calm empty state when security is not configured', async () => {
    const bare = world({ ...GARAGE_INPUT }, GARAGE_STATES);
    const mounted = await mountDrawer(servicesFor(bare, new FakeGateway()));
    expect(mounted.root.querySelector('agr-empty-state')?.getAttribute('heading')).toBe('Security is not set up');
    expect(mounted.root.querySelector('agr-button')).toBeNull();
  });
});

describe('agr-security-drawer: shared reasons and ticket text (§7.2, §8.2)', () => {
  it('with controls: false shows one notice instead of a line under every button', async () => {
    liveWorld({}, { controls: false });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    const notices = [...mounted.root.querySelectorAll('.notice')].map((p) => p.textContent?.trim());
    expect(notices).toEqual(['Controls are turned off in the dashboard configuration.']);
    for (const role of ROLES) expect(mounted.button(role)?.getAttribute('aria-disabled')).toBe('true');
    expect(mounted.root.querySelectorAll('.action [data-tone="attention"]')).toHaveLength(0);
    mounted.button('hold_night')?.click();
    expect(mounted.confirms).toEqual([]);
  });

  it('shows a per-action reason under that action only ("Already running")', async () => {
    liveWorld({ [IDS.holdAway]: ['on', { last_triggered: '2026-09-30T10:00:00.000Z' }] });
    const mounted = await mountDrawer(servicesFor(w, gateway));
    const reasons = [...mounted.root.querySelectorAll('.action [data-tone="attention"]')];
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.closest('.action')?.querySelector('agr-button')?.getAttribute('focus-key')).toBe(
      'security:hold_away',
    );
  });

  describe('with a controllable gateway', () => {
    let fake: FakeGateway;
    let mounted: Mounted;

    beforeEach(async () => {
      fake = new FakeGateway();
      fake.availability = { enabled: true, confirm: true };
      mounted = await mountDrawer(fakeGatewayServices(w, fake));
    });

    function notes(root = mounted.root): ShadowRoot {
      return root.querySelector('agr-control-notes')?.shadowRoot as ShadowRoot;
    }

    function liveRegion(root = mounted.root): string {
      return (notes(root).querySelector('[role="status"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    }

    /** The visible outcome line in the region (uncertain, failed), if any. */
    function visibleNote(): Element | null {
      return notes().querySelector('.note');
    }

    /** The short progress the attributed button shows in place. */
    function statusUnder(role: SecurityActionRole): string | undefined {
      return mounted.host(role)?.shadowRoot?.querySelector('.status')?.textContent?.trim();
    }

    async function move(phase: ActionStatus['phase'], error?: ActionStatus['error']): Promise<void> {
      fake.settle('security', phase, error);
      await settle();
    }

    it('shows each phase on the button that started it, and announces it in the one live region', async () => {
      const region = notes().querySelector('[role="status"]');
      mounted.button('hold_night')?.click();
      fake.request(mounted.confirms[0]!.detail.action);
      await settle();
      expect(statusUnder('hold_night')).toBe('Sending');
      expect(statusUnder('hold_away')).toBeUndefined();
      expect(liveRegion()).toBe('Hold Night Sending');
      await move('sent');
      expect(statusUnder('hold_night')).toBe('Waiting for a response');
      expect(liveRegion()).toBe('Hold Night Waiting for the security controller');
      await move('confirmed');
      expect(statusUnder('hold_night')).toBe('Requested');
      expect(liveRegion()).toBe('Hold Night Requested');
      expect(visibleNote()).toBeNull();
      expect(notes().querySelector('[role="status"]')).toBe(region);
      expect(mounted.root.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
      expect(mounted.root.querySelectorAll('agr-control-notes')).toHaveLength(1);
    });

    it('an uncertain outcome stays visible with Dismiss, which clears it and returns focus to the action', async () => {
      mounted.button('prepare_departure')?.click();
      fake.request(mounted.confirms[0]!.detail.action);
      await move('uncertain', { code: 'timeout', message: SECURITY_TICKET_COPY.uncertain });
      expect(statusUnder('prepare_departure')).toBe('No response yet');
      expect(visibleNote()?.textContent?.replace(/\s+/g, ' ')).toContain(
        `Prepare garage departure ${SECURITY_TICKET_COPY.uncertain}`,
      );
      expect(visibleNote()?.getAttribute('data-tone')).toBe('attention');
      const dismissSpy = vi.spyOn(fake, 'dismiss');
      const focusSpy = vi.spyOn(mounted.host('prepare_departure') as HTMLElement, 'focus');
      notes().querySelector('agr-button')?.shadowRoot?.querySelector('button')?.click();
      await settle();
      expect(dismissSpy).toHaveBeenCalledWith('security');
      expect(statusUnder('prepare_departure')).toBeUndefined();
      expect(liveRegion()).toBe('');
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('a failure shows the gateway message in danger text', async () => {
      mounted.button('disarm_hold')?.click();
      fake.request(mounted.confirms[0]!.detail.action);
      await move('failed', { code: 'permission-denied', message: "Your Home Assistant user can't control this." });
      expect(statusUnder('disarm_hold')).toBe('Not done');
      expect(visibleNote()?.textContent).toContain("Your Home Assistant user can't control this.");
      expect(visibleNote()?.getAttribute('data-tone')).toBe('danger');
    });

    it('a cancelled confirmation never claims a ticket; the next confirmed role takes the attribution', async () => {
      mounted.button('hold_vacation')?.click(); // the user then cancels: no request
      mounted.drawer.requestUpdate();
      await settle();
      expect(statusUnder('hold_vacation')).toBeUndefined();
      mounted.button('resume_auto')?.click();
      fake.request(mounted.confirms[1]!.detail.action);
      await settle();
      expect(statusUnder('resume_auto')).toBe('Sending');
      expect(statusUnder('hold_vacation')).toBeUndefined();
    });

    it('announces a ticket that predates the drawer without claiming a button for it', async () => {
      fake.request({ kind: 'security.run', role: 'hold_away' });
      const reopened = await mountDrawer(fakeGatewayServices(w, fake));
      expect(liveRegion(reopened.root)).toBe('Security Sending');
      expect(reopened.host('hold_away')?.shadowRoot?.querySelector('.status')).toBeNull();
    });

    it('shows VISIBLY why every action is disabled while a ticket that predates the drawer is in flight (§7.2)', async () => {
      const busy = 'Waiting for the security controller to respond to the last request.';
      fake.availability = { enabled: false, reason: 'busy', message: busy };
      fake.request({ kind: 'security.run', role: 'hold_away' });
      const reopened = await mountDrawer(fakeGatewayServices(w, fake));
      const region = notes(reopened.root);
      const visible = () => {
        const note = region.querySelector('.note');
        const groupNotice = reopened.root.querySelector('.notice')?.textContent?.trim();
        return [note?.textContent?.replace(/\s+/g, ' ').trim(), groupNotice];
      };
      // No button carries the progress, so the region shows it: nothing is announce-only or hidden.
      expect(region.querySelector('.visually-hidden')).toBeNull();
      expect(reopened.root.querySelector('agr-control-notes')?.hasAttribute('quiet')).toBe(false);
      expect(visible()[0]).toBe('Security Sending');
      fake.settle('security', 'sent');
      reopened.drawer.requestUpdate();
      await settle();
      expect(visible()[0]).toBe('Security Waiting for the security controller');
      // Each button's own reason stays visually hidden, so the region's visible line is what explains them.
      for (const role of ROLES) {
        expect(reopened.button(role)?.disabled || reopened.button(role)?.getAttribute('aria-disabled')).toBeTruthy();
      }
    });

    it('only Silence Sound may skip the dialog, even if an Availability says confirm: false for every role', async () => {
      fake.availability = { enabled: true, confirm: false };
      for (const role of ROLES) mounted.button(role)?.click();
      expect(fake.calls.map((call) => call.req)).toEqual([{ kind: 'security.run', role: 'silence_sound' }]);
      expect(mounted.confirms.map((event) => event.detail.action)).toEqual(
        ROLES.filter((role) => role !== 'silence_sound').map((role) => ({ kind: 'security.run', role })),
      );
    });

    it('a direct request that fails at once is still shown (Silence Sound while sounding)', async () => {
      fake.availability = { enabled: true, confirm: false };
      fake.failWith = {
        code: 'disconnected',
        message: 'Not sent: Home Assistant was disconnected. Nothing was changed.',
      };
      mounted.button('silence_sound')?.click();
      await settle();
      expect(fake.calls.map((call) => call.req)).toEqual([{ kind: 'security.run', role: 'silence_sound' }]);
      expect(statusUnder('silence_sound')).toBe('Not done');
      expect(visibleNote()?.textContent).toContain('Not sent: Home Assistant was disconnected. Nothing was changed.');
    });
  });
});

describe('agr-security-drawer: the drawer shell', () => {
  it('renders inside agr-drawer with the heading, demo flag and theme', async () => {
    const services = { ...servicesFor(w, gateway), mode: 'demo' as const, theme: 'dark' as const };
    const mounted = await mountDrawer(services);
    const shell = mounted.root.querySelector('agr-drawer');
    expect(shell?.heading).toBe('Security');
    expect(shell?.demo).toBe(true);
    expect(shell?.theme).toBe('dark');
    const headings = [...mounted.root.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings).toEqual(['Status', 'Actions', 'Monitored entry points']);
  });
});
