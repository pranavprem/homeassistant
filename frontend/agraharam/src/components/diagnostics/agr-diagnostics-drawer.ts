/**
 * Diagnostics drawer (§5.1, §5.3): admin-only, and only with `diagnostics: true`. It is the one place entity IDs
 * appear. It shows the build and any version conflict, the connection and HA version (never the rest of HA's
 * config), whether controls are on, the controller status lines from the StatusBoard, every binding with its status
 * and capabilities, each camera's gate decision, the last tickets from gateway.recent() and the config
 * warnings. It subscribes to the board and to every ticket, so it is current whenever it is open and loses nothing
 * while closed.
 */
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import type { Unsubscribe } from '../../ha/host.ts';
import { ABSENT_LABELS } from '../../ha/normalize.ts';
import { diagnosticsEntityIds, selectDiagnostics, type DiagnosticsView } from '../../model/diagnostics.ts';
import type { DiagnosticsVM } from '../../model/types.ts';
import { skeletonStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { isDefined } from '../../util/defined.ts';
import { log } from '../../util/log.ts';
import { APP_VERSION, GIT_SHA } from '../../version.ts';
import '../primitives/agr-drawer.ts';
import { drawerContentStyles } from '../header/drawer-content.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrDiagnosticsDrawerRequest = Extract<DrawerRequest, { id: 'diagnostics' }>;

const NOT_AVAILABLE =
  'Diagnostics are shown to Home Assistant administrators when the dashboard configuration enables them.';
const HOST_LABELS: Readonly<Record<DiagnosticsVM['hostKind'], string>> = Object.freeze({
  hass: 'Home Assistant',
  demo: 'Demo (fictional data)',
});

export class AgrDiagnosticsDrawer extends LitElement implements DrawerElement<AgrDiagnosticsDrawerRequest> {
  static override styles = [
    skeletonStyles,
    drawerContentStyles,
    css`
      dt,
      dd {
        margin: 0;
      }
      .binding {
        flex-direction: column;
        align-items: stretch;
        gap: 2px;
      }
      .binding-head {
        display: flex;
        justify-content: space-between;
        gap: var(--agr-space-3);
      }
      .meta {
        font: var(--agr-type-meta);
        color: var(--agr-muted);
        overflow-wrap: anywhere;
      }
      .entity {
        font: var(--agr-type-meta);
        color: var(--agr-ink);
        overflow-wrap: anywhere;
      }
      .warning-code {
        color: var(--agr-brass-ink);
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrDiagnosticsDrawerRequest;

  #unsubscribers: Unsubscribe[] = [];
  #watched: DashboardServices | undefined;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => this.#entityIds(),
      CONTROL_META,
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#watch();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#unwatch();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (this.isConnected && this.services !== this.#watched) this.#watch();
  }

  protected override render(): TemplateResult {
    const vm = this.#viewModel();
    return html`<agr-drawer
      heading="Diagnostics"
      .demo=${this.services?.mode === 'demo'}
      .theme=${this.services?.theme ?? 'light'}
    >
      ${vm === undefined ? html`<span class="skeleton" aria-hidden="true"></span>` : this.#renderBody(vm)}
    </agr-drawer>`;
  }

  #renderBody(vm: DiagnosticsView): TemplateResult {
    if (!vm.available) return html`<p class="note">${NOT_AVAILABLE}</p>`;
    return html`${this.#renderSummary(vm)} ${this.#renderStatusLines(vm)} ${this.#renderBindings(vm)}
    ${this.#renderCameras(vm)} ${this.#renderRecent(vm)} ${this.#renderWarnings(vm)}`;
  }

  #renderSummary(vm: DiagnosticsView): TemplateResult {
    return html`<section class="group" aria-labelledby="diag-build">
      <h3 id="diag-build">Build and connection</h3>
      <dl class="rows">
        ${this.#pair('Version', vm.version)} ${this.#pair('Git commit', vm.gitSha)}
        ${this.#pair('Bundle', vm.bundle ?? 'No other version loaded')} ${this.#pair('Host', HOST_LABELS[vm.hostKind])}
        ${this.#pair('Connection', vm.connection.label)}
        ${this.#pair('Home Assistant version', vm.haVersion ?? 'Not reported')}
        ${this.#pair('Controls', vm.controls ? 'On' : 'Off (controls: false)')}
      </dl>
    </section>`;
  }

  #renderStatusLines(vm: DiagnosticsView): TemplateResult {
    return html`<section class="group" aria-labelledby="diag-status">
      <h3 id="diag-status">Status</h3>
      <dl class="rows">
        ${this.#pair('Forecast', sentenceCase(vm.forecast))}
        ${this.#pair('Live view', sentenceCase(vm.liveViewDetail ?? 'Not opened'))}
        ${this.#pair('Calendar', sentenceCase(vm.calendar ?? 'Not started'))}
      </dl>
    </section>`;
  }

  #renderBindings(vm: DiagnosticsView): TemplateResult {
    return html`<section class="group" aria-labelledby="diag-bindings">
      <h3 id="diag-bindings">Bindings (${vm.bindings.length})</h3>
      <ul class="rows">
        ${vm.bindings.map(
          (binding) =>
            html`<li class="row binding">
              <span class="binding-head"
                ><span class="entity">${binding.entity}</span
                ><span class="value"
                  >${binding.status === 'available' ? 'Available' : ABSENT_LABELS[binding.status]}</span
                ></span
              >
              <span class="meta"
                >${binding.role}${binding.derived ? ', derived' : ''}${
                  binding.features === undefined ? '' : `, features ${binding.features}`
                }</span
              >
            </li>`,
        )}
      </ul>
    </section>`;
  }

  #renderCameras(vm: DiagnosticsView): TemplateResult | typeof nothing {
    if (vm.cameras.length === 0) return nothing;
    return html`<section class="group" aria-labelledby="diag-cameras">
      <h3 id="diag-cameras">Cameras</h3>
      <dl class="rows">${vm.cameras.map((camera) => this.#pair(camera.name, sentenceCase(camera.gate)))}</dl>
    </section>`;
  }

  #renderRecent(vm: DiagnosticsView): TemplateResult {
    return html`<section class="group" aria-labelledby="diag-recent">
      <h3 id="diag-recent">Recent actions</h3>
      ${
        vm.recentActions.length === 0
          ? html`<p class="footnote">No actions this session.</p>`
          : html`<dl class="rows">
              ${vm.recentActions.map((action) =>
                this.#pair(
                  action.kind,
                  sentenceCase(
                    [action.phase, action.code, action.ms === undefined ? undefined : `${action.ms} ms`]
                      .filter(isDefined)
                      .join(', '),
                  ),
                ),
              )}
            </dl>`
      }
    </section>`;
  }

  #renderWarnings(vm: DiagnosticsView): TemplateResult {
    return html`<section class="group" aria-labelledby="diag-warnings">
      <h3 id="diag-warnings">Configuration warnings</h3>
      ${
        vm.configWarnings.length === 0
          ? html`<p class="footnote">None.</p>`
          : html`<ul class="rows">
              ${vm.configWarnings.map(
                (warning) =>
                  html`<li class="row binding">
                    <span class="binding-head"
                      ><span class="entity">${warning.path || 'card'}</span
                      ><span class="value warning-code">${warning.code}</span></span
                    >
                    <span class="meta">${warning.message}</span>
                  </li>`,
              )}
            </ul>`
      }
    </section>`;
  }

  #pair(term: string, value: string): TemplateResult {
    return html`<div class="row">
      <dt class="name">${term}</dt>
      <dd class="value">${value}</dd>
    </div>`;
  }

  /** Bindings plus derived batteries; derivation reads the registry, so it is recomputed on every update. */
  #entityIds(): EntityId[] {
    const services = this.services;
    if (services?.config === undefined || services.store === undefined || services.reader === undefined) return [];
    try {
      return diagnosticsEntityIds(services.config, services.reader, services.store);
    } catch {
      log.error('diagnostics-entity-ids-failed');
      return [...services.config.bindings.keys()];
    }
  }

  #viewModel(): DiagnosticsView | undefined {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) return undefined;
    try {
      return selectDiagnostics({
        ...selectorInput(services),
        status: services.status,
        warnings: services.warnings,
        version: APP_VERSION,
        gitSha: GIT_SHA,
      });
    } catch {
      log.error('diagnostics-select-failed');
      return undefined;
    }
  }

  /** Re-render on any status line or ticket; resubscribe when the root publishes new services. */
  #watch(): void {
    this.#unwatch();
    const services = this.services;
    this.#watched = services;
    if (services?.status === undefined || services.gateway === undefined) return;
    const refresh = (): void => this.requestUpdate();
    this.#unsubscribers = [services.status.subscribe(refresh), services.gateway.subscribe('*', refresh)];
  }

  #unwatch(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    this.#watched = undefined;
  }
}

/**
 * Status lines come from controllers as lower-case codes ("hourly live", "ready", "closed: Privacy on"); shown as
 * values they start with a capital like every other value in the drawer ("Connected", "Not opened").
 */
function sentenceCase(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

defineOnce('agr-diagnostics-drawer', AgrDiagnosticsDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-diagnostics-drawer': AgrDiagnosticsDrawer;
  }
}
