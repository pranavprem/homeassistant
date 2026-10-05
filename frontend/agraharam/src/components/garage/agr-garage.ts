/**
 * Garage & car section (§8.5). The door shows its actual position and offers explicit "Open garage" and "Close
 * garage" buttons, never a toggle. Each button routes through agr-confirm-dialog (the gateway marks garage actions
 * confirm-required), so a tap alone moves nothing and Cancel sends nothing. Vehicle telemetry is read-only.
 *
 * The section's single polite live region reports the door's ticket, with Dismiss for uncertain and failed outcomes
 * (§7.2); agr-button's own status text is not used, so the door's progress is worded in one place.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId, ResolvedConfig } from '../../config/schema.ts';
import { ActionController } from '../../ha/actions/action-controller.ts';
import type { ActionRequest, ActionStatus, Availability } from '../../ha/actions/types.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { GARAGE_BUTTON_LABELS } from '../../model/action-copy.ts';
import { DOOR_POSITION_UNKNOWN_LINE, selectGarage } from '../../model/garage.ts';
import type { GarageDoorVM, GarageVM } from '../../model/types.ts';
import { focusRingStyles, sectionHostStyles, skeletonStyles, toneStyles } from '../../styles/shared.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { isDefined } from '../../util/defined.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import type { AgrButton } from '../primitives/agr-button.ts';
import '../primitives/agr-empty-state.ts';
import '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import { requestConfirm } from '../shell/overlay-types.ts';
import './agr-vehicle.ts';
import '../shared/agr-control-notes.ts';
import { controlNotes, type ControlNote } from '../shared/control-notes.ts';
import { panelPill, pausedByConnection } from '../shared/paused.ts';
import { selectorInput } from '../shared/selector-input.ts';

const HEADING_ID = 'agr-garage-heading';
const DEFAULT_HEADING = 'Garage & car';
const DOOR_ICON_SIZE = 22;
const LAST_KNOWN = 'Last known';

/** Reasons that describe the whole panel rather than one button; they are shown once (§16.10). */
const PANEL_LEVEL_REASONS: ReadonlySet<string> = new Set(['controls-off', 'preview', 'disconnected']);

/** The door row and the car block as placeholders, so the panel keeps its shape until states arrive. */
const GHOST_BODY = html`<div class="body" aria-hidden="true">
  <span class="ghost door-ghost"></span>
  <hr class="divider" />
  <span class="ghost vehicle-ghost"></span>
</div>`;

type DoorAction = 'open' | 'close';
type DisabledAvailability = Extract<Availability, { enabled: false }>;
const DOOR_REQUESTS: Readonly<Record<DoorAction, ActionRequest>> = Object.freeze({
  open: Object.freeze({ kind: 'garage.open' }),
  close: Object.freeze({ kind: 'garage.close' }),
});

export class AgrGarage extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    typographyStyles,
    toneStyles,
    focusRingStyles,
    css`
      .body {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-4);
      }
      .door {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        column-gap: var(--agr-space-3);
        row-gap: var(--agr-space-2);
        padding: var(--agr-space-3) var(--agr-space-3) var(--agr-space-3) var(--agr-space-4);
        border-radius: var(--agr-radius-inner);
        background: var(--agr-surface-inset);
      }
      .door-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 40px;
        block-size: 40px;
        border-radius: 50%;
        color: var(--agr-muted);
        background: var(--agr-surface);
      }
      .door-icon[data-position='open'],
      .door-icon[data-position='opening'],
      .door-icon[data-position='closing'] {
        color: var(--agr-brass-ink);
        background: var(--agr-brass-tint);
      }
      .door-state {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
      }
      .door-state p {
        margin: 0;
      }
      .door-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .position {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        column-gap: var(--agr-space-2);
      }
      .door-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--agr-space-2);
        justify-self: end;
      }
      /* Two buttons (position unknown or moving) take their own row under the state, aligned with its text. */
      .door[data-stacked] .door-actions {
        grid-column: 2 / -1;
        justify-self: start;
      }
      /* A door with no live position (unavailable, not found, offline) states why in muted sans, not as a value. */
      .door-status {
        font: var(--agr-type-strong);
      }
      .reason {
        grid-column: 2 / -1;
        margin: 0;
        color: var(--agr-muted);
      }
      @container panel (width < ${PANEL_CQ.garageDoorStacked}px) {
        .door-actions {
          grid-column: 2 / -1;
          justify-self: start;
        }
      }
      .divider {
        block-size: 1px;
        margin: 0;
        border: none;
        background: var(--agr-line);
      }
      .door-ghost {
        block-size: 68px;
      }
      .vehicle-ghost {
        block-size: 116px;
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  // Registered for their side effects: re-render on bound entity, control-meta and garage ticket changes.
  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => boundIds(this.services?.config),
      CONTROL_META,
    );
  }
  readonly #actions = new ActionController(
    this,
    () => this.services,
    () => ['garage'],
  );
  protected override render(): TemplateResult {
    const services = this.services;
    const config = services?.config;
    if (services === undefined || config === undefined || services.store?.isReady() !== true) {
      return this.#frame(config === undefined ? DEFAULT_HEADING : headingFor(config), GHOST_BODY);
    }
    let vm: GarageVM;
    try {
      vm = selectGarage(selectorInput(services));
    } catch {
      log.error('garage-select-failed');
      return this.#frame(headingFor(config), html`<span class="skeleton" aria-hidden="true"></span>`);
    }
    return this.#frame(headingFor(config), this.#renderBody(vm), showsNothing(vm));
  }

  /**
   * When the panel takes its column's slack (§6.2), the car stays under the door and the slack collects below. A
   * panel with nothing to show (`fit`: no car, and a door Home Assistant doesn't have) never stretches (§16.13).
   */
  #frame(heading: string, body: TemplateResult, fit = false): TemplateResult {
    return html`<agr-panel
      .heading=${heading}
      heading-id=${HEADING_ID}
      icon="garage-door"
      surface="raised"
      ?fit=${fit}
      .pill=${panelPill(this.services?.store)}
      >${body}</agr-panel
    >`;
  }

  #renderBody(vm: GarageVM): TemplateResult {
    if (vm.door === undefined && vm.vehicle === undefined) {
      return html`<agr-empty-state
        icon="garage-door"
        heading="Garage isn't connected yet"
        message="The garage door and car will show up here once they're connected."
      ></agr-empty-state>`;
    }
    return html`<div class="body">
      ${vm.door ? this.#renderDoor(vm.door) : nothing} ${vm.door && vm.vehicle ? html`<hr class="divider" />` : nothing}
      ${vm.vehicle ? html`<agr-vehicle .vm=${vm.vehicle}></agr-vehicle>` : nothing}
    </div>`;
  }

  #renderDoor(door: GarageDoorVM): TemplateResult {
    const stale = door.status === 'disconnected' && door.position !== 'unknown';
    const offered = (['open', 'close'] as const).filter((action) => door[action] !== undefined);
    const availabilities = offered.map((action) => door[action] as Availability);
    // Without a device to act on (unavailable, not found, offline with no last position) or a known position, buttons
    // would only be clutter or a false offer; the label and the one reason line say why nothing can be done.
    const positionUnknown = door.position === 'unknown' && hasPosition(door);
    const buttons = hasPosition(door) && !positionUnknown ? offered : [];
    const ticket = door.pending;
    return html`<div class="door-block">
      <div class="door" ?data-stacked=${buttons.length > 1}>
        <span class="door-icon" data-position=${door.position} aria-hidden="true"
          >${renderIcon('garage-door', DOOR_ICON_SIZE)}</span
        >
        <div class="door-state">
          <p class="door-name t-meta">${door.name}</p>
          ${
            door.status === 'loading'
              ? html`<span class="skeleton" aria-hidden="true"></span>`
              : html`<p class="position">
                  <span
                    class=${hasPosition(door) && !positionUnknown ? 't-value' : 'door-status'}
                    data-tone=${door.tone}
                    >${door.label}</span
                  >
                  ${stale ? html`<span class="t-meta">${LAST_KNOWN}</span>` : nothing}
                </p>`
          }
        </div>
        ${
          buttons.length > 0
            ? html`<div class="door-actions">
                ${buttons.map((action) => this.#renderDoorButton(action, door[action] as Availability))}
              </div>`
            : nothing
        }
        ${
          positionUnknown
            ? html`<p class="reason t-meta">${DOOR_POSITION_UNKNOWN_LINE}</p>`
            : this.#renderReason(availabilities, ticket !== undefined)
        }
      </div>
      <agr-control-notes
        .notes=${this.#notes(door, ticket)}
        focus-key-prefix="garage"
        @agr-dismiss-note=${this.#onDismiss}
      ></agr-control-notes>
    </div>`;
  }

  #renderDoorButton(action: DoorAction, availability: Availability): TemplateResult {
    return html`<agr-button
      label=${GARAGE_BUTTON_LABELS[action]}
      focus-key=${`garage:${action}`}
      variant="quiet"
      reason-display="hidden"
      .availability=${availability}
      @agr-activate=${(event: Event) => this.#onDoorActivate(action, event)}
    ></agr-button>`;
  }

  /**
   * The buttons keep their reasons in aria-describedby; the visible reason is one line under the door state, shown
   * once even when both buttons share it. 'busy' is left to the ticket text when one is shown.
   */
  #renderReason(availabilities: readonly Availability[], ticketShown: boolean): TemplateResult | typeof nothing {
    const disabled = availabilities.filter(
      (availability): availability is DisabledAvailability =>
        !availability.enabled && !(ticketShown && availability.reason === 'busy'),
    );
    if (disabled.length === 0) return nothing;
    const panelLevel = disabled.find((availability) => PANEL_LEVEL_REASONS.has(availability.reason));
    // Disconnected: the header's "Offline" pill and the banner say it; the buttons keep it in aria-describedby.
    if (panelLevel?.reason === 'disconnected' && pausedByConnection(this.services?.store)) return nothing;
    const text = panelLevel?.message ?? [...new Set(disabled.map((availability) => availability.message))].join(' ');
    return html`<p class="reason t-meta">${text}</p>`;
  }

  /** The door's ticket for the live region: its progress shows there, as the buttons show none (§7.2). */
  #notes(door: GarageDoorVM, status: ActionStatus | undefined): readonly ControlNote[] {
    return controlNotes(
      [{ key: 'garage', name: door.name }],
      () => status,
      (key) => this.#actions.draftState(key),
    );
  }

  /**
   * §7.1: garage actions always need confirmation, so an enabled tap only ever opens agr-confirm-dialog (the one
   * minter of the confirmation token request() needs); the panel itself never requests a door movement.
   */
  readonly #onDoorActivate = contained('garage-activate-failed', (action: DoorAction, event: Event) => {
    const request = DOOR_REQUESTS[action];
    if (!this.#actions.evaluate(request).enabled) return;
    requestConfirm(this, request, event.currentTarget as AgrButton);
  });

  readonly #onDismiss = contained('garage-dismiss-failed', (event: Event) => {
    event.stopPropagation();
    this.services?.gateway.dismiss('garage');
    this.requestUpdate();
    // The Dismiss button disappears; keep focus on the door's remaining control, or on the panel heading when the
    // door offers none (unavailable, not found), instead of dropping it to the page.
    void this.updateComplete
      .then(() => {
        const control = this.renderRoot.querySelector<HTMLElement>('agr-button');
        const heading = this.renderRoot.querySelector('agr-panel')?.shadowRoot?.getElementById(HEADING_ID);
        (control ?? heading)?.focus();
      })
      .catch(() => log.error('garage-focus-failed'));
  });
}

/**
 * No car, and the configured door is one Home Assistant doesn't have: an empty state, not a panel to stretch. An
 * unavailable door is a real device that may come back at any moment, so its panel keeps its place in the column.
 */
function showsNothing(vm: GarageVM): boolean {
  return vm.vehicle === undefined && (vm.door === undefined || vm.door.status === 'missing-binding');
}

/** The door reports a position (live, unknown or last known), so Open and Close are meaningful to show. */
function hasPosition(door: GarageDoorVM): boolean {
  return (
    door.status === 'available' ||
    door.status === 'unknown' ||
    (door.status === 'disconnected' && door.position !== 'unknown')
  );
}

function headingFor(config: ResolvedConfig): string {
  if (config.garage !== undefined && config.vehicle !== undefined) return DEFAULT_HEADING;
  return config.garage !== undefined ? 'Garage' : 'Car';
}

function boundIds(config: ResolvedConfig | undefined): EntityId[] {
  if (config === undefined) return [];
  const ids: (EntityId | undefined)[] = [config.garage?.cover];
  const vehicle = config.vehicle;
  if (vehicle !== undefined) {
    ids.push(vehicle.battery, vehicle.range, vehicle.chargerStatus, vehicle.chargerPower, vehicle.sessionEnergy);
  }
  return ids.filter(isDefined);
}

defineOnce('agr-garage', AgrGarage);

declare global {
  interface HTMLElementTagNameMap {
    'agr-garage': AgrGarage;
  }
}
