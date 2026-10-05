/**
 * Acceptance item 7 (panel part, §12.1 row 7): garage Open/Close need an explicit confirmation, Cancel sends
 * nothing, the Open confirmation is alarm-aware, and confirming sends exactly one cover call and never a script.
 * Most cases run the real gateway over a recording port, so "invokes" are what would reach Home Assistant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/garage/agr-garage.ts';
import type { AgrGarage } from '../../src/components/garage/agr-garage.ts';
import '../../src/components/primitives/agr-confirm-dialog.ts';
import type { AgrConfirmDialog } from '../../src/components/primitives/agr-confirm-dialog.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import type { ConfirmDetail } from '../../src/components/shell/overlay-types.ts';
import type { ActionGateway, ActionStatus } from '../../src/ha/actions/types.ts';
import { GARAGE_TICKET_COPY } from '../../src/ha/actions/messages.ts';
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
} from './world.ts';

const ARMED_LINE = 'The alarm is Armed away. Opening the garage may set it off.';
const DEPARTURE_HINT = 'To leave without setting it off, use Prepare garage departure in Security first.';
const UNKNOWN_ALARM_LINE =
  "The alarm state isn't available right now. Opening the garage may set it off if the house is armed.";

interface Mounted {
  readonly garage: AgrGarage;
  readonly root: ShadowRoot;
  readonly confirms: CustomEvent<ConfirmDetail>[];
  button(action: 'open' | 'close'): HTMLButtonElement | null;
  text(): string;
}

async function mountGarage(services: DashboardServices): Promise<Mounted> {
  const garage = document.createElement('agr-garage');
  garage.services = services;
  const confirms: CustomEvent<ConfirmDetail>[] = [];
  document.body.addEventListener('agr-request-confirm', (event) => confirms.push(event));
  document.body.append(garage);
  await settle();
  const root = garage.shadowRoot as ShadowRoot;
  return {
    garage,
    root,
    confirms,
    button: (action) =>
      root.querySelector(`agr-button[focus-key="garage:${action}"]`)?.shadowRoot?.querySelector('button') ?? null,
    text: () => visibleText(root),
  };
}

/** The panel's text through nested shadow roots (agr-panel, agr-button, agr-vehicle). */
function visibleText(root: ShadowRoot | Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    const element = node as Element;
    if (element.shadowRoot) walk(element.shadowRoot);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return parts.join(' ').replace(/\s+/g, ' ');
}

async function openConfirm(services: DashboardServices, detail: ConfirmDetail) {
  const dialog = document.createElement('agr-confirm-dialog') as AgrConfirmDialog;
  dialog.services = services;
  dialog.action = detail.action;
  document.body.append(dialog);
  await dialog.updateComplete;
  const root = dialog.shadowRoot as ShadowRoot;
  return {
    dialog,
    native: root.querySelector('dialog') as HTMLDialogElement,
    body: () => [...root.querySelectorAll('.dialog-body p')].map((p) => p.textContent ?? ''),
    confirm: () => (root.querySelector('button.confirm') as HTMLButtonElement).click(),
    cancel: () => (root.querySelector('button.cancel') as HTMLButtonElement).click(),
  };
}

let w: World;
let port: RecordingPort;
let gateway: ActionGateway;

function liveWorld(
  states: Record<string, readonly [string, Record<string, unknown>?]> = {},
  input: Record<string, unknown> = {},
): void {
  w = world({ ...GARAGE_INPUT, ...SECURITY_INPUT, ...input }, { ...GARAGE_STATES, ...SECURITY_STATES, ...states });
  port = recordingPort();
  gateway = realGateway(w, port);
}

beforeEach(() => liveWorld());

afterEach(() => {
  gateway.dispose();
});

describe('agr-garage: explicit, confirmed door actions (acceptance item 7)', () => {
  it('shows the actual position and only "Open garage" for a closed door', async () => {
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.text()).toContain('Garage & car');
    expect(mounted.text()).toContain('Closed');
    expect(mounted.button('open')?.textContent?.trim()).toBe('Open garage');
    expect(mounted.button('close')).toBeNull();
  });

  it('shows only "Close garage" for an open door (never a toggle)', async () => {
    w.set(IDS.garage, 'open');
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.button('open')).toBeNull();
    expect(mounted.button('close')?.textContent?.trim()).toBe('Close garage');
  });

  it('"Open garage" dispatches agr-request-confirm and invokes nothing', async () => {
    const mounted = await mountGarage(servicesFor(w, gateway));
    mounted.button('open')?.click();
    expect(mounted.confirms).toHaveLength(1);
    expect(mounted.confirms[0]?.detail.action).toEqual({ kind: 'garage.open' });
    expect(mounted.confirms[0]?.detail.trigger.getAttribute('focus-key')).toBe('garage:open');
    expect(port.calls).toEqual([]);
  });

  it('Cancel and Escape send nothing', async () => {
    const services = servicesFor(w, gateway);
    const mounted = await mountGarage(services);
    mounted.button('open')?.click();
    const cancelled = await openConfirm(services, mounted.confirms[0]!.detail);
    cancelled.cancel();
    expect(cancelled.native.open).toBe(false);
    mounted.button('open')?.click();
    const escaped = await openConfirm(services, mounted.confirms[1]!.detail);
    escaped.native.dispatchEvent(new Event('cancel', { cancelable: true }));
    escaped.native.close(); // what the browser does for Escape
    expect(escaped.dialog.outcome).toBe('cancelled');
    expect(port.calls).toEqual([]);
  });

  it('confirming sends exactly one cover.open_cover on the configured cover, and no script', async () => {
    const services = servicesFor(w, gateway);
    const mounted = await mountGarage(services);
    mounted.button('open')?.click();
    (await openConfirm(services, mounted.confirms[0]!.detail)).confirm();
    expect(port.calls).toEqual([
      { domain: 'cover', service: 'open_cover', data: {}, target: { entity_id: IDS.garage } },
    ]);
    // A second tap while the first call is in flight is busy: still one call.
    await settle();
    mounted.button('open')?.click();
    expect(port.calls).toHaveLength(1);
    expect(port.calls.some((call) => call.domain === 'script')).toBe(false);
  });

  it('confirming Close sends exactly one cover.close_cover', async () => {
    w.set(IDS.garage, 'open');
    const services = servicesFor(w, gateway);
    const mounted = await mountGarage(services);
    mounted.button('close')?.click();
    (await openConfirm(services, mounted.confirms[0]!.detail)).confirm();
    expect(port.calls).toEqual([
      { domain: 'cover', service: 'close_cover', data: {}, target: { entity_id: IDS.garage } },
    ]);
  });

  it('never requests a door movement itself, even if an Availability omitted the confirm flag', async () => {
    const fake = new FakeGateway();
    fake.availability = { enabled: true, confirm: false };
    const mounted = await mountGarage(fakeGatewayServices(w, fake));
    mounted.button('open')?.click();
    expect(fake.calls).toEqual([]);
    expect(mounted.confirms.map((event) => event.detail.action)).toEqual([{ kind: 'garage.open' }]);
  });

  it('the gateway refuses garage.open without the confirm dialog', () => {
    const status = gateway.request({ kind: 'garage.open' });
    expect(status).toMatchObject({ phase: 'failed', error: { code: 'confirmation-required' } });
    expect(gateway.evaluate({ kind: 'garage.open' })).toEqual({ enabled: true, confirm: true });
    expect(port.calls).toEqual([]);
  });

  it('an unknown position offers no door buttons, only one line saying to check the garage (§16.14)', async () => {
    w.set(IDS.garage, 'unknown');
    expect(gateway.evaluate({ kind: 'garage.open' })).toMatchObject({ enabled: false, reason: 'state-unknown' });
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.text()).toContain('Position unknown');
    expect(mounted.button('open')).toBeNull();
    expect(mounted.button('close')).toBeNull();
    const reasons = [...mounted.root.querySelectorAll('.reason')].map((p) => p.textContent?.trim());
    expect(reasons).toEqual(['Position unknown. Check the garage before using it from here.']);
    expect(mounted.confirms).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it('a state HA covers do not define ("stopped") reads Position unknown and offers no buttons either', async () => {
    w.set(IDS.garage, 'stopped');
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.text()).toContain('Position unknown');
    expect(mounted.button('open')).toBeNull();
    expect(mounted.button('close')).toBeNull();
    expect(port.calls).toEqual([]);
  });

  it('renders no door buttons when the door itself is unavailable, only its state and reason', async () => {
    w.set(IDS.garage, 'unavailable');
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.text()).toContain('Unavailable');
    expect(mounted.button('open')).toBeNull();
    expect(mounted.button('close')).toBeNull();
    expect(mounted.root.querySelector('.reason')?.textContent).toContain('unavailable');
  });

  it('keeps the last known position with "Last known" and pauses the button while disconnected', async () => {
    w.setConnected(false);
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.text()).toContain('Closed');
    expect(mounted.text()).toContain('Last known');
    expect(mounted.button('open')?.getAttribute('aria-disabled')).toBe('true');
    mounted.button('open')?.click();
    expect(mounted.confirms).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it('with controls: false shows one panel-level notice and dispatches nothing', async () => {
    liveWorld({}, { controls: false });
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.button('open')?.getAttribute('aria-disabled')).toBe('true');
    const reasons = [...mounted.root.querySelectorAll('.reason')].map((p) => p.textContent?.trim());
    expect(reasons).toEqual(['Controls are turned off in the dashboard configuration.']);
    mounted.button('open')?.click();
    expect(mounted.confirms).toEqual([]);
  });

  it('never calls the port on mount, render or state pushes', async () => {
    const mounted = await mountGarage(servicesFor(w, gateway));
    for (const state of ['opening', 'open', 'closing', 'closed', 'unknown', 'closed']) {
      w.set(IDS.garage, state);
      w.set(IDS.battery, String(50 + state.length));
      await mounted.garage.updateComplete;
    }
    w.setConnected(false);
    w.setConnected(true);
    await settle();
    expect(port.calls).toEqual([]);
  });

  it('re-renders on a bound entity change (cover and vehicle)', async () => {
    const mounted = await mountGarage(servicesFor(w, gateway));
    w.set(IDS.garage, 'opening');
    w.set(IDS.battery, '63');
    await settle();
    expect(mounted.text()).toContain('Opening');
    expect(mounted.text()).toContain('63%');
  });
});

describe('agr-garage: alarm-aware Open confirmation (§8.5)', () => {
  async function openBody(alarmState: string | undefined, input: Record<string, unknown> = {}) {
    liveWorld(alarmState === undefined ? {} : { [IDS.alarm]: [alarmState, {}] }, input);
    if (alarmState === undefined) w.set(IDS.alarm, undefined);
    const services = servicesFor(w, gateway);
    const mounted = await mountGarage(services);
    mounted.button('open')?.click();
    return openConfirm(services, mounted.confirms[0]!.detail);
  }

  it('armed_away adds the warning and, with departure configured, the departure hint', async () => {
    const { body } = await openBody('armed_away');
    expect(body()).toEqual([
      'The door starts moving when you confirm.',
      `${ARMED_LINE} ${DEPARTURE_HINT}`,
      'Make sure the doorway is clear.',
    ]);
  });

  it('without a departure script the hint is absent', async () => {
    const { prepare_departure: _departure, ...actions } = ROLE_SCRIPTS;
    const { body } = await openBody('armed_away', { security: { ...SECURITY_INPUT.security, actions } });
    expect(body()).toContain(ARMED_LINE);
    expect(body().join(' ')).not.toContain('Prepare garage departure');
  });

  it('arming warns the same way', async () => {
    const { body } = await openBody('arming');
    expect(body().join(' ')).toContain('The alarm is Arming. Opening the garage may set it off.');
  });

  it.each(['unknown', 'unavailable'])('%s alarm gives the "isn\'t available" line', async (state) => {
    const { body } = await openBody(state);
    expect(body()).toContain(UNKNOWN_ALARM_LINE);
  });

  it('a missing alarm entity gives the "isn\'t available" line', async () => {
    const { body } = await openBody(undefined);
    expect(body()).toContain(UNKNOWN_ALARM_LINE);
  });

  it('a stale alarm (disconnected) gives the "isn\'t available" line', async () => {
    liveWorld({ [IDS.alarm]: ['armed_away', {}] });
    const dialogServices = servicesFor(w, new FakeGateway());
    (dialogServices.gateway as FakeGateway).availability = { enabled: true, confirm: true };
    w.setConnected(false);
    const { body } = await openConfirm(dialogServices, { action: { kind: 'garage.open' }, trigger: document.body });
    expect(body()).toContain(UNKNOWN_ALARM_LINE);
    expect(body().join(' ')).not.toContain(ARMED_LINE);
  });

  it.each(['disarmed', 'pending', 'triggered', 'disarming'])('%s adds no extra line', async (state) => {
    const { body } = await openBody(state);
    expect(body()).toEqual(['The door starts moving when you confirm.', 'Make sure the doorway is clear.']);
  });

  it('updates the copy when the alarm changes while the dialog is open', async () => {
    const opened = await openBody('disarmed');
    expect(opened.body().join(' ')).not.toContain('Opening the garage may set it off');
    w.set(IDS.alarm, 'armed_away');
    await opened.dialog.updateComplete;
    expect(opened.body().join(' ')).toContain(ARMED_LINE);
  });

  it('Close never carries the alarm line', async () => {
    liveWorld({ [IDS.alarm]: ['armed_away', {}], [IDS.garage]: ['open', GARAGE_STATES[IDS.garage]?.[1] ?? {}] });
    const services = servicesFor(w, gateway);
    const mounted = await mountGarage(services);
    mounted.button('close')?.click();
    const { body } = await openConfirm(services, mounted.confirms[0]!.detail);
    expect(body()).toEqual(['The door starts moving when you confirm.', 'Make sure nothing is in the doorway.']);
  });

  it('confirming while armed still sends exactly one cover.open_cover and no script call', async () => {
    const opened = await openBody('armed_away');
    opened.confirm();
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({ domain: 'cover', service: 'open_cover' });
    expect(port.calls.filter((call) => call.domain === 'script')).toEqual([]);
  });
});

describe('agr-garage: ticket text in one polite live region (§7.2, §8.5)', () => {
  let fake: FakeGateway;
  let mounted: Mounted;

  beforeEach(async () => {
    fake = new FakeGateway();
    fake.availability = { enabled: true, confirm: true };
    mounted = await mountGarage(fakeGatewayServices(w, fake));
  });

  function notesRoot(): ShadowRoot {
    return mounted.root.querySelector('agr-control-notes')?.shadowRoot as ShadowRoot;
  }

  function region(): HTMLElement {
    return notesRoot().querySelector('[role="status"]') as HTMLElement;
  }

  function regionText(): string {
    return (region().textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function dismissButton(): HTMLButtonElement | null {
    return notesRoot().querySelector('agr-button')?.shadowRoot?.querySelector('button') ?? null;
  }

  async function ticket(phase: ActionStatus['phase'], error?: ActionStatus['error']): Promise<void> {
    if (fake.status('garage') === undefined) fake.request({ kind: 'garage.open' });
    if (phase !== 'pending') fake.settle('garage', phase, error);
    mounted.garage.requestUpdate();
    await settle();
  }

  it('keeps one persistent live region and words each phase', async () => {
    const live = region();
    expect(regionText()).toBe('');
    await ticket('pending');
    expect(region()).toBe(live);
    expect(regionText()).toBe('Garage Sending');
    await ticket('sent');
    expect(regionText()).toBe('Waiting for Garage');
    await ticket('confirmed');
    expect(regionText()).toBe('Garage Done');
    expect(mounted.root.querySelectorAll('agr-control-notes')).toHaveLength(1);
    expect(mounted.root.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(0);
  });

  it("a timeout shows the gateway's garage copy with Dismiss, which clears it and keeps focus on the door", async () => {
    await ticket('uncertain', { code: 'timeout', message: GARAGE_TICKET_COPY.uncertainOpen });
    expect(regionText()).toBe(`Garage ${GARAGE_TICKET_COPY.uncertainOpen}`);
    expect(notesRoot().querySelector('.note')?.getAttribute('data-tone')).toBe('attention');
    const dismissSpy = vi.spyOn(fake, 'dismiss');
    const doorButton = mounted.root.querySelector('agr-button[focus-key="garage:open"]') as HTMLElement;
    const focusSpy = vi.spyOn(doorButton, 'focus');
    dismissButton()?.click();
    await settle();
    expect(dismissSpy).toHaveBeenCalledWith('garage');
    expect(regionText()).toBe('');
    expect(dismissButton()).toBeNull();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('Dismiss keeps focus in the panel (its heading) when the door offers no control any more', async () => {
    await ticket('uncertain', { code: 'timeout', message: GARAGE_TICKET_COPY.uncertainOpen });
    w.set(IDS.garage, 'unavailable');
    mounted.garage.requestUpdate();
    await settle();
    expect(mounted.root.querySelector('agr-button')).toBeNull();
    const heading = mounted.root.querySelector('agr-panel')?.shadowRoot?.getElementById('agr-garage-heading');
    const focusSpy = vi.spyOn(heading as HTMLElement, 'focus');
    dismissButton()?.click();
    await settle();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('a reversal shows at once in danger text', async () => {
    await ticket('failed', { code: 'reversed', message: GARAGE_TICKET_COPY.reversedOpen });
    expect(regionText()).toBe(`Garage ${GARAGE_TICKET_COPY.reversedOpen}`);
    expect(notesRoot().querySelector('.note')?.getAttribute('data-tone')).toBe('danger');
    expect(dismissButton()).not.toBeNull();
  });

  it('other failures use the gateway message', async () => {
    await ticket('failed', { code: 'permission-denied', message: "Your Home Assistant user can't control Garage." });
    expect(regionText()).toBe("Your Home Assistant user can't control Garage.");
  });
});

describe('agr-garage: configuration shapes', () => {
  it('hides the vehicle when it is not configured and names the panel "Garage"', async () => {
    const garageOnly = world({ garage: GARAGE_INPUT.garage }, GARAGE_STATES);
    const mounted = await mountGarage(servicesFor(garageOnly, new FakeGateway()));
    expect(mounted.root.querySelector('agr-panel')?.heading).toBe('Garage');
    expect(mounted.root.querySelector('agr-vehicle')).toBeNull();
  });

  it('hides the door when no garage is configured and names the panel "Car"', async () => {
    const carOnly = world({ vehicle: GARAGE_INPUT.vehicle }, GARAGE_STATES);
    const mounted = await mountGarage(servicesFor(carOnly, new FakeGateway()));
    expect(mounted.root.querySelector('agr-panel')?.heading).toBe('Car');
    expect(mounted.button('open')).toBeNull();
    expect(mounted.root.querySelector('agr-vehicle')).not.toBeNull();
  });

  it('a garage-only panel whose door Home Assistant does not have keeps its content height (§16.13)', async () => {
    const garageOnly = world({ garage: GARAGE_INPUT.garage }, GARAGE_STATES);
    garageOnly.set(IDS.garage, undefined);
    const missing = await mountGarage(servicesFor(garageOnly, new FakeGateway()));
    expect(missing.text()).toContain('Not found');
    // Household copy: the configuration hint is left to Diagnostics.
    expect(missing.text()).not.toContain('dashboard configuration');
    expect(missing.root.querySelector('agr-panel')?.hasAttribute('fit')).toBe(true);

    garageOnly.set(IDS.garage, 'unavailable');
    await settle();
    expect(missing.root.querySelector('agr-panel')?.hasAttribute('fit')).toBe(false);
    const withCar = await mountGarage(servicesFor(w, gateway));
    w.set(IDS.garage, undefined);
    await settle();
    expect(withCar.root.querySelector('agr-panel')?.hasAttribute('fit')).toBe(false);
  });

  it('renders a labelled placeholder before the store is ready, and never a departure control', async () => {
    const empty = document.createElement('agr-garage');
    document.body.append(empty);
    await empty.updateComplete;
    expect(empty.shadowRoot?.querySelector('agr-panel')?.getAttribute('heading-id')).toBe('agr-garage-heading');
    // The door row and the car as hidden ghost blocks, so the panel keeps its shape until states arrive.
    expect(empty.shadowRoot?.querySelector('[aria-hidden="true"] .door-ghost')).not.toBeNull();
    expect(empty.shadowRoot?.querySelector('agr-button')).toBeNull();
    const mounted = await mountGarage(servicesFor(w, gateway));
    expect(mounted.text()).not.toContain('Prepare garage departure');
  });

  it('escapes runtime names', async () => {
    const hostile = world(
      { garage: { cover: IDS.garage, name: '<img src=x onerror=alert(1)>' }, vehicle: GARAGE_INPUT.vehicle },
      GARAGE_STATES,
    );
    const mounted = await mountGarage(servicesFor(hostile, new FakeGateway()));
    expect(mounted.text()).toContain('<img src=x onerror=alert(1)>');
    expect(mounted.root.querySelector('img')).toBeNull();
  });
});
