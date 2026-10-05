/**
 * The overlay host's side of confirm-dialog integrity (§5.2 rule 1): a confirm request is validated and frozen
 * before the dialog is mounted, and a malformed one is refused, announced and never mounted.
 */
import { html, render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import '../../src/agraharam.ts';
import {
  CONFIRM_REFUSED_ANNOUNCEMENT,
  type AgrConfirmDialog,
} from '../../src/components/primitives/agr-confirm-dialog.ts';
import type { AgrOverlayHost } from '../../src/components/shell/agr-overlay-host.ts';
import type { ActionRequest } from '../../src/ha/actions/types.ts';
import { settle } from '../helpers/dom.ts';
import { liveStore } from '../helpers/live-store.ts';
import { configFrom, fakeServices } from '../helpers/services.ts';

const GARAGE = 'cover.demo_garage';

async function mountHost() {
  const config = configFrom({ garage: { cover: GARAGE } });
  const services = fakeServices({ config, store: liveStore(config, { [GARAGE]: 'closed' }).store });
  services.gateway.availability = { enabled: true, confirm: true };
  const card = document.createElement('div');
  document.body.append(card);
  const shadow = card.attachShadow({ mode: 'open' });
  render(
    html`<button id="trigger">Open garage</button><agr-overlay-host .services=${services}></agr-overlay-host>`,
    shadow,
  );
  await settle();
  const host = shadow.querySelector('agr-overlay-host') as AgrOverlayHost;
  const trigger = shadow.querySelector('#trigger') as HTMLButtonElement;
  return { host, trigger, gateway: services.gateway };
}

function mountedConfirm(host: AgrOverlayHost): AgrConfirmDialog | null {
  return host.shadowRoot?.querySelector('agr-confirm-dialog') ?? null;
}

function announcement(host: AgrOverlayHost): string {
  return host.shadowRoot?.querySelector('[role="status"]')?.textContent?.trim() ?? '';
}

describe('agr-overlay-host confirm requests (§5.2)', () => {
  it('mounts the dialog with a frozen copy of the action, not the caller object', async () => {
    const { host, trigger } = await mountHost();
    const action = { kind: 'garage.open' } as ActionRequest;
    host.confirm({ action, trigger });
    await settle();
    const dialog = mountedConfirm(host);
    expect(dialog?.action).toEqual({ kind: 'garage.open' });
    expect(dialog?.action).not.toBe(action);
    expect(Object.isFrozen(dialog?.action)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['an unknown role', { kind: 'security.run', role: 'disarm' }],
    ['an extra key', { kind: 'garage.open', entity_id: GARAGE }],
    ['an unknown kind', { kind: 'garage.force_open' }],
    ['null', null],
    [
      'a proxy whose traps throw',
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('trap');
          },
        },
      ),
    ],
  ])('refuses %s without mounting anything or throwing, and announces it', async (_label, action) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { host, trigger, gateway } = await mountHost();
    expect(() => host.confirm({ action: action as ActionRequest, trigger })).not.toThrow();
    await settle();
    expect(mountedConfirm(host)).toBeNull();
    expect(host.hasOpenOverlay).toBe(false);
    expect(announcement(host)).toBe(CONFIRM_REFUSED_ANNOUNCEMENT);
    expect(errors).toHaveBeenCalled();
    expect(gateway.calls).toEqual([]);
  });

  it('announces the same refusal again: the region is cleared before it is set', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { host, trigger } = await mountHost();
    host.confirm({ action: null as unknown as ActionRequest, trigger });
    await settle();
    const region = host.shadowRoot?.querySelector('[role="status"]');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(region?.textContent?.trim() ?? ''));
    observer.observe(region as Node, { childList: true, subtree: true, characterData: true });
    host.confirm({ action: null as unknown as ActionRequest, trigger });
    await settle();
    observer.disconnect();
    expect(seen).toContain('');
    expect(announcement(host)).toBe(CONFIRM_REFUSED_ANNOUNCEMENT);
  });
});
