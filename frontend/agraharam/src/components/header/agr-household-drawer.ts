/**
 * Household drawer (§5.3, §6.3): opened from the compact header's menu, so it is always a bottom sheet. It holds what
 * the compact header has no room for: presence (initials and names, Home/Away/Unknown only), the full date, the
 * connection state and, for administrators with diagnostics enabled, the Diagnostics link, which replaces this
 * drawer (the overlay host keeps the menu button as the focus restore target).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ENABLED } from '../../ha/actions/types.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { headerEntityIds, selectHousehold, type HouseholdVM } from '../../model/header.ts';
import { skeletonStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import '../primitives/agr-drawer.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer, type DrawerElement, type DrawerRequest } from '../shell/overlay-types.ts';
import './agr-connection-indicator.ts';
import { avatarStyles, renderAvatar } from './agr-presence.ts';
import { drawerContentStyles } from './drawer-content.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrHouseholdDrawerRequest = Extract<DrawerRequest, { id: 'household' }>;

const HOUSEHOLD_META: readonly MetaKind[] = Object.freeze(['connection', 'locale', 'clock', 'user']);

export class AgrHouseholdDrawer extends LitElement implements DrawerElement<AgrHouseholdDrawerRequest> {
  static override styles = [
    skeletonStyles,
    visuallyHiddenStyles,
    avatarStyles,
    drawerContentStyles,
    css`
      :host {
        --agr-avatar-cutout: var(--agr-surface-inset);
      }
      .today {
        margin: 0 0 var(--agr-space-6);
      }
      .today .lead {
        margin: 0;
      }
      .person {
        justify-content: flex-start;
      }
      .person .name {
        flex: 1 1 auto;
      }
      .connection {
        justify-content: flex-start;
      }
      .connection agr-connection-indicator {
        min-block-size: 0;
      }
      .detail {
        margin: var(--agr-space-2) 0 0;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrHouseholdDrawerRequest;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : headerEntityIds(this.services.config)),
      HOUSEHOLD_META,
    );
  }

  protected override render(): TemplateResult {
    const vm = this.#viewModel();
    return html`<agr-drawer
      heading="Household"
      sheet="bottom"
      .demo=${this.services?.mode === 'demo'}
      .theme=${this.services?.theme ?? 'light'}
    >
      ${vm === undefined ? html`<span class="skeleton" aria-hidden="true"></span>` : this.#renderBody(vm)}
    </agr-drawer>`;
  }

  #renderBody(vm: HouseholdVM): TemplateResult {
    // The compact header right behind this sheet already shows the time, so the sheet adds only the full date.
    return html`<div class="today">
        <p class="lead">${vm.date}</p>
      </div>
      ${
        vm.people.length === 0
          ? nothing
          : html`<section class="group" aria-labelledby="household-people">
              <h3 id="household-people">Presence</h3>
              <ul class="rows">
                ${vm.people.map(
                  (person) =>
                    html`<li class="row person">
                      ${renderAvatar(person)}<span class="name">${person.name}</span
                      ><span class="state value" data-presence=${person.presence}>${person.label}</span>
                    </li>`,
                )}
              </ul>
            </section>`
      }
      <section class="group" aria-labelledby="household-connection">
        <h3 id="household-connection">Home Assistant</h3>
        <div class="rows">
          <div class="row connection">
            <agr-connection-indicator show-label .connection=${vm.connection}></agr-connection-indicator>
          </div>
        </div>
        ${vm.connectionDetail === undefined ? nothing : html`<p class="detail">${vm.connectionDetail}</p>`}
      </section>
      ${
        vm.diagnosticsAvailable
          ? html`<agr-button
              label="Diagnostics"
              opens-dialog
              icon="info"
              focus-key="household:diagnostics"
              .availability=${ENABLED}
              @agr-activate=${this.#onDiagnostics}
            ></agr-button>`
          : nothing
      }`;
  }

  #viewModel(): HouseholdVM | undefined {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) return undefined;
    try {
      return selectHousehold(selectorInput(services));
    } catch {
      log.error('household-select-failed');
      return undefined;
    }
  }

  readonly #onDiagnostics = contained('household-diagnostics-failed', (event: Event) => {
    requestDrawer(this, { id: 'diagnostics' }, event.currentTarget as HTMLElement);
  });
}

defineOnce('agr-household-drawer', AgrHouseholdDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-household-drawer': AgrHouseholdDrawer;
  }
}
