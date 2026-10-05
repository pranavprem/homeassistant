/**
 * Upcoming (§9.5): today's and tomorrow's events, at most four, on a quiet surface. Hidden entirely when no
 * calendars are configured. Event text is runtime data and is rendered only through Lit text bindings (escaped).
 * Reads only, through CalendarController; it renders no controls.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId } from '../../config/schema.ts';
import { CalendarController, type CalendarSource } from '../../ha/calendar-controller.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { UpcomingEventVM, UpcomingVM } from '../../model/types.ts';
import { NOW_LABEL, selectUpcoming } from '../../model/upcoming.ts';
import {
  numStyles,
  sectionHostStyles,
  skeletonStyles,
  staleStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { log } from '../../util/log.ts';
import '../primitives/agr-panel.ts';
import type { DashboardServices } from '../services.ts';
import { panelPill } from '../shared/paused.ts';
import { selectorInput } from '../shared/selector-input.ts';

const HEADING_ID = 'agr-upcoming-heading';
/** 'clock' rolls the Today/Tomorrow groups over at midnight and drops ended events without a refetch. */
const UPCOMING_META: readonly MetaKind[] = Object.freeze(['connection', 'locale', 'clock']);
const NOTE_ICON_SIZE = 16;
const NO_IDS: readonly EntityId[] = Object.freeze([]);
const EMPTY_COPY = 'Nothing scheduled today or tomorrow.';
const UPCOMING_FAILED = "Events couldn't be shown.";

export class AgrUpcoming extends LitElement {
  static override styles = [
    sectionHostStyles,
    skeletonStyles,
    typographyStyles,
    numStyles,
    visuallyHiddenStyles,
    css`
      :host([hidden]) {
        display: none;
      }
      p,
      ol {
        margin: 0;
      }
      ol {
        padding: 0;
        list-style: none;
      }
      .group + .group {
        margin-block-start: var(--agr-space-3);
      }
      .group-label {
        margin-block-end: 2px;
        color: var(--agr-brass-ink);
      }
      .event {
        display: grid;
        grid-template-columns: 76px minmax(0, 1fr) auto;
        align-items: baseline;
        column-gap: var(--agr-space-3);
        box-sizing: border-box;
        min-block-size: 34px;
        padding-block: 6px;
      }
      .event + .event {
        border-block-start: 1px solid var(--agr-line);
      }
      .time {
        white-space: nowrap;
      }
      .time.now {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--agr-olive-ink);
        font-weight: 650;
      }
      .time.now::before {
        content: '';
        inline-size: 6px;
        block-size: 6px;
        border-radius: 50%;
        background: var(--agr-olive);
      }
      .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .calendar {
        max-inline-size: 9em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .note {
        display: flex;
        align-items: flex-start;
        gap: var(--agr-space-2);
        margin-block-start: var(--agr-space-2);
      }
      .note svg {
        flex: none;
        margin-block-start: 1px;
      }
      .empty {
        padding-block: var(--agr-space-1);
      }
      /* The loading shell is built from the real group label and event rows, so the panel is the height of a
         two-event day before anything arrives (§6.2.1) and nothing moves when the events fill in. */
      .loading .skeleton {
        margin-block: 5px;
      }
      .loading .day-ghost {
        inline-size: 48px;
        margin-block: 2px 4px;
      }
      .loading .time-ghost {
        inline-size: 52px;
      }
      .loading .title-ghost {
        inline-size: min(160px, 80%);
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  /** Re-renders on calendar entity changes, the connection phase, locale and the minute clock. */
  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => this.#calendarIds(),
      UPCOMING_META,
    );
  }
  readonly #calendar = new CalendarController(this, () => this.#calendarSource());

  protected override render(): TemplateResult | typeof nothing {
    const services = this.services;
    if (services === undefined) return this.#renderFrame(renderLoading());
    if (services.config.calendars.length === 0) return nothing;
    let vm: UpcomingVM;
    try {
      vm = selectUpcoming({ ...selectorInput(services), calendar: this.#calendar.snapshot() });
    } catch {
      log.error('upcoming-select-failed');
      return this.#renderFrame(renderNote(UPCOMING_FAILED));
    }
    return this.#renderFrame(renderUpcoming(vm, services.config.calendars.length > 1));
  }

  /** Hidden without calendars, so a stretched column never holds an empty bordered box. */
  protected override updated(): void {
    this.hidden = this.services !== undefined && this.services.config.calendars.length === 0;
  }

  #calendarIds(): readonly EntityId[] {
    return this.services?.config.calendars.map((ref) => ref.entity) ?? NO_IDS;
  }

  #calendarSource(): CalendarSource | undefined {
    const services = this.services;
    if (services === undefined) return undefined;
    return { reader: services.reader, status: services.status, calendars: this.#calendarIds() };
  }

  #renderFrame(content: TemplateResult): TemplateResult {
    return html`<agr-panel
      heading="Upcoming"
      heading-id=${HEADING_ID}
      surface="quiet"
      icon="calendar-days"
      .pill=${panelPill(this.services?.store)}
    >
      ${content}
    </agr-panel>`;
  }
}

/** Rows in the loading shell: the two events the §6.2.1 Upcoming target holds. */
const GHOST_EVENTS: readonly number[] = Object.freeze([0, 1]);

function renderLoading(): TemplateResult {
  return html`<div class="group loading" aria-hidden="true">
      <span class="skeleton day-ghost"></span>
      <ol>
        ${GHOST_EVENTS.map(
          () =>
            html`<li class="event">
              <span class="skeleton time-ghost"></span><span class="skeleton title-ghost"></span>
            </li>`,
        )}
      </ol>
    </div>
    <span class="visually-hidden">Loading events</span>`;
}

function renderUpcoming(vm: UpcomingVM, showCalendar: boolean): TemplateResult {
  if (vm.state === 'loading') return renderLoading();
  const stale = vm.state === 'error' || vm.state === 'disconnected';
  const empty = vm.groups.length === 0 && vm.state === 'ready';
  return html`${vm.groups.map(
    (group) =>
      html`<div class="group ${stale ? 'stale' : ''}">
        <h3 class="group-label t-label">${group.label}</h3>
        <ol>
          ${group.events.map((event) => renderEvent(event, showCalendar, stale))}
        </ol>
      </div>`,
  )}
  ${empty ? html`<p class="empty t-meta">${EMPTY_COPY}</p>` : nothing}
  ${vm.note !== undefined ? renderNote(vm.note) : nothing}`;
}

function renderEvent(event: UpcomingEventVM, showCalendar: boolean, stale: boolean): TemplateResult {
  const now = event.time === NOW_LABEL;
  return html`<li class="event">
    <span class="time t-meta num ${now ? 'now' : ''}">${event.time}</span>
    <span class="title t-body">${event.title}</span>
    ${showCalendar ? html`<span class="calendar t-meta">${event.calendarName}</span>` : nothing}
    ${stale ? html`<span class="visually-hidden">, last known</span>` : nothing}
  </li>`;
}

function renderNote(note: string): TemplateResult {
  return html`<p class="note t-meta">${renderIcon('info', NOTE_ICON_SIZE)}<span>${note}</span></p>`;
}

defineOnce('agr-upcoming', AgrUpcoming);

declare global {
  interface HTMLElementTagNameMap {
    'agr-upcoming': AgrUpcoming;
  }
}
