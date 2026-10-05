/**
 * DOM project setup (§12.1): per-test DOM isolation, controllable ResizeObserver and IntersectionObserver fakes,
 * page visibility reset to visible, and URL.createObjectURL / revokeObjectURL spies (camera stills are object URLs).
 * Fake timers are per test: a test opts in with vi.useFakeTimers(), and real timers are restored after every test,
 * so Lit's microtask updates work by default.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { installObserverFakes, resetObserverFakes, setVisibility } from './helpers/observers.ts';

const originalCreateObjectURL = URL.createObjectURL.bind(URL);
const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
let objectUrlCount = 0;

beforeEach(() => {
  installObserverFakes();
  URL.createObjectURL = vi.fn(() => {
    objectUrlCount += 1;
    return `blob:agr-test/${objectUrlCount}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  document.body.replaceChildren();
  resetObserverFakes();
  setVisibility('visible');
  vi.useRealTimers();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});
