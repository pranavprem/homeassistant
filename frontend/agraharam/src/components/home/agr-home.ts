/**
 * Home panel (§5.1, §6.2.1, §18): room chips (at most six, lit rooms first), the Whole-house shortcuts row, at most
 * two vacuum rows, active appliances with idle ones collapsed into a count, and the studio monitors. "All rooms and
 * devices" opens the home drawer when anything is left out.
 *
 * The section holds the ActionController; chips and rows are leaves that emit intent events. It subscribes to every
 * Home entity plus CONTROL_META (Availability depends on services, user and registry) and 'clock' (appliance finish
 * times). Nothing is requested on mount or render: only an activation makes a request, and only one.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ActionController } from '../../ha/actions/action-controller.ts';
import type { ShortcutRole } from '../../config/schema.ts';
import {
  ENABLED,
  newerStatus,
  type ActionRequest,
  type ActionStatus,
  type Availability,
} from '../../ha/actions/types.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { SHORTCUT_COPY, STUDIO_MONITORS_COPY } from '../../model/action-copy.ts';
import {
  homeActionKeys,
  homeEntityIds,
  selectHome,
  type HomeOverviewVM,
  type HomeShortcutVM,
  type HomeStudioMonitorsVM,
} from '../../model/home.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import { sectionHostStyles, skeletonStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import '../primitives/agr-empty-state.ts';
import '../primitives/agr-panel.ts';
import type { PanelPill } from '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import {
  ImmediateTickets,
  panelNotice,
  performFromEvent,
  roomRequest,
  rowStatusText,
  vacuumRequest,
  type RoomQuickDetail,
  type VacuumCommandDetail,
} from './home-actions.ts';
import { deviceRowStyles, rowListStyles, textBlockStyles, wellStyles } from './home-styles.ts';
import './agr-appliance-row.ts';
import './agr-room-chip.ts';
import './agr-vacuum-row.ts';
import '../shared/agr-control-notes.ts';
import { controlNotes, dismissNote, type ControlNote, type NoteSubject } from '../shared/control-notes.ts';
import { panelPill, pausedByConnection } from '../shared/paused.ts';
import { selectorInput } from '../shared/selector-input.ts';

const HEADING_ID = 'agr-home-heading';
const HOME_META: readonly MetaKind[] = Object.freeze([...CONTROL_META, 'clock']);
const STUDIO_MONITORS_REQUEST: ActionRequest = Object.freeze({ kind: 'studio_monitors.run' });
const GHOST_CHIPS: readonly number[] = Object.freeze([0, 1, 2, 3]);
const GHOST_ROWS: readonly number[] = Object.freeze([0, 1, 2]);

export class AgrHome extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    typographyStyles,
    rowListStyles,
    textBlockStyles,
    wellStyles,
    deviceRowStyles,
    css`
      .body {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-3);
      }
      .rooms {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--agr-space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      /* Chips in one row share its height even when one name wraps to two lines. */
      .rooms > li {
        display: grid;
      }
      /* Room chips sit two to a row; in a narrow panel a chip gets the full row, so its name never splits. */
      @container panel (width < ${PANEL_CQ.twoUp}px) {
        .rooms,
        .ghost-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      /* Vacuums, appliances and the studio monitors read as one hairline-separated list of flat device rows. */
      .rows + .rows {
        border-block-start: 1px solid var(--agr-line);
      }
      .studio-action {
        flex: none;
      }
      /* Beside the text buttons in a narrow panel the name wraps rather than truncating ("Studio monit…"). */
      .studio-label,
      .shortcut-label {
        overflow-wrap: break-word;
      }
      .studio-status[data-phase='uncertain'],
      .shortcut-status[data-phase='uncertain'] {
        color: var(--agr-brass-ink);
      }
      .studio-status[data-phase='failed'],
      .shortcut-status[data-phase='failed'] {
        color: var(--agr-danger);
      }
      .shortcut-actions {
        display: flex;
        flex: none;
        gap: var(--agr-space-2);
      }
      .notice {
        margin: 0;
      }
      .all {
        align-self: flex-start;
      }
      /* The live region is always present; it must not add the body's gap (it brings its own spacing when a note
         is visible). */
      agr-control-notes {
        margin-block-start: calc(var(--agr-space-3) * -1);
      }
      .chip-ghost {
        block-size: 48px;
      }
      .row-ghost {
        inline-size: 45%;
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services === undefined ? [] : homeEntityIds(this.services.config, this.services.reader)),
      HOME_META,
    );
  }
  readonly #actions = new ActionController(
    this,
    () => this.services,
    () => (this.services === undefined ? [] : homeActionKeys(this.services.config)),
  );
  readonly #tickets = new ImmediateTickets(this);

  readonly #onRoomQuick = contained('home-room-quick-failed', (event: CustomEvent<RoomQuickDetail>) => {
    event.stopPropagation();
    performFromEvent(this, this.#actions, this.#tickets, roomRequest(event.detail), event);
  });

  readonly #onVacuum = contained('home-vacuum-failed', (event: CustomEvent<VacuumCommandDetail>) => {
    event.stopPropagation();
    performFromEvent(this, this.#actions, this.#tickets, vacuumRequest(event.detail), event);
  });

  readonly #onStudioMonitors = contained('home-studio-monitors-failed', (event: Event) => {
    performFromEvent(this, this.#actions, this.#tickets, STUDIO_MONITORS_REQUEST, event);
  });

  /** Always routed through the confirm dialog: the shortcut's availability asks for confirmation (§18). */
  readonly #onShortcut = contained('home-shortcut-failed', (role: ShortcutRole, event: Event) => {
    performFromEvent(this, this.#actions, this.#tickets, { kind: 'shortcut.run', role }, event);
  });

  readonly #onDismiss = contained('home-dismiss-failed', (event: CustomEvent<ControlNote>) => {
    event.stopPropagation();
    dismissNote(event.detail, this.#actions, this.#tickets);
  });

  readonly #onOpenAll = contained('home-open-all-failed', (event: Event) => {
    requestDrawer(this, { id: 'home' }, event.currentTarget as HTMLElement);
  });

  protected override render(): TemplateResult {
    const services = this.services;
    const vm = services === undefined ? undefined : this.#select(services);
    if (services === undefined || vm === undefined) return this.#renderFrame(this.#renderLoading());
    if (!vm.configured) {
      return this.#renderFrame(
        html`<agr-empty-state
          icon="house"
          heading="No rooms or devices yet"
          message="Rooms, robot vacuums and appliances will show up here once they're connected."
        ></agr-empty-state>`,
      );
    }
    // Disconnected: the header's "Offline" pill and the banner say it; other shared reasons keep their notice.
    const notice = pausedByConnection(services.store) ? undefined : panelNotice(this.#availabilities(vm));
    return this.#renderFrame(
      html`<div
        class="body"
        @agr-home-room-quick=${this.#onRoomQuick}
        @agr-home-vacuum=${this.#onVacuum}
        @agr-dismiss-note=${this.#onDismiss}
      >
        ${notice === undefined ? nothing : html`<p class="notice t-meta">${notice}</p>`}
        ${vm.registryNotice === undefined ? nothing : html`<p class="notice t-meta">${vm.registryNotice}</p>`}
        ${this.#renderRooms(vm)} ${this.#renderDevices(vm)}
        <agr-control-notes .notes=${this.#notes(services, vm)} focus-key-prefix="home"></agr-control-notes>
        ${this.#renderAll(vm)}
      </div>`,
      panelPill(services.store, lightsPill(vm)),
    );
  }

  #select(services: DashboardServices): HomeOverviewVM | undefined {
    try {
      return selectHome(selectorInput(services));
    } catch {
      log.error('home-select-failed');
      return undefined;
    }
  }

  #renderFrame(body: TemplateResult, pill?: PanelPill): TemplateResult {
    return html`<agr-panel heading="Home" heading-id=${HEADING_ID} icon="house" surface="raised" .pill=${pill}>
      ${body}
    </agr-panel>`;
  }

  /** Four chips and three device rows: the shape of the §6.2.1 overview before anything is known. */
  #renderLoading(): TemplateResult {
    return html`<div class="body" aria-hidden="true">
      <div class="ghost-grid">${GHOST_CHIPS.map(() => html`<span class="ghost chip-ghost"></span>`)}</div>
      <div class="devices">
        ${GHOST_ROWS.map(
          () =>
            html`<span class="device-row"><span class="well"></span><span class="skeleton row-ghost"></span></span>`,
        )}
      </div>
    </div>`;
  }

  #renderRooms(vm: HomeOverviewVM): TemplateResult | typeof nothing {
    if (vm.rooms.length === 0) return nothing;
    return html`<ul class="rooms" aria-label="Rooms">
      ${vm.rooms.map((room) => html`<li><agr-room-chip .room=${room}></agr-room-chip></li>`)}
    </ul>`;
  }

  /**
   * The Whole-house shortcuts (lighting, so next to the room chips), vacuums, then appliances and the studio monitors,
   * as one list of flat rows with no gap between its parts.
   */
  #renderDevices(vm: HomeOverviewVM): TemplateResult | typeof nothing {
    const shortcuts = vm.shortcuts === undefined ? nothing : this.#renderShortcuts(vm.shortcuts.buttons);
    const vacuums = this.#renderVacuums(vm);
    const rows = this.#renderRows(vm);
    if (shortcuts === nothing && vacuums === nothing && rows === nothing) return nothing;
    return html`<div class="devices">${shortcuts}${vacuums}${rows}</div>`;
  }

  /**
   * One device row: the label, and one button per configured shortcut. A script reports no state, so the second line
   * is the newest shortcut ticket's progress, named by its button ("Lights: Requested"), or nothing visible at rest.
   */
  #renderShortcuts(buttons: readonly HomeShortcutVM[]): TemplateResult {
    const latest = this.#latestShortcutTicket(buttons);
    const statusText = latest === undefined ? undefined : rowStatusText(latest.status);
    return html`<div class="rows shortcuts">
      <div class="device-row">
        <span class="well" aria-hidden="true">${renderIcon('house')}</span>
        <div class="text">
          <span class="t-body shortcut-label">${SHORTCUT_COPY.label}</span>
          ${
            latest === undefined || statusText === undefined
              ? html`<span class="visually-hidden">${SHORTCUT_COPY.consequence}</span>`
              : html`<span class="shortcut-status t-meta ellipsis" data-phase=${latest.status.phase}
                  >${latest.label}: ${statusText}</span
                >`
          }
        </div>
        <div class="shortcut-actions" role="group" aria-label=${SHORTCUT_COPY.groupLabel}>
          ${buttons.map(
            (button) =>
              html`<agr-button
                label=${button.label}
                accessible-label=${button.accessibleLabel}
                focus-key=${`home:shortcut:${button.role}`}
                reason-display="hidden"
                opens-dialog
                .availability=${button.availability}
                @agr-activate=${(event: Event) => this.#onShortcut(button.role, event)}
              ></agr-button>`,
          )}
        </div>
      </div>
    </div>`;
  }

  /** The newest ticket across the shortcut buttons, with the label of the button it belongs to. */
  #latestShortcutTicket(
    buttons: readonly HomeShortcutVM[],
  ): { readonly label: string; readonly status: ActionStatus } | undefined {
    let latest: { readonly label: string; readonly status: ActionStatus } | undefined;
    for (const button of buttons) {
      const status = this.#tickets.current(`shortcut:${button.role}`, button.pending);
      if (status !== undefined && newerStatus(latest?.status, status) === status)
        latest = { label: button.label, status };
    }
    return latest;
  }

  #renderVacuums(vm: HomeOverviewVM): TemplateResult | typeof nothing {
    if (vm.vacuums.length === 0) return nothing;
    return html`<ul class="rows vacuums" aria-label="Robot vacuums">
      ${vm.vacuums.map((vacuum) => html`<li><agr-vacuum-row .vacuum=${vacuum}></agr-vacuum-row></li>`)}
    </ul>`;
  }

  /** Appliances, the idle count and the studio monitors share one hairline-separated list. */
  #renderRows(vm: HomeOverviewVM): TemplateResult | typeof nothing {
    const rows: TemplateResult[] = vm.appliances.map(
      (appliance) => html`<li><agr-appliance-row .appliance=${appliance}></agr-appliance-row></li>`,
    );
    if (vm.idleCount > 0) rows.push(html`<li><agr-appliance-row .idle=${vm.idleCount}></agr-appliance-row></li>`);
    if (vm.studioMonitors !== undefined) rows.push(html`<li>${this.#renderStudioMonitors(vm.studioMonitors)}</li>`);
    if (rows.length === 0) return nothing;
    return html`<ul class="rows" aria-label="Appliances and devices">
      ${rows}
    </ul>`;
  }

  #renderStudioMonitors(studio: HomeStudioMonitorsVM): TemplateResult {
    const status = this.#tickets.current('studio_monitors', studio.pending);
    const statusText = rowStatusText(status);
    // A script reports no on or off, so the row never claims one (§8.2): at rest it shows only the name, the button
    // names the action ("Switch monitors", never a power glyph that reads as a state toggle), and a ticket's
    // progress ("Requested") takes the second line.
    return html`<div class="studio device-row">
      <span class="well" aria-hidden="true">${renderIcon('speaker')}</span>
      <div class="text">
        <span class="t-body studio-label">${studio.label}</span>
        ${
          statusText === undefined
            ? html`<span class="visually-hidden">${STUDIO_MONITORS_COPY.consequence}</span>`
            : html`<span class="studio-status t-meta ellipsis" data-phase=${status?.phase ?? nothing}
                >${statusText}</span
              >`
        }
      </div>
      <agr-button
        class="studio-action"
        label=${STUDIO_MONITORS_COPY.button}
        focus-key="home:studio-monitors"
        reason-display="hidden"
        .availability=${studio.availability}
        @agr-activate=${this.#onStudioMonitors}
      ></agr-button>
    </div>`;
  }

  #renderAll(vm: HomeOverviewVM): TemplateResult | typeof nothing {
    const hidden = vm.roomsOverflow + vm.vacuumsOverflow + vm.appliancesOverflow + vm.idleCount;
    if (hidden === 0) return nothing;
    return html`<agr-button
      class="all"
      label="All rooms and devices"
      opens-dialog
      focus-key="home:all"
      .availability=${ENABLED}
      @agr-activate=${this.#onOpenAll}
    ></agr-button>`;
  }

  #availabilities(vm: HomeOverviewVM): (Availability | undefined)[] {
    return [
      ...vm.rooms.map((room) => room.quickToggle?.availability),
      ...(vm.shortcuts?.buttons ?? []).map((button) => button.availability),
      ...vm.vacuums.flatMap((vacuum) => [vacuum.start, vacuum.pause, vacuum.returnHome]),
      vm.studioMonitors?.availability,
    ];
  }

  /**
   * Every Home ticket the live region reports, including rooms the budget left out of the overview. Rows and chips
   * show their own progress, so only outcomes that need acknowledging are visible (§7.2).
   */
  #notes(services: DashboardServices, vm: HomeOverviewVM): readonly ControlNote[] {
    const subjects: NoteSubject[] = [
      ...services.config.rooms.map((room, index) => ({ key: `room:${index}` as const, name: `${room.name} lights` })),
      ...(vm.shortcuts?.buttons ?? []).map((button) => ({
        key: `shortcut:${button.role}` as const,
        name: button.accessibleLabel,
      })),
      ...vm.vacuums.map((vacuum) => ({ key: `entity:${vacuum.key}` as const, name: vacuum.name })),
      ...(vm.studioMonitors === undefined
        ? []
        : [{ key: 'studio_monitors' as const, name: STUDIO_MONITORS_COPY.label }]),
    ];
    return controlNotes(
      subjects,
      (key) => this.#tickets.current(key, services.gateway.status(key)),
      (key) => this.#actions.draftState(key),
      'announced',
    );
  }
}

/** "2 lights on" while live; nothing when everything is off or values are not current. */
function lightsPill(vm: HomeOverviewVM): PanelPill | undefined {
  if (vm.lightsOn === null || vm.lightsOn === 0) return undefined;
  return { label: vm.lightsOn === 1 ? '1 light on' : `${vm.lightsOn} lights on`, tone: 'ok' };
}

defineOnce('agr-home', AgrHome);

declare global {
  interface HTMLElementTagNameMap {
    'agr-home': AgrHome;
  }
}
