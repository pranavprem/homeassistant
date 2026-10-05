/**
 * Focus helpers that see through shadow roots (§5.4). Every primitive renders its controls in its own shadow root,
 * so document-level focus APIs alone would only ever see the outermost host.
 */

/** Elements that can take keyboard focus when not disabled and not removed from the tab order. */
const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';

/** The focused element, following shadowRoot.activeElement down to the innermost one (§5.4 rule 2). */
export function deepActiveElement(root: DocumentOrShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * Tabbable elements under `root` in composed-tree order: shadow roots are entered, slots are replaced by their
 * assigned elements, and a host whose shadow root delegates focus contributes its inner controls, not itself.
 */
export function tabbableElements(root: Element | ShadowRoot): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const child of root.children) collectTabbable(child, found);
  return found;
}

function collectTabbable(element: Element, found: HTMLElement[]): void {
  if (element instanceof HTMLSlotElement) {
    const assigned = element.assignedElements({ flatten: true });
    for (const child of assigned.length > 0 ? assigned : [...element.children]) collectTabbable(child, found);
    return;
  }
  if (element instanceof HTMLElement && element.hidden) return;
  if (element instanceof HTMLElement && isTabbable(element)) found.push(element);
  const children = element.shadowRoot ? element.shadowRoot.children : element.children;
  for (const child of children) collectTabbable(child, found);
}

function isTabbable(element: HTMLElement): boolean {
  if (!element.matches(FOCUSABLE_SELECTOR) || element.tabIndex < 0) return false;
  if (element.shadowRoot?.delegatesFocus) return false;
  if (element.hasAttribute('disabled') || element.closest('[inert]') !== null) return false;
  return isRendered(element);
}

/**
 * Whether the element is rendered: checkVisibility where the engine has it (it is missing below Safari 17.4), else
 * its client rects, which display:none on the element or any ancestor leaves empty.
 */
function isRendered(element: HTMLElement): boolean {
  return typeof element.checkVisibility === 'function'
    ? element.checkVisibility()
    : element.getClientRects().length > 0;
}

/**
 * Wraps Tab and Shift+Tab inside `container` (§5.4 rule 4). Every Tab is handled here rather than by the browser,
 * so Alt+Tab (Safari's "move to buttons too" chord) behaves exactly like Tab in every engine.
 */
export function trapTabKey(event: KeyboardEvent, container: Element | ShadowRoot): void {
  if (event.key !== 'Tab' || event.ctrlKey || event.metaKey) return;
  const tabbables = tabbableElements(container);
  event.preventDefault();
  if (tabbables.length === 0) return;
  const current = deepActiveElement();
  const index = current instanceof HTMLElement ? tabbables.indexOf(current) : -1;
  const step = event.shiftKey ? -1 : 1;
  const next = index === -1 ? (event.shiftKey ? tabbables.length - 1 : 0) : index + step;
  const wrapped = (next + tabbables.length) % tabbables.length;
  tabbables[wrapped]?.focus();
}

/** First element in the composed tree under `root` (shadow roots included) that satisfies `predicate`. */
export function findDeep(root: Element | ShadowRoot, predicate: (element: Element) => boolean): Element | undefined {
  for (const child of root.children) {
    if (predicate(child)) return child;
    const nested = findDeep(child, predicate) ?? (child.shadowRoot ? findDeep(child.shadowRoot, predicate) : undefined);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The composed-tree parent: the parent element, or the shadow host when `element` is a shadow root's child. */
export function composedParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** The stable `data-focus-key` (§5.1) of a control: on the element, or on the native control inside its shadow. */
export function focusKeyOf(element: Element): string | undefined {
  const own = element.getAttribute('data-focus-key');
  if (own) return own;
  return element.shadowRoot?.querySelector('[data-focus-key]')?.getAttribute('data-focus-key') ?? undefined;
}
