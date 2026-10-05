/** Build identity injected by Vite `define` from build-env.ts (vite.config.ts and vitest.config.ts). */
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;

/** The subset of HA's card helpers used by the live camera view (§9.4); feature-detected at runtime. */
interface LovelaceCardHelpers {
  createCardElement(config: Readonly<Record<string, unknown>>): HTMLElement & { hass?: unknown };
}

/** One entry in HA's custom card picker list. */
interface CustomCardEntry {
  readonly type: string;
  readonly name: string;
  readonly description?: string;
  readonly preview?: boolean;
}

interface Window {
  loadCardHelpers?: () => Promise<LovelaceCardHelpers>;
  customCards?: CustomCardEntry[];
}
