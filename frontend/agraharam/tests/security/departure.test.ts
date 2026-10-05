/**
 * Acceptance item 7 (departure part, §8.4, §12.1 row 7): "Prepare garage departure" runs only the departure script.
 * It never moves the garage door and never chains a door call, before or after the script reports back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/components/garage/agr-garage.ts';
import '../../src/components/primitives/agr-confirm-dialog.ts';
import type { AgrConfirmDialog } from '../../src/components/primitives/agr-confirm-dialog.ts';
import '../../src/components/security/agr-security-drawer.ts';
import type { ConfirmDetail } from '../../src/components/shell/overlay-types.ts';
import type { ActionGateway } from '../../src/ha/actions/types.ts';
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
  SECURITY_INPUT,
  SECURITY_STATES,
  servicesFor,
  world,
  type RecordingPort,
  type World,
} from '../garage/world.ts';

let w: World;
let port: RecordingPort;
let gateway: ActionGateway;

beforeEach(() => {
  w = world(
    { ...GARAGE_INPUT, ...SECURITY_INPUT },
    { ...GARAGE_STATES, ...SECURITY_STATES, [IDS.alarm]: ['armed_away', {}] },
  );
  port = recordingPort();
  gateway = realGateway(w, port);
});

afterEach(() => {
  gateway.dispose();
});

async function activateDeparture(services = servicesFor(w, gateway)): Promise<ConfirmDetail[]> {
  const confirms: ConfirmDetail[] = [];
  document.body.addEventListener('agr-request-confirm', (event) => confirms.push(event.detail));
  const drawer = document.createElement('agr-security-drawer');
  drawer.services = services;
  drawer.request = { id: 'security' };
  document.body.append(drawer);
  await settle();
  const host = drawer.shadowRoot?.querySelector('agr-button[focus-key="security:prepare_departure"]');
  expect(host?.shadowRoot?.querySelector('button')?.textContent?.trim()).toBe('Prepare garage departure');
  host?.shadowRoot?.querySelector('button')?.click();
  return confirms;
}

async function confirm(detail: ConfirmDetail, services = servicesFor(w, gateway)): Promise<AgrConfirmDialog> {
  const dialog = document.createElement('agr-confirm-dialog') as AgrConfirmDialog;
  dialog.services = services;
  dialog.action = detail.action;
  document.body.append(dialog);
  await dialog.updateComplete;
  return dialog;
}

describe('Prepare garage departure is not door movement (acceptance item 7)', () => {
  it('asks for confirmation with copy that says the door does not move', async () => {
    const [detail] = await activateDeparture();
    expect(detail?.action).toEqual({ kind: 'security.run', role: 'prepare_departure' });
    const dialog = await confirm(detail!);
    const body = dialog.shadowRoot?.querySelector('.dialog-body')?.textContent ?? '';
    expect(body).toContain('The garage door does not move. Open it separately from the Garage panel.');
    expect(port.calls).toEqual([]);
  });

  it('runs only the departure script, once, and never a cover service', async () => {
    const [detail] = await activateDeparture();
    const dialog = await confirm(detail!);
    (dialog.shadowRoot?.querySelector('button.confirm') as HTMLButtonElement).click();
    expect(port.calls).toEqual([
      { domain: 'script', service: 'turn_on', data: {}, target: { entity_id: IDS.departure } },
    ]);
  });

  it('sends no follow-up door call after the script reports back, and the door stays put', async () => {
    const [detail] = await activateDeparture();
    const dialog = await confirm(detail!);
    (dialog.shadowRoot?.querySelector('button.confirm') as HTMLButtonElement).click();
    await Promise.resolve();
    w.set(IDS.departure, 'on', { last_triggered: '2026-09-30T17:51:01.000Z' });
    w.set(IDS.alarm, 'disarmed');
    w.set(IDS.departure, 'off');
    await settle();
    expect(port.calls).toHaveLength(1);
    expect(port.calls.filter((call) => call.domain === 'cover')).toEqual([]);
    expect(w.get(IDS.garage)?.state).toBe('closed');
    expect(gateway.status('garage')).toBeUndefined();
  });

  it('requests exactly the departure role, with no garage action, from the drawer', async () => {
    const fake = new FakeGateway();
    fake.availability = { enabled: true, confirm: true };
    const services = fakeGatewayServices(w, fake);
    const [detail] = await activateDeparture(services);
    const dialog = await confirm(detail!, services);
    (dialog.shadowRoot?.querySelector('button.confirm') as HTMLButtonElement).click();
    expect(fake.calls.map((call) => call.req)).toEqual([{ kind: 'security.run', role: 'prepare_departure' }]);
    expect(fake.calls.some((call) => call.req.kind.startsWith('garage.'))).toBe(false);
  });

  it('lives only in the security drawer, never in the Garage panel', async () => {
    const garage = document.createElement('agr-garage');
    garage.services = servicesFor(w, gateway);
    document.body.append(garage);
    await settle();
    const garageText = (root: ParentNode): string =>
      [...root.querySelectorAll('*')]
        .map((element) => (element.shadowRoot ? garageText(element.shadowRoot) : (element.textContent ?? '')))
        .join(' ');
    expect(garageText(garage.shadowRoot as ShadowRoot)).not.toContain(SECURITY_ACTION_COPY.prepare_departure.label);
    expect(garage.shadowRoot?.querySelector('[focus-key="security:prepare_departure"]')).toBeNull();
  });
});
