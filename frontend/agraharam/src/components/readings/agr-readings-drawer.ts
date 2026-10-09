/**
 * House readings drawer (§18): every configured collection as a group of read-only rows, each with its value and an
 * honest condition. Groups that need a look start open; the rest stay collapsed so the list never becomes a wall of
 * entities. With 16 or more rows a search field narrows the groups and rows by name.
 *
 * Read-only by construction: no gateway, no action controller, no action buttons and no more-info. Rows are plain
 * list items with no handlers. Search and the open groups are local view state: nothing is written anywhere, and both
 * reset when the drawer closes. Escape in a non-empty search field clears it and leaves the drawer open; Escape again
 * closes the drawer.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';
import {
  collectionEntityIds,
  createReadingsSelector,
  readingGroupMeta,
  readingGroupStartsExpanded,
  readingsSentence,
  type ReadingGroupVM,
  type ReadingsVM,
  type ReadingVM,
} from '../../model/readings.ts';
import { focusRingStyles, numStyles, skeletonStyles, staleStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import { drawerContentStyles } from '../header/drawer-content.ts';
import '../primitives/agr-drawer.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrReadingsDrawerRequest = Extract<DrawerRequest, { id: 'readings' }>;

/** 'registry' for display precision; 'clock' so "Today" and "Tomorrow" roll over at midnight. */
const READINGS_META: readonly MetaKind[] = Object.freeze(['connection', 'locale', 'registry', 'clock']);
const HEADING = 'House readings';
/** Below this many rows every group fits without searching. */
const SEARCH_MIN_ROWS = 16;
const SEARCH_MAX_CHARS = 60;
const SEARCH_LABEL = 'Find a reading';
const ICON_PX = 18;
const ATTENTION_ICON_PX = 16;
const COMBINING_MARKS_RE = /\p{M}/gu;

let drawerCount = 0;

export class AgrReadingsDrawer extends LitElement implements DrawerElement<AgrReadingsDrawerRequest> {
  static override styles = [
    focusRingStyles,
    visuallyHiddenStyles,
    skeletonStyles,
    numStyles,
    drawerContentStyles,
    css`
      .search {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-1);
        margin: 0 0 var(--agr-space-5);
      }
      .search label {
        font: var(--agr-type-label);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--agr-muted);
      }
      .search input {
        box-sizing: border-box;
        inline-size: 100%;
        min-block-size: var(--agr-target);
        padding: 0 var(--agr-space-4);
        border: 1px solid var(--agr-line);
        border-radius: var(--agr-radius-control);
        font: var(--agr-type-body);
        color: var(--agr-ink);
        background: var(--agr-surface-inset);
      }
      .search input:focus-visible {
        outline: 2px solid var(--agr-focus);
        outline-offset: 2px;
      }
      .matches {
        margin: 0;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .group h3 {
        margin: 0 0 var(--agr-space-2);
        font: inherit;
        letter-spacing: normal;
        text-transform: none;
      }
      .disclosure {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
        inline-size: 100%;
        min-block-size: var(--agr-target);
        padding: var(--agr-space-2) var(--agr-space-4);
        border: none;
        border-radius: var(--agr-radius-inner);
        font: var(--agr-type-control);
        color: var(--agr-ink);
        text-align: start;
        background: var(--agr-surface-inset);
        cursor: pointer;
      }
      .disclosure svg {
        flex: none;
        color: var(--agr-muted);
      }
      .group-name {
        flex: 1 1 auto;
        min-inline-size: 0;
        overflow-wrap: break-word;
      }
      .group-meta {
        flex: none;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .group-meta[data-tone='attention'] {
        color: var(--agr-brass-ink);
      }
      .chevron {
        transition: transform var(--agr-dur-1) var(--agr-ease);
      }
      .disclosure[aria-expanded='true'] .chevron {
        transform: rotate(180deg);
      }
      .reading {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        column-gap: var(--agr-space-3);
        align-items: baseline;
      }
      .reading .name {
        grid-column: 1;
      }
      .reading-value {
        grid-column: 2;
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--agr-space-1);
        max-inline-size: 14em;
        font: var(--agr-type-meta-strong);
        color: var(--agr-ink);
        text-align: end;
        overflow-wrap: anywhere;
      }
      /* An icon, not text: plain brass meets the 3:1 non-text contrast, and the hidden words carry the meaning. */
      .reading-value svg {
        flex: none;
        stroke: var(--agr-brass);
      }
      .reading[data-condition='attention'] .reading-value {
        color: var(--agr-brass-ink);
      }
      .reading[data-condition='unavailable'] .reading-value,
      .reading[data-muted] .reading-value {
        color: var(--agr-muted);
      }
      .detail {
        grid-column: 1 / -1;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .reading[data-condition='attention'] .detail {
        color: var(--agr-brass-ink);
      }
      .glyph {
        color: var(--agr-muted);
      }
      .reading .skeleton {
        inline-size: 4em;
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrReadingsDrawerRequest;

  /** Normalised search text; empty when not searching. */
  @state() private query = '';
  /** Groups the user opened or closed, by group index; the rest follow the default rule. */
  @state() private toggled: ReadonlyMap<number, boolean> = new Map();

  readonly #select = createReadingsSelector();
  readonly #idPrefix = `agr-readings-${(drawerCount += 1)}`;
  /** Set for the one Escape that cleared the search, so the dialog close request it may still raise is refused. */
  #escapeClearedSearch = false;
  #escapeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : collectionEntityIds(this.services.config)),
      READINGS_META,
    );
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.#escapeTimer);
    this.#escapeClearedSearch = false;
  }

  protected override render(): TemplateResult {
    const vm = this.#viewModel();
    return html`<agr-drawer
      heading=${HEADING}
      .demo=${this.services?.mode === 'demo'}
      .theme=${this.services?.theme ?? 'light'}
      @agr-drawer-cancel=${this.#onDrawerCancel}
    >
      ${vm === undefined ? html`<span class="skeleton" aria-hidden="true"></span>` : this.#renderBody(vm)}
    </agr-drawer>`;
  }

  #renderBody(vm: ReadingsVM): TemplateResult {
    const formatter = this.services.reader.formatter();
    const searching = this.query !== '';
    const shown = searching ? filterGroups(vm.groups, this.query) : vm.groups;
    return html`<p class="lead">${readingsSentence(vm, formatter)}</p>
      ${vm.counts.total >= SEARCH_MIN_ROWS ? this.#renderSearch(shown, searching) : nothing}
      ${shown.map((group) => this.#renderGroup(vm, group, searching))}`;
  }

  #renderSearch(shown: readonly ReadingGroupVM[], searching: boolean): TemplateResult {
    const inputId = `${this.#idPrefix}-search`;
    const matches = shown.reduce((total, group) => total + group.rows.length, 0);
    const status = !searching
      ? ''
      : matches === 0
        ? 'No readings match'
        : `${matches} ${matches === 1 ? 'reading matches' : 'readings match'}`;
    return html`<div class="search">
      <label for=${inputId}>${SEARCH_LABEL}</label>
      <input
        id=${inputId}
        type="search"
        maxlength=${SEARCH_MAX_CHARS}
        autocomplete="off"
        spellcheck="false"
        enterkeyhint="search"
        data-focus-key="readings:search"
        @input=${this.#onSearchInput}
        @keydown=${this.#onSearchKeydown}
      />
      <p class="matches" role="status">${status}</p>
    </div>`;
  }

  #renderGroup(vm: ReadingsVM, group: ReadingGroupVM, searching: boolean): TemplateResult {
    const headingId = `${this.#idPrefix}-group-${group.index}`;
    const rowsId = `${headingId}-rows`;
    const expanded = searching || (this.toggled.get(group.index) ?? readingGroupStartsExpanded(group, vm));
    const meta = readingGroupMeta(group, vm, this.services.reader.formatter());
    const needsLook = vm.state === 'live' && (group.counts.attention > 0 || group.counts.unavailable > 0);
    return html`<section class="group" aria-labelledby=${headingId}>
      <h3>
        <button
          id=${headingId}
          type="button"
          class="disclosure"
          aria-expanded=${String(expanded)}
          aria-controls=${rowsId}
          data-focus-key=${`readings:group:${group.index}`}
          @click=${() => this.#onToggle(group.index, !expanded)}
          @keydown=${suppressKeyRepeat}
        >
          ${group.icon === undefined ? nothing : renderIcon(group.icon, ICON_PX)}
          <span class="group-name">${group.name}</span>
          <span class="group-meta" data-tone=${needsLook ? 'attention' : nothing}>${meta}</span>
          <span class="chevron" aria-hidden="true">${renderIcon('chevron-down', ICON_PX)}</span>
        </button>
      </h3>
      <ul id=${rowsId} class="rows" ?hidden=${!expanded}>
        ${expanded ? group.rows.map((row) => renderRow(row)) : nothing}
      </ul>
    </section>`;
  }

  #viewModel(): ReadingsVM | undefined {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) return undefined;
    try {
      return this.#select(selectorInput(services));
    } catch {
      log.error('readings-select-failed');
      return undefined;
    }
  }

  readonly #onToggle = contained('readings-toggle-failed', (index: number, open: boolean) => {
    const next = new Map(this.toggled);
    next.set(index, open);
    this.toggled = next;
  });

  readonly #onSearchInput = contained('readings-search-failed', (event: Event) => {
    this.query = normalizeForSearch((event.currentTarget as HTMLInputElement).value);
  });

  /** Escape in a non-empty field clears it and stops there; in an empty field it closes the drawer as usual. */
  readonly #onSearchKeydown = contained('readings-search-key-failed', (event: KeyboardEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    if (event.key !== 'Escape' || input.value === '') return;
    event.preventDefault();
    event.stopPropagation();
    input.value = '';
    this.query = '';
    // Some engines raise the dialog's close request even so; it arrives in this same task, and is refused once.
    this.#escapeClearedSearch = true;
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = setTimeout(() => {
      this.#escapeClearedSearch = false;
    }, 0);
  });

  readonly #onDrawerCancel = contained('readings-cancel-failed', (event: Event) => {
    const input = this.renderRoot.querySelector<HTMLInputElement>('.search input');
    const nonEmpty = input !== null && input.value !== '';
    if (!nonEmpty && !this.#escapeClearedSearch) return;
    event.preventDefault();
    this.#escapeClearedSearch = false;
    if (input !== null) input.value = '';
    this.query = '';
  });
}

/**
 * One read-only row: the name, the value (or an honest absent label), and the detail beneath. Attention is never
 * carried by colour alone: an icon and hidden text say it too.
 */
function renderRow(row: ReadingVM): TemplateResult {
  return html`<li
    class="row reading"
    data-condition=${row.condition}
    ?data-muted=${row.condition === 'info' && row.value.kind === 'absent'}
  >
    <span class="name">${row.name}</span>
    <span class="reading-value num">${renderValue(row)}</span>
    ${row.detail === undefined ? nothing : html`<span class="detail">${row.detail}</span>`}
  </li>`;
}

function renderValue(row: ReadingVM): TemplateResult {
  const value = row.value;
  if (row.condition === 'loading') {
    return html`<span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">Loading</span>`;
  }
  if (value.kind === 'absent') {
    // An unavailable reading shows the dash and its label; a rule-less unknown one only its muted word.
    return row.condition === 'info'
      ? html`<span>${value.label}</span>`
      : html`<span class="glyph" aria-hidden="true">${ABSENT_GLYPH}</span><span>${value.label}</span>`;
  }
  if (row.condition === 'attention') {
    return html`${renderIcon('circle-alert', ATTENTION_ICON_PX)}<span>${value.text}</span
      ><span class="visually-hidden">, needs attention</span>`;
  }
  return html`<span class=${value.stale ? 'stale' : ''}>${value.text}</span>${
      value.stale ? html`<span class="visually-hidden">, last known</span>` : nothing
    }`;
}

/** Lower case with diacritics removed, so "cafe" finds "Café". */
function normalizeForSearch(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS_RE, '').toLowerCase().trim();
}

/** Groups with a match, each with its matching rows (every row when the group's own name matches). */
function filterGroups(groups: readonly ReadingGroupVM[], query: string): ReadingGroupVM[] {
  return groups.flatMap((group) => {
    if (normalizeForSearch(group.name).includes(query)) return [group];
    const rows = group.rows.filter((row) => normalizeForSearch(row.name).includes(query));
    return rows.length === 0 ? [] : [{ ...group, rows }];
  });
}

defineOnce('agr-readings-drawer', AgrReadingsDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-readings-drawer': AgrReadingsDrawer;
  }
}
