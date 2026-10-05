/**
 * Controllable stand-ins for the browser observers and page visibility (§12.1). happy-dom has no layout, so tests
 * deliver sizes and intersections explicitly.
 */

/** A ResizeObserver whose deliveries the test triggers with resizeElement(). */
export class FakeResizeObserver implements ResizeObserver {
  static readonly instances = new Set<FakeResizeObserver>();
  readonly targets = new Set<Element>();
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    FakeResizeObserver.instances.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  deliver(target: Element, inlineSize: number): void {
    const size = { inlineSize, blockSize: 0 };
    const entry = {
      target,
      contentRect: { x: 0, y: 0, top: 0, left: 0, right: inlineSize, bottom: 0, width: inlineSize, height: 0 },
      contentBoxSize: [size],
      borderBoxSize: [size],
      devicePixelContentBoxSize: [size],
    } as unknown as ResizeObserverEntry;
    this.#callback([entry], this);
  }
}

/** An IntersectionObserver whose intersections the test sets with setIntersecting(). */
export class FakeIntersectionObserver implements IntersectionObserver {
  static readonly instances = new Set<FakeIntersectionObserver>();
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds: readonly number[] = [0];
  readonly targets = new Set<Element>();
  readonly #callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
    FakeIntersectionObserver.instances.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  deliver(target: Element, isIntersecting: boolean): void {
    const entry = { target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 } as IntersectionObserverEntry;
    this.#callback([entry], this);
  }
}

/** Delivers `inlineSize` to every fake ResizeObserver observing `target`. */
export function resizeElement(target: Element, inlineSize: number): void {
  for (const observer of FakeResizeObserver.instances) {
    if (observer.targets.has(target)) observer.deliver(target, inlineSize);
  }
}

export function setIntersecting(target: Element, isIntersecting: boolean): void {
  for (const observer of FakeIntersectionObserver.instances) {
    if (observer.targets.has(target)) observer.deliver(target, isIntersecting);
  }
}

/** Sets document.visibilityState (and `hidden`) and dispatches visibilitychange, as a sleeping tablet would. */
export function setVisibility(visibility: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

export function installObserverFakes(): void {
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.IntersectionObserver = FakeIntersectionObserver;
}

export function resetObserverFakes(): void {
  FakeResizeObserver.instances.clear();
  FakeIntersectionObserver.instances.clear();
}
