/**
 * Room drawer (§5.3, §18): every light with its toggle and brightness slider, every lighting switch with its toggle,
 * explicit All on and All off for the room's lights and switches together, curtains with Open and Close (garage, gate
 * and door covers read-only with the reason), and the room purifier through the shared agr-fan-controls.
 *
 * The drawer holds the ActionController for everything inside it: rows and the fan controls emit intents, and each
 * becomes exactly one request (or one debounced draft for sliders). Ticket messages go to its single polite live
 * region. A room index that no longer exists (the configuration changed) renders an honest empty state.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ActionController } from '../../ha/actions/action-controller.ts';
import { SLIDER_COMMIT_DEBOUNCE_MS } from '../../ha/actions/types.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import { displayText } from '../../model/display.ts';
import { observedBrightnessPct, roomActionKeys, roomEntityIds, selectRoom, type HomeRoomVM } from '../../model/home.ts';
import type { AirTileVM } from '../../model/types.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import '../primitives/agr-drawer.ts';
import '../primitives/agr-empty-state.ts';
import type { DashboardServices } from '../services.ts';
import type { DrawerElement, DrawerRequest } from '../shell/overlay-types.ts';
import '../shared/agr-fan-controls.ts';
import { applyFanIntent, fanActionKey, type FanIntent } from '../shared/agr-fan-controls.ts';
import '../shared/agr-control-notes.ts';
import { controlNotes, dismissNote, type ControlNote, type NoteSubject } from '../shared/control-notes.ts';
import {
  curtainRequest,
  ImmediateTickets,
  lightRequest,
  panelNotice,
  performFromEvent,
  roomRequest,
  switchRequest,
  type BrightnessDraftDetail,
  type CurtainCommandDetail,
  type LightCommandDetail,
  type SwitchCommandDetail,
} from './home-actions.ts';
import { drawerGroupStyles, insetStyles } from './home-styles.ts';
import './agr-curtain-row.ts';
import './agr-light-row.ts';
import './agr-switch-row.ts';
import { selectorInput } from '../shared/selector-input.ts';

type AgrRoomDrawerRequest = Extract<DrawerRequest, { id: 'room' }>;

const FALLBACK_HEADING = 'Room';

export class AgrRoomDrawer extends LitElement implements DrawerElement<AgrRoomDrawerRequest> {
  static override styles = [
    typographyStyles,
    insetStyles,
    drawerGroupStyles,
    css`
      .summary {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--agr-space-2) var(--agr-space-3);
      }
      .summary p {
        flex: 1 1 auto;
        margin: 0;
      }
      .room-actions {
        display: flex;
        gap: var(--agr-space-2);
      }
      .purifier {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-3);
        padding: var(--agr-space-3) var(--agr-space-4) var(--agr-space-4);
      }
      .purifier-name {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--agr-space-3);
      }
      agr-control-notes:not([quiet]) {
        margin-block-end: var(--agr-space-2);
      }
      .registry {
        margin: 0;
      }
    `,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrRoomDrawerRequest;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services === undefined ? [] : roomEntityIds(this.services.config, this.#index())),
      CONTROL_META,
    );
  }
  readonly #actions = new ActionController(
    this,
    () => this.services,
    () => (this.services === undefined ? [] : roomActionKeys(this.services.config, this.#index())),
  );
  readonly #tickets = new ImmediateTickets(this);

  readonly #onLight = contained('room-light-failed', (event: CustomEvent<LightCommandDetail>) => {
    event.stopPropagation();
    performFromEvent(this, this.#actions, this.#tickets, lightRequest(event.detail), event);
  });

  readonly #onSwitch = contained('room-switch-failed', (event: CustomEvent<SwitchCommandDetail>) => {
    event.stopPropagation();
    performFromEvent(this, this.#actions, this.#tickets, switchRequest(event.detail), event);
  });

  readonly #onBrightness = contained('room-brightness-failed', (event: CustomEvent<BrightnessDraftDetail>) => {
    event.stopPropagation();
    const { entity, value } = event.detail;
    this.#actions.draft(
      `entity:${entity}`,
      value,
      (pct) => ({ kind: 'light.set_brightness', entity, pct: Math.round(pct) }),
      SLIDER_COMMIT_DEBOUNCE_MS,
      () => observedBrightnessPct(this.services.store, entity),
    );
  });

  readonly #onCurtain = contained('room-curtain-failed', (event: CustomEvent<CurtainCommandDetail>) => {
    event.stopPropagation();
    performFromEvent(this, this.#actions, this.#tickets, curtainRequest(event.detail), event);
  });

  readonly #onRoomAction = contained('room-all-failed', (next: 'on' | 'off', event: Event) => {
    performFromEvent(this, this.#actions, this.#tickets, roomRequest({ room: this.#index(), next }), event);
  });

  readonly #onDismiss = contained('room-dismiss-failed', (event: CustomEvent<ControlNote>) => {
    event.stopPropagation();
    dismissNote(event.detail, this.#actions, this.#tickets);
  });

  protected override render(): TemplateResult {
    const room = this.#select();
    return html`<agr-drawer
      heading=${room?.name ?? FALLBACK_HEADING}
      .demo=${this.services.mode === 'demo'}
      .theme=${this.services.theme}
    >
      ${room === undefined ? this.#renderMissing() : this.#renderRoom(room)}
    </agr-drawer>`;
  }

  #select(): HomeRoomVM | undefined {
    try {
      return selectRoom(selectorInput(this.services), this.#index());
    } catch {
      log.error('room-select-failed');
      return undefined;
    }
  }

  #renderMissing(): TemplateResult {
    return html`<agr-empty-state
      icon="house"
      heading="This room isn't available"
      message="The dashboard configuration changed. Close this panel and choose the room again."
    ></agr-empty-state>`;
  }

  #renderRoom(room: HomeRoomVM): TemplateResult {
    // A settings switch is refused whatever else holds, so it never takes part in the one shared notice.
    const switchToggles = room.switches.filter((item) => !item.readOnly).map((item) => item.toggle);
    const notice = panelNotice([
      room.allOn,
      room.allOff,
      ...room.lights.map((light) => light.toggle),
      ...switchToggles,
    ]);
    return html`<div
      @agr-home-light=${this.#onLight}
      @agr-home-switch=${this.#onSwitch}
      @agr-home-brightness=${this.#onBrightness}
      @agr-home-curtain=${this.#onCurtain}
      @agr-dismiss-note=${this.#onDismiss}
      @agr-fan-intent=${(event: CustomEvent<FanIntent>) => this.#onFanIntent(event, room.purifier)}
    >
      ${notice === undefined ? nothing : html`<p class="notice t-meta">${notice}</p>`}
      <agr-control-notes
        .notes=${this.#notes(room)}
        focus-key-prefix=${`room-drawer:${room.index}`}
      ></agr-control-notes>
      ${this.#renderLights(room)} ${this.#renderCurtains(room)} ${this.#renderPurifier(room)}
    </div>`;
  }

  #renderLights(room: HomeRoomVM): TemplateResult {
    const prefix = `room-drawer:${room.index}`;
    const rows = room.lights.length + room.switches.length;
    return html`<section class="group">
      <h3 class="t-label">Lights</h3>
      ${room.registryNotice === undefined ? nothing : html`<p class="registry t-meta">${room.registryNotice}</p>`}
      ${this.#renderRoomActions(room)}
      ${
        rows === 0
          ? nothing
          : html`<ul class="stack">
              ${room.lights.map(
                (light) =>
                  html`<li>
                    <agr-light-row
                      .light=${light}
                      .draft=${this.#actions.draftState(`entity:${light.key}`)}
                      focus-key-prefix=${`${prefix}:light`}
                    ></agr-light-row>
                  </li>`,
              )}
              ${room.switches.map(
                (item) =>
                  html`<li><agr-switch-row .item=${item} focus-key-prefix=${`${prefix}:switch`}></agr-switch-row></li>`,
              )}
            </ul>`
      }
    </section>`;
  }

  /** The summary with All on and All off for lights and lamp switches together; none without a lighting item. */
  #renderRoomActions(room: HomeRoomVM): TemplateResult {
    const prefix = `room-drawer:${room.index}`;
    if (room.allOn === undefined || room.allOff === undefined) {
      return html`<p class="t-meta">No lights are set up for this room.</p>`;
    }
    return html`<div class="summary">
      <p class="t-body">${room.summary}</p>
      <div class="room-actions" role="group" aria-label=${`All ${room.name} lights`}>
        <agr-button
          label="All on"
          icon="lightbulb"
          focus-key=${`${prefix}:all-on`}
          reason-display="hidden"
          .availability=${room.allOn}
          @agr-activate=${(event: Event) => this.#onRoomAction('on', event)}
        ></agr-button>
        <agr-button
          label="All off"
          icon="lightbulb-off"
          focus-key=${`${prefix}:all-off`}
          reason-display="hidden"
          .availability=${room.allOff}
          @agr-activate=${(event: Event) => this.#onRoomAction('off', event)}
        ></agr-button>
      </div>
    </div>`;
  }

  #renderCurtains(room: HomeRoomVM): TemplateResult | typeof nothing {
    if (room.curtains.length === 0) return nothing;
    return html`<section class="group">
      <h3 class="t-label">Curtains and blinds</h3>
      <ul class="stack">
        ${room.curtains.map(
          (curtain) =>
            html`<li>
              <agr-curtain-row
                .curtain=${curtain}
                focus-key-prefix=${`room-drawer:${room.index}:curtain`}
              ></agr-curtain-row>
            </li>`,
        )}
      </ul>
    </section>`;
  }

  #renderPurifier(room: HomeRoomVM): TemplateResult | typeof nothing {
    const tile = room.purifier;
    if (tile === undefined) return nothing;
    return html`<section class="group">
      <h3 class="t-label">Air purifier</h3>
      <div class="purifier inset">
        <div class="purifier-name">
          <span class="t-strong">${tile.name}</span>
          <span class="t-meta">${purifierState(tile)}</span>
        </div>
        <agr-fan-controls
          .tile=${tile}
          .draft=${this.#actions.draftState(fanActionKey(tile.key))}
          focus-key-prefix=${`room-drawer:${room.index}:purifier`}
        ></agr-fan-controls>
      </div>
    </section>`;
  }

  readonly #onFanIntent = contained(
    'room-fan-intent-failed',
    (event: CustomEvent<FanIntent>, tile: AirTileVM | undefined) => {
      event.stopPropagation();
      if (tile === undefined || event.detail.entity !== tile.key) return;
      applyFanIntent(this.#actions, event.detail, () => this.#select()?.purifier?.percentage?.value ?? null);
    },
  );

  /** Rows show their own progress, so only outcomes that need acknowledging are visible (§7.2). */
  #notes(room: HomeRoomVM): readonly ControlNote[] {
    const subjects: NoteSubject[] = [
      { key: `room:${room.index}`, name: `${room.name} lights` },
      ...room.lights.map((light) => ({ key: `entity:${light.key}` as const, name: light.name })),
      ...room.switches.map((item) => ({ key: `entity:${item.key}` as const, name: item.name })),
      ...room.curtains.map((curtain) => ({ key: `entity:${curtain.key}` as const, name: curtain.name })),
      ...(room.purifier === undefined ? [] : [{ key: fanActionKey(room.purifier.key), name: room.purifier.name }]),
    ];
    return controlNotes(
      subjects,
      (key) => this.#tickets.current(key, this.services.gateway.status(key)),
      (key) => this.#actions.draftState(key),
      'announced',
    );
  }

  #index(): number {
    return this.request?.room ?? -1;
  }
}

/** "On, Sleep", "Off", or the honest absent label. */
function purifierState(tile: AirTileVM): string {
  if (tile.status === 'unknown') return 'State unknown';
  if (tile.status !== 'available' && tile.status !== 'disconnected') return displayText(tile.detail);
  if (tile.power === 'off') return 'Off';
  const detail = tile.detail.kind === 'value' ? tile.detail.text : undefined;
  if (tile.power === 'on') return detail === undefined ? 'On' : `On, ${detail}`;
  return 'State unknown';
}

defineOnce('agr-room-drawer', AgrRoomDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-room-drawer': AgrRoomDrawer;
  }
}
