import { html, render } from 'lit';
import { describe, expect, it, vi } from 'vitest';
import '../../src/components/primitives/agr-drawer.ts';
import type { AgrDrawer } from '../../src/components/primitives/agr-drawer.ts';
import { trapTabKey } from '../../src/util/focus.ts';
import { deepActive } from '../helpers/dom.ts';
import { resizeElement } from '../helpers/observers.ts';

async function mountDrawer(options: { demo?: boolean; theme?: 'light' | 'dark' } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  render(
    html`<agr-drawer heading="Security" .demo=${options.demo ?? false} .theme=${options.theme ?? 'light'}>
      <button id="first-action">Hold Night</button>
      <button id="last-action">Hold Away</button>
    </agr-drawer>`,
    container,
  );
  const drawer = container.querySelector('agr-drawer') as AgrDrawer;
  await drawer.updateComplete;
  const root = drawer.shadowRoot as ShadowRoot;
  const dialog = root.querySelector('dialog') as HTMLDialogElement;
  return { drawer, root, dialog, container };
}

describe('agr-drawer (§5.2, §5.4)', () => {
  it('opens its dialog modally on mount, labelled by its h2, and focuses the heading', async () => {
    const { root, dialog } = await mountDrawer();
    expect(dialog.open).toBe(true);
    const heading = root.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('Security');
    expect(heading?.getAttribute('tabindex')).toBe('-1');
    expect(deepActive()).toBe(heading);
  });

  it('generates a distinct heading id per drawer', async () => {
    const first = await mountDrawer();
    const second = await mountDrawer();
    expect(first.dialog.getAttribute('aria-labelledby')).not.toBe(second.dialog.getAttribute('aria-labelledby'));
  });

  it('reflects the theme onto the dialog and shows the Demo pill only in demo mode', async () => {
    const dark = await mountDrawer({ theme: 'dark', demo: true });
    expect(dark.dialog.dataset['theme']).toBe('dark');
    expect(dark.root.querySelector('.pill')?.textContent).toBe('Demo');
    const live = await mountDrawer();
    expect(live.root.querySelector('.pill')).toBeNull();
  });

  it('renders a 44 px Close button with an accessible name, and dispatches agr-drawer-closed on close', async () => {
    const { drawer, root, dialog } = await mountDrawer();
    const closed = vi.fn();
    drawer.addEventListener('agr-drawer-closed', closed);
    const close = root.querySelector('button.close') as HTMLButtonElement;
    expect(close.textContent?.trim()).toBe('Close');
    close.click();
    expect(dialog.open).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    expect((closed.mock.calls[0]?.[0] as Event).composed).toBe(true);
  });

  it('closes on a backdrop click (a click on the dialog box itself) but not on content clicks', async () => {
    const { dialog, drawer } = await mountDrawer();
    (drawer.querySelector('#first-action') as HTMLElement).click();
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialog.open).toBe(false);
  });

  it('closes its dialog when detached and never reopens on re-attach (rule 11)', async () => {
    const { drawer, dialog, container } = await mountDrawer();
    drawer.remove();
    expect(dialog.open).toBe(false);
    container.append(drawer);
    await drawer.updateComplete;
    expect(dialog.open).toBe(false);
  });

  it('wraps Tab and Shift+Tab inside the dialog, treating Alt+Tab like Tab', async () => {
    const { root, dialog, drawer } = await mountDrawer();
    const close = root.querySelector('button.close') as HTMLButtonElement;
    const last = drawer.querySelector('#last-action') as HTMLButtonElement;
    last.focus();
    trapTabKey(new KeyboardEvent('keydown', { key: 'Tab', altKey: true, cancelable: true }), dialog);
    expect(deepActive()).toBe(close);
    trapTabKey(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }), dialog);
    expect(deepActive()).toBe(last);
  });
});

describe('agr-drawer scrolling body (WCAG 2.1.1, axe scrollable-region-focusable)', () => {
  const BODY_HEIGHT_PX = 400;
  const LONG_CONTENT_PX = 900;

  async function mountWithContent(content: ReturnType<typeof html>) {
    const container = document.createElement('div');
    document.body.append(container);
    render(html`<agr-drawer heading="House health">${content}</agr-drawer>`, container);
    const drawer = container.querySelector('agr-drawer') as AgrDrawer;
    await drawer.updateComplete;
    const root = drawer.shadowRoot as ShadowRoot;
    return {
      drawer,
      dialog: root.querySelector('dialog') as HTMLDialogElement,
      body: root.querySelector('.dialog-body') as HTMLElement,
      close: root.querySelector('button.close') as HTMLButtonElement,
    };
  }

  /** happy-dom has no layout, so the test sets the body's heights and delivers the resize itself. */
  async function setContentHeight(drawer: AgrDrawer, body: HTMLElement, contentPx: number): Promise<void> {
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: BODY_HEIGHT_PX });
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: contentPx });
    resizeElement(body, BODY_HEIGHT_PX);
    await drawer.updateComplete;
  }

  it('a body that scrolls with nothing focusable becomes a focusable region named by the heading', async () => {
    const { drawer, dialog, body, close } = await mountWithContent(html`<p>Devices not reporting</p>`);
    expect(body.hasAttribute('tabindex')).toBe(false);

    await setContentHeight(drawer, body, LONG_CONTENT_PX);
    expect(body.getAttribute('tabindex')).toBe('0');
    expect(body.getAttribute('role')).toBe('region');
    expect(body.getAttribute('aria-labelledby')).toBe(dialog.getAttribute('aria-labelledby'));
    close.focus();
    trapTabKey(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }), dialog);
    expect(deepActive()).toBe(body);

    await setContentHeight(drawer, body, BODY_HEIGHT_PX);
    expect(body.hasAttribute('tabindex')).toBe(false);
    expect(body.hasAttribute('role')).toBe(false);
    expect(body.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('a scrolling body with a control stays out of the tab order, so nothing focusable is nested', async () => {
    const { drawer, body } = await mountWithContent(html`<button>Details</button>`);
    await setContentHeight(drawer, body, LONG_CONTENT_PX);
    expect(body.hasAttribute('tabindex')).toBe(false);
    expect(body.hasAttribute('role')).toBe(false);
  });
});
