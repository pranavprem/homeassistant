/**
 * Composed-tree utilities installed into every harness page as `window.__agrE2E` (test-only; never in the bundle).
 * The card renders everything inside nested open shadow roots and its overlays live in the top layer, so questions
 * such as "where is focus?" or "is this control inside the topmost dialog?" need a walk across shadow boundaries.
 * Playwright locators already pierce shadow roots; these helpers cover what locators cannot express.
 */
import type { Page } from '@playwright/test';

export interface FocusInfo {
  readonly tag: string;
  readonly focusKey: string | null;
  readonly text: string;
  /** True when the focused element is inside the topmost open dialog (composed containment). */
  readonly inTopDialog: boolean;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly focusVisible: boolean;
}

export interface AgrE2E {
  all(selector: string, root?: ParentNode): Element[];
  card(): HTMLElement;
  view(): HTMLElement;
  deepActive(): Element | null;
  contains(ancestor: Node, node: Node): boolean;
  openDialogs(): HTMLDialogElement[];
  topDialog(): HTMLDialogElement | null;
  focusInfo(): FocusInfo | null;
  shellButton(label: string): HTMLButtonElement;
  signature(): string;
  /** Resolves when every finite running animation or transition in the composed tree has finished. */
  animationsSettled(): Promise<void>;
}

declare global {
  interface Window {
    __agrE2E: AgrE2E;
  }
}

/** Runs in the page before any page script (serialized by Playwright, so it must be self-contained). */
function definePageTools(): void {
  const all = (selector: string, root: ParentNode = document): Element[] => {
    const found: Element[] = [];
    const walk = (node: ParentNode): void => {
      for (const element of node.querySelectorAll('*')) {
        if (element.matches(selector)) found.push(element);
        if (element.shadowRoot !== null) walk(element.shadowRoot);
      }
    };
    walk(root);
    return found;
  };
  const first = (selector: string): Element => {
    const element = all(selector)[0];
    if (element === undefined) throw new Error(`no element matches ${selector}`);
    return element;
  };
  // Flat-tree parent: slotted content belongs to the slot it renders in (drawer bodies are slotted into the
  // dialog), and a shadow root's children belong to its host.
  const parentOf = (node: Node): Node | null => {
    if (node instanceof Element && node.assignedSlot !== null) return node.assignedSlot;
    return node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
  };
  const contains = (ancestor: Node, node: Node): boolean => {
    for (let current: Node | null = node; current !== null; current = parentOf(current)) {
      if (current === ancestor) return true;
    }
    return false;
  };
  const deepActive = (): Element | null => {
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  const openDialogs = (): HTMLDialogElement[] =>
    all('dialog').filter((dialog): dialog is HTMLDialogElement => (dialog as HTMLDialogElement).open);
  // Overlays mount in order (a confirm dialog after the drawer it stacks on), so the last open dialog is on top.
  const topDialog = (): HTMLDialogElement | null => openDialogs().at(-1) ?? null;
  const shellRoot = (): ShadowRoot => {
    const root = document.querySelector('dev-ha-shell')?.shadowRoot;
    if (root === null || root === undefined) throw new Error('the dev HA shell is not rendered');
    return root;
  };
  const ANIMATION_CAP_MS = 2_000;
  window.__agrE2E = {
    all,
    card: () => first('agraharam-dashboard') as HTMLElement,
    view: () => {
      const view = shellRoot().querySelector<HTMLElement>('.view');
      if (view === null) throw new Error('the shell has no view');
      return view;
    },
    deepActive,
    contains,
    openDialogs,
    topDialog,
    focusInfo: () => {
      const active = deepActive();
      if (active === null || active === document.body) return null;
      const dialog = topDialog();
      const style = getComputedStyle(active);
      return {
        tag: active.tagName.toLowerCase(),
        focusKey: active.getAttribute('data-focus-key'),
        text: (active.textContent ?? '').replace(/\s+/g, ' ').trim(),
        inTopDialog: dialog !== null && contains(dialog, active),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        focusVisible: active.matches(':focus-visible'),
      };
    },
    shellButton: (label: string) => {
      const button = [...shellRoot().querySelectorAll('button')].find(
        (candidate) => (candidate.textContent ?? '').trim() === label,
      );
      if (button === undefined) throw new Error(`the shell has no "${label}" button`);
      return button;
    },
    // A cheap summary of what is rendered; equal samples in a row mean rendering has settled.
    signature: () => {
      const card = all('agraharam-dashboard')[0];
      if (card === undefined || card.shadowRoot === null) return 'no-card';
      const elements = all('*', card.shadowRoot);
      const images = elements.filter((element): element is HTMLImageElement => element instanceof HTMLImageElement);
      let text = 0;
      for (const element of elements) {
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) text += (child.textContent ?? '').trim().length;
        }
      }
      const loaded = images.filter((image) => image.complete).length;
      const height = Math.round(card.getBoundingClientRect().height);
      return `${elements.length}:${text}:${images.length}:${loaded}:${height}:${openDialogs().length}`;
    },
    animationsSettled: async () => {
      const running = all('*')
        .flatMap((element) => element.getAnimations())
        .filter((animation) => animation.playState === 'running')
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
      const cap = new Promise<void>((resolve) => setTimeout(resolve, ANIMATION_CAP_MS));
      await Promise.race([Promise.all(running.map((animation) => animation.finished.catch(() => undefined))), cap]);
    },
  };
}

export async function installPageTools(page: Page): Promise<void> {
  await page.addInitScript(definePageTools);
}
