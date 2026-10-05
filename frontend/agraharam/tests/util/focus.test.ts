import { describe, expect, it } from 'vitest';
import { deepActiveElement, findDeep, focusKeyOf, tabbableElements, trapTabKey } from '../../src/util/focus.ts';

/** <div> with light buttons, a shadow host with its own buttons and a slot, and a disabled/hidden/negative mix. */
function tree() {
  const container = document.createElement('div');
  container.innerHTML =
    '<button id="a">A</button><span id="host"><button id="slotted">S</button></span><button id="z">Z</button>';
  const host = container.querySelector('#host') as HTMLElement;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<button id="inner-1" data-focus-key="inner">1</button><slot></slot><button id="inner-off" disabled>x</button>' +
    '<button id="inner-neg" tabindex="-1">y</button><button id="inner-hidden" hidden>h</button>';
  document.body.append(container);
  return { container, host, shadow };
}

describe('composed-tree focus helpers (§5.4)', () => {
  it('lists tabbables in composed order, entering shadow roots and slots, skipping disabled, hidden and -1', () => {
    const { container } = tree();
    expect(tabbableElements(container).map((element) => element.id)).toEqual(['a', 'inner-1', 'slotted', 'z']);
  });

  it('without checkVisibility (Safari before 17.4), skips an element with no client rects (display:none)', () => {
    const { container, shadow } = tree();
    const notRendered = shadow.querySelector('#inner-1') as HTMLElement;
    notRendered.getClientRects = () => [] as unknown as DOMRectList;
    // An own property shadows the engine's method on every element; deleting it restores the method.
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', { value: undefined, configurable: true });
    try {
      expect(tabbableElements(container).map((element) => element.id)).toEqual(['a', 'slotted', 'z']);
    } finally {
      delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
    }
    expect(typeof notRendered.checkVisibility).toBe('function');
  });

  it('finds the deep active element through shadow roots', () => {
    const { shadow } = tree();
    const inner = shadow.querySelector('#inner-1') as HTMLButtonElement;
    inner.focus();
    expect(deepActiveElement()).toBe(inner);
  });

  it('wraps Tab from the last to the first and Shift+Tab from the first to the last', () => {
    const { container, shadow } = tree();
    (container.querySelector('#z') as HTMLButtonElement).focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    trapTabKey(tab, container);
    expect(tab.defaultPrevented).toBe(true);
    expect(deepActiveElement()?.id).toBe('a');
    trapTabKey(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }), container);
    expect(deepActiveElement()?.id).toBe('z');
    trapTabKey(new KeyboardEvent('keydown', { key: 'Tab' }), container);
    trapTabKey(new KeyboardEvent('keydown', { key: 'Tab' }), container);
    expect(deepActiveElement()).toBe(shadow.querySelector('#inner-1'));
  });

  it('ignores other keys', () => {
    const { container } = tree();
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    trapTabKey(arrow, container);
    expect(arrow.defaultPrevented).toBe(false);
  });

  it('finds elements across shadow roots and reads focus keys from a host or its shadow', () => {
    const { container, host } = tree();
    expect(findDeep(container, (element) => element.id === 'inner-1')?.id).toBe('inner-1');
    expect(focusKeyOf(host)).toBe('inner');
  });
});
