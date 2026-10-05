import { describe, expect, it, vi } from 'vitest';
import { AgrButton } from '../../src/components/primitives/agr-button.ts';
import '../../src/components/primitives/agr-icon-button.ts';
import type { ActionStatus, Availability } from '../../src/ha/actions/types.ts';

const ENABLED: Availability = { enabled: true, confirm: false };
const DISABLED: Availability = {
  enabled: false,
  reason: 'disconnected',
  message: 'Paused while Home Assistant is disconnected.',
};

function pending(kind: ActionStatus['kind'] = 'light.turn_on'): ActionStatus {
  return { id: 1, key: 'entity:light.demo_kitchen', kind, phase: 'pending', startedAt: 0 };
}

async function mountButton(tag: 'agr-button' | 'agr-icon-button', configure: (button: AgrButton) => void) {
  const button = document.createElement(tag) as AgrButton;
  button.label = 'Kitchen lights';
  button.focusKey = 'room:0:toggle';
  button.availability = ENABLED;
  configure(button);
  document.body.append(button);
  await button.updateComplete;
  const native = button.shadowRoot?.querySelector('button');
  if (!native) throw new Error('no native button');
  const activations = vi.fn();
  button.addEventListener('agr-activate', activations);
  return { button, native, activations, root: button.shadowRoot as ShadowRoot };
}

describe('agr-button (§5.5, §7.2)', () => {
  it('carries aria-pressed only as a state toggle, reporting the pressed state it is given', async () => {
    const plain = await mountButton('agr-button', () => undefined);
    expect(plain.native.hasAttribute('aria-pressed')).toBe(false);
    const pressed = await mountButton('agr-button', (button) => {
      button.pressed = true;
    });
    expect(pressed.native.getAttribute('aria-pressed')).toBe('true');
    pressed.button.pressed = false;
    await pressed.button.updateComplete;
    expect(pressed.native.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders a native button with its focus key and emits agr-activate once per click, not composed', async () => {
    const { native, activations } = await mountButton('agr-button', () => undefined);
    expect(native.dataset['focusKey']).toBe('room:0:toggle');
    expect(native.textContent).toContain('Kitchen lights');
    native.click();
    expect(activations).toHaveBeenCalledTimes(1);
    const event = activations.mock.calls[0]?.[0] as CustomEvent;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(false);
  });

  it('uses aria-disabled (never native disabled), stays focusable, guards clicks and names the reason', async () => {
    const { native, activations, root } = await mountButton('agr-button', (button) => {
      button.availability = DISABLED;
    });
    expect(native.getAttribute('aria-disabled')).toBe('true');
    expect(native.hasAttribute('disabled')).toBe(false);
    expect(native.tabIndex).toBe(0);
    native.click();
    native.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(activations).not.toHaveBeenCalled();
    const reasonId = native.getAttribute('aria-describedby') ?? '';
    expect(root.getElementById(reasonId)?.textContent).toBe(DISABLED.message);
  });

  it('shows the reason as visible meta by default and visually hidden on request', async () => {
    const visible = await mountButton('agr-button', (button) => {
      button.availability = DISABLED;
    });
    expect(visible.root.getElementById('reason')?.className).toBe('reason');
    const hidden = await mountButton('agr-button', (button) => {
      button.availability = DISABLED;
      button.reasonDisplay = 'hidden';
    });
    expect(hidden.root.getElementById('reason')?.className).toBe('visually-hidden');
  });

  it('suppresses held-key repeats so a held Enter cannot click repeatedly', async () => {
    const { native } = await mountButton('agr-button', () => undefined);
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, cancelable: true });
    native.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    const first = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    native.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
  });

  it('activates once for a double click while its ticket is pending', async () => {
    const { button, native, activations } = await mountButton('agr-button', () => undefined);
    button.addEventListener('agr-activate', () => {
      button.status = pending(); // the section requests and passes the pending ticket down
    });
    native.click();
    native.click();
    expect(activations).toHaveBeenCalledTimes(1);
  });

  it('renders static status text (no live region): Sending, Done, Requested for scripts', async () => {
    const { button, root } = await mountButton('agr-button', (b) => {
      b.status = pending();
    });
    expect(root.getElementById('status')?.textContent).toBe('Sending');
    expect(root.querySelector('[aria-live]')).toBeNull();
    button.status = { ...pending(), phase: 'confirmed' };
    await button.updateComplete;
    expect(root.getElementById('status')?.textContent).toBe('Done');
    button.status = { ...pending('security.run'), key: 'security', phase: 'confirmed' };
    await button.updateComplete;
    expect(root.getElementById('status')?.textContent).toBe('Requested');
  });

  it('asks for focus delegation, so host.focus() reaches the native button (verified in real engines by e2e)', () => {
    expect(AgrButton.shadowRootOptions.delegatesFocus).toBe(true);
  });
});

describe('agr-icon-button', () => {
  it('carries its label as visually hidden text inside the native button, with the same guard', async () => {
    const { native, activations } = await mountButton('agr-icon-button', (button) => {
      button.icon = 'menu';
      button.label = 'Open household menu';
      button.availability = DISABLED;
    });
    expect(native.querySelector('.visually-hidden')?.textContent).toBe('Open household menu');
    expect(native.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    native.click();
    expect(activations).not.toHaveBeenCalled();
  });

  it('shows a switched-on device in its own fill, and drops it while disabled (the label keeps the fact)', async () => {
    const on = await mountButton('agr-icon-button', (button) => {
      button.powered = 'device';
    });
    expect(on.native.dataset['powered']).toBe('device');
    const off = await mountButton('agr-icon-button', () => undefined);
    expect(off.native.hasAttribute('data-powered')).toBe(false);
    const paused = await mountButton('agr-icon-button', (button) => {
      button.powered = 'light';
      button.availability = DISABLED;
    });
    // The attribute stays; the shared disabled look wins in CSS (aria-disabled outranks data-powered there).
    expect(paused.native.dataset['powered']).toBe('light');
    expect(paused.native.getAttribute('aria-disabled')).toBe('true');
  });
});
