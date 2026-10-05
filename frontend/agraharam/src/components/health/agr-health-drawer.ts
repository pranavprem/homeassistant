/**
 * House health drawer (§5.3): the summary sentence, then every monitored entry point, the devices not reporting,
 * those still loading while HA starts, and the devices reporting, each by name with its status. It says plainly
 * that it covers only what the dashboard is configured to show.
 *
 * While paused (HA disconnected or resyncing) it lists the monitored devices by name only: their statuses are
 * unknown because the dashboard's connection is down, which is not the same as a device not reporting.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import type { Tone } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { healthEntityIds, selectHealthDetails, type HealthDetailsVM } from '../../model/health.ts';
import { focusRingStyles, skeletonStyles, toneStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { log } from '../../util/log.ts';
import '../primitives/agr-drawer.ts';
import { drawerContentStyles } from '../header/drawer-content.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrHealthDrawerRequest = Extract<DrawerRequest, { id: 'health' }>;

const HEALTH_META: readonly MetaKind[] = Object.freeze(['connection', 'locale']);
const REPORTING_LABEL = 'Reporting';
const DISCLOSURE_ICON_SIZE = 16;
const LOADING_LABEL = 'Loading';
const COVERAGE_NOTE =
  'Counts only the devices and entry points this dashboard is set up to show. It is not a full system check.';
const PERIMETER_NOTE = 'Only the sensors listed here are monitored. A camera picture is not a monitored entry point.';
const PAUSED_DEVICES_NOTE = 'Statuses return when current states arrive from Home Assistant.';

export class AgrHealthDrawer extends LitElement implements DrawerElement<AgrHealthDrawerRequest> {
  static override styles = [
    focusRingStyles,
    skeletonStyles,
    toneStyles,
    drawerContentStyles,
    css`
      .value[data-tone='attention'] {
        color: var(--agr-brass-ink);
      }
      .value[data-tone='ok'] {
        color: var(--agr-olive-ink);
      }
      /* The healthy list is long and uniform, so it waits behind a disclosure; problems are never collapsed. */
      summary {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: var(--agr-space-2);
        min-block-size: var(--agr-target);
        padding: 0 var(--agr-space-4);
        border-radius: var(--agr-radius-inner);
        font: var(--agr-type-control);
        color: var(--agr-ink);
        background: var(--agr-surface-inset);
        cursor: pointer;
        list-style: none;
      }
      summary::-webkit-details-marker {
        display: none;
      }
      summary svg {
        flex: none;
        color: var(--agr-muted);
        transition: transform var(--agr-dur-1) var(--agr-ease);
      }
      details[open] summary svg {
        transform: rotate(45deg);
      }
      details[open] summary {
        margin-block-end: var(--agr-space-2);
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrHealthDrawerRequest;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : healthEntityIds(this.services.config)),
      HEALTH_META,
    );
  }

  protected override render(): TemplateResult {
    const vm = this.#viewModel();
    return html`<agr-drawer
      heading="House health"
      .demo=${this.services?.mode === 'demo'}
      .theme=${this.services?.theme ?? 'light'}
    >
      ${vm === undefined || vm.state === 'loading' ? html`<span class="skeleton" aria-hidden="true"></span>` : this.#renderBody(vm)}
    </agr-drawer>`;
  }

  #renderBody(vm: HealthDetailsVM): TemplateResult {
    return html`<p class="lead">${vm.headline}</p>
      <p class="note">${COVERAGE_NOTE}</p>
      ${this.#renderEntryPoints(vm)} ${vm.state === 'live' ? this.#renderDeviceStatuses(vm) : this.#renderMonitored(vm)}`;
  }

  #renderEntryPoints(vm: HealthDetailsVM): TemplateResult | typeof nothing {
    if (vm.entryPoints.length === 0) return nothing;
    return html`<section class="group" aria-labelledby="health-entry-points">
      <h3 id="health-entry-points">Monitored entry points</h3>
      <ul class="rows">
        ${vm.entryPoints.map((entry) => this.#row(entry.name, entry.label, entry.tone))}
      </ul>
      <p class="footnote">${PERIMETER_NOTE}</p>
    </section>`;
  }

  #renderDeviceStatuses(vm: HealthDetailsVM): TemplateResult {
    return html`${this.#group('health-not-reporting', 'Not reporting', vm.notReporting, (device) =>
      this.#row(device.name, device.label, 'attention'),
    )}
    ${this.#group('health-loading', 'Still loading', vm.loading, (device) =>
      this.#row(device.name, LOADING_LABEL, 'muted'),
    )}
    ${this.#renderReporting(vm)}`;
  }

  /** Healthy devices by name only, behind a disclosure: the per-row "Reporting" said nothing the heading does not. */
  #renderReporting(vm: HealthDetailsVM): TemplateResult | typeof nothing {
    const count = vm.reporting.length;
    if (count === 0) return nothing;
    return html`<section class="group" aria-labelledby="health-reporting">
      <h3 id="health-reporting">${REPORTING_LABEL} (${count})</h3>
      <details>
        <summary data-focus-key="health-drawer:reporting">
          ${renderIcon('plus', DISCLOSURE_ICON_SIZE)}<span
            >${count === 1 ? 'Show the device' : `Show all ${count}`}</span
          >
        </summary>
        <ul class="rows">
          ${vm.reporting.map((device) => html`<li class="row"><span class="name">${device.name}</span></li>`)}
        </ul>
      </details>
    </section>`;
  }

  /** Paused: names only, no per-device status, so an outage never reads as every device having stopped. */
  #renderMonitored(vm: HealthDetailsVM): TemplateResult | typeof nothing {
    if (vm.monitored.length === 0) return nothing;
    return html`<section class="group" aria-labelledby="health-monitored">
      <h3 id="health-monitored">Monitored devices (${vm.monitored.length})</h3>
      <ul class="rows">
        ${vm.monitored.map((device) => html`<li class="row"><span class="name">${device.name}</span></li>`)}
      </ul>
      <p class="footnote">${PAUSED_DEVICES_NOTE}</p>
    </section>`;
  }

  #group<T>(
    id: string,
    heading: string,
    items: readonly T[],
    row: (item: T) => TemplateResult,
  ): TemplateResult | typeof nothing {
    if (items.length === 0) return nothing;
    return html`<section class="group" aria-labelledby=${id}>
      <h3 id=${id}>${heading} (${items.length})</h3>
      <ul class="rows">
        ${items.map(row)}
      </ul>
    </section>`;
  }

  #row(name: string, label: string, tone: Tone): TemplateResult {
    return html`<li class="row">
      <span class="name">${name}</span><span class="value" data-tone=${tone}>${label}</span>
    </li>`;
  }

  #viewModel(): HealthDetailsVM | undefined {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) return undefined;
    try {
      return selectHealthDetails(selectorInput(services));
    } catch {
      log.error('health-details-select-failed');
      return undefined;
    }
  }
}

defineOnce('agr-health-drawer', AgrHealthDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-health-drawer': AgrHealthDrawer;
  }
}
