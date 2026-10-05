/**
 * Layout measurements taken inside the page (§6.1, §6.2, §6.2.1, §6.4). Everything is read from what the browser
 * laid out: computed styles and bounding boxes of the built card inside the fake HA shell. Nothing here reads the
 * card's internal state.
 */
import type { Page } from '@playwright/test';
import type { HeaderVariant, LayoutMode } from './viewports.ts';

export interface Overflow {
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

export interface SectionBox {
  readonly tag: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly height: number;
  /** Height with `flex: 0 0 auto`, i.e. the panel's own content height before column stretching. */
  readonly naturalHeight: number;
  readonly stretched: boolean;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

export interface ControlIssue {
  readonly control: string;
  readonly detail: string;
}

export interface LayoutMeasure {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly cardWidth: number;
  readonly mode: LayoutMode | null;
  readonly header: {
    readonly width: number;
    readonly containerType: string;
    readonly containerName: string;
    readonly variant: HeaderVariant;
    readonly policyShown: boolean;
    readonly overflow: Overflow;
  };
  readonly heroPx: number | null;
  readonly forecastCells: number;
  readonly overflow: { readonly document: Overflow; readonly view: Overflow; readonly frame: Overflow };
  readonly view: { readonly scrollHeight: number; readonly clientHeight: number };
  readonly frame: { readonly left: number; readonly right: number };
  readonly columns: readonly (readonly SectionBox[])[];
  readonly controls: {
    readonly count: number;
    readonly overlaps: readonly ControlIssue[];
    readonly outsideViewport: readonly ControlIssue[];
    readonly outsideSection: readonly ControlIssue[];
    readonly clipped: readonly ControlIssue[];
  };
}

export async function measureLayout(page: Page): Promise<LayoutMeasure> {
  return page.evaluate(() => {
    const tools = window.__agrE2E;
    const card = tools.card();
    const root = card.shadowRoot;
    if (root === null) throw new Error('the card has no shadow root');
    const one = <E extends Element>(selector: string, scope: ParentNode = root): E | null =>
      (tools.all(selector, scope)[0] as E | undefined) ?? null;
    const shown = (element: Element | null): boolean =>
      element !== null && getComputedStyle(element).display !== 'none';
    const overflowOf = (element: Element): { scrollWidth: number; clientWidth: number } => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    });
    const round = (value: number): number => Math.round(value * 10) / 10;

    const header = one<HTMLElement>('agr-header');
    if (header === null || header.shadowRoot === null) throw new Error('the card has no header');
    const headerRoot = header.shadowRoot;
    const compact = shown(headerRoot.querySelector('.menu'));
    const variant = compact
      ? shown(headerRoot.querySelector('.mark'))
        ? 'compact'
        : 'compact-no-kolam'
      : shown(headerRoot.querySelector('.greeting'))
        ? 'full'
        : 'medium';
    const headerStyle = getComputedStyle(header);
    const policy = one('.policy', headerRoot);

    const today = one<HTMLElement>('agr-today');
    const hero = today?.shadowRoot?.querySelector('.temperature') ?? null;
    const cells = today === null ? [] : tools.all('li.cell', today.shadowRoot ?? today);

    const frame = root.querySelector<HTMLElement>('.frame');
    if (frame === null) throw new Error('the card has no frame');
    const frameBox = frame.getBoundingClientRect();
    const view = tools.view();

    const columns = [...root.querySelectorAll('.column')].map((column) =>
      [...column.children].map((section) => {
        const host = section as HTMLElement;
        const box = host.getBoundingClientRect();
        const previous = host.style.flex;
        host.style.flex = '0 0 auto';
        const naturalHeight = host.getBoundingClientRect().height;
        host.style.flex = previous;
        return {
          tag: host.tagName.toLowerCase(),
          top: round(box.top),
          bottom: round(box.bottom),
          left: round(box.left),
          right: round(box.right),
          height: round(box.height),
          naturalHeight: round(naturalHeight),
          stretched: host.hasAttribute('data-stretch'),
          scrollWidth: host.scrollWidth,
          clientWidth: host.clientWidth,
        };
      }),
    );

    // Every visible control in the columns and header (overlays are measured separately).
    const overlayHost = root.querySelector('agr-overlay-host');
    const interactive = 'button, input, select, textarea, a[href], [role="button"], [tabindex]:not([tabindex="-1"])';
    const sectionTags = new Set([...root.querySelectorAll('.column > *')].map((element) => element));
    const sectionOf = (element: Element): Element | null => {
      for (let node: Node | null = element; node !== null;) {
        if (node instanceof Element && (sectionTags.has(node) || node.tagName === 'AGR-HEADER')) return node;
        node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
      }
      return null;
    };
    const describe = (element: Element): string =>
      element.getAttribute('data-focus-key') ??
      `${element.tagName.toLowerCase()} "${(element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
    const controls = tools
      .all(interactive, root)
      .filter((element) => overlayHost === null || !tools.contains(overlayHost, element))
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(
        ({ element, box }) => box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== 'hidden',
      );

    const overlaps: { control: string; detail: string }[] = [];
    for (let i = 0; i < controls.length; i += 1) {
      for (let j = i + 1; j < controls.length; j += 1) {
        const a = controls[i]!.box;
        const b = controls[j]!.box;
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (width > 1 && height > 1) {
          overlaps.push({
            control: describe(controls[i]!.element),
            detail: `overlaps ${describe(controls[j]!.element)} by ${round(width)}×${round(height)}`,
          });
        }
      }
    }
    const outsideViewport: { control: string; detail: string }[] = [];
    const outsideSection: { control: string; detail: string }[] = [];
    const clipped: { control: string; detail: string }[] = [];
    for (const { element, box } of controls) {
      if (box.left < -0.5 || box.right > window.innerWidth + 0.5) {
        outsideViewport.push({ control: describe(element), detail: `x ${round(box.left)}..${round(box.right)}` });
      }
      const section = sectionOf(element);
      const sectionBox = section?.getBoundingClientRect();
      if (
        sectionBox !== undefined &&
        (box.left < sectionBox.left - 1 ||
          box.right > sectionBox.right + 1 ||
          box.top < sectionBox.top - 1 ||
          box.bottom > sectionBox.bottom + 1)
      ) {
        outsideSection.push({ control: describe(element), detail: `outside ${section?.tagName.toLowerCase()}` });
      }
      // A control whose own content overflows it, unless the overflow is a designed ellipsis truncation.
      const ellipsis = tools
        .all('*', element)
        .concat(element)
        .some((node) => getComputedStyle(node).textOverflow === 'ellipsis');
      if (!ellipsis && element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0) {
        clipped.push({ control: describe(element), detail: `${element.scrollWidth} > ${element.clientWidth}` });
      }
    }

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      cardWidth: round(card.getBoundingClientRect().width),
      mode: (frame.dataset['layout'] as 'wide' | 'medium' | 'narrow' | undefined) ?? null,
      header: {
        width: round(header.getBoundingClientRect().width),
        containerType: headerStyle.containerType,
        containerName: headerStyle.containerName,
        variant,
        policyShown: shown(policy),
        overflow: overflowOf(header),
      },
      heroPx: hero === null ? null : Number.parseFloat(getComputedStyle(hero).fontSize),
      forecastCells: cells.filter((cell) => getComputedStyle(cell).display !== 'none').length,
      overflow: {
        document: overflowOf(document.documentElement),
        view: overflowOf(view),
        frame: overflowOf(frame),
      },
      view: { scrollHeight: view.scrollHeight, clientHeight: view.clientHeight },
      frame: { left: round(frameBox.left), right: round(frameBox.right) },
      columns,
      controls: { count: controls.length, overlaps, outsideViewport, outsideSection, clipped },
    };
  });
}

/** Bottom of the last panel in each column. */
export function columnBottoms(measure: LayoutMeasure): number[] {
  return measure.columns.map((column) => column.at(-1)?.bottom ?? 0);
}

/** Every horizontal overflow on the page: document, shell view, frame, header and each panel. */
export function horizontalOverflows(measure: LayoutMeasure): string[] {
  const issues: string[] = [];
  const check = (name: string, overflow: Overflow): void => {
    if (overflow.scrollWidth > overflow.clientWidth) {
      issues.push(`${name}: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`);
    }
  };
  check('document', measure.overflow.document);
  check('shell view', measure.overflow.view);
  check('frame', measure.overflow.frame);
  check('agr-header', measure.header.overflow);
  for (const section of measure.columns.flat()) {
    check(section.tag, section);
    if (section.left < measure.frame.left - 0.5 || section.right > measure.frame.right + 0.5) {
      issues.push(`${section.tag}: outside the frame (${section.left}..${section.right})`);
    }
  }
  return issues;
}

export interface PanelVoid {
  readonly panel: string;
  /** The largest vertical gap between two bands of the panel's content, in CSS px. */
  readonly largestGapPx: number;
}

/**
 * The largest empty band between a panel's own children, per panel (§6.2: a stretched panel never distributes its
 * column's slack between its children). The children are the default slot's elements, descending while there is
 * only one; side-by-side children (a tile grid) form one band, so only stacked bands count.
 */
export async function panelVoids(page: Page): Promise<PanelVoid[]> {
  return page.evaluate(() => {
    const root = window.__agrE2E.card().shadowRoot;
    if (root === null) throw new Error('the card has no shadow root');
    const MAX_DEPTH = 3;
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      return box.height > 0.5 && box.width > 0.5 && getComputedStyle(element).visibility !== 'hidden';
    };
    const bandsOf = (elements: readonly Element[], depth: number): Element[] => {
      const shown = elements.filter(visible);
      const only = shown[0];
      if (shown.length === 1 && only !== undefined && depth < MAX_DEPTH) {
        return bandsOf([...only.children], depth + 1);
      }
      return shown;
    };
    return [...root.querySelectorAll('.column > *')].flatMap((section) => {
      const panel = section.shadowRoot?.querySelector('agr-panel');
      const slot = panel?.shadowRoot?.querySelector<HTMLSlotElement>('slot:not([name])');
      if (panel === null || panel === undefined || slot === null || slot === undefined) return [];
      const boxes = bandsOf(slot.assignedElements({ flatten: true }), 0)
        .map((element) => element.getBoundingClientRect())
        .sort((a, b) => a.top - b.top);
      let reached = Number.NEGATIVE_INFINITY;
      let largest = 0;
      for (const box of boxes) {
        if (reached !== Number.NEGATIVE_INFINITY && box.top > reached) largest = Math.max(largest, box.top - reached);
        reached = Math.max(reached, box.bottom);
      }
      return [{ panel: section.tagName.toLowerCase(), largestGapPx: Math.round(largest * 10) / 10 }];
    });
  });
}

export interface WordSplit {
  readonly panel: string;
  readonly word: string;
}

/**
 * Every word in the columns' panels that the browser broke across two lines (an `overflow-wrap` break or a
 * hyphenation): a word whose text range renders on more than one line box. Visually hidden text (a 1 px box) and
 * text that is not rendered are skipped, so only what a person sees counts.
 */
export async function midWordSplits(page: Page): Promise<WordSplit[]> {
  return page.evaluate(() => {
    const root = window.__agrE2E.card().shadowRoot;
    if (root === null) throw new Error('the card has no shadow root');
    const MIN_VISIBLE_BOX_PX = 2;
    const WORD_RE = /\S{2,}/g;
    const splits: { panel: string; word: string }[] = [];
    const textNodes = (scope: Node): Text[] => {
      const found: Text[] = [];
      const walk = (node: Node): void => {
        if (node instanceof Text) found.push(node);
        if (node instanceof Element && node.shadowRoot !== null) walk(node.shadowRoot);
        for (const child of node.childNodes) walk(child);
      };
      walk(scope);
      return found;
    };
    for (const section of root.querySelectorAll('.column > *')) {
      for (const text of textNodes(section)) {
        const owner = text.parentElement;
        if (owner === null || owner.getBoundingClientRect().width < MIN_VISIBLE_BOX_PX) continue;
        for (const match of text.data.matchAll(WORD_RE)) {
          const range = document.createRange();
          range.setStart(text, match.index);
          range.setEnd(text, match.index + match[0].length);
          const lines = new Set(
            [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)),
          );
          if (lines.size > 1) splits.push({ panel: section.tagName.toLowerCase(), word: match[0] });
        }
      }
    }
    return splits;
  });
}
