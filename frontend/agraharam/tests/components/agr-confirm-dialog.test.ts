import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/primitives/agr-confirm-dialog.ts';
import type { AgrConfirmDialog } from '../../src/components/primitives/agr-confirm-dialog.ts';
import type { SecurityActionRole } from '../../src/config/schema.ts';
import { redeemConfirmationToken } from '../../src/ha/actions/confirmation.ts';
import { CONFIRM_DIALOG_TIMEOUT_MS, type ActionRequest } from '../../src/ha/actions/types.ts';
import { GARAGE_BUTTON_LABELS, SECURITY_ACTION_COPY, SHORTCUT_COPY } from '../../src/model/action-copy.ts';
import { deepActive } from '../helpers/dom.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { liveStore, type LiveStore } from '../helpers/live-store.ts';
import { configFrom, fakeServices } from '../helpers/services.ts';

const ALARM = 'alarm_control_panel.demo_home';
const GARAGE = 'cover.demo_garage';
const ROLES: readonly SecurityActionRole[] = [
  'silence_sound',
  'disarm_hold',
  'resume_auto',
  'hold_night',
  'hold_away',
  'hold_vacation',
  'prepare_departure',
];
const SCRIPTS = Object.fromEntries(ROLES.map((role) => [role, `script.demo_${role}`]));

function configWith(actions: Readonly<Record<string, string>> = SCRIPTS) {
  return configFrom({
    garage: { cover: GARAGE },
    security: { alarm: ALARM, policy: 'input_select.demo_policy', actions },
  });
}

let gateway: FakeGateway;
let live: LiveStore;

async function openConfirm(action: ActionRequest, config = configWith()) {
  live = liveStore(config, { [ALARM]: 'disarmed', [GARAGE]: 'closed' });
  const dialog = document.createElement('agr-confirm-dialog') as AgrConfirmDialog;
  dialog.services = fakeServices({ config, store: live.store, gateway });
  dialog.action = action;
  const closed = vi.fn();
  dialog.addEventListener('agr-drawer-closed', closed);
  document.body.append(dialog);
  await dialog.updateComplete;
  const root = dialog.shadowRoot as ShadowRoot;
  const native = root.querySelector('dialog') as HTMLDialogElement;
  return {
    dialog,
    root,
    native,
    closed,
    body: () => [...root.querySelectorAll('.dialog-body p')].map((p) => p.textContent),
    confirmButton: () => root.querySelector('button.confirm') as HTMLButtonElement,
    cancelButton: () => root.querySelector('button.cancel') as HTMLButtonElement,
  };
}

beforeEach(() => {
  gateway = new FakeGateway();
  gateway.availability = { enabled: true, confirm: true };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agr-confirm-dialog integrity (§5.2)', () => {
  it('is an alertdialog whose copy comes from the action alone, with Cancel focused', async () => {
    const { root, native, cancelButton, confirmButton } = await openConfirm({ kind: 'garage.close' });
    expect(native.getAttribute('role')).toBe('alertdialog');
    expect(native.open).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe('Close the garage door?');
    expect(confirmButton().textContent?.trim()).toBe('Close garage');
    expect(deepActive()).toBe(cancelButton());
  });

  it.each(ROLES)('the confirm label for %s equals the security drawer button label', async (role) => {
    const { confirmButton } = await openConfirm({ kind: 'security.run', role });
    expect(confirmButton().textContent?.trim()).toBe(SECURITY_ACTION_COPY[role].label);
  });

  it.each<['garage.open' | 'garage.close', string]>([
    ['garage.open', GARAGE_BUTTON_LABELS.open],
    ['garage.close', GARAGE_BUTTON_LABELS.close],
  ])('the confirm label for %s equals the Garage panel button', async (kind, label) => {
    const { confirmButton } = await openConfirm({ kind });
    expect(confirmButton().textContent?.trim()).toBe(label);
  });

  it('confirm makes exactly one request with a token for that action and the epoch captured at open, then closes', async () => {
    const { confirmButton, native, closed } = await openConfirm({ kind: 'garage.open' });
    confirmButton().click();
    expect(gateway.calls).toHaveLength(1);
    const [call] = gateway.calls;
    expect(call?.req).toEqual({ kind: 'garage.open' });
    expect(call?.opts?.epoch).toBe(0);
    expect(Object.keys(call?.opts ?? {}).sort()).toEqual(['confirmation', 'epoch']);
    // The fake gateway does not spend tokens, so the test spends it: valid for exactly garage.open, once.
    expect(redeemConfirmationToken(call?.opts?.confirmation, { kind: 'garage.open' })).toBe(true);
    expect(redeemConfirmationToken(call?.opts?.confirmation, { kind: 'garage.open' })).toBe(false);
    expect(native.open).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('confirms the action it opened with, as a frozen copy, even if the caller mutates its object afterwards', async () => {
    const action = { kind: 'security.run', role: 'silence_sound' } as {
      kind: 'security.run';
      role: SecurityActionRole;
    };
    const { root, confirmButton } = await openConfirm(action);
    action.role = 'disarm_hold';
    confirmButton().click();
    const [call] = gateway.calls;
    expect(root.querySelector('h2')?.textContent).toBe('Silence sound?');
    expect(call?.req).toEqual({ kind: 'security.run', role: 'silence_sound' });
    expect(call?.req).not.toBe(action);
    expect(Object.isFrozen(call?.req)).toBe(true);
  });

  it('describes the alertdialog with its whole body, safety lines included, so it is read with Cancel', async () => {
    const opened = await openConfirm({ kind: 'garage.open' });
    const describedBy = opened.native.getAttribute('aria-describedby') ?? '';
    const description = opened.root.getElementById(describedBy);
    expect(description?.closest('.dialog-body')).not.toBeNull();
    expect([...(description?.querySelectorAll('p') ?? [])].map((p) => p.textContent)).toEqual([
      'The door starts moving when you confirm.',
      'Make sure the doorway is clear.',
    ]);
    gateway.availability = { enabled: false, reason: 'not-applicable', message: 'Already open' };
    live.set(GARAGE, 'open');
    await opened.dialog.updateComplete;
    expect(opened.root.getElementById(describedBy)?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'The door starts moving when you confirm. Already open',
    );
  });

  it('fails closed and visibly for a malformed role: no throw, no Confirm button, nothing sent', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const malformed = { kind: 'security.run', role: 'disarm' } as unknown as ActionRequest;
    const { dialog, root, native, cancelButton, confirmButton } = await openConfirm(malformed);
    expect(native.open).toBe(true);
    expect(root.querySelector('h2')?.textContent).toBe("This action isn't available");
    expect(root.getElementById(native.getAttribute('aria-describedby') ?? '')?.textContent?.trim()).toBe(
      'Nothing was sent.',
    );
    expect(confirmButton()).toBeNull();
    expect(cancelButton().textContent?.trim()).toBe('Close');
    expect(errors).toHaveBeenCalled();
    cancelButton().click();
    expect(dialog.outcome).toBe('cancelled');
    expect(gateway.calls).toEqual([]);
  });

  it('Cancel and Escape send nothing; a backdrop click does not close it', async () => {
    const cancelled = await openConfirm({ kind: 'garage.open' });
    cancelled.native.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cancelled.native.open).toBe(true);
    cancelled.cancelButton().click();
    expect(cancelled.native.open).toBe(false);
    const escaped = await openConfirm({ kind: 'security.run', role: 'disarm_hold' });
    escaped.native.dispatchEvent(new Event('cancel', { cancelable: true }));
    escaped.native.close(); // what the browser does for Escape
    expect(escaped.dialog.outcome).toBe('cancelled');
    expect(gateway.calls).toEqual([]);
  });

  it('closes as cancelled on an epoch change, announcing it, and sends nothing (rule 3)', async () => {
    const { dialog, native, confirmButton } = await openConfirm({ kind: 'garage.open' });
    gateway.advanceEpoch();
    expect(native.open).toBe(false);
    expect(dialog.outcome).toBe('connection-changed');
    expect(dialog.announcement).toBe('Not sent. The connection changed while this was open.');
    confirmButton().click();
    expect(gateway.calls).toEqual([]);
  });

  it('cancels itself after CONFIRM_DIALOG_TIMEOUT_MS with no answer (rule 4)', async () => {
    vi.useFakeTimers();
    const { dialog, native } = await openConfirm({ kind: 'garage.open' });
    vi.advanceTimersByTime(CONFIRM_DIALOG_TIMEOUT_MS - 1);
    expect(native.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(native.open).toBe(false);
    expect(dialog.announcement).toBe('Not sent. Confirmation timed out.');
    expect(gateway.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disables Confirm and shows the reason in place of the last body line when a precondition fails (rule 2)', async () => {
    const opened = await openConfirm({ kind: 'garage.close' });
    gateway.availability = { enabled: false, reason: 'not-applicable', message: 'Already closed' };
    live.set(GARAGE, 'closed');
    await opened.dialog.updateComplete;
    expect(opened.confirmButton().getAttribute('aria-disabled')).toBe('true');
    expect(opened.root.getElementById(opened.confirmButton().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Already closed',
    );
    expect(opened.body()).toEqual(['The door starts moving when you confirm.', 'Already closed']);
    opened.confirmButton().click();
    expect(gateway.calls).toEqual([]);
  });

  it('closes when the config changes under it (a new gateway)', async () => {
    const { dialog, native } = await openConfirm({ kind: 'garage.open' });
    dialog.services = fakeServices({ config: configWith(), store: live.store, gateway: new FakeGateway() });
    await dialog.updateComplete;
    expect(native.open).toBe(false);
    expect(dialog.outcome).toBe('connection-changed');
  });

  it('cancels at once for an action that never asks for confirmation', async () => {
    const { dialog, closed } = await openConfirm({ kind: 'studio_monitors.run' });
    await Promise.resolve();
    expect(dialog.outcome).toBe('cancelled');
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('garage Open alarm-aware copy (§8.5)', () => {
  const ARMED_LINE = 'The alarm is Armed away. Opening the garage may set it off.';
  const DEPARTURE = 'To leave without setting it off, use Prepare garage departure in Security first.';
  const UNKNOWN_LINE =
    "The alarm state isn't available right now. Opening the garage may set it off if the house is armed.";

  it('warns when armed, with the departure hint when prepare_departure is configured, before the last line', async () => {
    const { body, dialog } = await openConfirm({ kind: 'garage.open' });
    live.set(ALARM, 'armed_away');
    await dialog.updateComplete;
    expect(body()).toEqual([
      'The door starts moving when you confirm.',
      `${ARMED_LINE} ${DEPARTURE}`,
      'Make sure the doorway is clear.',
    ]);
  });

  it('omits the departure hint when prepare_departure is not configured, and warns while arming', async () => {
    const { body, dialog } = await openConfirm({ kind: 'garage.open' }, configWith({ hold_night: 'script.demo_n' }));
    live.set(ALARM, 'arming');
    await dialog.updateComplete;
    expect(body()[1]).toBe('The alarm is Arming. Opening the garage may set it off.');
  });

  it.each(['unknown', 'unavailable'])('says the state is not available when the alarm is %s', async (state) => {
    const { body, dialog } = await openConfirm({ kind: 'garage.open' });
    live.set(ALARM, state);
    await dialog.updateComplete;
    expect(body()[1]).toBe(UNKNOWN_LINE);
  });

  it('says the state is not available while disconnected (stale)', async () => {
    const { body, dialog } = await openConfirm({ kind: 'garage.open' });
    live.set(ALARM, 'armed_away');
    live.setConnected(false);
    await dialog.updateComplete;
    expect(body()[1]).toBe(UNKNOWN_LINE);
  });

  it.each(['disarmed', 'pending', 'triggered', 'disarming'])('adds nothing when the alarm is %s', async (state) => {
    const { body, dialog } = await openConfirm({ kind: 'garage.open' });
    live.set(ALARM, state);
    await dialog.updateComplete;
    expect(body()).toEqual(['The door starts moving when you confirm.', 'Make sure the doorway is clear.']);
  });

  it('never adds the line to Close', async () => {
    const { body, dialog } = await openConfirm({ kind: 'garage.close' });
    live.set(ALARM, 'armed_away');
    await dialog.updateComplete;
    expect(body()).toEqual(['The door starts moving when you confirm.', 'Make sure nothing is in the doorway.']);
  });
});

describe('whole-house shortcuts (§18)', () => {
  const LIGHTS_SCRIPT = 'script.demo_house_lights_toggle';
  const CURTAINS_SCRIPT = 'script.demo_house_curtains_toggle';
  const shortcutConfig = () =>
    configFrom({
      garage: { cover: GARAGE },
      shortcuts: { lights_toggle: LIGHTS_SCRIPT, curtains_toggle: CURTAINS_SCRIPT },
    });

  it.each(['lights_toggle', 'curtains_toggle'] as const)(
    '%s: renders its fixed copy with Cancel focused; Confirm sends one request with a token for exactly it',
    async (role) => {
      const copy = SHORTCUT_COPY.buttons[role];
      const { root, native, body, confirmButton, cancelButton } = await openConfirm(
        { kind: 'shortcut.run', role },
        shortcutConfig(),
      );
      expect(native.getAttribute('role')).toBe('alertdialog');
      expect(root.querySelector('h2')?.textContent).toBe(copy.confirm.title);
      expect(body()).toEqual(copy.confirm.body);
      expect(confirmButton().textContent?.trim()).toBe(copy.confirm.confirmLabel);
      expect(deepActive()).toBe(cancelButton());
      confirmButton().click();
      expect(gateway.calls).toHaveLength(1);
      const [call] = gateway.calls;
      expect(call?.req).toEqual({ kind: 'shortcut.run', role });
      // Bound to exactly this role (a lights token cannot confirm curtains: gateway-shortcut.test.ts).
      expect(redeemConfirmationToken(call?.opts?.confirmation, { kind: 'shortcut.run', role })).toBe(true);
    },
  );

  it('watches the shortcut script: a run starting while it is open disables Confirm with the reason', async () => {
    const opened = await openConfirm({ kind: 'shortcut.run', role: 'lights_toggle' }, shortcutConfig());
    gateway.availability = { enabled: false, reason: 'not-applicable', message: 'Already running' };
    // Only the script changes, so only a watch on that script can re-check the precondition.
    live.set(LIGHTS_SCRIPT, 'on');
    await opened.dialog.updateComplete;
    expect(opened.confirmButton().getAttribute('aria-disabled')).toBe('true');
    expect(opened.body().at(-1)).toBe('Already running');
    opened.confirmButton().click();
    expect(gateway.calls).toEqual([]);
  });

  it('Cancel sends nothing', async () => {
    const opened = await openConfirm({ kind: 'shortcut.run', role: 'curtains_toggle' }, shortcutConfig());
    opened.cancelButton().click();
    expect(opened.dialog.outcome).toBe('cancelled');
    expect(gateway.calls).toEqual([]);
  });
});
