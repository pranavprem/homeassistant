/**
 * "All rooms and devices" (§5.3, §6.2.1): every room (each chip opens its room drawer, which replaces this one), every
 * vacuum row and every appliance row, uncut and in configuration order. It holds its own ActionController and
 * single polite live region, exactly like the Home panel, and subscribes to 'clock' for appliance finish times.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ActionController } from '../../ha/actions/action-controller.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { homeActionKeys, homeEntityIds, selectHomeDetail, type HomeDetailVM } from '../../model/home.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-drawer.ts';
import '../primitives/agr-empty-state.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import '../shared/agr-control-notes.ts';
import { controlNotes, dismissNote, type ControlNote, type NoteSubject } from '../shared/control-notes.ts';
import {
  ImmediateTickets,
  panelNotice,
  performFromEvent,
  roomRequest,
  vacuumRequest,
  type RoomQuickDetail,
  type VacuumCommandDetail,
} from './home-actions.ts';
import { drawerGroupStyles, rowListStyles } from './home-styles.ts';
import './agr-appliance-row.ts';
import './agr-room-chip.ts';
import './agr-vacuum-row.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrHomeDrawerRequest = Extract<DrawerRequest, { id: 'home' }>;

const HOME_META: readonly MetaKind[] = Object.freeze([...CONTROL_META, 'clock']);

export class AgrHomeDrawer extends LitElement implements DrawerElement<AgrHomeDrawerRequest> {
  static override styles = [
    typographyStyles,
    drawerGroupStyles,
    rowListStyles,
    css`
      .rooms {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--agr-space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      @media (width < 360px) {
        .rooms {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .rows {
        padding-inline: var(--agr-space-1);
      }
      agr-control-notes:not([quiet]) {
        margin-block-end: var(--agr-space-2);
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrHomeDrawerRequest;

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

  readonly #onRoomQuick = contained('home-drawer-room-quick-failed', (event: CustomEvent<RoomQuickDetail>) => {
    event.stopPropagation();
    performFromEvent(this, this.#actions, this.#tickets, roomRequest(event.detail), event);
  });

  readonly #onVacuum = contained('home-drawer-vacuum-failed', (event: CustomEvent<VacuumCommandDetail>) => {
    event.stopPropagation();
    performFromEvent(this, this.#actions, this.#tickets, vacuumRequest(event.detail), event);
  });

  readonly #onDismiss = contained('home-drawer-dismiss-failed', (event: CustomEvent<ControlNote>) => {
    event.stopPropagation();
    dismissNote(event.detail, this.#actions, this.#tickets);
  });

  protected override render(): TemplateResult {
    const vm = this.#select();
    return html`<agr-drawer
      heading="All rooms and devices"
      .demo=${this.services.mode === 'demo'}
      .theme=${this.services.theme}
    >
      ${vm === undefined ? this.#renderUnavailable() : this.#renderDetail(vm)}
    </agr-drawer>`;
  }

  #select(): HomeDetailVM | undefined {
    try {
      return selectHomeDetail(selectorInput(this.services));
    } catch {
      log.error('home-drawer-select-failed');
      return undefined;
    }
  }

  #renderUnavailable(): TemplateResult {
    return html`<agr-empty-state
      icon="house"
      heading="Rooms and devices can't be shown"
      message="Close this panel and open it again."
    ></agr-empty-state>`;
  }

  #renderDetail(vm: HomeDetailVM): TemplateResult {
    const notice = panelNotice([
      ...vm.rooms.map((room) => room.quickToggle?.availability),
      ...vm.vacuums.flatMap((vacuum) => [vacuum.start, vacuum.pause, vacuum.returnHome]),
    ]);
    return html`<div
      @agr-home-room-quick=${this.#onRoomQuick}
      @agr-home-vacuum=${this.#onVacuum}
      @agr-dismiss-note=${this.#onDismiss}
    >
      ${notice === undefined ? nothing : html`<p class="notice t-meta">${notice}</p>`}
      <agr-control-notes .notes=${this.#notes(vm)} focus-key-prefix="home-drawer"></agr-control-notes>
      ${this.#renderRooms(vm)} ${this.#renderVacuums(vm)} ${this.#renderAppliances(vm)}
    </div>`;
  }

  #renderRooms(vm: HomeDetailVM): TemplateResult | typeof nothing {
    if (vm.rooms.length === 0) return nothing;
    return html`<section class="group">
      <h3 class="t-label">Rooms</h3>
      <ul class="rooms">
        ${vm.rooms.map(
          (room) => html`<li><agr-room-chip .room=${room} focus-key-prefix="home-drawer:room"></agr-room-chip></li>`,
        )}
      </ul>
    </section>`;
  }

  #renderVacuums(vm: HomeDetailVM): TemplateResult | typeof nothing {
    if (vm.vacuums.length === 0) return nothing;
    return html`<section class="group">
      <h3 class="t-label">Robot vacuums</h3>
      <ul class="stack">
        ${vm.vacuums.map(
          (vacuum) =>
            html`<li><agr-vacuum-row .vacuum=${vacuum} focus-key-prefix="home-drawer:vacuum"></agr-vacuum-row></li>`,
        )}
      </ul>
    </section>`;
  }

  #renderAppliances(vm: HomeDetailVM): TemplateResult | typeof nothing {
    if (vm.appliances.length === 0) return nothing;
    return html`<section class="group">
      <h3 class="t-label">Appliances</h3>
      <ul class="rows">
        ${vm.appliances.map((appliance) => html`<li><agr-appliance-row .appliance=${appliance}></agr-appliance-row></li>`)}
      </ul>
    </section>`;
  }

  /** Chips and rows show their own progress, so only outcomes that need acknowledging are visible (§7.2). */
  #notes(vm: HomeDetailVM): readonly ControlNote[] {
    const subjects: NoteSubject[] = [
      ...vm.rooms.map((room) => ({ key: `room:${room.index}` as const, name: `${room.name} lights` })),
      ...vm.vacuums.map((vacuum) => ({ key: `entity:${vacuum.key}` as const, name: vacuum.name })),
    ];
    return controlNotes(
      subjects,
      (key) => this.#tickets.current(key, this.services.gateway.status(key)),
      (key) => this.#actions.draftState(key),
      'announced',
    );
  }
}

defineOnce('agr-home-drawer', AgrHomeDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-home-drawer': AgrHomeDrawer;
  }
}
