import { html, render } from 'lit';
import { describe, expect, it } from 'vitest';
import '../../src/agraharam.ts';
import type { AgrOverlayHost } from '../../src/components/shell/agr-overlay-host.ts';
import { DRAWER_TAGS, type DrawerElement, type DrawerRequest } from '../../src/components/shell/overlay-types.ts';
import type { DashboardServices } from '../../src/components/services.ts';
import { deepActive, deepQuery, deepQueryAll, settle } from '../helpers/dom.ts';
import { liveStore } from '../helpers/live-store.ts';
import { configFrom, fakeServices } from '../helpers/services.ts';

const CAMERA = 'camera.demo_front_gate';

function services(theme: DashboardServices['theme'] = 'light'): DashboardServices {
  const config = configFrom({
    cameras: [{ entity: CAMERA, name: 'Front gate' }],
    garage: { cover: 'cover.demo_garage' },
  });
  return fakeServices({ config, store: liveStore(config, { [CAMERA]: 'idle' }).store, mode: 'demo', theme });
}

/** A card-like shadow tree: a frame with a panel holding a trigger, and the overlay host beside it. */
async function mountHost(theme: DashboardServices['theme'] = 'light') {
  const card = document.createElement('div');
  document.body.append(card);
  const shadow = card.attachShadow({ mode: 'open' });
  render(
    html`<div class="frame" tabindex="-1" data-focus-fallback>
        <agr-panel heading="Home" heading-id="agr-home-heading">
          <button id="trigger" data-focus-key="room:0:open">Courtyard</button>
        </agr-panel>
      </div>
      <agr-overlay-host .services=${services(theme)}></agr-overlay-host>`,
    shadow,
  );
  const host = shadow.querySelector('agr-overlay-host') as AgrOverlayHost;
  await settle();
  const trigger = shadow.querySelector('#trigger') as HTMLButtonElement;
  return { host, shadow, trigger };
}

function mounted(host: AgrOverlayHost): Element[] {
  return [...(host.shadowRoot?.querySelector('.layer')?.children ?? [])];
}

function openDialogs(): HTMLDialogElement[] {
  return deepQueryAll<HTMLDialogElement>(document.body, 'dialog').filter((dialog) => dialog.open);
}

async function closeTop(host: AgrOverlayHost): Promise<void> {
  const top = openDialogs().at(-1);
  top?.close();
  await settle(host.shadowRoot as ShadowRoot);
}

describe('agr-overlay-host (§5.2, §5.4)', () => {
  it.each(Object.entries(DRAWER_TAGS))('mounts %s as <%s> with services and the request', async (id, tag) => {
    const { host, trigger } = await mountHost('dark');
    const request = { id, room: 0, entity: CAMERA } as unknown as DrawerRequest;
    host.open({ request, trigger });
    await settle();
    const [element] = mounted(host) as DrawerElement[];
    expect(element?.tagName.toLowerCase()).toBe(tag);
    expect(element?.request).toBe(request);
    expect(element?.services.theme).toBe('dark');
    expect(openDialogs()).toHaveLength(1);
  });

  it('replaces an open drawer and keeps the original trigger as the restore target (rule 8)', async () => {
    const { host, trigger } = await mountHost();
    host.open({ request: { id: 'household' }, trigger });
    await settle();
    const householdClose = deepQuery<HTMLButtonElement>(document.body, 'button.close');
    host.open({ request: { id: 'diagnostics' }, trigger: householdClose as HTMLElement });
    await settle();
    expect(mounted(host).map((element) => element.tagName.toLowerCase())).toEqual(['agr-diagnostics-drawer']);
    expect(openDialogs()).toHaveLength(1);
    await closeTop(host);
    expect(mounted(host)).toEqual([]);
    expect(deepActive()).toBe(trigger);
  });

  it('stacks the camera dialog above the cameras drawer, with the theme and demo flag on the dialog', async () => {
    const { host, trigger } = await mountHost('dark');
    host.open({ request: { id: 'cameras' }, trigger });
    await settle();
    host.open({ request: { id: 'camera', entity: CAMERA as never }, trigger });
    await settle();
    expect(mounted(host).map((element) => element.tagName.toLowerCase())).toEqual([
      'agr-cameras-drawer',
      'agr-camera-dialog',
    ]);
    const cameraDialog = mounted(host)[1] as HTMLElement & { theme: string; demo: boolean };
    expect(cameraDialog.theme).toBe('dark');
    expect(cameraDialog.demo).toBe(true);
    expect(openDialogs()).toHaveLength(2);
    await closeTop(host);
    expect(mounted(host).map((element) => element.tagName.toLowerCase())).toEqual(['agr-cameras-drawer']);
  });

  it('stacks a confirm dialog above a drawer and returns focus to the button that asked for it', async () => {
    const { host, trigger } = await mountHost();
    host.open({ request: { id: 'security' }, trigger });
    await settle();
    const drawerButton = deepQuery<HTMLButtonElement>(document.body, 'button.close') as HTMLButtonElement;
    host.confirm({ action: { kind: 'garage.close' }, trigger: drawerButton });
    await settle();
    expect(mounted(host).map((element) => element.tagName.toLowerCase())).toEqual([
      'agr-security-drawer',
      'agr-confirm-dialog',
    ]);
    deepQuery<HTMLButtonElement>(document.body, 'button.cancel')?.click();
    await settle();
    expect(mounted(host).map((element) => element.tagName.toLowerCase())).toEqual(['agr-security-drawer']);
    expect(deepActive()).toBe(drawerButton);
  });

  it('announces a confirm dialog that closed itself', async () => {
    const { host, trigger } = await mountHost();
    host.confirm({ action: { kind: 'garage.open' }, trigger });
    await settle();
    host.services?.gateway.invalidate('preview');
    await settle();
    expect(host.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe(
      'Not sent. The connection changed while this was open.',
    );
  });

  it('closeAll() unmounts everything with no dialog left open and restores nothing; reopening works', async () => {
    const { host, trigger } = await mountHost();
    host.open({ request: { id: 'cameras' }, trigger });
    await settle();
    host.open({ request: { id: 'camera', entity: CAMERA as never }, trigger });
    host.confirm({ action: { kind: 'garage.open' }, trigger });
    await settle();
    expect(openDialogs()).toHaveLength(3);
    host.closeAll();
    expect(mounted(host)).toEqual([]);
    expect(openDialogs()).toEqual([]);
    expect(host.hasOpenOverlay).toBe(false);
    host.open({ request: { id: 'home' }, trigger });
    await settle();
    expect(openDialogs()).toHaveLength(1);
  });

  it('closes every overlay when detached (rule 11)', async () => {
    const { host, trigger, shadow } = await mountHost();
    host.open({ request: { id: 'health' }, trigger });
    await settle();
    host.remove();
    expect(openDialogs()).toEqual([]);
    shadow.append(host);
    await settle();
    expect(mounted(host)).toEqual([]);
  });

  it('restores focus by focus key, then section heading, then the frame when the trigger is gone (rule 7)', async () => {
    const byKey = await mountHost();
    byKey.host.open({ request: { id: 'room', room: 0 }, trigger: byKey.trigger });
    await settle();
    const replacement = byKey.trigger.cloneNode(true) as HTMLButtonElement;
    byKey.trigger.replaceWith(replacement);
    await closeTop(byKey.host);
    expect(deepActive()).toBe(replacement);
    document.body.replaceChildren();

    const byHeading = await mountHost();
    byHeading.host.open({ request: { id: 'room', room: 0 }, trigger: byHeading.trigger });
    await settle();
    byHeading.trigger.remove();
    await closeTop(byHeading.host);
    expect(deepActive()?.id).toBe('agr-home-heading');
    document.body.replaceChildren();

    const byFrame = await mountHost();
    byFrame.host.open({ request: { id: 'room', room: 0 }, trigger: byFrame.trigger });
    await settle();
    byFrame.shadow.querySelector('agr-panel')?.remove();
    await closeTop(byFrame.host);
    expect(deepActive()?.classList.contains('frame')).toBe(true);
  });

  it('passes new services to mounted overlays on publish', async () => {
    const { host, trigger } = await mountHost();
    host.open({ request: { id: 'security' }, trigger });
    await settle();
    const next = services('dark');
    host.services = next;
    await settle();
    expect((mounted(host)[0] as DrawerElement).services).toBe(next);
  });
});
