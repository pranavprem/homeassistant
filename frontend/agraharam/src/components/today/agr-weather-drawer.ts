/**
 * Weather details drawer (AIRSPACE.md §8), opened from Today's header "Details": the condition and temperature as
 * a lead line, the extended current conditions the weather entity actually reports (feels like, dew point, humidity,
 * cloud cover, UV with its WHO category, wind, gust and direction, visibility, pressure), then the next sunrise and
 * sunset.
 *
 * Read-only by construction: no gateway, no action controller, no more-info and no handlers on the rows. Honesty as
 * in Today: a metric the source never reports is not listed, one it reports as null reads "No data", never 0; while
 * Home Assistant is offline the values are the last known ones, dimmed and marked; an unavailable or missing entity
 * shows its state and no values. The entity's friendly name is never shown (it is often a place name).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import type { Display } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';
import {
  selectWeatherDetails,
  type SunEventVM,
  type WeatherDetailsVM,
  type WeatherDetailVM,
} from '../../model/weather-details.ts';
import { focusRingStyles, numStyles, skeletonStyles, staleStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { isDefined } from '../../util/defined.ts';
import { log } from '../../util/log.ts';
import { drawerContentStyles } from '../header/drawer-content.ts';
import '../primitives/agr-drawer.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrWeatherDrawerRequest = Extract<DrawerRequest, { id: 'weather' }>;

/** 'clock' so the next sunrise and sunset roll over without an entity change. */
const WEATHER_META: readonly MetaKind[] = Object.freeze(['connection', 'locale', 'clock']);
const HEADING = 'Weather details';
const CONDITION_ICON_PX = 36;
const SUN_ICON_PX = 18;
const NO_IDS: readonly EntityId[] = Object.freeze([]);
const STALE_NOTE = 'Last known values while Home Assistant is offline.';
const FAILED_NOTE = "Weather details couldn't be shown.";
/** The lead line for an entity with no reading, by its status; the reason itself is the Display label. */
const UNAVAILABLE_LEAD = 'Weather unavailable';

export class AgrWeatherDrawer extends LitElement implements DrawerElement<AgrWeatherDrawerRequest> {
  static override styles = [
    focusRingStyles,
    visuallyHiddenStyles,
    skeletonStyles,
    numStyles,
    drawerContentStyles,
    css`
      dl,
      dd {
        margin: 0;
      }
      .now {
        display: flex;
        align-items: center;
        gap: var(--agr-space-4);
        margin: 0 0 var(--agr-space-5);
      }
      /* The condition glyph, thinned like Today's hero glyph so it keeps the icon set's stroke weight. */
      .glyph {
        display: inline-flex;
        flex: none;
        color: var(--agr-brass-ink);
      }
      .glyph svg {
        stroke-width: 1.4;
      }
      .glyph.absent {
        color: var(--agr-muted);
      }
      .reading {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
      }
      .temperature {
        font: var(--agr-type-title);
        font-optical-sizing: auto;
        font-variant-numeric: tabular-nums lining-nums;
        color: var(--agr-ink);
      }
      .condition {
        font: var(--agr-type-body);
        color: var(--agr-ink);
        overflow-wrap: break-word;
      }
      .reason {
        font: var(--agr-type-strong);
        color: var(--agr-muted);
      }
      .rows .name {
        display: inline-flex;
        align-items: center;
        gap: var(--agr-space-2);
      }
      .rows .name svg {
        flex: none;
        color: var(--agr-muted);
      }
      .rows .value {
        color: var(--agr-ink);
      }
      .rows .value.absent {
        color: var(--agr-muted);
      }
      .detail {
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrWeatherDrawerRequest;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => this.#boundIds(),
      WEATHER_META,
    );
  }

  protected override render(): TemplateResult {
    return html`<agr-drawer
      heading=${HEADING}
      .demo=${this.services?.mode === 'demo'}
      .theme=${this.services?.theme ?? 'light'}
    >
      ${this.#renderBody()}
    </agr-drawer>`;
  }

  #boundIds(): readonly EntityId[] {
    const config = this.services?.config;
    if (config === undefined) return NO_IDS;
    return [config.weather, config.sun].filter(isDefined);
  }

  #renderBody(): TemplateResult {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) {
      return html`<span class="skeleton" aria-hidden="true"></span>`;
    }
    let vm: WeatherDetailsVM;
    try {
      vm = selectWeatherDetails(selectorInput(services));
    } catch {
      log.error('weather-details-select-failed');
      return html`<p class="note">${FAILED_NOTE}</p>`;
    }
    if (vm.status === 'loading') return html`<span class="skeleton" aria-hidden="true"></span>`;
    return html`${renderNow(vm)} ${vm.stale ? html`<p class="note">${STALE_NOTE}</p>` : nothing} ${renderConditions(vm)}
    ${renderSun(vm.sun)}`;
  }
}

/**
 * The lead: the condition glyph, the temperature in the serif title face and the condition beneath it; for an entity
 * without a reading, its reason ("Unavailable", "Not found") in muted sans instead.
 */
function renderNow(vm: WeatherDetailsVM): TemplateResult {
  const temperature = vm.temperature;
  if (temperature.kind === 'absent') {
    const lead = vm.status === 'unavailable' ? UNAVAILABLE_LEAD : temperature.label;
    return html`<div class="now">
      <span class="glyph absent" aria-hidden="true">${renderIcon(vm.condition.icon, CONDITION_ICON_PX)}</span>
      <p class="reason">${lead}</p>
    </div>`;
  }
  const unit = vm.unit ?? '';
  return html`<div class="now">
    <span class="glyph" aria-hidden="true">${renderIcon(vm.condition.icon, CONDITION_ICON_PX)}</span>
    <p class="reading">
      <span class="temperature num ${temperature.stale ? 'stale' : ''}"
        >${temperature.text}${unit}${
          temperature.stale ? html`<span class="visually-hidden">, last known</span>` : nothing
        }</span
      >
      <span class="condition ${temperature.stale ? 'stale' : ''}">${vm.condition.label}</span>
    </p>
  </div>`;
}

/** The reported metrics as a definition list in the drawer's row style; nothing when the source reports none. */
function renderConditions(vm: WeatherDetailsVM): TemplateResult | typeof nothing {
  if (vm.metrics.length === 0) return nothing;
  return html`<section class="group" aria-labelledby="weather-now">
    <h3 id="weather-now">Now</h3>
    <dl class="rows">${vm.metrics.map((metric) => renderMetric(metric))}</dl>
  </section>`;
}

function renderMetric(metric: WeatherDetailVM): TemplateResult {
  return html`<div class="row" data-key=${metric.key}>
    <dt class="name">${metric.label}</dt>
    ${renderValue(metric.value, metric.detail)}
  </div>`;
}

/** A value with its optional detail ("6 · High"), or the absent glyph and its label ("No data"), never 0. */
function renderValue(value: Display, detail: string | undefined): TemplateResult {
  if (value.kind === 'absent') {
    return html`<dd class="value absent"><span aria-hidden="true">${ABSENT_GLYPH} </span>${value.label}</dd>`;
  }
  return html`<dd class="value num ${value.stale ? 'stale' : ''}">
    ${value.text}${detail === undefined ? nothing : html`<span class="detail"> · ${detail}</span>`}${
      value.stale ? html`<span class="visually-hidden">, last known</span>` : nothing
    }
  </dd>`;
}

function renderSun(sun: readonly SunEventVM[]): TemplateResult | typeof nothing {
  if (sun.length === 0) return nothing;
  return html`<section class="group" aria-labelledby="weather-sun">
    <h3 id="weather-sun">Sun</h3>
    <dl class="rows">
      ${sun.map(
        (event) =>
          html`<div class="row" data-key=${event.kind}>
            <dt class="name">${renderIcon(event.kind, SUN_ICON_PX)}<span>${event.label}</span></dt>
            <dd class="value num">${event.time}</dd>
          </div>`,
      )}
    </dl>
  </section>`;
}

defineOnce('agr-weather-drawer', AgrWeatherDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-weather-drawer': AgrWeatherDrawer;
  }
}
