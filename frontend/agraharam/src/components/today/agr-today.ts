/**
 * Today (§9.2): the visual anchor of the dashboard. A large editorial temperature with its condition and the day's
 * high and low, sunset or sunrise in the panel header, a quiet metrics row, and a modest forecast strip.
 *
 * Reads only: the weather and sun entities through the store, and the forecast through ForecastController
 * (weather/subscribe_forecast). It renders no controls and makes no service calls.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import { ForecastController, type ForecastSource } from '../../ha/forecast-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { ABSENT_GLYPH, displayText } from '../../model/display.ts';
import { FORECAST_NOTES, selectToday } from '../../model/today.ts';
import type { MetricVM, TodayVM } from '../../model/types.ts';
import {
  hyphenationDeclarations,
  numStyles,
  sectionHostStyles,
  skeletonStyles,
  staleStyles,
  visuallyHiddenDeclarations,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import { HERO_LINE_HEIGHT, typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { isDefined } from '../../util/defined.ts';
import { log } from '../../util/log.ts';
import '../primitives/agr-empty-state.ts';
import '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import './agr-forecast-strip.ts';
import { panelPill } from '../shared/paused.ts';
import { selectorInput } from '../shared/selector-input.ts';

const HEADING_ID = 'agr-today-heading';
/** 'clock' keeps "Now", the next 8 hours and the Today/Tomorrow high-low label current without entity changes. */
const TODAY_META: readonly MetaKind[] = Object.freeze(['connection', 'locale', 'clock']);
const HERO_ICON_SIZE = 44;
const SUN_ICON_SIZE = 16;
/** The narrowest condition column kept beside the hero number before the summary wraps below it. */
const SUMMARY_BASIS_PX = 120;
/** The absent hero: two short strokes, set smaller than a reading and without a degree sign, so they read as one
 *  deliberate placeholder rather than a temperature or a divider rule. */
const ABSENT_HERO = '--';
/** Short visible labels for the narrowest panels; the full label stays readable to assistive technology. */
const SHORT_METRIC_LABELS: Readonly<Partial<Record<MetricVM['key'], string>>> = Object.freeze({ feels: 'Feels' });
/** When the weather reading is absent the row keeps its shape with these readings shown as absent. */
const ABSENT_METRIC_LABELS: readonly string[] = Object.freeze(['Feels like', 'Wind', 'Humidity']);
const WEATHER_UNAVAILABLE = 'Weather unavailable';
const NO_IDS: readonly EntityId[] = Object.freeze([]);

export class AgrToday extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    typographyStyles,
    numStyles,
    visuallyHiddenStyles,
    css`
      p,
      dl,
      dd {
        margin: 0;
      }
      .sun {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .sun .time {
        color: var(--agr-ink);
      }
      .hero {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        column-gap: var(--agr-space-4);
        row-gap: var(--agr-space-2);
      }
      .reading {
        display: flex;
        flex: none;
        align-items: center;
        gap: var(--agr-space-3);
      }
      /* The condition glyph is drawn larger than the 24 px grid it was designed on, so its stroke is thinned to
         stay close to the 1.75 px weight of the other icons. */
      .glyph {
        display: inline-flex;
        flex: none;
        color: var(--agr-brass-ink);
      }
      .glyph svg {
        stroke-width: 1.15;
      }
      .temperature {
        display: inline-flex;
        align-items: flex-start;
        white-space: nowrap;
        letter-spacing: -0.02em;
      }
      .temperature .degree {
        margin-inline-start: 0.04em;
        line-height: 1.1;
      }
      /* A decimal reading keeps its precision (§4.8) without competing with the whole degrees: the fraction is set
         small and raised like the degree sign. */
      .temperature .fraction {
        font-size: 0.45em;
        line-height: 1.1;
        letter-spacing: 0;
      }
      .absent {
        color: var(--agr-muted);
      }
      /* The placeholder keeps the hero line's height, so the panel's shape does not change, but its strokes are 0.7 of
         a reading and drawn tighter (the serif's hyphens carry wide side bearings), so "--" reads as one mark. */
      .temperature.absent {
        align-items: center;
        block-size: ${HERO_LINE_HEIGHT}em;
      }
      .temperature.absent .placeholder {
        font-size: 0.7em;
        line-height: 1;
        letter-spacing: -0.07em;
      }
      /* A basis rather than the label's full width: in a narrow panel a long condition wraps beside the number
         instead of dropping the whole summary onto its own row. */
      .summary {
        display: flex;
        flex: 1 1 ${SUMMARY_BASIS_PX}px;
        flex-direction: column;
        gap: 2px;
        min-inline-size: 0;
      }
      .condition {
        overflow-wrap: break-word;
        ${hyphenationDeclarations}
        text-wrap: balance;
      }
      /* Why there is no reading ("Not found", "Offline") is a reason, not a value: muted sans, never the serif. */
      .condition.reason {
        font: var(--agr-type-strong);
        color: var(--agr-muted);
      }
      /* Beside an 80 or 68 px hero the column is narrow, so the condition steps down a size rather than break. */
      @container panel (width < ${PANEL_CQ.hero96}px) {
        .condition {
          font: var(--agr-type-value);
        }
      }
      .range {
        display: flex;
        flex-wrap: wrap;
        column-gap: var(--agr-space-3);
      }
      .range .value {
        color: var(--agr-ink);
        font-weight: 620;
      }
      /* One row of up to three readings, never an uneven wrap: the columns size to their text and share the
         spare width; below 320 px "Feels like" shortens to "Feels" (the full label stays for assistive tech). */
      .metrics {
        display: grid;
        grid-auto-columns: auto;
        grid-auto-flow: column;
        justify-content: space-between;
        gap: var(--agr-space-3);
        margin-block-start: var(--agr-space-4);
        padding: 9px var(--agr-space-4);
        border-radius: var(--agr-radius-inner);
        background: var(--agr-surface-inset);
      }
      /* The short label is generated content with empty alternative text, so it is never read twice and never
         part of the text; the full label is then only visually hidden. */
      @container panel (width < ${PANEL_CQ.metricsShortLabels}px) {
        .metric dt[data-short] .full {
          ${visuallyHiddenDeclarations}
        }
        .metric dt[data-short]::before {
          content: attr(data-short);
          content: attr(data-short) / '';
        }
      }
      .metric {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-inline-size: 0;
      }
      .metric dd {
        color: var(--agr-ink);
        font-weight: 620;
        white-space: nowrap;
      }
      .metric dd.absent {
        color: var(--agr-muted);
        font-weight: 500;
      }
      /* staleStyles alone loses to the more specific .metric dd ink. */
      .metric dd.stale {
        color: var(--agr-muted);
      }
      agr-forecast-strip {
        margin-block-start: var(--agr-space-5);
      }
      /* The loading shell has the hero's real footprint: a glyph, a number block as tall as one hero line (it carries
         .t-hero, so it follows the hero's own sizes), the condition lines and the metrics row, then the strip's cells. */
      .hero-skeleton {
        display: flex;
        align-items: center;
        gap: var(--agr-space-4);
      }
      .hero-skeleton .skeleton {
        margin: 0;
      }
      .hero-skeleton .glyph-ghost {
        flex: none;
        inline-size: 44px;
        block-size: 44px;
        border-radius: 50%;
      }
      .hero-skeleton .number {
        flex: none;
        inline-size: 2.1em;
        block-size: ${HERO_LINE_HEIGHT}em;
      }
      .hero-skeleton .lines {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: var(--agr-space-2);
        min-inline-size: 0;
      }
      .hero-skeleton .text {
        inline-size: min(140px, 100%);
        block-size: 20px;
      }
      .hero-skeleton .text.short {
        inline-size: min(96px, 80%);
        block-size: 12px;
      }
      .metrics-ghost {
        block-size: 40px;
        margin-block-start: var(--agr-space-4);
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  /** Re-renders on weather or sun changes, the connection phase, locale and the minute clock. */
  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => this.#boundIds(),
      TODAY_META,
    );
  }
  readonly #forecast = new ForecastController(this, () => this.#forecastSource());

  protected override render(): TemplateResult {
    const services = this.services;
    if (services === undefined) return this.#renderFrame(this.#renderLoading());
    if (services.config.weather === undefined) {
      return this.#renderFrame(
        html`<agr-empty-state
          icon="cloud"
          heading="Weather isn't set up"
          message=${FORECAST_NOTES.notConfigured}
        ></agr-empty-state>`,
      );
    }
    let vm: TodayVM;
    try {
      vm = selectToday({ ...selectorInput(services), forecast: this.#forecast.snapshot() });
    } catch {
      log.error('today-select-failed');
      return this.#renderFrame(
        html`<agr-empty-state icon="circle-alert" heading="Weather couldn't be shown"></agr-empty-state>`,
      );
    }
    return this.#renderFrame(this.#renderToday(vm), vm);
  }

  #boundIds(): readonly EntityId[] {
    const config = this.services?.config;
    if (config === undefined) return NO_IDS;
    return [config.weather, config.sun].filter(isDefined);
  }

  #forecastSource(): ForecastSource | undefined {
    const services = this.services;
    if (services === undefined) return undefined;
    return {
      reader: services.reader,
      status: services.status,
      ...(services.config.weather !== undefined && { weather: services.config.weather }),
    };
  }

  /**
   * `centered`: when Today takes its column's slack (§6.2), the hero, metrics and strip stay one group, centred in
   * the free height, so their spacing is the same at every panel height.
   */
  #renderFrame(content: TemplateResult, vm?: TodayVM): TemplateResult {
    return html`<agr-panel
      heading="Today"
      heading-id=${HEADING_ID}
      surface="hero"
      icon="sun"
      centered
      .pill=${panelPill(this.services?.store)}
    >
      ${vm?.sun ? renderSun(vm.sun) : nothing} ${content}
    </agr-panel>`;
  }

  /** The anchor's shell while nothing is known: hero, condition and metrics placeholders above the strip's. */
  #renderLoading(): TemplateResult {
    return html`<div class="now" aria-hidden="true">
        <div class="hero-skeleton">
          <span class="ghost glyph-ghost"></span><span class="ghost number t-hero"></span>
          <span class="lines"><span class="skeleton text"></span><span class="skeleton text short"></span></span>
        </div>
        <span class="ghost metrics-ghost"></span>
      </div>
      <agr-forecast-strip></agr-forecast-strip>
      <span class="visually-hidden">Loading weather</span>`;
  }

  #renderToday(vm: TodayVM): TemplateResult {
    if (vm.status === 'loading') return this.#renderLoading();
    const tone = heroTone(vm);
    // The reading and its metrics stay one group, so a stretched panel centres them above the strip (§6.2).
    return html`<div class="now">
        <div class="hero">
          <div class="reading">
            <span class="glyph ${tone}">${renderIcon(vm.condition.icon, HERO_ICON_SIZE)}</span>
            ${renderTemperature(vm)}
          </div>
          <div class="summary">${renderCondition(vm, tone)} ${renderRange(vm)}</div>
        </div>
        ${renderMetricsRow(vm)}
      </div>
      <agr-forecast-strip .forecast=${vm.forecast}></agr-forecast-strip>`;
  }
}

function renderSun(sun: NonNullable<TodayVM['sun']>): TemplateResult {
  const label = sun.kind === 'sunset' ? 'Sunset' : 'Sunrise';
  return html`<span slot="actions" class="sun t-meta"
    >${renderIcon(sun.kind, SUN_ICON_SIZE)}<span>${label}</span> <span class="time num">${sun.time}</span></span
  >`;
}

/**
 * The hero number: the value with a raised degree glyph (and a raised, smaller fraction for a decimal reading), or
 * a muted "--°" at the same size when absent (never 0, and never a long dash that reads as a divider).
 */
function renderTemperature(vm: TodayVM): TemplateResult {
  const field = html`<span class="visually-hidden">${vm.name} temperature</span>`;
  const display = vm.temperature;
  const unit = vm.unit ?? '°';
  const glyph = unit.startsWith('°') ? '°' : unit;
  if (display.kind === 'absent') {
    return html`${field}<span class="temperature t-hero absent" aria-hidden="true"
        ><span class="placeholder">${ABSENT_HERO}</span></span
      >`;
  }
  const [whole, fraction] = splitFraction(display.text);
  return html`${field}<span class="temperature t-hero num ${display.stale ? 'stale' : ''}"
      >${whole}${fraction === undefined ? nothing : html`<span class="fraction">${fraction}</span>`}<span
        class="degree"
        aria-hidden="true"
        >${glyph}</span
      ></span
    ><span class="visually-hidden">${unit}${display.stale ? ', last known' : ''}</span>`;
}

/**
 * "70.5" → ["70", ".5"]; a whole reading has no fraction. The separator is whatever the locale used ("." or ",");
 * an outdoor temperature never needs a grouping separator, so trailing separator-plus-digits is the decimal part.
 */
function splitFraction(text: string): readonly [string, string | undefined] {
  const match = /^(.*\d)([.,]\d+)$/.exec(text);
  return match === null ? [text, undefined] : [match[1] ?? text, match[2]];
}

/** The reading is absent for a reason (unavailable, not found, offline), not merely still loading. */
function heroAbsent(vm: TodayVM): boolean {
  return vm.temperature.kind === 'absent' && vm.status !== 'loading';
}

/** Live reads at full ink; last-known values are dimmed; absent ones are muted. */
function heroTone(vm: TodayVM): '' | 'stale' | 'absent' {
  if (vm.temperature.kind === 'value') return vm.temperature.stale ? 'stale' : '';
  return vm.status === 'available' ? '' : 'absent';
}

/**
 * The condition in the serif title, "Weather unavailable" for an unavailable source, or otherwise the reason itself
 * ("Not found", "Offline") beside the absent hero, in muted sans.
 */
function renderCondition(vm: TodayVM, tone: string): TemplateResult {
  if (vm.status === 'available' || vm.temperature.kind === 'value') {
    return html`<p class="condition t-title ${tone}">${vm.condition.label}</p>`;
  }
  if (vm.status === 'unavailable') return html`<p class="condition t-title ${tone}">${WEATHER_UNAVAILABLE}</p>`;
  return html`<p class="condition reason">${vm.temperature.label}</p>`;
}

function renderRange(vm: TodayVM): TemplateResult | typeof nothing {
  if (vm.high === undefined && vm.low === undefined) return nothing;
  return html`<p class="range t-meta">
    ${vm.highLowDay === 'tomorrow' ? html`<span>Tomorrow:</span>` : nothing}
    ${vm.high ? html`<span>High <span class="value num">${displayText(vm.high)}</span></span>` : nothing}
    ${vm.low ? html`<span>Low <span class="value num">${displayText(vm.low)}</span></span>` : nothing}
  </p>`;
}

function renderMetricLabel(metric: MetricVM): TemplateResult {
  const short = SHORT_METRIC_LABELS[metric.key];
  if (short === undefined) return html`<dt>${metric.label}</dt>`;
  return html`<dt data-short=${short}><span class="full">${metric.label}</span></dt>`;
}

/** The reported metrics; for an absent reading the same row of dashes; nothing when the source reports none. */
function renderMetricsRow(vm: TodayVM): TemplateResult | typeof nothing {
  if (vm.metrics.length > 0) return renderMetrics(vm.metrics);
  return heroAbsent(vm) ? renderAbsentMetrics() : nothing;
}

/** The metrics row of an absent reading: the same labels with "—", so the panel keeps its normal shape. */
function renderAbsentMetrics(): TemplateResult {
  return html`<dl class="metrics t-meta">
    ${ABSENT_METRIC_LABELS.map(
      (label) =>
        html`<div class="metric">
          <dt>${label}</dt>
          <dd class="absent">
            <span aria-hidden="true">${ABSENT_GLYPH}</span><span class="visually-hidden">No data</span>
          </dd>
        </div>`,
    )}
  </dl>`;
}

function renderMetrics(metrics: readonly MetricVM[]): TemplateResult {
  return html`<dl class="metrics t-meta">
    ${metrics.map(
      (metric) =>
        html`<div class="metric">
          ${renderMetricLabel(metric)}
          ${
            metric.value.kind === 'value'
              ? html`<dd class="num ${metric.value.stale ? 'stale' : ''}">
                  ${metric.value.text}${
                    metric.value.stale ? html`<span class="visually-hidden">, last known</span>` : nothing
                  }
                </dd>`
              : html`<dd class="absent"><span aria-hidden="true">${ABSENT_GLYPH} </span>${metric.value.label}</dd>`
          }
        </div>`,
    )}
  </dl>`;
}

defineOnce('agr-today', AgrToday);

declare global {
  interface HTMLElementTagNameMap {
    'agr-today': AgrToday;
  }
}
