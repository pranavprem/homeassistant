/**
 * Sky drawer (AIRSPACE.md §6): one stacked column whose DOM order is the reading order.
 *
 *   1. Banner: while not live, the fixed state sentence (AIRSPACE.md §4; the only role="status" sentence) and,
 *      separately and outside any live region, the age of the last update.
 *   2. Radar (agr-sky-radar) while the data is drawable: a pointer on a mark expands that aircraft in Nearby (a mark is
 *      a live position, never a past pass) and scrolls its row into view without moving focus.
 *   3. "Show" choices: Nearby, Overhead, Recent, each with its count.
 *   4. Search ("Find aircraft", from SEARCH_MIN_ROWS rows and kept while it holds text, Escape clears it first) and
 *      the Sort choices.
 *   5. The list: one disclosure button per aircraft (keyed by its ICAO hex), its detail immediately after it. One row
 *      is expanded at a time; an expanded aircraft that leaves the view collapses silently.
 *   6. Conditions (with weather configured): cloud cover, visibility and wind.
 *   7. Footnotes (entries not shown, the Recent note) and Sources (two constant links and the payload attribution).
 *
 * Focus: if the focused control disappears after an update, focus moves to the same control if it is still there
 * (a row that only moved), else from a row to the next row or the previous one, else to the drawer heading. That
 * covers a Show or Sort choice or the search field unmounting when the sensor turns unavailable, and the whole list
 * going at the drawable cutoff: focus never falls out of the dialog onto the page.
 *
 * Read-only by construction: no gateway, no action controller, no more-info, no service calls. Views, sort, search
 * and the expanded row are local view state, reset when the drawer closes. Outbound anchors are only the model's
 * constant source links and its validated aircraft link (live Home Assistant only, never in demo), each opened in a
 * new tab without a referrer on a deliberate click.
 */
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import type { EntityId } from '../../config/schema.ts';
import { ENABLED } from '../../ha/actions/types.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { aircraftLink, SKY_SOURCES, type SkyState } from '../../model/airspace.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';
import {
  airspaceEntityIds,
  createSkySelector,
  defaultSkySort,
  SKY_FILTER_MAX_CHARS,
  SKY_LABELS,
  SKY_SORT_LABELS,
  SKY_VIEW_LABELS,
  type AircraftVM,
  type SkyDrawerUi,
  type SkyDrawerVM,
  type SkySort,
  type SkyView,
} from '../../model/sky.ts';
import type { ChoiceOptionVM } from '../../model/types.ts';
import { selectSkyConditions, type WeatherDetailVM } from '../../model/weather-details.ts';
import { focusRingStyles, numStyles, skeletonStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { composedParent, deepActiveElement, findDeep } from '../../util/focus.ts';
import { contained, log } from '../../util/log.ts';
import { drawerContentStyles } from '../header/drawer-content.ts';
import '../primitives/agr-choice-group.ts';
import type { ChooseDetail } from '../primitives/agr-choice-group.ts';
import '../primitives/agr-drawer.ts';
import type { AgrDrawer } from '../primitives/agr-drawer.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import { selectorInput } from '../shared/selector-input.ts';
import './agr-sky-radar.ts';
import type { SkyMarkDetail } from './agr-sky-radar.ts';
import { SkyClock } from './sky-clock.ts';
import { skyDrawerStyles } from './sky-drawer-styles.ts';
import { aircraftCardStyles, renderAircraftHead, renderAircraftMeta } from './aircraft-card.ts';

type AgrSkyDrawerRequest = Extract<DrawerRequest, { id: 'sky' }>;

/** 'connection' for the offline layer; 'locale' for the formatter's number format and length unit. */
const SKY_DRAWER_META: readonly MetaKind[] = Object.freeze(['connection', 'locale']);
const NO_IDS: readonly EntityId[] = Object.freeze([]);
const BANNER_ICON_PX = 18;
const CHEVRON_PX = 18;
const LINK_ICON_PX = 14;
const ANCHOR_REL = 'noopener noreferrer external';
/** Shown in the detail when the row is labelled by its callsign or hex and a registration is also reported. */
const REGISTRATION_CAPTION = 'Registration';

/**
 * Focus inside the drawer recorded before an update: the focused control's focus key and, when it sat in an aircraft
 * row (the row button or its detail link), that row's key and the row order it was focused in.
 */
interface FocusedControl {
  readonly focusKey: string | undefined;
  readonly row: string | undefined;
  readonly order: readonly string[];
}

let drawerCount = 0;

export class AgrSkyDrawer extends LitElement implements DrawerElement<AgrSkyDrawerRequest> {
  static override styles = [
    focusRingStyles,
    visuallyHiddenStyles,
    skeletonStyles,
    numStyles,
    drawerContentStyles,
    aircraftCardStyles,
    skyDrawerStyles,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrSkyDrawerRequest;

  @state() private view: SkyView = 'nearby';
  /** The sort the user chose; undefined follows the view's default (Latest in Recent, else Distance). */
  @state() private sort: SkySort | undefined;
  /** The search text as typed; the selector trims and caps it. Empty when not searching. */
  @state() private filter = '';
  @state() private expanded: string | undefined;

  readonly #select = createSkySelector();
  readonly #idPrefix = `agr-sky-${(drawerCount += 1)}`;
  #requestApplied = false;
  #state: SkyState | undefined;
  #vm: SkyDrawerVM | undefined;
  #failed = false;
  #focused: FocusedControl | undefined;
  /** A row to scroll into view after the next render (a radar mark was chosen). */
  #scrollTo: string | undefined;
  /** A radar mark's aircraft shown in Nearby by the next render, past a search that would hide it. */
  #reveal: string | undefined;
  /** Set for the one Escape that cleared the search, so the dialog close request it may still raise is refused. */
  #escapeClearedSearch = false;
  #escapeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => this.#boundIds(),
      SKY_DRAWER_META,
    );
    new SkyClock(this, () => this.services?.config?.airspace !== undefined);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.#escapeTimer);
    this.#escapeClearedSearch = false;
  }

  /** The view model is built once per update, before render, so render and focus recovery see the same rows. */
  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (!this.#requestApplied && this.request !== undefined) {
      this.#requestApplied = true;
      this.expanded = this.request.select;
    }
    this.#focused = this.#focusedControl();
    this.#vm = this.#viewModel();
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    this.#recoverFocus();
    this.#scrollChosenRow();
  }

  protected override render(): TemplateResult {
    return html`<agr-drawer
      heading=${SKY_LABELS.heading}
      .demo=${this.services?.mode === 'demo'}
      .theme=${this.services?.theme ?? 'light'}
      @agr-drawer-cancel=${this.#onDrawerCancel}
    >
      ${this.#renderBody()}
    </agr-drawer>`;
  }

  #boundIds(): readonly EntityId[] {
    const config = this.services?.config;
    if (config === undefined) return NO_IDS;
    return config.weather === undefined ? airspaceEntityIds(config) : [...airspaceEntityIds(config), config.weather];
  }

  #ui(): SkyDrawerUi {
    const ui = { view: this.view, sort: this.sort ?? defaultSkySort(this.view), filter: this.filter };
    return this.expanded === undefined ? ui : { ...ui, expanded: this.expanded };
  }

  /**
   * The drawer VM for this render. Typed search text is never dropped by an update: the field stays while it holds
   * text (#renderControls), so no filter is ever hidden. A radar mark being revealed clears only a search that would
   * still hide its row; an expanded aircraft no longer listed collapses silently.
   */
  #viewModel(): SkyDrawerVM | undefined {
    const services = this.services;
    this.#failed = false;
    const reveal = this.#reveal;
    this.#reveal = undefined;
    if (services?.store === undefined || services.reader === undefined) return undefined;
    try {
      const input = selectorInput(services);
      const sky = this.#select.state(input);
      this.#state = sky;
      let vm = this.#select.drawer(input, sky, this.#ui());
      if (reveal !== undefined && this.filter !== '' && !vm.rows.some((row) => row.key === reveal)) {
        this.filter = '';
        vm = this.#select.drawer(input, sky, this.#ui());
      }
      if (this.expanded !== undefined && vm.expanded === undefined) {
        this.expanded = undefined;
        vm = this.#select.drawer(input, sky, this.#ui());
      }
      return vm;
    } catch {
      log.error('sky-drawer-select-failed');
      this.#failed = true;
      return undefined;
    }
  }

  #renderBody(): TemplateResult {
    const vm = this.#vm;
    if (vm === undefined) {
      return this.#failed
        ? html`<p class="note">${SKY_LABELS.failed}</p>`
        : html`<span class="skeleton" aria-hidden="true"></span>`;
    }
    const drawable = this.#state?.drawable === true;
    return html`${this.#renderBanner(vm)}
    ${drawable ? html`${this.#renderRadar(vm)} ${this.#renderControls(vm)} ${this.#renderList(vm)}` : nothing}
    ${this.#renderConditions()} ${drawable ? renderFootnotes(vm) : nothing}
    ${renderSources(vm, `${this.#idPrefix}-sources`)}`;
  }

  /**
   * The status sentence lives in a status region that is always present (empty while live), so a change between
   * states is announced; the age is a separate plain line, so a minute passing is never announced.
   */
  #renderBanner(vm: SkyDrawerVM): TemplateResult {
    const freshness = vm.freshness;
    const sentence = freshness.live ? undefined : freshness.sentence;
    return html`<div class="banner" data-status=${freshness.status} ?data-notice=${sentence !== undefined}>
      ${
        sentence === undefined
          ? nothing
          : html`<span class="notice-glyph" aria-hidden="true">${renderIcon(bannerIcon(vm), BANNER_ICON_PX)}</span>`
      }
      <div class="banner-text">
        <p class="sentence" role="status">${sentence ?? ''}</p>
        ${freshness.ageText === undefined ? nothing : html`<p class="age">${freshness.ageText}</p>`}
      </div>
    </div>`;
  }

  /** Shown with nearby aircraft to place, or in Nearby and Overhead even when the sky is quiet. */
  #renderRadar(vm: SkyDrawerVM): TemplateResult | typeof nothing {
    const radar = vm.radar;
    if (radar === undefined || (radar.marks.length === 0 && vm.view === 'recent')) return nothing;
    const caption = [vm.radiusText, vm.overheadText].filter((part) => part !== undefined).join(' · ');
    return html`<figure class="radar-block">
      <agr-sky-radar .vm=${radar} @agr-sky-mark=${this.#onMark}></agr-sky-radar>
      ${caption === '' ? nothing : html`<figcaption class="radar-caption">${caption}</figcaption>`}
    </figure>`;
  }

  #renderControls(vm: SkyDrawerVM): TemplateResult {
    const views: ChoiceOptionVM[] = vm.views.map((option) => ({
      value: option.id,
      label: option.count === undefined ? option.label : `${option.label} ${option.count}`,
      pressed: option.id === vm.view,
      availability: ENABLED,
    }));
    const sorts: ChoiceOptionVM[] = vm.sorts.map((sort) => ({
      value: sort,
      label: SKY_SORT_LABELS[sort],
      pressed: sort === vm.sort,
      availability: ENABLED,
    }));
    return html`<div class="controls">
      <div class="control">
        <span class="control-label" aria-hidden="true">${SKY_LABELS.show}</span>
        <agr-choice-group
          label=${SKY_LABELS.show}
          focus-key-prefix="sky:view"
          .options=${views}
          @agr-choose=${this.#onView}
        ></agr-choice-group>
      </div>
      ${
        // Kept while it holds typed text, so a live count dipping below SEARCH_MIN_ROWS never hides or wipes a search.
        vm.searchable || this.filter !== '' ? this.#renderSearch(vm) : nothing
      }
      <div class="control">
        <span class="control-label" aria-hidden="true">${SKY_LABELS.sort}</span>
        <agr-choice-group
          label=${SKY_LABELS.sort}
          focus-key-prefix="sky:sort"
          .options=${sorts}
          @agr-choose=${this.#onSort}
        ></agr-choice-group>
      </div>
    </div>`;
  }

  #renderSearch(vm: SkyDrawerVM): TemplateResult {
    const inputId = `${this.#idPrefix}-search`;
    const matches = vm.rows.length;
    const status =
      this.filter.trim() === ''
        ? ''
        : matches === 0
          ? 'No aircraft match'
          : `${matches} ${matches === 1 ? 'aircraft matches' : 'aircraft match'}`;
    return html`<div class="search">
      <label for=${inputId}>${SKY_LABELS.search}</label>
      <input
        id=${inputId}
        type="search"
        maxlength=${SKY_FILTER_MAX_CHARS}
        autocomplete="off"
        spellcheck="false"
        enterkeyhint="search"
        data-focus-key="sky:search"
        .value=${this.filter}
        @input=${this.#onSearchInput}
        @keydown=${this.#onSearchKeydown}
      />
      <p class="matches" role="status">${status}</p>
    </div>`;
  }

  #renderList(vm: SkyDrawerVM): TemplateResult {
    if (vm.rows.length === 0) return html`<p class="empty">${vm.emptyText ?? ''}</p>`;
    const live = vm.freshness.live;
    return html`<ul class="aircraft-list" aria-label=${`${SKY_VIEW_LABELS[vm.view]} aircraft`}>
      ${repeat(
        vm.rows,
        (row) => row.key,
        (row) => this.#renderRow(row, vm, live),
      )}
    </ul>`;
  }

  /** A disclosure row: the button names the aircraft in full; its detail renders right after it. */
  #renderRow(row: AircraftVM, vm: SkyDrawerVM, live: boolean): TemplateResult {
    const expanded = vm.expanded === row.key;
    const detailId = `${this.#idPrefix}-detail-${row.key}`;
    return html`<li class="aircraft" data-key=${row.key}>
      <button
        type="button"
        class="aircraft-row aircraft-card"
        aria-expanded=${expanded ? 'true' : 'false'}
        aria-controls=${detailId}
        aria-label=${row.accessibleName}
        data-focus-key=${rowFocusKey(row.key)}
        ?data-overhead=${row.overhead}
        ?data-muted=${!live}
        @click=${() => this.#onToggle(row.key)}
        @keydown=${suppressKeyRepeat}
      >
        ${renderAircraftHead(row)} ${renderAircraftMeta(row)}
        <span class="chevron" aria-hidden="true">${renderIcon('chevron-down', CHEVRON_PX)}</span>
      </button>
      <div id=${detailId} class="detail" ?hidden=${!expanded}>
        ${expanded ? this.#renderDetail(row, vm, live) : nothing}
      </div>
    </li>`;
  }

  #renderDetail(row: AircraftVM, vm: SkyDrawerVM, live: boolean): TemplateResult {
    const notes = [live ? undefined : SKY_LABELS.lastKnown, vm.view === 'recent' ? SKY_LABELS.recentPass : undefined]
      .filter((note) => note !== undefined)
      .join(' · ');
    const link = this.#aircraftLink(row);
    return html`${notes === '' ? nothing : html`<p class="detail-note">${notes}</p>`}
      <dl class="facts">${renderFacts(row)}</dl>
      ${row.route === undefined ? nothing : renderRoute(row.route)}
      <p class="seen">${row.closest === undefined ? row.seen : `${row.closest} · ${row.seen}`}</p>
      ${
        link === undefined
          ? nothing
          : html`<a
              class="external"
              href=${link}
              target="_blank"
              rel=${ANCHOR_REL}
              referrerpolicy="no-referrer"
              data-focus-key=${`sky:link:${row.key}`}
              ><span>${SKY_LABELS.aircraftLink}</span>${renderIcon('external-link', LINK_ICON_PX)}<span
                class="visually-hidden"
                >${SKY_LABELS.newTab}</span
              ></a
            >`
      }`;
  }

  /**
   * The aircraft link only in live Home Assistant mode, and only when it is exactly what the validated builder makes
   * for this row's hex: the view model already guarantees both, and this keeps the anchor honest on its own.
   */
  #aircraftLink(row: AircraftVM): string | undefined {
    if (this.services?.mode !== 'live' || row.link === undefined) return undefined;
    return aircraftLink(row.key) === row.link ? row.link : undefined;
  }

  #renderConditions(): TemplateResult | typeof nothing {
    const services = this.services;
    if (services?.config?.weather === undefined) return nothing;
    let metrics: readonly WeatherDetailVM[];
    try {
      metrics = selectSkyConditions(selectorInput(services));
    } catch {
      log.error('sky-conditions-select-failed');
      return nothing;
    }
    if (metrics.length === 0) return nothing;
    const headingId = `${this.#idPrefix}-conditions`;
    return html`<section class="group" aria-labelledby=${headingId}>
      <h3 id=${headingId}>${SKY_LABELS.conditions}</h3>
      <dl class="strip">
        ${metrics.map(
          (metric) =>
            html`<div class="strip-item" data-key=${metric.key}>
              <dt>${metric.label}</dt>
              ${
                metric.value.kind === 'value'
                  ? html`<dd class=${metric.value.stale ? 'stale' : ''}>
                      ${metric.value.text}${
                        metric.value.stale ? html`<span class="visually-hidden">, last known</span>` : nothing
                      }
                    </dd>`
                  : html`<dd class="absent"><span aria-hidden="true">${ABSENT_GLYPH} </span>${metric.value.label}</dd>`
              }
            </div>`,
        )}
      </dl>
    </section>`;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Focus (AIRSPACE.md §6)

  /**
   * Any focus inside the drawer before this update: the search field, a Show or Sort choice (inside its group's own
   * shadow root), a row or its link. A row's key and the row order are kept for the next-row fallback.
   */
  #focusedControl(): FocusedControl | undefined {
    const active = deepActiveElement();
    if (!(active instanceof HTMLElement) || !composedWithin(this, active)) return undefined;
    const row =
      active.getRootNode() === this.renderRoot ? active.closest('li.aircraft')?.getAttribute('data-key') : undefined;
    return {
      focusKey: active.getAttribute('data-focus-key') ?? undefined,
      row: row ?? undefined,
      order: this.#vm?.rows.map((listed) => listed.key) ?? [],
    };
  }

  /**
   * Runs after each render. Focus that is still inside the drawer is left alone. Focus that fell out with its control
   * goes to the same control if it still exists (a moved row), else, from a row, to that row, the next or the previous
   * one, else to the drawer heading, so it never lands on the page behind the modal dialog.
   */
  #recoverFocus(): void {
    const focused = this.#focused;
    this.#focused = undefined;
    if (focused === undefined || composedWithin(this, deepActiveElement())) return;
    const target =
      (focused.focusKey === undefined ? undefined : this.#byFocusKey(focused.focusKey)) ?? this.#nearestRow(focused);
    if (target !== undefined) target.focus();
    else this.renderRoot.querySelector<AgrDrawer>('agr-drawer')?.focusHeading();
  }

  /** From a row that lost focus: the row's own button if it is still listed, else the next row, else the previous. */
  #nearestRow(focused: FocusedControl): HTMLElement | undefined {
    if (focused.row === undefined) return undefined;
    const listed = new Set(this.#vm?.rows.map((row) => row.key));
    const at = Math.max(focused.order.indexOf(focused.row), 0);
    const nearest =
      focused.order.slice(at).find((key) => listed.has(key)) ??
      focused.order
        .slice(0, at)
        .reverse()
        .find((key) => listed.has(key));
    return nearest === undefined ? undefined : this.#byFocusKey(rowFocusKey(nearest));
  }

  /** The control with this focus key anywhere in the drawer, including inside the choice groups' shadow roots. */
  #byFocusKey(focusKey: string): HTMLElement | undefined {
    const root = this.shadowRoot;
    const found =
      root === null ? undefined : findDeep(root, (element) => element.getAttribute('data-focus-key') === focusKey);
    return found instanceof HTMLElement ? found : undefined;
  }

  /** After a radar mark was chosen: its row is brought into view; focus stays where it was. */
  #scrollChosenRow(): void {
    const key = this.#scrollTo;
    this.#scrollTo = undefined;
    if (key === undefined) return;
    const row = this.#byFocusKey(rowFocusKey(key))?.closest('li');
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Handlers

  readonly #onToggle = contained('sky-toggle-failed', (key: string) => {
    this.expanded = this.expanded === key ? undefined : key;
  });

  readonly #onView = contained('sky-view-failed', (event: CustomEvent<ChooseDetail>) => {
    const view = SKY_VIEWS_BY_ID.get(event.detail.value);
    if (view !== undefined) this.view = view;
  });

  readonly #onSort = contained('sky-sort-failed', (event: CustomEvent<ChooseDetail>) => {
    const sort = SKY_SORTS_BY_ID.get(event.detail.value);
    if (sort !== undefined) this.sort = sort;
  });

  /**
   * A mark is a live nearby position, never a past pass: chosen while Recent is shown, or while its aircraft is not
   * listed (another view, or hidden by the search), it shows Nearby and expands the aircraft there.
   */
  readonly #onMark = contained('sky-mark-failed', (event: CustomEvent<SkyMarkDetail>) => {
    const key = event.detail.key;
    const listed = this.view !== 'recent' && this.#vm?.rows.some((row) => row.key === key) === true;
    if (!listed) {
      this.view = 'nearby';
      this.#reveal = key;
    }
    this.expanded = key;
    this.#scrollTo = key;
  });

  readonly #onSearchInput = contained('sky-search-failed', (event: Event) => {
    this.filter = (event.currentTarget as HTMLInputElement).value;
  });

  /** Escape in a non-empty field clears it and stops there; in an empty field it closes the drawer as usual. */
  readonly #onSearchKeydown = contained('sky-search-key-failed', (event: KeyboardEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    if (event.key !== 'Escape' || input.value === '') return;
    event.preventDefault();
    event.stopPropagation();
    input.value = '';
    this.filter = '';
    // Some engines raise the dialog's close request even so; it arrives in this same task, and is refused once.
    this.#escapeClearedSearch = true;
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = setTimeout(() => {
      this.#escapeClearedSearch = false;
    }, 0);
  });

  readonly #onDrawerCancel = contained('sky-cancel-failed', (event: Event) => {
    const input = this.renderRoot.querySelector<HTMLInputElement>('.search input');
    const nonEmpty = input !== null && input.value !== '';
    if (!nonEmpty && !this.#escapeClearedSearch) return;
    event.preventDefault();
    this.#escapeClearedSearch = false;
    if (input !== null) input.value = '';
    this.filter = '';
  });
}

/** Choice values arrive as strings; only the known ids are accepted. */
const SKY_VIEWS_BY_ID: ReadonlyMap<string, SkyView> = new Map(
  (Object.keys(SKY_VIEW_LABELS) as SkyView[]).map((view) => [view, view]),
);
const SKY_SORTS_BY_ID: ReadonlyMap<string, SkySort> = new Map(
  (Object.keys(SKY_SORT_LABELS) as SkySort[]).map((sort) => [sort, sort]),
);

/** Whether `node` is `host` or inside it in the composed tree (its shadow tree, or what is slotted from it). */
function composedWithin(host: Element, node: Element | null): boolean {
  for (let current = node; current !== null; current = composedParent(current)) {
    if (current === host) return true;
  }
  return false;
}

function rowFocusKey(key: string): string {
  return `sky:aircraft:${key}`;
}

/** The banner glyph: the connection for offline, a clock for stale or waiting data, an alert otherwise. */
function bannerIcon(vm: SkyDrawerVM): 'plane' | 'clock' | 'circle-alert' | 'wifi-off' {
  switch (vm.freshness.status) {
    case 'offline':
      return 'wifi-off';
    case 'stale':
    case 'waiting':
      return 'clock';
    case 'missing':
    case 'unsupported':
    case 'malformed':
      return 'circle-alert';
    case 'loading':
    case 'unavailable':
    case 'empty':
    case 'live':
      return 'plane';
  }
}

/** The detail's captions and values; a fact the aircraft did not report is left out, never invented. */
function renderFacts(row: AircraftVM): TemplateResult {
  const facts: readonly (readonly [string, string | undefined])[] = [
    [SKY_LABELS.altitude, row.altitude],
    [SKY_LABELS.speed, row.speed],
    [SKY_LABELS.track, row.track === undefined ? undefined : `${row.track.deg} ${row.track.compass}`],
    [SKY_LABELS.vertical, row.trend?.text],
    [SKY_LABELS.fromHome, `${row.distance} ${row.bearing.compass} · ${row.bearing.deg}`],
    [SKY_LABELS.icao, row.icao],
    [REGISTRATION_CAPTION, row.labelKind === 'registration' ? undefined : row.registration],
  ];
  return html`${facts.map(([caption, value]) =>
    value === undefined
      ? nothing
      : html`<div class="fact">
          <dt>${caption}</dt>
          <dd>${value}</dd>
        </div>`,
  )}`;
}

/** "XAAA → XBBB", the airport names and airline when supplied, then the caption naming it reported and unverified. */
function renderRoute(route: NonNullable<AircraftVM['route']>): TemplateResult {
  return html`<div class="route">
    <p class="route-codes">${route.codes}</p>
    ${route.names === undefined ? nothing : html`<p class="route-names">${route.names}</p>`}
    ${route.airline === undefined ? nothing : html`<p class="route-airline">${route.airline}</p>`}
    <p class="route-caption">${SKY_LABELS.route} · ${route.source}</p>
  </div>`;
}

function renderFootnotes(vm: SkyDrawerVM): TemplateResult | typeof nothing {
  const recent = vm.view === 'recent' ? vm.recentNote : undefined;
  if (vm.footnote === undefined && recent === undefined) return nothing;
  return html`<div class="footnotes">
    ${recent === undefined ? nothing : html`<p class="footnote">${recent}</p>`}
    ${vm.footnote === undefined ? nothing : html`<p class="footnote">${vm.footnote}</p>`}
  </div>`;
}

/** The two constant source links (AIRSPACE.md §9), then the payload's own attribution as plain text. */
function renderSources(vm: SkyDrawerVM, headingId: string): TemplateResult {
  return html`<section class="group" aria-labelledby=${headingId}>
    <h3 id=${headingId}>${SKY_LABELS.sources}</h3>
    <ul class="source-links">
      ${SKY_SOURCES.map(
        (source) =>
          html`<li>
            <a
              class="external"
              href=${source.href}
              target="_blank"
              rel=${ANCHOR_REL}
              referrerpolicy="no-referrer"
              data-focus-key=${`sky:source:${source.key}`}
              ><span>${source.label}</span>${renderIcon('external-link', LINK_ICON_PX)}<span class="visually-hidden"
                >${SKY_LABELS.newTab}</span
              ></a
            >
          </li>`,
      )}
    </ul>
    ${vm.attribution === undefined ? nothing : html`<p class="attribution">${vm.attribution}</p>`}
  </section>`;
}

defineOnce('agr-sky-drawer', AgrSkyDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-sky-drawer': AgrSkyDrawer;
  }
}
