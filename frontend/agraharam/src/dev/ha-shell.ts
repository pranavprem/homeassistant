/**
 * <dev-ha-shell> (§10.3): fake HA chrome around the card for `npm run dev`, `npm run preview` and e2e. Not in the
 * bundle. A 56 px toolbar and a sidebar that is 256 px expanded, 56 px collapsed and hidden below an 870 px viewport
 * (HA narrow), so the card sees the widths it sees inside HA. Query params (scenario, theme, sidebar, host) are the
 * only state; no storage APIs.
 *
 * Import boundary (§10.3): it never imports element source. The page entry defines the card (from source in dev,
 * from the built bundle in the harness) and the shell creates it by tag name.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
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
const SIDEBAR_ITEMS = ['Overview', 'Agraharam', 'Energy', 'Logbook', 'History', 'Settings'] as const;

class DevHaShell extends LitElement {
  static override styles = css`
    :host {
      /* HA-like body typography, so any style leaking into the card shows up in previews and screenshots. */
      display: block;
      font-family: Roboto, 'Noto Sans', system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.43;
      letter-spacing: 0.0178em;
      color: #212121;
      background: #fafafa;
    }
    .app {
      display: flex;
      min-block-size: 100dvh;
    }
    .sidebar {
      flex: none;
      inline-size: 256px;
      box-sizing: border-box;
      padding-block-start: 56px;
      border-inline-end: 1px solid #e0e0e0;
      background: #fff;
      overflow: hidden;
    }
    .app[data-sidebar='collapsed'] .sidebar {
      inline-size: 56px;
    }
    .app[data-narrow] .sidebar {
      display: none;
    }
    .app[data-narrow][data-menu-open] .sidebar {
      display: block;
      position: fixed;
      z-index: 2;
      inset-block: 0;
      inset-inline-start: 0;
    }
    .sidebar li {
      padding: 12px 16px;
      white-space: nowrap;
      list-style: none;
    }
    .sidebar ul {
      margin: 0;
      padding: 0;
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
      gap: 8px;
      block-size: 56px;
      padding: 0 12px;
      color: #fff;
      background: #03a9f4;
      overflow-x: auto;
      white-space: nowrap;
    }
    .toolbar .title {
      font-size: 18px;
      font-weight: 500;
      margin-inline-end: 8px;
    }
    .toolbar label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .toolbar button,
    .toolbar select {
      font: inherit;
      letter-spacing: normal;
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
      ?data-narrow=${this.narrow}
      ?data-menu-open=${this.menuOpen}
    >
      <nav class="sidebar" aria-label="Fake Home Assistant sidebar">
        <ul>
          ${SIDEBAR_ITEMS.map((item) => html`<li>${item}</li>`)}
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
      <span class="title">Agraharam preview (not Home Assistant)</span>
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
      ${this.pageErrors > 0 ? html`<span class="errors" role="status">${this.pageErrors} page errors</span>` : nothing}`;
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
