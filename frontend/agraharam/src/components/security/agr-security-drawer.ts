/**
 * Security drawer (§8). Three groups in order: Status (read-only), Actions, Monitored entry points. The actual alarm
 * state, the policy, the suggested mode, commissioning and the health text are separate rows, never one sentence.
 * Only configured roles render, each button with its consequence line beneath; labels and consequences come from
 * model/action-copy.ts. Every action except a sounding-alarm Silence Sound routes through agr-confirm-dialog
 * (the gateway decides via Availability.confirm), and the UI never claims an arm or disarm happened: only the live
 * Alarm row reports it.
 *
 * All roles share the 'security' ticket key (§4.7 step 13), so SecurityTickets remembers which button started the
 * current ticket: that button shows its progress in place, and the section's single live region at the top of
 * Actions announces every change and keeps an uncertain or failed outcome visible with Dismiss (§7.2, §16.10).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId, ResolvedConfig, SecurityActionRole } from '../../config/schema.ts';
import { isAlarmSounding, type AlarmDisplay } from '../../domain/alarm.ts';
import { ActionController } from '../../ha/actions/action-controller.ts';
import type { ActionRequest, ActionStatus, Availability } from '../../ha/actions/types.ts';
import { CONTROL_META, EntityController } from '../../ha/entity-controller.ts';
import type { Display } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { alarmIcon } from '../../model/alarm-labels.ts';
import { selectSecurity } from '../../model/security.ts';
import type { IconName, PerimeterItemVM, SecurityActionVM, SecurityVM } from '../../model/types.ts';
import {
  focusRingStyles,
  numStyles,
  skeletonStyles,
  staleStyles,
  toneStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { isDefined } from '../../util/defined.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-button.ts';
import type { AgrButton } from '../primitives/agr-button.ts';
import '../primitives/agr-drawer.ts';
import '../primitives/agr-empty-state.ts';
import type { DashboardServices } from '../services.ts';
import { requestConfirm, type DrawerElement, type DrawerRequest } from '../shell/overlay-types.ts';
import '../shared/agr-control-notes.ts';
import { controlNotes, type ControlNote, type ProgressPresentation } from '../shared/control-notes.ts';
import {
  ACTION_GROUP_HEADINGS,
  LAST_KNOWN,
  NOT_CONFIGURED,
  PERIMETER_EMPTY,
  PERIMETER_FOOTER,
  SECURITY_DRAWER_HEADING,
  SECURITY_GROUP_HEADINGS,
  STATUS_ROWS,
} from './security-copy.ts';
import { selectorInput } from '../shared/selector-input.ts';
import { SecurityTickets, type AttributedTicket } from './security-tickets.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';

type AgrSecurityDrawerRequest = Extract<DrawerRequest, { id: 'security' }>;
type DisabledAvailability = Extract<Availability, { enabled: false }>;

const ROW_ICON_SIZE = 18;
/** Who every security request waits for (the gateway's subject for security tickets). */
const SECURITY_CONTROLLER = 'the security controller';

/** Reasons that apply to every action at once; they are stated once for the group, not under each button. */
const GROUP_LEVEL_REASONS: ReadonlySet<string> = new Set(['controls-off', 'preview', 'disconnected', 'busy']);
/**
 * §7.1 and §8.2: Silence Sound is the only role that may skip its confirmation (while the alarm sounds). Every
 * other role goes through agr-confirm-dialog even if an Availability ever reported `confirm: false`, so a
 * persistent disarm can never run from a single tap (defense in depth for acceptance item 6).
 */
const MAY_SKIP_CONFIRMATION: ReadonlySet<SecurityActionRole> = new Set(['silence_sound']);

const PERIMETER_ICONS: Readonly<Record<PerimeterItemVM['position'], IconName>> = Object.freeze({
  closed: 'door-closed',
  open: 'door-open',
  unknown: 'circle-question-mark',
});
const PERIMETER_TONES: Readonly<Record<PerimeterItemVM['position'], string>> = Object.freeze({
  closed: 'neutral',
  open: 'attention',
  unknown: 'muted',
});

export class AgrSecurityDrawer extends LitElement implements DrawerElement<AgrSecurityDrawerRequest> {
  static override styles = [
    typographyStyles,
    numStyles,
    toneStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    focusRingStyles,
    css`
      .content {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-8);
        padding-block-start: var(--agr-space-2);
      }
      section {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-3);
      }
      h3 {
        margin: 0;
      }
      h4 {
        margin: 0;
        font: var(--agr-type-meta-strong);
        color: var(--agr-ink);
      }
      p {
        margin: 0;
      }
      dl,
      ul {
        margin: 0;
        padding: 0;
      }
      ul {
        list-style: none;
      }
      .card {
        padding: var(--agr-space-1) var(--agr-space-4);
        border-radius: var(--agr-radius-inner);
        background: var(--agr-surface-inset);
      }
      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: baseline;
        column-gap: var(--agr-space-4);
        row-gap: 2px;
        padding-block: var(--agr-space-3);
      }
      .row + .row,
      .entry + .entry {
        border-block-start: 1px solid var(--agr-line);
      }
      .row dt {
        grid-column: 1;
      }
      .row .value {
        grid-column: 2;
        display: inline-flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: flex-end;
        column-gap: var(--agr-space-2);
        margin: 0;
        text-align: end;
      }
      .row .helper {
        grid-column: 1 / -1;
        margin: 0;
      }
      .row[data-wide] .value {
        grid-column: 1 / -1;
        justify-content: flex-start;
        text-align: start;
        overflow-wrap: anywhere;
      }
      .alarm-value {
        display: inline-flex;
        align-items: center;
        gap: var(--agr-space-2);
      }
      .glyph {
        color: var(--agr-muted);
      }
      .value .skeleton {
        inline-size: 5em;
        margin-block: 0;
      }
      .value .skeleton.wide {
        inline-size: 7em;
      }
      .card.empty {
        padding-block: var(--agr-space-3);
      }
      .notice {
        padding: var(--agr-space-3) var(--agr-space-4);
        border-radius: var(--agr-radius-inner);
        color: var(--agr-ink);
        background: var(--agr-brass-tint);
      }
      .groups {
        display: flex;
        flex-direction: column;
      }
      .group {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-3);
        padding-block: var(--agr-space-4);
      }
      .group + .group {
        border-block-start: 1px solid var(--agr-line);
      }
      .group:first-child {
        padding-block-start: 0;
      }
      .actions {
        display: flex;
        flex-direction: column;
        gap: var(--agr-space-4);
      }
      .action {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--agr-space-2);
      }
      .action .t-meta {
        max-inline-size: 36em;
      }
      /* The live region is always present; while it shows nothing it must not add the section's gap. */
      agr-control-notes {
        margin-block-start: calc(var(--agr-space-3) * -1);
      }
      .entry {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        column-gap: var(--agr-space-3);
        min-block-size: var(--agr-target);
      }
      .entry-icon {
        display: inline-flex;
        color: var(--agr-muted);
      }
      .entry[data-position='open'] .entry-icon {
        color: var(--agr-brass-ink);
      }
      .entry-name {
        overflow-wrap: anywhere;
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) services!: DashboardServices;
  @property({ attribute: false }) request!: AgrSecurityDrawerRequest;

  // Registered for their side effects: re-render on bound entity, control-meta and security ticket changes.
  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => securityIds(this.services?.config),
      CONTROL_META,
    );
  }
  readonly #actions = new ActionController(
    this,
    () => (this.services?.gateway === undefined ? undefined : this.services),
    () => ['security'],
  );
  readonly #tickets = new SecurityTickets(this, () => this.services?.gateway);

  protected override render(): TemplateResult {
    const services = this.services;
    return html`<agr-drawer
      heading=${SECURITY_DRAWER_HEADING}
      .demo=${services?.mode === 'demo'}
      .theme=${services?.theme ?? 'light'}
      >${this.#renderContent(services)}</agr-drawer
    >`;
  }

  #renderContent(services: DashboardServices | undefined): TemplateResult {
    const config = services?.config;
    const store = services?.store;
    if (services === undefined || config === undefined || store === undefined || services.gateway === undefined) {
      return html`<span class="skeleton" aria-hidden="true"></span>`;
    }
    if (config.security === undefined) {
      return html`<agr-empty-state
        icon="shield"
        heading=${NOT_CONFIGURED.heading}
        message=${NOT_CONFIGURED.message}
      ></agr-empty-state>`;
    }
    if (!store.isReady()) return html`<span class="skeleton" aria-hidden="true"></span>`;
    let vm: SecurityVM;
    try {
      vm = selectSecurity(selectorInput(services));
    } catch {
      log.error('security-select-failed');
      return html`<span class="skeleton" aria-hidden="true"></span>`;
    }
    const ticket = this.#tickets.current();
    return html`<div class="content">
      ${this.#renderStatus(vm)} ${this.#renderActions(vm, ticket)} ${this.#renderPerimeter(vm.perimeter)}
    </div>`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Status (§8.1)

  #renderStatus(vm: SecurityVM): TemplateResult {
    return html`<section aria-labelledby="security-status">
      <h3 id="security-status" class="t-label">${SECURITY_GROUP_HEADINGS.status}</h3>
      <dl class="card">
        <div class="row">
          <dt class="t-strong">${STATUS_ROWS.alarm.label}</dt>
          <dd class="value">${renderAlarm(vm.alarm)}</dd>
          <dd class="helper t-meta">${STATUS_ROWS.alarm.helper}</dd>
        </div>
        ${vm.policy ? statusRow(STATUS_ROWS.policy, renderDisplay(vm.policy)) : nothing}
        ${vm.suggested ? statusRow(STATUS_ROWS.suggested, renderDisplay(vm.suggested)) : nothing}
        ${vm.commissioning ? statusRow(STATUS_ROWS.commissioning, renderCommissioning(vm.commissioning)) : nothing}
        ${vm.health ? statusRow(STATUS_ROWS.health, renderDisplay(vm.health), true) : nothing}
      </dl>
    </section>`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Actions (§8.2)

  #renderActions(vm: SecurityVM, ticket: AttributedTicket | undefined): TemplateResult | typeof nothing {
    if (vm.actions.length === 0) return nothing;
    // Every ticket's progress is visible somewhere (§7.2): on the button that started it, or, for a ticket no button
    // here carries (started before this drawer opened), in the live region itself. Either way it explains `busy`.
    const carriedByButton = ticket !== undefined && vm.actions.some((action) => action.role === ticket.role);
    const notice = groupNotice(vm.actions, ticket !== undefined);
    return html`<section aria-labelledby="security-actions">
      <h3 id="security-actions" class="t-label">${SECURITY_GROUP_HEADINGS.actions}</h3>
      ${notice ? html`<p class="notice t-meta">${notice}</p>` : nothing}
      <agr-control-notes
        .notes=${this.#notes(vm, ticket, carriedByButton ? 'announced' : 'shown')}
        focus-key-prefix="security"
        @agr-dismiss-note=${this.#onDismiss}
      ></agr-control-notes>
      <div class="groups">
        ${groupActions(vm.actions).map(
          ([group, actions]) =>
            html`<div class="group">
              <h4>${ACTION_GROUP_HEADINGS[group]}</h4>
              <ul class="actions">
                ${actions.map((action) =>
                  this.#renderAction(vm.alarm, action, ticket?.role === action.role ? ticket.status : undefined),
                )}
              </ul>
            </div>`,
        )}
      </div>
    </section>`;
  }

  /**
   * The live region's note for the current ticket, named by the action that started it. When that button shows the
   * progress in place, only an uncertain or failed outcome is visible here; otherwise every phase is (§7.2). The copy
   * never claims the alarm changed.
   */
  #notes(vm: SecurityVM, ticket: AttributedTicket | undefined, progress: ProgressPresentation): readonly ControlNote[] {
    if (ticket === undefined) return [];
    const label = vm.actions.find((action) => action.role === ticket.role)?.label ?? SECURITY_DRAWER_HEADING;
    return controlNotes(
      [{ key: 'security', name: label, waitingFor: SECURITY_CONTROLLER }],
      () => ticket.status,
      (key) => this.#actions.draftState(key),
      progress,
    );
  }

  /** The button that started the current ticket shows its progress in place ("Sending", "Requested"). */
  #renderAction(alarm: AlarmDisplay, action: SecurityActionVM, status: ActionStatus | undefined): TemplateResult {
    const availability = action.availability;
    // A reason this action alone has (not one the group notice states), shown under it.
    const ownReason =
      !availability.enabled && !GROUP_LEVEL_REASONS.has(availability.reason) ? availability.message : undefined;
    // While the alarm sounds, Silence sound is the one action that matters, so it gets the strong button.
    const strong = action.role === 'silence_sound' && isAlarmSounding(alarm);
    return html`<li class="action">
      <agr-button
        label=${action.label}
        focus-key=${`security:${action.role}`}
        variant=${strong ? 'confirm' : 'quiet'}
        reason-display="hidden"
        .availability=${availability}
        .status=${status}
        @agr-activate=${(event: Event) => this.#onActivate(action.role, event)}
      ></agr-button>
      <p class="t-meta">${action.consequence}</p>
      ${ownReason === undefined ? nothing : html`<p class="t-meta" data-tone="attention">${ownReason}</p>`}
    </li>`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Monitored entry points (§8.3)

  #renderPerimeter(perimeter: readonly PerimeterItemVM[]): TemplateResult {
    return html`<section aria-labelledby="security-perimeter">
      <h3 id="security-perimeter" class="t-label">${SECURITY_GROUP_HEADINGS.perimeter}</h3>
      ${
        perimeter.length === 0
          ? html`<p class="card empty t-meta">${PERIMETER_EMPTY}</p>`
          : html`<ul class="card">
              ${perimeter.map(
                (item) =>
                  html`<li class="entry" data-position=${item.position}>
                    <span class="entry-icon" aria-hidden="true"
                      >${renderIcon(PERIMETER_ICONS[item.position], ROW_ICON_SIZE)}</span
                    >
                    <span class="entry-name t-body">${item.name}</span>
                    <span class="t-strong" data-tone=${PERIMETER_TONES[item.position]}>${item.label}</span>
                  </li>`,
              )}
            </ul>`
      }
      <p class="t-meta">${PERIMETER_FOOTER}</p>
    </section>`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Gestures and tickets

  readonly #onActivate = contained('security-activate-failed', (role: SecurityActionRole, event: Event) => {
    const request: ActionRequest = { kind: 'security.run', role };
    const availability = this.#actions.evaluate(request);
    if (!availability.enabled) return;
    this.#tickets.begin(role);
    if (availability.confirm || !MAY_SKIP_CONFIRMATION.has(role)) {
      requestConfirm(this, request, event.currentTarget as AgrButton);
      return;
    }
    this.#tickets.record(role, this.#actions.request(request));
    this.requestUpdate();
  });

  readonly #onDismiss = contained('security-dismiss-failed', (event: Event) => {
    event.stopPropagation();
    const role = this.#tickets.dismiss();
    this.requestUpdate();
    // The Dismiss button disappears; return focus to the action it belonged to rather than dropping it.
    const selector = role === undefined ? 'agr-button' : `agr-button[focus-key="security:${role}"]`;
    void this.updateComplete
      .then(() => this.renderRoot.querySelector<HTMLElement>(selector)?.focus())
      .catch(() => log.error('security-focus-failed'));
  });
}

/** Every entity the drawer reads: availability depends on the scripts' states too ("Already running"). */
function securityIds(config: ResolvedConfig | undefined): EntityId[] {
  const security = config?.security;
  if (security === undefined) return [];
  const ids: (EntityId | undefined)[] = [
    security.alarm,
    security.policy,
    security.suggested,
    security.commissioning,
    security.healthText,
    ...security.perimeter.map((ref) => ref.entity),
    ...Object.values(security.actions),
  ];
  return ids.filter(isDefined);
}

/** Actions grouped in their §8.2 order; selectSecurity already sorts roles, so groups come out in order. */
function groupActions(actions: readonly SecurityActionVM[]): [SecurityActionVM['group'], SecurityActionVM[]][] {
  const groups = new Map<SecurityActionVM['group'], SecurityActionVM[]>();
  for (const action of actions) groups.set(action.group, [...(groups.get(action.group) ?? []), action]);
  return [...groups.entries()];
}

/** One line for a reason every action shares; 'busy' is explained by the ticket's visible progress when one exists. */
function groupNotice(actions: readonly SecurityActionVM[], ticketShown: boolean): string | undefined {
  const shared = actions
    .map((action) => action.availability)
    .find(
      (availability): availability is DisabledAvailability =>
        !availability.enabled && GROUP_LEVEL_REASONS.has(availability.reason),
    );
  if (shared === undefined || (shared.reason === 'busy' && ticketShown)) return undefined;
  return shared.message;
}

function statusRow(
  row: { readonly label: string; readonly helper: string },
  value: TemplateResult,
  wide = false,
): TemplateResult {
  return html`<div class="row" ?data-wide=${wide}>
    <dt class="t-strong">${row.label}</dt>
    <dd class="value t-body">${value}</dd>
    <dd class="helper t-meta">${row.helper}</dd>
  </div>`;
}

/** The alarm panel's own state; when stale it keeps the last label with a separate "Last known" element (§8.1). */
function renderAlarm(alarm: AlarmDisplay): TemplateResult {
  if (alarm.state === 'loading') {
    return html`<span class="skeleton wide" aria-hidden="true"></span
      ><span class="visually-hidden">${alarm.label}</span>`;
  }
  return html`<span class="alarm-value t-value" data-tone=${alarm.tone}
      >${renderIcon(alarmIcon(alarm), ROW_ICON_SIZE)}<span class=${alarm.stale ? 'stale' : ''}
        >${alarm.label}</span
      ></span
    >${alarm.stale ? html`<span class="t-meta">${LAST_KNOWN}</span>` : nothing}`;
}

function renderDisplay(display: Display): TemplateResult {
  if (display.kind === 'value') {
    return html`<span class=${display.stale ? 'stale' : ''}>${display.text}</span>${
        display.stale ? html`<span class="t-meta">${LAST_KNOWN}</span>` : nothing
      }`;
  }
  if (display.reason === 'loading') {
    return html`<span class="skeleton" aria-hidden="true"></span><span class="visually-hidden">${display.label}</span>`;
  }
  return html`<span class="glyph" aria-hidden="true">${ABSENT_GLYPH}</span
    ><span class="t-meta">${display.label}</span>`;
}

function renderCommissioning(commissioning: NonNullable<SecurityVM['commissioning']>): TemplateResult {
  const stale = commissioning.status === 'disconnected' && commissioning.on !== null;
  if (commissioning.on === null) {
    return renderDisplay({ kind: 'absent', reason: absentReason(commissioning.status), label: commissioning.label });
  }
  return html`<span class=${stale ? 'stale' : ''}>${commissioning.label}</span>${
      stale ? html`<span class="t-meta">${LAST_KNOWN}</span>` : nothing
    }`;
}

function absentReason(
  status: NonNullable<SecurityVM['commissioning']>['status'],
): Extract<Display, { kind: 'absent' }>['reason'] {
  return status === 'available' ? 'unknown' : status;
}

defineOnce('agr-security-drawer', AgrSecurityDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-security-drawer': AgrSecurityDrawer;
  }
}
