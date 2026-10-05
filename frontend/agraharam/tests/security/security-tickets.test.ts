/**
 * Security ticket attribution (§8.2, §4.7 step 13): every role shares the 'security' key, so only a ticket newer than
 * the one current at the gesture belongs to the button the user activated; a cancelled confirmation claims nothing,
 * and a failure the gateway never stored is kept until dismissed or superseded.
 */
import { LitElement } from 'lit';
import { describe, expect, it } from 'vitest';
import { SecurityTickets } from '../../src/components/security/security-tickets.ts';
import { FakeGateway } from '../helpers/fake-gateway.ts';

class Host extends LitElement {
  readonly gateway = new FakeGateway();
  readonly tickets = new SecurityTickets(this, () => this.gateway);
}
customElements.define('test-security-tickets-host', Host);

async function mounted(): Promise<Host> {
  const host = document.createElement('test-security-tickets-host') as Host;
  document.body.append(host);
  await host.updateComplete;
  return host;
}

async function rerender(host: Host): Promise<void> {
  host.requestUpdate();
  await host.updateComplete;
}

describe('SecurityTickets', () => {
  it('attributes the next ticket to the role activated before it, and none to a ticket that predates the gesture', async () => {
    const host = await mounted();
    host.gateway.request({ kind: 'security.run', role: 'hold_away' });
    await rerender(host);
    expect(host.tickets.current()?.role).toBeUndefined();

    host.tickets.begin('hold_night');
    await rerender(host);
    expect(host.tickets.current()?.role).toBeUndefined();
    host.gateway.request({ kind: 'security.run', role: 'hold_night' });
    await rerender(host);
    expect(host.tickets.current()?.role).toBe('hold_night');
  });

  it('a cancelled confirmation claims nothing; the next activated role takes the attribution', async () => {
    const host = await mounted();
    host.tickets.begin('hold_vacation');
    host.tickets.begin('resume_auto');
    host.gateway.request({ kind: 'security.run', role: 'resume_auto' });
    await rerender(host);
    expect(host.tickets.current()?.role).toBe('resume_auto');
  });

  it('keeps an immediate failure until dismissed, and dismissing clears the stored ticket too', async () => {
    const host = await mounted();
    host.gateway.failWith = { code: 'disconnected', message: 'Not sent.' };
    host.tickets.record('silence_sound', host.gateway.request({ kind: 'security.run', role: 'silence_sound' }));
    expect(host.tickets.current()).toMatchObject({ role: 'silence_sound', status: { phase: 'failed' } });
    expect(host.tickets.dismiss()).toBe('silence_sound');
    expect(host.tickets.current()).toBeUndefined();
  });

  it('a newer stored ticket supersedes an older immediate failure', async () => {
    const host = await mounted();
    host.gateway.failWith = { code: 'disconnected', message: 'Not sent.' };
    host.tickets.record('silence_sound', host.gateway.request({ kind: 'security.run', role: 'silence_sound' }));
    host.gateway.failWith = undefined;
    host.tickets.record('silence_sound', host.gateway.request({ kind: 'security.run', role: 'silence_sound' }));
    expect(host.tickets.current()).toMatchObject({ role: 'silence_sound', status: { phase: 'pending' } });
  });
});
