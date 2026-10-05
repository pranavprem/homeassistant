/**
 * <dev-ha-shell> (§10.3): fake HA chrome around the card for `npm run dev`, `npm run preview` and e2e. Not in the
 * bundle. A 56 px toolbar and a sidebar that is 256 px expanded, 56 px collapsed and hidden below an 870 px viewport
 * (HA narrow), so the card sees the widths it sees inside HA. Query params (scenario, theme, sidebar, host) are the
 * only state; no storage APIs.
 *
 * Import boundary (§10.3): it never imports element source. The page entry defines the card (from source in dev,
 * from the built bundle in the harness) and the shell creates it by tag name.
 */
import { css, html, LitElement, nothing, svg, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import type { CardConfigInput, DemoScenarioId } from '../config/schema.ts';
import { CARD_TYPE, demoCardInput } from '../demo/configs.ts';
import { DEMO_SCENARIO_IDS } from '../demo/scenarios.ts';
import { SHELL_SNAPSHOT_DELAY_MS } from '../timing.ts';
import { FakeHass, type FakeHassCall } from './fake-hass.ts';

declare global {
  interface Window {
    __agrCalls?: FakeHassCall[];
    __agrPageErrors?: number;
  }
  interface HTMLElementTagNameMap {
    'dev-ha-shell': DevHaShell;
  }
}

/** The card's public surface as HA uses it; typed locally so the shell never imports element source. */
interface CardElement extends HTMLElement {
  setConfig(config: unknown): void;
  hass: unknown;
  preview: boolean;
  releaseDemoFirstIngest(): void;
}

type HostMode = 'demo' | 'fake-hass';
type Theme = 'light' | 'dark';
type Sidebar = 'expanded' | 'collapsed';

const CARD_TAG = 'agraharam-dashboard';
const HA_NARROW_QUERY = '(max-width: 869px)';
const ROUTE_CHANGE_GAP_MS = 1_000;
const EDIT_MODE_DURATION_MS = 1_000;
/** Lucide-style 24 px stroke glyphs, so the fake sidebar reads like HA's without importing the card's icon set. */
const SIDEBAR_ITEMS = [
  {
    label: 'Overview',
    glyph: svg`<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>`,
  },
  {
    label: 'Agraharam',
    glyph: svg`<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>`,
  },
  { label: 'Energy', glyph: svg`<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>` },
  { label: 'Logbook', glyph: svg`<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>` },
  { label: 'History', glyph: svg`<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>` },
  {
    label: 'Settings',
    glyph: svg`<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>`,
  },
] as const;
const ACTIVE_SIDEBAR_ITEM = 'Agraharam';

class DevHaShell extends LitElement {
  static override styles = css`
    :host {
      /* HA-like body typography, so any style leaking into the card shows up in previews and screenshots. */
      display: block;
      font-family: Roboto, 'Noto Sans', system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.43;
      letter-spacing: 0.0178em;
    }
    /* HA's default light and dark chrome colours, so the card is previewed against what surrounds it in HA. */
    .app {
      --shell-bg: #fafafa;
      --shell-text: #212121;
      --shell-muted: #727272;
      --side-bg: #fff;
      --side-line: #e0e0e0;
      --side-active-bg: rgb(3 169 244 / 0.12);
      --side-active-text: #0288d1;
      --bar-bg: #03a9f4;
      --bar-text: #fff;
      --control-bg: rgb(255 255 255 / 0.18);
      --control-hover: rgb(255 255 255 / 0.3);
      display: flex;
      min-block-size: 100dvh;
      color: var(--shell-text);
      background: var(--shell-bg);
    }
    .app[data-theme='dark'] {
      --shell-bg: #111;
      --shell-text: #e1e1e1;
      --shell-muted: #9b9b9b;
      --side-bg: #1c1c1c;
      --side-line: #2c2c2c;
      --side-active-bg: rgb(3 169 244 / 0.16);
      --side-active-text: #4fc3f7;
      --bar-bg: #101e24;
      --bar-text: #e1e1e1;
      --control-bg: rgb(255 255 255 / 0.1);
      --control-hover: rgb(255 255 255 / 0.18);
      color-scheme: dark;
    }
    .sidebar {
      flex: none;
      display: flex;
      flex-direction: column;
      inline-size: 256px;
      box-sizing: border-box;
      border-inline-end: 1px solid var(--side-line);
      background: var(--side-bg);
      overflow: hidden;
    }
    .app[data-sidebar='collapsed'] .sidebar {
      inline-size: 56px;
    }
    .app[data-narrow] .sidebar {
      display: none;
    }
    .app[data-narrow][data-menu-open] .sidebar {
      display: flex;
      position: fixed;
      z-index: 2;
      inset-block: 0;
      inset-inline-start: 0;
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.24);
    }
    .sidebar-header {
      flex: none;
      display: flex;
      align-items: center;
      gap: 16px;
      box-sizing: border-box;
      block-size: 56px;
      padding-inline: 16px;
      border-block-end: 1px solid var(--side-line);
      font-size: 20px;
      white-space: nowrap;
    }
    .brand {
      flex: none;
      display: grid;
      place-items: center;
      inline-size: 24px;
      block-size: 24px;
      border-radius: 6px;
      background: #03a9f4;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .sidebar ul {
      margin: 0;
      padding: 4px 0;
      list-style: none;
    }
    .sidebar li {
      display: flex;
      align-items: center;
      gap: 24px;
      block-size: 40px;
      margin: 4px 8px;
      padding-inline: 8px;
      border-radius: 4px;
      font-weight: 500;
      white-space: nowrap;
    }
    .sidebar li[aria-current='page'] {
      background: var(--side-active-bg);
      color: var(--side-active-text);
    }
    .sidebar svg {
      flex: none;
      inline-size: 24px;
      block-size: 24px;
      color: var(--shell-muted);
    }
    .sidebar li[aria-current='page'] svg {
      color: inherit;
    }
    .app[data-sidebar='collapsed']:not([data-narrow]) .label {
      display: none;
    }
    .content {
      flex: 1 1 auto;
      min-inline-size: 0;
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 6px;
      block-size: 56px;
      padding: 0 12px;
      color: var(--bar-text);
      background: var(--bar-bg);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
    }
    /* Dev controls scroll on their own when the bar is narrow; the fade shows there is more to the right. */
    .controls {
      flex: 1 1 auto;
      min-inline-size: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding-inline-end: 24px;
      overflow-x: auto;
      scrollbar-width: none;
      mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
    }
    .controls::-webkit-scrollbar {
      display: none;
    }
    .toolbar .title {
      flex: 0 1 auto;
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 18px;
      margin-inline-end: 4px;
    }
    /* At HA-narrow widths the dev chrome must never widen the page, or it fakes a horizontal-scroll failure. */
    .app[data-narrow] .toolbar .tag {
      display: none;
    }
    .toolbar .tag {
      flex: none;
      margin-inline-end: 8px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--control-bg);
      font-size: 11px;
    }
    .toolbar label {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .toolbar button,
    .toolbar select {
      font: inherit;
      letter-spacing: normal;
      color: inherit;
      border: 0;
      border-radius: 999px;
      padding: 6px 12px;
      background: var(--control-bg);
      cursor: pointer;
      flex: none;
    }
    .toolbar button:hover:not(:disabled),
    .toolbar select:hover {
      background: var(--control-hover);
    }
    .toolbar button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .toolbar button:focus-visible,
    .toolbar select:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }
    .toolbar option {
      color: var(--shell-text);
      background: var(--side-bg);
    }
    .errors {
      padding: 2px 8px;
      border-radius: 10px;
      background: #b71c1c;
      font-weight: 700;
    }
    .view {
      box-sizing: border-box;
      block-size: calc(100dvh - 56px);
      overflow: auto;
    }
    .edit-mode {
      outline: 2px dashed #03a9f4;
    }
  `;

  @state() private scenario: DemoScenarioId = 'normal';
  @state() private theme: Theme = 'light';
  @state() private sidebar: Sidebar = 'expanded';
  @state() private host: HostMode = 'demo';
  @state() private narrow = false;
  @state() private menuOpen = false;
  @state() private busy = false;
  @state() private connected = true;
  @state() private firstUpdateHeld = false;
  @state() private pageErrors = 0;

  readonly #card = document.createElement(CARD_TAG) as CardElement;
  readonly #narrowQuery = window.matchMedia(HA_NARROW_QUERY);
  #fake: FakeHass | undefined;
  #unsubscribePush: (() => void) | undefined;
  /** False while the panel is "removed": HA does not push hass to a detached panel. */
  #delivering = true;

  override connectedCallback(): void {
    super.connectedCallback();
    this.#readQuery();
    this.narrow = this.#narrowQuery.matches;
    this.#narrowQuery.addEventListener('change', this.#onNarrowChange);
    window.addEventListener('error', this.#onPageError);
    window.addEventListener('unhandledrejection', this.#onPageError);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#narrowQuery.removeEventListener('change', this.#onNarrowChange);
    window.removeEventListener('error', this.#onPageError);
    window.removeEventListener('unhandledrejection', this.#onPageError);
    this.#disposeFake();
  }

  protected override firstUpdated(): void {
    this.#view().append(this.#card);
    this.#startScenario();
    this.#writeQuery();
  }

  protected override render(): TemplateResult {
    return html`<div
      class="app"
      data-sidebar=${this.sidebar}
      data-theme=${this.theme}
      ?data-narrow=${this.narrow}
      ?data-menu-open=${this.menuOpen}
    >
      <nav class="sidebar" aria-label="Fake Home Assistant sidebar">
        <div class="sidebar-header">
          <span class="brand" aria-hidden="true">HA</span><span class="label">Home Assistant</span>
        </div>
        <ul>
          ${SIDEBAR_ITEMS.map(
            (item) =>
              html`<li aria-current=${item.label === ACTIVE_SIDEBAR_ITEM ? 'page' : nothing} title=${item.label}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  ${item.glyph}
                </svg>
                <span class="label">${item.label}</span>
              </li>`,
          )}
        </ul>
      </nav>
      <div class="content">
        <header class="toolbar">${this.#renderToolbar()}</header>
        <main class="view"></main>
      </div>
    </div>`;
  }

  #renderToolbar(): TemplateResult {
    const fake = this.host === 'fake-hass';
    return html`${
        this.narrow
          ? html`<button @click=${() => (this.menuOpen = !this.menuOpen)} aria-label="Toggle sidebar">Menu</button>`
          : nothing
      }
      <span class="title">Agraharam preview</span>
      <span class="tag">not Home Assistant</span>
      <div class="controls">
        <label
          >Scenario
          <select @change=${this.#onScenarioChange}>
            ${DEMO_SCENARIO_IDS.map((id) => html`<option value=${id} ?selected=${id === this.scenario}>${id}</option>`)}
          </select></label
        >
        <button @click=${this.#toggleTheme}>Theme: ${this.theme}</button>
        <button ?disabled=${this.narrow} @click=${this.#toggleSidebar}>Sidebar: ${this.sidebar}</button>
        <label
          >Host
          <select @change=${this.#onHostChange}>
            <option value="demo" ?selected=${!fake}>demo</option>
            <option value="fake-hass" ?selected=${fake}>fake-hass</option>
          </select></label
        >
        ${
          fake
            ? html`<button ?disabled=${this.busy} @click=${this.#toggleConnection}>
                ${this.connected ? 'Disconnect' : 'Reconnect'}
              </button>`
            : nothing
        }
        ${this.firstUpdateHeld ? html`<button @click=${this.#deliverFirstUpdate}>Deliver first update</button>` : nothing}
        <button ?disabled=${this.busy} @click=${this.#routeChange}>Route change</button>
        <button ?disabled=${this.busy} @click=${this.#editModeToggle}>Edit-mode toggle</button>
        <button ?disabled=${this.busy} @click=${this.#hiddenFiveMinutes}>Hidden 5 min</button>
        ${
          fake
            ? html`<button ?disabled=${this.busy || this.connected} @click=${this.#outageChange}>Outage change</button>`
            : nothing
        }
        ${this.pageErrors > 0 ? html`<span class="errors" role="status">${this.pageErrors} page errors</span>` : nothing}
      </div>`;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Scenario and host

  #startScenario(): void {
    this.#disposeFake();
    const fake = new FakeHass(this.scenario, { darkMode: this.theme === 'dark' });
    this.#fake = fake;
    window.__agrCalls = fake.calls;
    this.connected = true;
    this.#delivering = true;
    this.#unsubscribePush = fake.onPush((hass) => {
      this.connected = fake.connection.connected;
      if (this.#delivering && !this.firstUpdateHeld) this.#card.hass = hass;
    });
    this.#card.setConfig(this.#cardConfig());
    const hold = fake.scenario.spec.holdFirstIngest;
    // demo: DemoHost holds its own first ingest; fake-hass: the shell holds the first hass push.
    this.firstUpdateHeld = hold;
    if (this.host === 'demo' || !hold) this.#card.hass = fake.hass;
    if (!hold) fake.applyScenarioConnection();
  }

  /** Diagnostics is on in the shell so its drawer can be previewed; it stays admin-only (`restricted` hides it). */
  #cardConfig(): CardConfigInput {
    return this.host === 'demo'
      ? { type: CARD_TYPE, demo: true, demo_scenario: this.scenario, diagnostics: true }
      : { ...demoCardInput(this.scenario), diagnostics: true };
  }

  #disposeFake(): void {
    this.#unsubscribePush?.();
    this.#unsubscribePush = undefined;
    this.#fake?.dispose();
    this.#fake = undefined;
  }

  #deliverFirstUpdate = (): void => {
    this.firstUpdateHeld = false;
    if (this.host === 'demo') this.#card.releaseDemoFirstIngest();
    else if (this.#fake) this.#card.hass = this.#fake.hass;
    this.#fake?.applyScenarioConnection();
  };

  #toggleConnection = (): void => {
    const fake = this.#fake;
    if (fake === undefined) return;
    if (fake.connection.connected) fake.disconnect();
    else fake.reconnect({ snapshotDelayMs: SHELL_SNAPSHOT_DELAY_MS });
  };

  #onScenarioChange = (event: Event): void => {
    this.scenario = (event.target as HTMLSelectElement).value as DemoScenarioId;
    this.#startScenario();
    this.#writeQuery();
  };

  #onHostChange = (event: Event): void => {
    this.host = (event.target as HTMLSelectElement).value as HostMode;
    this.#startScenario();
    this.#writeQuery();
  };

  #toggleTheme = (): void => {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    this.#fake?.setDarkMode(this.theme === 'dark');
    this.#writeQuery();
  };

  #toggleSidebar = (): void => {
    this.sidebar = this.sidebar === 'expanded' ? 'collapsed' : 'expanded';
    this.#writeQuery();
  };

  // -------------------------------------------------------------------------------------------------------------
  // Remount modes on the SAME element (§10.3)

  /** Remove, wait 1 s, re-append, as a real route change away and back does. */
  #routeChange = async (): Promise<void> => {
    await this.#whileBusy(async () => {
      this.#card.remove();
      await delay(ROUTE_CHANGE_GAP_MS);
      this.#view().append(this.#card);
    });
  };

  /** hui-card-options moves the card into a wrapper with preview on, then back with preview off. */
  #editModeToggle = async (): Promise<void> => {
    await this.#whileBusy(async () => {
      const wrapper = document.createElement('div');
      wrapper.className = 'edit-mode';
      this.#view().append(wrapper);
      wrapper.append(this.#card);
      this.#card.preview = true;
      await delay(EDIT_MODE_DURATION_MS);
      this.#view().append(this.#card);
      this.#card.preview = false;
      wrapper.remove();
    });
  };

  /**
   * The realistic hidden-tab order (§16.10): panel removed, one state change, socket dropped, element re-appended
   * before 'ready' (HA pushes the current hass to the re-added panel), then the two-step reconnect.
   */
  #hiddenFiveMinutes = async (): Promise<void> => {
    await this.#whileBusy(async () => {
      setDocumentVisibility('hidden');
      this.#delivering = false;
      this.#card.remove();
      const fake = this.#fake;
      if (this.host === 'fake-hass' && fake !== undefined) {
        const light = firstEntityOfDomain(fake, 'light');
        if (light !== undefined) fake.setState(light.entity_id, light.state === 'on' ? 'off' : 'on');
        fake.disconnect();
      }
      this.#view().append(this.#card);
      this.#delivering = true;
      if (fake !== undefined) this.#card.hass = fake.hass;
      if (this.host === 'fake-hass') fake?.reconnect({ snapshotDelayMs: SHELL_SNAPSHOT_DELAY_MS });
      setDocumentVisibility('visible');
    });
  };

  /**
   * While disconnected, a camera's privacy turns on (§10.3, §12.2); only the reconnect snapshot delivers it. Without
   * a privacy-bound camera that is not already private, a light flips instead.
   */
  #outageChange = (): void => {
    const fake = this.#fake;
    if (fake === undefined || fake.connection.connected) return;
    const privacy = privacyToTurnOn(fake);
    if (privacy !== undefined) {
      fake.queueOutageChange(privacy.entity, privacy.onValue);
      return;
    }
    const light = firstEntityOfDomain(fake, 'light');
    if (light !== undefined) fake.queueOutageChange(light.entity_id, light.state === 'on' ? 'off' : 'on');
  };

  async #whileBusy(run: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await run();
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Page state

  #onNarrowChange = (event: MediaQueryListEvent): void => {
    this.narrow = event.matches;
    if (!event.matches) this.menuOpen = false;
  };

  /** The page script counts first; this listener runs after it and shows the count. */
  #onPageError = (): void => {
    queueMicrotask(() => {
      this.pageErrors = window.__agrPageErrors ?? 0;
    });
  };

  #readQuery(): void {
    const params = new URLSearchParams(window.location.search);
    const scenario = params.get('scenario');
    if (scenario !== null && (DEMO_SCENARIO_IDS as readonly string[]).includes(scenario)) {
      this.scenario = scenario as DemoScenarioId;
    }
    if (params.get('theme') === 'dark') this.theme = 'dark';
    if (params.get('sidebar') === 'collapsed') this.sidebar = 'collapsed';
    if (params.get('host') === 'fake-hass') this.host = 'fake-hass';
  }

  #writeQuery(): void {
    const params = new URLSearchParams({
      scenario: this.scenario,
      theme: this.theme,
      sidebar: this.sidebar,
      host: this.host,
    });
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }

  #view(): HTMLElement {
    const view = this.renderRoot.querySelector<HTMLElement>('.view');
    if (view === null) throw new Error('dev-ha-shell rendered no view');
    return view;
  }
}

interface PrivacyBinding {
  readonly entity: string;
  readonly onValue: 'on' | 'off';
}

/**
 * The privacy binding "Outage change" turns on: the first camera that is visible (its privacy entity reads the exact
 * off value, honoring `privacy_on_value`), else the first whose privacy reads anything but its on value (unknown or
 * unexpected). A camera that is already private is never picked, since turning it on again would change nothing.
 */
function privacyToTurnOn(fake: FakeHass): PrivacyBinding | undefined {
  const bindings = (fake.scenario.input.cameras ?? []).flatMap((camera): PrivacyBinding[] =>
    camera.privacy_entity === undefined
      ? []
      : [{ entity: camera.privacy_entity, onValue: camera.privacy_on_value ?? 'on' }],
  );
  const stateOf = (binding: PrivacyBinding): string | undefined => fake.hass.states[binding.entity]?.state;
  const offValue = (binding: PrivacyBinding): string => (binding.onValue === 'on' ? 'off' : 'on');
  return (
    bindings.find((binding) => stateOf(binding) === offValue(binding)) ??
    bindings.find((binding) => stateOf(binding) !== binding.onValue)
  );
}

function firstEntityOfDomain(fake: FakeHass, domain: string): { entity_id: string; state: string } | undefined {
  return Object.values(fake.hass.states).find((entity) => entity.entity_id.startsWith(`${domain}.`));
}

/** Overrides the document's visibility for the hidden-tab remount and notifies listeners. */
function setDocumentVisibility(visibility: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (customElements.get('dev-ha-shell') === undefined) customElements.define('dev-ha-shell', DevHaShell);
