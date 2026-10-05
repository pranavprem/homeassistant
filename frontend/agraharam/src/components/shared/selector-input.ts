/** Builds the SelectorInput (§4.8) a section or drawer passes to its pure selectors from its DashboardServices. */
import type { SelectorInput } from '../../model/types.ts';
import type { DashboardServices } from '../services.ts';

export function selectorInput(services: DashboardServices): SelectorInput {
  return {
    config: services.config,
    store: services.store,
    reader: services.reader,
    gateway: services.gateway,
    now: new Date(),
  };
}
