import { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardServices } from '../../src/components/services.ts';
import { ActionController } from '../../src/ha/actions/action-controller.ts';
import { STEPPER_COMMIT_DEBOUNCE_MS, type ActionKey, type ActionRequest } from '../../src/ha/actions/types.ts';
import type { ConnectionPhase } from '../../src/ha/host.ts';
import { entityId } from '../helpers/fake-store.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';
import { fakeServices } from '../helpers/services.ts';

const CLIMATE = entityId('climate.demo_bedroom');
const KEY: ActionKey = `entity:${CLIMATE}`;
const build = (temperature: number): ActionRequest => ({
  kind: 'climate.set_temperature',
  entity: CLIMATE,
  temperature,
});

/** A section-like host holding an ActionController, with services swappable like a root publish. */
class ProbeControls extends LitElement {
  services: DashboardServices | undefined;
  readonly actions = new ActionController(
    this,
    () => this.services,
    () => [KEY],
  );
}
customElements.define('agr-test-probe-controls', ProbeControls);

let phase: ConnectionPhase;
let observed: number | null;

async function mountProbe(gateway = new FakeGateway()): Promise<{ probe: ProbeControls; gateway: FakeGateway }> {
  const probe = document.createElement('agr-test-probe-controls') as ProbeControls;
  probe.services = fakeServices({ gateway, phase: () => phase });
  document.body.append(probe);
  await probe.updateComplete;
  return { probe, gateway };
}

function draft(probe: ProbeControls, value: number): void {
  probe.actions.draft(KEY, value, build, STEPPER_COMMIT_DEBOUNCE_MS, () => observed);
}

async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  phase = 'connected';
  observed = 72;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActionController draft rules (§4.7, §12.1 row 5)', () => {
  it('coalesces three taps into one request with the last value and the first gesture epoch', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    await elapse(300);
    draft(probe, 74);
    draft(probe, 75);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'drafting', value: 75 });
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    expect(gateway.invoked).toEqual([build(75)]);
    expect(gateway.calls[0]?.opts).toEqual({ epoch: 0 });
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'idle' });
  });

  it('holds a draft behind a pending ticket and discards it when that ticket times out (uncertain)', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    draft(probe, 74);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'held', value: 74 });
    gateway.settle(KEY, 'uncertain', { code: 'timeout', message: 'No confirmation.' });
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'not-sent', value: 74, reason: 'uncertain' });
    await elapse(60_000);
    expect(gateway.invoked).toHaveLength(1);
  });

  it('never revives a draft after a connection-lost ticket and a reconnect', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    draft(probe, 74);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    gateway.settle(KEY, 'uncertain', { code: 'connection-lost', message: 'Dropped.' });
    phase = 'disconnected';
    gateway.advanceEpoch();
    phase = 'connected';
    probe.requestUpdate();
    await elapse(60_000);
    expect(gateway.invoked).toHaveLength(1);
    expect(probe.actions.draftState(KEY)).toMatchObject({ phase: 'not-sent' });
  });

  it('sends a held draft exactly once after the ticket confirms, when the value still differs', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    draft(probe, 75);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    observed = 73;
    gateway.settle(KEY, 'confirmed');
    expect(gateway.invoked).toEqual([build(73), build(75)]);
    gateway.settle(KEY, 'confirmed');
    expect(gateway.invoked).toHaveLength(2);
  });

  it('drops a held draft that already equals the observed value after the confirm', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    observed = 73;
    gateway.settle(KEY, 'confirmed');
    expect(gateway.invoked).toHaveLength(1);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'idle' });
  });

  it('does not send a held draft when the connection dropped before the confirm', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    draft(probe, 75);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    phase = 'disconnected';
    gateway.settle(KEY, 'confirmed');
    expect(gateway.invoked).toHaveLength(1);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'not-sent', value: 75, reason: 'disconnected' });
  });

  it('sends nothing when the element is removed within the debounce window', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    await elapse(400);
    probe.remove();
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS * 2);
    expect(gateway.calls).toHaveLength(0);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<[string, 'preview' | 'disconnected']>([
    ['preview', 'preview'],
    ['disconnect', 'disconnected'],
  ])('cancels the timer on an epoch change (%s) and shows not-sent', async (_cause, reason) => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    if (reason === 'disconnected') phase = 'disconnected';
    gateway.invalidate();
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS * 2);
    expect(gateway.calls).toHaveLength(0);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'not-sent', value: 73, reason });
  });

  it('cancels the timer on a config change (new gateway) and shows not-sent(config)', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    const next = new FakeGateway();
    gateway.dispose();
    probe.services = fakeServices({ gateway: next, phase: () => phase });
    probe.requestUpdate();
    await probe.updateComplete;
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS * 2);
    expect(gateway.calls).toHaveLength(0);
    expect(next.calls).toHaveLength(0);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'not-sent', value: 73, reason: 'config' });
  });

  it('starts a new draft after not-sent, capturing the new epoch', async () => {
    const { probe, gateway } = await mountProbe();
    draft(probe, 73);
    gateway.invalidate();
    draft(probe, 74);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    expect(gateway.calls.map((call) => call.opts)).toEqual([{ epoch: 1 }]);
  });

  it('keeps the disconnected reason when request() itself notices the drop and moves the epoch first', async () => {
    class DroppingGateway extends FakeGateway {
      override request(req: ActionRequest, opts?: Parameters<FakeGateway['request']>[1]) {
        phase = 'disconnected';
        this.invalidate(); // the real gateway's phase sync fires epoch listeners from inside request()
        return super.request(req, opts);
      }
    }
    const { probe, gateway } = await mountProbe(new DroppingGateway());
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    expect(gateway.invoked).toEqual([]);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'not-sent', value: 73, reason: 'disconnected' });
  });

  it('shows not-sent with the reason when the request fails at once', async () => {
    const { probe, gateway } = await mountProbe();
    gateway.failWith = { code: 'disconnected', message: 'Paused.' };
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'not-sent', value: 73, reason: 'disconnected' });
    probe.actions.dismiss(KEY, { draft: true, ticket: false });
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'idle' });
  });
});

describe('ActionController.dismiss (§7.2)', () => {
  it('clears the draft, the stored ticket or both, as asked, and re-renders the host', async () => {
    const { probe, gateway } = await mountProbe();
    gateway.failWith = { code: 'disconnected', message: 'Paused.' };
    draft(probe, 73);
    await elapse(STEPPER_COMMIT_DEBOUNCE_MS);
    gateway.failWith = undefined;
    gateway.request(build(74));
    gateway.settle(KEY, 'failed', { code: 'rejected', message: 'No.' });
    const dismissTicket = vi.spyOn(gateway, 'dismiss');
    const update = vi.spyOn(probe, 'requestUpdate');
    probe.actions.dismiss(KEY, { draft: false, ticket: true });
    expect(dismissTicket).toHaveBeenCalledWith(KEY);
    expect(probe.actions.draftState(KEY).phase).toBe('not-sent');
    probe.actions.dismiss(KEY, { draft: true, ticket: false });
    expect(dismissTicket).toHaveBeenCalledTimes(1);
    expect(probe.actions.draftState(KEY)).toEqual({ phase: 'idle' });
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe('ActionController immediate gestures', () => {
  it('passes evaluate and request through to the gateway', async () => {
    const { probe, gateway } = await mountProbe();
    gateway.availability = { enabled: true, confirm: true };
    expect(probe.actions.evaluate({ kind: 'garage.open' })).toEqual({ enabled: true, confirm: true });
    expect(probe.actions.request({ kind: 'garage.close' })).toMatchObject({ key: 'garage', phase: 'pending' });
    expect(probe.actions.status('garage')).toMatchObject({ phase: 'pending' });
  });

  it('re-renders the host when a watched ticket changes', async () => {
    const { probe, gateway } = await mountProbe();
    const update = vi.spyOn(probe, 'requestUpdate');
    probe.actions.request(build(70));
    gateway.settle(KEY, 'confirmed');
    expect(update).toHaveBeenCalled();
  });

  it('is disabled without services and never throws', async () => {
    const probe = document.createElement('agr-test-probe-controls') as ProbeControls;
    document.body.append(probe);
    await probe.updateComplete;
    expect(probe.actions.evaluate(build(70))).toMatchObject({ enabled: false });
    expect(probe.actions.request(build(70))).toMatchObject({ phase: 'failed' });
  });
});
