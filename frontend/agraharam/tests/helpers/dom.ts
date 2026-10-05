/** Shadow-root-aware queries and update settling for component tests. */

type Updatable = Element & { updateComplete: Promise<boolean> };

/** Every element under `root`, descending into shadow roots. */
export function deepElements(root: ParentNode): Element[] {
  const found: Element[] = [];
  for (const element of root.querySelectorAll('*')) {
    found.push(element);
    if (element.shadowRoot) found.push(...deepElements(element.shadowRoot));
  }
  return found;
}

export function deepQuery<E extends Element = Element>(root: ParentNode, selector: string): E | null {
  return (deepElements(root).find((element) => element.matches(selector)) as E | undefined) ?? null;
}

export function deepQueryAll<E extends Element = Element>(root: ParentNode, selector: string): E[] {
  return deepElements(root).filter((element) => element.matches(selector)) as E[];
}

/** The innermost focused element, through shadow roots. */
export function deepActive(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/** Awaits Lit updates across the whole composed tree until nothing is pending (nested elements render later). */
export async function settle(root: ParentNode = document.body, rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const pending = deepElements(root).filter((element): element is Updatable => 'updateComplete' in element);
    const results = await Promise.all(pending.map((element) => element.updateComplete));
    if (results.every(Boolean)) {
      await Promise.resolve();
      if (round > 0) return;
    }
  }
}

/** Gives every element `width` from getBoundingClientRect (happy-dom has no layout). */
export function stubWidth(element: Element, width: number): void {
  element.getBoundingClientRect = () => new DOMRect(0, 0, width, 800);
}
