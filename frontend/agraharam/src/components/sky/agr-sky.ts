/**
 * Sky (AIRSPACE.md §6): the optional overview panel for the aircraft near the house. Live, it shows the nearby
 * count in the serif value face beside "aircraft within 25 km", a meta line (update age, the overhead count in
 * brass-ink, entries not shown) and one inset row for the nearest aircraft: the closest overhead one, else the
 * closest. In every other state the count block becomes one honest state line and the inset disappears: stale or
 * offline data is never depicted as live. If the selector itself fails, one calm line says so instead of a skeleton
 * that would otherwise read as loading forever.
 *
 * Read-only by construction: the "Details" header button is navigation, always enabled (never gated by controls,
 * preview or permissions), and opens the sky drawer with the nearest aircraft expanded. No service calls, no
 * more-info, no network. The sky clock re-renders the panel every 10 s so the live → stale step needs no update.
 *
 * Rendered only when an airspace entity is configured (the root lays it out as a satellite that never stretches,
 * AIRSPACE.md §7).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { SkyStatus } from '../../model/airspace.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { airspaceEntityIds, createSkySelector, SKY_LABELS, type AircraftVM, type SkyPanelVM } from '../../model/sky.ts';
import type { IconName } from '../../model/types.ts';
import {
  focusRingStyles,
  headerActionStyles,
  numStyles,
  sectionHostStyles,
  skeletonStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import '../primitives/agr-panel.ts';
import type { PanelPill } from '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import { panelPill } from '../shared/paused.ts';
import { selectorInput } from '../shared/selector-input.ts';
import { SkyClock } from './sky-clock.ts';
import { aircraftCardStyles, renderAircraftHead, renderAircraftMeta } from './aircraft-card.ts';

interface FrameOptions {
  readonly pill?: PanelPill | undefined;
  readonly details?: boolean;
  readonly fit?: boolean;
}

/** 'connection' for the offline layer; 'locale' for the formatter's number format and length unit. */
const SKY_META: readonly MetaKind[] = Object.freeze(['connection', 'locale']);
const HEADING_ID = 'agr-sky-heading';
const DETAILS_FOCUS_KEY = 'sky:details';
const STATE_ICON_PX = 20;

/** The muted glyph beside each state line: a clock for time, the plane for the feed, an alert for bad data. */
const STATE_ICONS: Readonly<Record<Exclude<SkyStatus, 'live' | 'empty'>, IconName>> = Object.freeze({
  loading: 'plane',
  missing: 'circle-alert',
  waiting: 'clock',
  unavailable: 'plane',
  unsupported: 'circle-alert',
  malformed: 'circle-alert',
  offline: 'plane',
  stale: 'clock',
});

export class AgrSky extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    numStyles,
    typographyStyles,
    focusRingStyles,
    visuallyHiddenStyles,
    headerActionStyles,
    aircraftCardStyles,
    css`
      p {
        margin: 0;
      }
      /* The count and its label share the first line's baseline; the meta line sits under the label. */
      .summary {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        column-gap: var(--agr-space-3);
        align-items: baseline;
      }
      .count {
        grid-row: 1;
        grid-column: 1;
        color: var(--agr-ink);
      }
      .count-label {
        grid-row: 1;
        grid-column: 2;
        font: var(--agr-type-strong);
        color: var(--agr-ink);
        overflow-wrap: break-word;
      }
      .meta {
        grid-row: 2;
        grid-column: 2;
        overflow-wrap: break-word;
      }
      .overhead-count {
        color: var(--agr-brass-ink);
        font-weight: 600;
      }
      .nearest {
        margin-block-start: 10px;
      }
      .nearest .card {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
      }
      .state {
        display: flex;
        align-items: flex-start;
        gap: var(--agr-space-3);
      }
      .state-glyph {
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        inline-size: 36px;
        block-size: 36px;
        border-radius: 50%;
        color: var(--agr-muted);
        background: var(--agr-surface-inset);
      }
      .state-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-inline-size: 0;
        padding-block-start: 7px;
      }
      .state-line {
        font: var(--agr-type-strong);
        color: var(--agr-ink);
        overflow-wrap: break-word;
      }
      .ghost-summary {
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
      }
      .ghost-summary .count-ghost {
        inline-size: 1.6em;
        block-size: 26px;
        margin: 0;
      }
      .ghost-summary .lines {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: var(--agr-space-2);
        min-inline-size: 0;
      }
      .ghost-summary .skeleton {
        margin: 0;
      }
      .ghost-summary .label-ghost {
        inline-size: min(11em, 80%);
        block-size: 14px;
      }
      .ghost-summary .meta-ghost {
        inline-size: min(8em, 60%);
        block-size: 10px;
      }
      .nearest-ghost {
        block-size: 54px;
        margin-block-start: 10px;
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  readonly #select = createSkySelector();

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : airspaceEntityIds(this.services.config)),
      SKY_META,
    );
    new SkyClock(this, () => this.services?.config?.airspace !== undefined);
  }

  protected override render(): TemplateResult | typeof nothing {
    const services = this.services;
    if (services === undefined) return this.#frame(this.#renderLoading(), { details: false });
    if (services.config?.airspace === undefined) return nothing;
    const vm = this.#viewModel(services);
    if (vm === undefined) {
      return this.#frame(renderStateLine('failed', 'circle-alert', SKY_LABELS.failed), {
        pill: panelPill(services.store),
        fit: true,
      });
    }
    const pill = panelPill(services.store, vm.freshness.pill);
    if (vm.freshness.status === 'loading') return this.#frame(this.#renderLoading(), { pill });
    if (vm.count === undefined) return this.#frame(this.#renderState(vm), { pill, fit: true });
    return this.#frame(this.#renderCount(vm, vm.count), { pill });
  }

  #viewModel(services: DashboardServices): SkyPanelVM | undefined {
    try {
      const input = selectorInput(services);
      return this.#select.panel(input, this.#select.state(input));
    } catch {
      log.error('sky-select-failed');
      return undefined;
    }
  }

  /**
   * The panel frame. Details is shown once services exist, in every state: the drawer explains each one in full.
   * `fit`: a sentence-only state keeps its content height, like other panels with nothing to show.
   */
  #frame(body: TemplateResult, options: FrameOptions): TemplateResult {
    return html`<agr-panel
      heading=${SKY_LABELS.heading}
      heading-id=${HEADING_ID}
      icon="plane"
      surface="raised"
      ?fit=${options.fit === true}
      .pill=${options.pill}
    >
      ${options.details === false ? nothing : this.#renderDetails()} ${body}
    </agr-panel>`;
  }

  #renderDetails(): TemplateResult {
    return html`<button
      type="button"
      slot="actions"
      class="header-action"
      aria-label=${SKY_LABELS.details}
      aria-haspopup="dialog"
      data-focus-key=${DETAILS_FOCUS_KEY}
      @click=${this.#onDetails}
      @keydown=${suppressKeyRepeat}
    >
      Details
    </button>`;
  }

  /** The loaded panel's shape as placeholders, so nothing moves when the first data arrives. */
  #renderLoading(): TemplateResult {
    return html`<div class="ghost-summary" aria-hidden="true">
        <span class="ghost count-ghost"></span>
        <span class="lines"><span class="skeleton label-ghost"></span><span class="skeleton meta-ghost"></span></span>
      </div>
      <span class="ghost nearest-ghost" aria-hidden="true"></span>
      <span class="visually-hidden">Loading the sky</span>`;
  }

  #renderCount(vm: SkyPanelVM, count: number): TemplateResult {
    return html`<div class="summary">
        <span class="count t-value num">${count}</span>
        <span class="count-label">${vm.countLabel ?? ''}</span>
        <p class="meta t-meta">${metaParts(vm)}</p>
      </div>
      ${vm.nearest === undefined ? nothing : renderNearest(vm.nearest)}`;
  }

  /** A non-live state: its muted glyph, the panel line (AIRSPACE.md §4) and the age of the last update when known. */
  #renderState(vm: SkyPanelVM): TemplateResult {
    const status = vm.freshness.status;
    const icon = status === 'live' || status === 'empty' ? 'plane' : STATE_ICONS[status];
    return renderStateLine(status, icon, vm.freshness.sentence ?? '', vm.freshness.ageText);
  }

  readonly #onDetails = contained('sky-details-failed', (event: Event) => {
    const services = this.services;
    const nearest = services === undefined ? undefined : this.#viewModel(services)?.nearest?.key;
    requestDrawer(
      this,
      nearest === undefined ? { id: 'sky' } : { id: 'sky', select: nearest },
      event.currentTarget as HTMLElement,
    );
  });
}

/** One state line with its muted glyph: a non-live status, or 'failed' when the selector could not run. */
function renderStateLine(status: SkyStatus | 'failed', icon: IconName, line: string, ageText?: string): TemplateResult {
  return html`<div class="state" data-status=${status}>
    <span class="state-glyph" aria-hidden="true">${renderIcon(icon, STATE_ICON_PX)}</span>
    <div class="state-text">
      <p class="state-line">${line}</p>
      ${ageText === undefined ? nothing : html`<p class="meta t-meta">${ageText}</p>`}
    </div>
  </div>`;
}

/** "Updated just now · 1 overhead · 2 entries not shown", each part only when it applies. */
function metaParts(vm: SkyPanelVM): TemplateResult {
  const overhead =
    vm.overheadCount === undefined || vm.overheadCount === 0
      ? undefined
      : html`<span class="overhead-count">${vm.overheadCount} overhead</span>`;
  const parts = [vm.freshness.ageText, overhead, vm.droppedText].filter((part) => part !== undefined);
  return html`${parts.map((part, index) => html`${index > 0 ? ' · ' : ''}${part}`)}`;
}

/**
 * The nearest aircraft as one inset card (aircraft-card.ts): distance with the compass point as text, never a rotated
 * arrow, which would read as a heading. The visible card is hidden from assistive technology, which reads the
 * aircraft's accessible name instead.
 */
function renderNearest(aircraft: AircraftVM): TemplateResult {
  return html`<div class="nearest aircraft-card" ?data-overhead=${aircraft.overhead}>
    <p class="visually-hidden">Nearest: ${aircraft.accessibleName}</p>
    <span class="card" aria-hidden="true">${renderAircraftHead(aircraft)} ${renderAircraftMeta(aircraft)}</span>
  </div>`;
}

defineOnce('agr-sky', AgrSky);

declare global {
  interface HTMLElementTagNameMap {
    'agr-sky': AgrSky;
  }
}
