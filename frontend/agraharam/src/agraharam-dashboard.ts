/**
 * The card, custom:agraharam-dashboard (§2, §9.1): the composition root. It validates the config, owns the runtime
 * (HassHost or DemoHost) and the action gateway, publishes one memoized DashboardServices object to every section,
 * picks the column layout from its own measured width (D2), and routes overlay events to the overlay host.
 *
 * HA detaches and re-attaches the SAME element on every edit-mode toggle and after a hidden tab's panel is removed,
 * and re-sends setConfig after any dashboard save, so the lifecycle is explicit (§9.1 table). Every entry point HA
 * calls is wrapped so nothing escapes to HA's logging mixin (§4.9).
 */
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import './components/shell/agr-config-error.ts';
import './components/shell/agr-demo-ribbon.ts';
import './components/shell/agr-overlay-host.ts';
import type { AgrOverlayHost } from './components/shell/agr-overlay-host.ts';
import type { ConfirmDetail, OpenDrawerDetail } from './components/shell/overlay-types.ts';
import { PANEL_RESIZE_EVENT } from './components/primitives/agr-panel.ts';
import { memoizeServices, type DashboardServices } from './components/services.ts';
import type { CardConfigInput, DemoScenarioId, EntityId, ResolvedConfig } from './config/schema.ts';
import { validateConfig, type ConfigIssue } from './config/validate.ts';
import { demoCardInput } from './demo/configs.ts';
import { DemoHost } from './demo/demo-host.ts';
import { createGateway } from './ha/actions/gateway.ts';
import type { ActionGateway } from './ha/actions/types.ts';
import { HassHost } from './ha/hass-host.ts';
import { runtimeKey } from './ha/host.ts';
import type { HassLike } from './ha/types.ts';
import { CONTENT_BUDGET, panelHeightEstimates } from './model/budget.ts';
import { layoutFor, type LayoutMode } from './styles/breakpoints.ts';
import { ensureFonts } from './styles/fonts.ts';
import {
  capStretchedSlack,
  columnsFor,
  nextComfortTileBudget,
  emptySections,
  frameStyles,
  stretchedSections,
  visibleSections,
  type SectionId,
} from './styles/layout.ts';
import { tokenStyles } from './styles/tokens.ts';
import { defineOnce, recordedConflicts } from './util/define.ts';
import { deepActiveElement, findDeep, focusKeyOf } from './util/focus.ts';
import { contained, log } from './util/log.ts';
import { startMinuteTicker, type StopTicker } from './util/time.ts';
import { APP_VERSION } from './version.ts';

/** Masonry size in HA's 50 px rows; large, because the card is meant to fill a panel view (§14). */
const CARD_SIZE = 12;
/** A detached card keeps its runtime and gateway this long (edit-mode toggles, hidden tabs), then disposes them. */
export const ORPHAN_DISPOSE_MS = 60_000;
const NOT_A_MAPPING = 'Agraharam: card configuration must be a mapping.';
const DEMO_CONFIG_INVALID =
  'The built-in demo configuration did not validate. This is a dashboard bug; please report it.';

type Runtime = HassHost | DemoHost;
type Mode = 'live' | 'demo';

export class AgraharamDashboard extends LitElement {
  /** Read by e2e to prove the running element came from the built bundle (§11.3). */
  static readonly version = APP_VERSION;
  static override styles = [
    tokenStyles,
    frameStyles,
    css`
      .notice {
        margin: 0;
        font: var(--agr-type-meta);
        color: var(--agr-danger);
      }
    `,
  ];

  /** HA's card picker inserts this: demo mode is the safe first render. */
  static getStubConfig(): { readonly demo: true } {
    return { demo: true };
  }

  @state() private services: DashboardServices | undefined;
  @state() private issues: readonly ConfigIssue[] | undefined;
  @state() private mode: Mode | undefined;
  /** Undefined until the host has a measured width (D2): no sections are created in a guessed mode. */
  @state() private layoutMode: LayoutMode | undefined;
  /** Chooses the config-error detail level before any runtime exists (D4). */
  @state() private admin = false;
  /** Climate's tile budget, raised while its column has a tile row of spare height (§16.14). */
  @state() private comfortTiles: number = CONTENT_BUDGET.comfortTiles;

  #input: Readonly<Record<string, unknown>> | undefined;
  #config: ResolvedConfig | undefined;
  #scenario: DemoScenarioId = 'normal';
  #warnings: readonly ConfigIssue[] = [];
  #runtime: Runtime | undefined;
  #gateway: ActionGateway | undefined;
  #hass: HassLike | undefined;
  /**
   * Whether #hass arrived after the latest detach. HA assigns hass before it attaches a new card, so that hass is
   * current; one retained from before a detach may predate a reconnect, and the resync tracker must only ever
   * observe states HA just delivered (§4.4), so a live runtime is then rebuilt by the next hass instead.
   */
  #hassSinceDetach = false;
  #darkMode = false;
  #preview = false;
  #resizeObserver: ResizeObserver | undefined;
  #layoutFrame: number | undefined;
  /** The pending re-measure of the stretched panels' slack allowance (§16.14). */
  #slackFrame: number | undefined;
  /** The pending focus restore after a layout change re-created the sections (§5.1). */
  #focusFrame: number | undefined;
  /** The theme last written to the host attribute, so an unchanged theme never touches the DOM. */
  #theme: DashboardServices['theme'] | undefined;
  #measuredWidth = 0;
  #stopTicker: StopTicker | undefined;
  #orphanTimer: ReturnType<typeof setTimeout> | undefined;

  /** Throws only when the config is not a mapping; every other issue renders inside the card (D4). */
  setConfig(config: unknown): void {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error(NOT_A_MAPPING);
    try {
      this.#acceptConfig(config as Readonly<Record<string, unknown>>);
    } catch {
      log.error('set-config-failed');
    }
  }

  /** A plain accessor, not a reactive property: a hass update never re-renders the root (§2.2). */
  set hass(hass: HassLike | undefined) {
    try {
      this.#receiveHass(hass);
    } catch {
      log.error('hass-update-failed');
    }
  }

  /** True while HA's dashboard editor shows the card; controls are disabled then (§2.4). */
  get preview(): boolean {
    return this.#preview;
  }

  set preview(value: boolean) {
    try {
      const next = value === true;
      if (next === this.#preview) return;
      this.#preview = next;
      // Moves the gateway epoch, so open confirm dialogs and pending drafts are discarded as "Not sent".
      if (next) this.#gateway?.invalidate('preview');
      this.#publish();
    } catch {
      log.error('preview-failed');
    }
  }

  getCardSize(): number {
    return CARD_SIZE;
  }

  getGridOptions(): { readonly columns: 'full' } {
    return { columns: 'full' };
  }

  /** Dev-shell hook for the 'loading' scenario's "Deliver first update"; a no-op outside demo mode. */
  releaseDemoFirstIngest(): void {
    if (this.#runtime instanceof DemoHost) this.#runtime.releaseFirstIngest();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    try {
      clearTimeout(this.#orphanTimer);
      this.#orphanTimer = undefined;
      ensureFonts();
      this.#measureInitialLayout();
      this.#ensureRuntime();
      this.#publish();
      this.#startObservingWidth();
      this.#stopTicker = startMinuteTicker(() => this.#runtime?.tick());
      this.#runtime?.tick();
    } catch {
      log.error('card-connect-failed');
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    try {
      this.#resizeObserver?.disconnect();
      this.#cancelFrames();
      this.#stopTicker?.();
      this.#stopTicker = undefined;
      this.#hassSinceDetach = false;
      this.#overlayHost()?.closeAll();
      this.#orphanTimer = setTimeout(
        contained('orphan-dispose-failed', () => this.#disposeOrphan()),
        ORPHAN_DISPOSE_MS,
      );
    } catch {
      log.error('card-disconnect-failed');
    }
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    const root = super.createRenderRoot();
    // Sections and drawers dispatch overlay requests composed; the overlay host is a sibling of the columns, so the
    // root catches them here, stops them, and calls the host.
    root.addEventListener('agr-open-drawer', this.#onOpenDrawer as EventListener);
    root.addEventListener('agr-request-confirm', this.#onRequestConfirm as EventListener);
    // A panel's content changed size, so a stretched one may take a different share of its column (§16.14).
    root.addEventListener(PANEL_RESIZE_EVENT, this.#onPanelResize);
    return root;
  }

  /** The columns may have been re-created or re-stretched, so the slack allowance is measured again. */
  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    this.#scheduleSlackCap();
  }

  protected override render(): TemplateResult | typeof nothing {
    if (this.issues !== undefined) {
      return html`<agr-config-error .issues=${this.issues} ?detailed=${this.admin}></agr-config-error>`;
    }
    if (this.mode === undefined) return nothing;
    const services = this.services;
    // data-focus-fallback is FOCUS_FALLBACK_ATTRIBUTE: the overlay host's last focus target (§5.4 rule 7).
    return html`<div class="frame" data-layout=${this.layoutMode ?? nothing} tabindex="-1" data-focus-fallback>
        ${this.mode === 'demo' ? html`<agr-demo-ribbon></agr-demo-ribbon>` : nothing} ${this.#renderVersionNotice()}
        <agr-header .services=${services}></agr-header>
        <agr-alert-banner .services=${services}></agr-alert-banner>
        ${this.#renderColumns(services)}
      </div>
      <agr-overlay-host .services=${services}></agr-overlay-host>`;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Configuration (§9.1 rows 1–3, §4.2 rule 9)

  #acceptConfig(input: Readonly<Record<string, unknown>>): void {
    // HA re-sends identical configs after unrelated dashboard saves; those must not close an open drawer.
    if (this.#input !== undefined && sameConfig(this.#input, input)) return;
    this.#input = cloneConfig(input);
    this.#overlayHost()?.closeAll();
    const result = validateConfig(input);
    if (!result.ok) {
      this.#showIssues(result.issues);
      return;
    }
    const mode: Mode = result.config.demo ? 'demo' : 'live';
    const runtimeResult = mode === 'demo' ? validateConfig(demoRuntimeInput(result.config)) : result;
    if (!runtimeResult.ok) {
      this.#showIssues([{ path: '', code: 'demo-config-invalid', message: DEMO_CONFIG_INVALID }]);
      return;
    }
    this.issues = undefined;
    this.mode = mode;
    this.#scenario = result.config.demoScenario;
    this.#config = runtimeResult.config;
    this.#warnings = result.warnings;
    const sameRuntime = this.#runtime !== undefined && this.#runtime.key === this.#runtimeKey(runtimeResult.config);
    if (sameRuntime) {
      // Role assignments (which script is disarm_hold) can change without changing the bound set.
      this.#replaceGateway();
    } else {
      this.#disposeRuntime();
      this.#ensureRuntime();
    }
    this.#publish();
  }

  #showIssues(issues: readonly ConfigIssue[]): void {
    this.#disposeRuntime();
    this.#config = undefined;
    this.mode = undefined;
    this.issues = issues;
    this.services = undefined;
  }

  #runtimeKey(config: ResolvedConfig): string {
    const bound = config.bindings.keys();
    return this.mode === 'demo' ? runtimeKey('demo', this.#scenario, bound) : runtimeKey('hass', undefined, bound);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Runtime and gateway (§9.1)

  #receiveHass(hass: HassLike | undefined): void {
    this.#hass = hass;
    this.#hassSinceDetach = hass !== undefined;
    this.admin = hass?.user?.is_admin === true;
    if (this.mode === 'demo') {
      // §10.1: in demo mode the real hass is read for the theme only.
      const darkMode = hass?.themes?.darkMode === true;
      if (darkMode !== this.#darkMode) {
        this.#darkMode = darkMode;
        this.#publish();
      }
      return;
    }
    if (hass === undefined || this.mode !== 'live') return;
    if (this.#runtime instanceof HassHost) this.#runtime.update(hass);
    else this.#ensureRuntime();
    this.#publish();
  }

  /** §16.10 runtime hygiene: runtimes are built only while attached; a live runtime starts from a current hass. */
  #ensureRuntime(): void {
    const config = this.#config;
    if (!this.isConnected || config === undefined || this.#runtime !== undefined) return;
    if (this.mode === 'demo') {
      this.#runtime = new DemoHost(this.#scenario);
    } else {
      const hass = this.#hass;
      if (hass === undefined || !this.#hassSinceDetach) return;
      const host = new HassHost(config.bindings.keys(), { vacuums: vacuumsWithoutBattery(config) });
      host.update(hass);
      this.#runtime = host;
    }
    this.#reportVersionConflicts(this.#runtime);
    this.#replaceGateway();
  }

  #replaceGateway(): void {
    this.#gateway?.dispose();
    this.#gateway = undefined;
    const runtime = this.#runtime;
    const config = this.#config;
    if (runtime === undefined || config === undefined) return;
    this.#gateway = createGateway({
      port: runtime.port,
      reader: runtime.reader,
      config,
      isPreview: () => this.#preview,
    });
  }

  /** Disposing the gateway settles its tickets as uncertain; the module-level in-flight registry keeps locks. */
  #disposeRuntime(): void {
    this.#gateway?.dispose();
    this.#gateway = undefined;
    this.#runtime?.dispose();
    this.#runtime = undefined;
  }

  /** §9.1: after ORPHAN_DISPOSE_MS detached, nothing page-lifetime may retain this card, its store or its states. */
  #disposeOrphan(): void {
    this.#orphanTimer = undefined;
    if (this.isConnected) return;
    this.#disposeRuntime();
    this.#hass = undefined;
    this.#hassSinceDetach = false;
    this.services = undefined;
  }

  #publish(): void {
    const runtime = this.#runtime;
    const gateway = this.#gateway;
    const config = this.#config;
    const mode = this.mode;
    if (runtime === undefined || gateway === undefined || config === undefined || mode === undefined) {
      this.services = undefined;
      return;
    }
    const theme = (mode === 'demo' ? this.#darkMode : runtime.reader.isDarkMode()) ? 'dark' : 'light';
    // Every hass update publishes; the attribute is written only when the theme actually changes.
    if (theme !== this.#theme) {
      this.#theme = theme;
      this.setAttribute('data-theme', theme);
    }
    this.services = memoizeServices(this.services, {
      config,
      reader: runtime.reader,
      store: runtime.reader.store,
      gateway,
      status: runtime.status,
      warnings: this.#warnings,
      mode,
      preview: this.#preview,
      theme,
    });
  }

  /** A stale second bundle never runs silently (§11.3): diagnostics reads this line. */
  #reportVersionConflicts(runtime: Runtime): void {
    const conflicts = recordedConflicts(AgraharamDashboard);
    if (conflicts.length > 0) runtime.status.set('bundle', `version-conflict ignored ${conflicts[0]?.loaded}`);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Layout (D2, §6.1, §6.2)

  /** The first render already uses the measured mode; a host that is not laid out yet waits for the observer. */
  #measureInitialLayout(): void {
    const width = this.getBoundingClientRect().width;
    if (width > 0) {
      this.#measuredWidth = width;
      this.layoutMode = layoutFor(width, this.layoutMode);
    }
  }

  #startObservingWidth(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.#resizeObserver ??= new ResizeObserver(
      contained('layout-observe-failed', (entries: ResizeObserverEntry[]) => this.#onResize(entries)),
    );
    this.#resizeObserver.observe(this);
  }

  /** Applied in the next animation frame, so a layout switch never resizes an observed box during delivery. */
  #onResize(entries: readonly ResizeObserverEntry[]): void {
    const entry = entries[entries.length - 1];
    if (entry === undefined) return;
    this.#measuredWidth = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    if (this.#layoutFrame !== undefined) return;
    this.#layoutFrame = requestAnimationFrame(
      contained('layout-apply-failed', () => {
        this.#layoutFrame = undefined;
        this.#applyMeasuredWidth();
      }),
    );
  }

  #applyMeasuredWidth(): void {
    if (this.#measuredWidth <= 0) return;
    const next = layoutFor(this.#measuredWidth, this.layoutMode);
    if (next === this.layoutMode) return;
    const focusKey = this.#focusKeyInColumns();
    this.layoutMode = next;
    if (focusKey !== undefined) this.#restoreFocusAfterRender(focusKey);
  }

  /** §5.1: a layout change re-creates the sections, so focus inside the columns is restored by data-focus-key. */
  #focusKeyInColumns(): string | undefined {
    const active = deepActiveElement();
    const columns = this.renderRoot.querySelector('.columns');
    if (active === null || columns === null || !composedContains(columns, active)) return undefined;
    return focusKeyOf(active);
  }

  /** §4.9 rule 2: the frame callback is contained like every other entry point, and a detach cancels it. */
  #restoreFocusAfterRender(focusKey: string): void {
    void this.updateComplete
      .then(() => {
        // A detach between the layout change and this render has already cancelled frames; schedule none after it.
        if (!this.isConnected) return;
        if (this.#focusFrame !== undefined) cancelAnimationFrame(this.#focusFrame);
        this.#focusFrame = requestAnimationFrame(
          contained('focus-restore-failed', () => {
            this.#focusFrame = undefined;
            const target = findDeep(
              this.renderRoot as ShadowRoot,
              (el) => el.getAttribute('data-focus-key') === focusKey,
            );
            if (target instanceof HTMLElement) target.focus();
          }),
        );
      })
      .catch(() => log.warn('focus-restore-failed'));
  }

  /**
   * Coalesces re-measures into the next frame, so a burst of panel resizes costs one layout read per section. The
   * same measurement decides whether Climate spends spare column height on a second row of tiles.
   */
  #scheduleSlackCap(): void {
    if (this.#slackFrame !== undefined || !this.isConnected) return;
    this.#slackFrame = requestAnimationFrame(
      contained('slack-cap-failed', () => {
        this.#slackFrame = undefined;
        const columns = capStretchedSlack(this.renderRoot);
        const config = this.services?.config ?? this.#config;
        if (config !== undefined) this.comfortTiles = nextComfortTileBudget(this.comfortTiles, config, columns);
      }),
    );
  }

  readonly #onPanelResize = contained('panel-resize-failed', (event: Event) => {
    event.stopPropagation();
    this.#scheduleSlackCap();
  });

  #cancelFrames(): void {
    for (const frame of [this.#layoutFrame, this.#slackFrame, this.#focusFrame]) {
      if (frame !== undefined) cancelAnimationFrame(frame);
    }
    this.#layoutFrame = undefined;
    this.#slackFrame = undefined;
    this.#focusFrame = undefined;
  }

  /**
   * The columns come from the accepted config, so before the first hass (or while a runtime is rebuilt) every panel
   * already stands in its place with its label and placeholder content, and the first real render only fills it in.
   * The runtime config equals the published services config, so the sections are the same elements afterwards and
   * nothing is created twice. Sections without services make no reads and no calls.
   */
  #renderColumns(services: DashboardServices | undefined): TemplateResult | typeof nothing {
    const config = services?.config ?? this.#config;
    if (config === undefined || this.layoutMode === undefined) return nothing;
    const columns = columnsFor(this.layoutMode, visibleSections(config), panelHeightEstimates(config));
    const stretched = stretchedSections(columns, emptySections(config));
    const layout: SectionLayout = { comfortTiles: this.comfortTiles };
    return html`<div class="columns" data-columns=${columns.length}>
      ${columns.map(
        (column) =>
          html`<div class="column">${column.map((id) => renderSection(id, services, stretched.has(id), layout))}</div>`,
      )}
    </div>`;
  }

  #renderVersionNotice(): TemplateResult | typeof nothing {
    const conflict = recordedConflicts(AgraharamDashboard)[0];
    if (!this.admin || conflict === undefined) return nothing;
    return html`<p class="notice">
      Agraharam ${conflict.loaded} was also loaded and ignored; ${conflict.running} is running. Remove the extra
      dashboard resource.
    </p>`;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Overlays (§5.1, §5.2)

  #overlayHost(): AgrOverlayHost | null {
    return this.renderRoot?.querySelector('agr-overlay-host') ?? null;
  }

  readonly #onOpenDrawer = contained('open-drawer-failed', (event: CustomEvent<OpenDrawerDetail>) => {
    event.stopPropagation();
    this.#overlayHost()?.open(event.detail);
  });

  readonly #onRequestConfirm = contained('request-confirm-failed', (event: CustomEvent<ConfirmDetail>) => {
    event.stopPropagation();
    this.#overlayHost()?.confirm(event.detail);
  });
}

/** What the column layout decides for a section's content, beyond its place: budgets raised by spare height. */
interface SectionLayout {
  readonly comfortTiles: number;
}

/** One template per section tag (Lit cannot bind tag names); `data-stretch` marks the column's stretching panel. */
function renderSection(
  id: SectionId,
  services: DashboardServices | undefined,
  stretch: boolean,
  layout: SectionLayout,
): TemplateResult {
  switch (id) {
    case 'today':
      return html`<agr-today .services=${services} ?data-stretch=${stretch}></agr-today>`;
    case 'comfort':
      return html`<agr-comfort
        .services=${services}
        .tileBudget=${layout.comfortTiles}
        ?data-stretch=${stretch}
      ></agr-comfort>`;
    case 'home':
      return html`<agr-home .services=${services} ?data-stretch=${stretch}></agr-home>`;
    case 'cameras':
      return html`<agr-cameras .services=${services} ?data-stretch=${stretch}></agr-cameras>`;
    case 'garage':
      return html`<agr-garage .services=${services} ?data-stretch=${stretch}></agr-garage>`;
    case 'media':
      return html`<agr-media .services=${services} ?data-stretch=${stretch}></agr-media>`;
    case 'health':
      return html`<agr-health .services=${services} ?data-stretch=${stretch}></agr-health>`;
    case 'upcoming':
      return html`<agr-upcoming .services=${services} ?data-stretch=${stretch}></agr-upcoming>`;
  }
}

/** §4.2 rule 9: the demo runtime config is the scenario's fixtures plus the user's own title and diagnostics flag. */
function demoRuntimeInput(user: ResolvedConfig): CardConfigInput {
  return { ...demoCardInput(user.demoScenario), title: user.title, diagnostics: user.diagnostics };
}

function vacuumsWithoutBattery(config: ResolvedConfig): EntityId[] {
  return config.vacuums.filter((vacuum) => vacuum.batterySensor === undefined).map((vacuum) => vacuum.entity);
}

function composedContains(container: Element, element: Element): boolean {
  for (let node: Node | null = element; node !== null;) {
    if (node === container) return true;
    const root = node.getRootNode();
    node = node.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

/** Lovelace configs are plain JSON-like data, so structural comparison is exact. */
function sameConfig(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) && sameConfig((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** A private copy, so a later mutation by HA cannot make the identical-config check lie. */
function cloneConfig(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return structuredClone(input) as Readonly<Record<string, unknown>>;
}

defineOnce('agraharam-dashboard', AgraharamDashboard);

declare global {
  interface HTMLElementTagNameMap {
    'agraharam-dashboard': AgraharamDashboard;
  }
}
