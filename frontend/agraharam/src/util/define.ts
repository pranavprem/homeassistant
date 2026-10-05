/**
 * Custom element registration that tolerates the bundle being loaded twice (§11.3). A second resource URL with the
 * SAME version is a no-op; a DIFFERENT version is a conflict: it is logged and recorded, never redefined, so a
 * stale bundle cannot silently replace or shadow the running one.
 */
import { APP_VERSION } from '../version.ts';
import { log } from './log.ts';

interface VersionConflict {
  readonly tag: string;
  readonly running: string; // version of the constructor already registered for the tag
  readonly loaded: string; // version of this bundle, which was not registered
}

/**
 * Registered constructors carry their own conflict list. The bundle that detects a conflict is the one that did NOT
 * register, so its module state is invisible to the running card; appending to the running constructor's list is
 * how the running card learns about it (diagnostics and the admin-only notice).
 */
const CONFLICTS_PROPERTY = 'agrVersionConflicts';

type VersionedConstructor = CustomElementConstructor & {
  version?: unknown;
  [CONFLICTS_PROPERTY]?: unknown;
};

const UNKNOWN_VERSION = 'unknown';

export function defineOnce(tag: string, ctor: CustomElementConstructor): void {
  const existing: VersionedConstructor | undefined = customElements.get(tag);
  if (existing === undefined) {
    stampVersion(ctor);
    customElements.define(tag, ctor);
    return;
  }
  const running = typeof existing.version === 'string' ? existing.version : UNKNOWN_VERSION;
  if (running === APP_VERSION) return;
  const conflict: VersionConflict = Object.freeze({ tag, running, loaded: APP_VERSION });
  const runningList = existing[CONFLICTS_PROPERTY];
  if (Array.isArray(runningList)) runningList.push(conflict);
  log.warn('version-conflict', tag, running, APP_VERSION);
}

/** Conflicts other bundles reported against `ctor` after it was registered by this bundle. */
export function recordedConflicts(ctor: CustomElementConstructor): readonly VersionConflict[] {
  const list = (ctor as VersionedConstructor)[CONFLICTS_PROPERTY];
  return Array.isArray(list) ? [...(list as VersionConflict[])] : [];
}

// The card class declares `static readonly version`; every other element constructor gets it here, so a later
// bundle can compare versions for any tag.
function stampVersion(ctor: VersionedConstructor): void {
  if (!Object.hasOwn(ctor, 'version')) Object.defineProperty(ctor, 'version', { value: APP_VERSION });
  if (!Object.hasOwn(ctor, CONFLICTS_PROPERTY)) Object.defineProperty(ctor, CONFLICTS_PROPERTY, { value: [] });
}
