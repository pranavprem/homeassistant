/**
 * The single property every section receives (§5.1). The root publishes it through memoizeServices, so a
 * root render that changes nothing passes the same object and no section re-renders.
 */
import type { ResolvedConfig } from '../config/schema.ts';
import type { ConfigIssue } from '../config/validate.ts';
import type { ActionGateway } from '../ha/actions/types.ts';
import type { StoreView } from '../ha/entity-store.ts';
import type { HostReader } from '../ha/host.ts';
import type { StatusBoard } from '../ha/status-board.ts';

export interface DashboardServices {
  readonly config: ResolvedConfig; // the runtime config (the demo config in demo mode)
  readonly reader: HostReader;
  readonly store: StoreView; // read-only (§4.5)
  readonly gateway: ActionGateway;
  readonly status: StatusBoard; // runtime.status
  readonly warnings: readonly ConfigIssue[]; // ValidationResult warnings of the accepted input (diagnostics)
  readonly mode: 'live' | 'demo';
  readonly preview: boolean;
  readonly theme: 'light' | 'dark'; // reflected onto every dialog element by the overlay host (§5.4)
}

// reader, store and status all come from the runtime, so comparing them is comparing the runtime. The Record type
// makes a new DashboardServices field a compile error here until it takes part in the comparison.
const IDENTITY_FIELDS: Readonly<Record<keyof DashboardServices, true>> = {
  config: true,
  reader: true,
  store: true,
  gateway: true,
  status: true,
  warnings: true,
  mode: true,
  preview: true,
  theme: true,
};
const IDENTITY_FIELD_NAMES = Object.freeze(Object.keys(IDENTITY_FIELDS) as (keyof DashboardServices)[]);

/** Returns the previous object unless runtime, gateway, config, warnings, mode, preview or theme changed; frozen. */
export function memoizeServices(prev: DashboardServices | undefined, next: DashboardServices): DashboardServices {
  if (prev !== undefined && IDENTITY_FIELD_NAMES.every((field) => Object.is(prev[field], next[field]))) {
    return prev;
  }
  return Object.freeze({ ...next });
}
