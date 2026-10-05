import { describe, expect, it, vi } from 'vitest';
import { AgrChoiceGroup } from '../../src/components/primitives/agr-choice-group.ts';
import type { ChoiceOptionVM } from '../../src/model/types.ts';

const ENABLED = { enabled: true, confirm: false } as const;
const CURRENT = { enabled: false, reason: 'not-applicable', message: 'Current mode' } as const;

const OPTIONS: readonly ChoiceOptionVM[] = [
  { value: 'off', label: 'Off', pressed: false, availability: ENABLED },
  { value: 'cool', label: 'Cool', pressed: true, availability: CURRENT },
  { value: 'fan_only', label: 'Fan', pressed: false, availability: ENABLED },
];
const NAVIGATION_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

async function mountGroup(options: readonly ChoiceOptionVM[] = OPTIONS) {
  const group = document.createElement('agr-choice-group') as AgrChoiceGroup;
  group.label = 'Mode';
  group.focusKeyPrefix = 'climate:0:mode';
  group.options = options;
  document.body.append(group);
  await group.updateComplete;
  const root = group.shadowRoot as ShadowRoot;
  const chosen = vi.fn();
  group.addEventListener('agr-choose', chosen);
  return { group, root, chosen, buttons: [...root.querySelectorAll('button')] };
}

describe('agr-choice-group (§5.5, §7.2, §12.1 row 5)', () => {
  it('renders only native buttons with aria-pressed inside role="group", never radios, selects or listboxes', async () => {
    const { root, buttons } = await mountGroup();
    const group = root.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('Mode');
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(root.querySelector('input, select, [role="radio"], [role="radiogroup"], [role="listbox"]')).toBeNull();
    expect(buttons.map((button) => button.dataset['focusKey'])).toEqual([
      'climate:0:mode:off',
      'climate:0:mode:cool',
      'climate:0:mode:fan_only',
    ]);
  });

  it.each(NAVIGATION_KEYS)('%s on any option emits nothing and is not handled', async (key) => {
    const { buttons, chosen } = await mountGroup();
    for (const button of buttons) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(chosen).not.toHaveBeenCalled();
  });

  it('emits exactly one agr-choose for one activation of an enabled option', async () => {
    const { buttons, chosen } = await mountGroup();
    buttons[2]?.click();
    expect(chosen).toHaveBeenCalledTimes(1);
    expect((chosen.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ value: 'fan_only' });
    expect((chosen.mock.calls[0]?.[0] as CustomEvent).composed).toBe(false);
  });

  it('suppresses held Enter repeats on options', async () => {
    const { buttons } = await mountGroup();
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, cancelable: true });
    buttons[0]?.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
  });

  it('sends nothing for the pressed (current) option, which is aria-disabled with its reason', async () => {
    const { root, buttons, chosen } = await mountGroup();
    const current = buttons[1];
    current?.click();
    expect(chosen).not.toHaveBeenCalled();
    expect(current?.getAttribute('aria-disabled')).toBe('true');
    expect(root.getElementById(current?.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Current mode');
  });

  it('resolves every aria-describedby inside its own shadow root and keeps every option tabbable', async () => {
    const busy = { enabled: false, reason: 'busy', message: 'Waiting for Bedroom to respond.' } as const;
    const { root, buttons } = await mountGroup(OPTIONS.map((option) => ({ ...option, availability: busy })));
    for (const button of buttons) {
      expect(button.tabIndex).toBe(0);
      expect(root.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe(busy.message);
    }
  });

  it('reflects a vertical orientation for long lists', async () => {
    const { group } = await mountGroup();
    group.orientation = 'vertical';
    await group.updateComplete;
    expect(group.getAttribute('orientation')).toBe('vertical');
  });

  it('tone="media" marks only the current option with a decorative check, as the media drawer marks its chosen player', async () => {
    const plain = await mountGroup();
    expect(plain.root.querySelector('.check')).toBeNull();
    plain.group.tone = 'media';
    await plain.group.updateComplete;
    expect(plain.group.getAttribute('tone')).toBe('media');
    const checks = [...plain.root.querySelectorAll('button')].map((button) => button.querySelector('.check') !== null);
    expect(checks).toEqual([false, true, false]);
    expect(plain.root.querySelector('.check')?.getAttribute('aria-hidden')).toBe('true');
  });
});
