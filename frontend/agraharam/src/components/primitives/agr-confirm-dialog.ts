/**
 * Confirmation dialog (§5.2 "Confirm dialog integrity", §5.4). The ONLY minter of confirmation tokens: Confirm calls
 * gateway.request(action, { confirmation: mintConfirmationToken(action), epoch }) (a fitness test enforces it).
 *
 * 1. Title, body and button label come from confirmCopyFor(action, context); a ConfirmDetail carries no copy. The
 *    action is a frozen, validated copy taken when the dialog opens, so the action confirmed is the action shown.
 * 2. On open it captures gateway.epoch() and re-evaluates the action on every gateway, target, alarm and connection
 *    change; a disabled result disables Confirm and shows the reason in place of the body's last line.
 * 3. An epoch change closes it as cancelled with "Not sent. The connection changed while this was open."
 * 4. After CONFIRM_DIALOG_TIMEOUT_MS unanswered it cancels itself with "Not sent. Confirmation timed out."
 * 5. Cancel and Escape send nothing; Cancel has initial focus, so Enter never confirms by accident; a backdrop click
 *    does nothing.
 * 6. A malformed action, or a copy lookup that fails, never throws out of a lifecycle method: the dialog fails
 *    closed and visibly ("This action isn't available", no Confirm button, nothing sent).
 * 7. The body, safety lines and reason included, is the dialog's accessible description (aria-describedby), so a
 *    screen reader reads the consequence along with the focused Cancel button.
 */
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { EntityId, ResolvedConfig } from '../../config/schema.ts';
import { alarmDisplayFor } from '../../domain/alarm.ts';
import { CONTROL_META } from '../../ha/entity-controller.ts';
import { mintConfirmationToken } from '../../ha/actions/confirmation.ts';
import { CONFIRM_DIALOG_TIMEOUT_MS, frozenActionRequest } from '../../ha/actions/types.ts';
import type { ActionGateway, ActionRequest, Availability } from '../../ha/actions/types.ts';
import type { Unsubscribe } from '../../ha/host.ts';
import { confirmCopyFor, type ConfirmContext, type ConfirmCopy } from '../../model/action-copy.ts';
import { disabledControlDeclarations } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import type { DashboardServices } from '../services.ts';
import { suppressKeyRepeat } from './control-helpers.ts';
import { AgrDialog } from './agr-dialog.ts';

type ConfirmOutcome = 'pending' | 'confirmed' | 'cancelled' | 'timed-out' | 'connection-changed';

/** Announced by the overlay host after the dialog closed on its own. */
const CONFIRM_ANNOUNCEMENTS: Readonly<Partial<Record<ConfirmOutcome, string>>> = Object.freeze({
  'connection-changed': 'Not sent. The connection changed while this was open.',
  'timed-out': 'Not sent. Confirmation timed out.',
});
/** Announced by the overlay host when it refuses a malformed confirm request instead of mounting the dialog. */
export const CONFIRM_REFUSED_ANNOUNCEMENT = "Not sent. This action isn't available.";

const CANCEL_LABEL = 'Cancel';
const CLOSE_LABEL = 'Close';
/** The id of the body wrapper, the dialog's accessible description. */
const DESCRIPTION_ID = 'confirm-description';
const UNAVAILABLE: Availability = Object.freeze({
  enabled: false,
  reason: 'unsupported',
  message: "This control isn't available.",
});
/** Shown instead of the action's copy when the action cannot be confirmed at all (rule 6). */
const UNCONFIRMABLE_COPY: ConfirmCopy = Object.freeze({
  title: "This action isn't available",
  body: Object.freeze(['Nothing was sent.']),
  confirmLabel: '',
});

/** The entities whose state decides this action's availability and copy: its target(s) and the alarm. */
function confirmWatchIds(action: ActionRequest, config: ResolvedConfig): EntityId[] {
  const ids: EntityId[] = [];
  if ('entity' in action) ids.push(action.entity);
  if (action.kind === 'security.run') {
    const script = config.security?.actions[action.role];
    if (script !== undefined) ids.push(script);
  }
  if ((action.kind === 'garage.open' || action.kind === 'garage.close') && config.garage) ids.push(config.garage.cover);
  if (config.security) ids.push(config.security.alarm);
  return ids;
}

export class AgrConfirmDialog extends AgrDialog {
  static override styles = [
    ...AgrDialog.styles,
    css`
      p {
        margin: 0 0 var(--agr-space-3);
      }
      .reason {
        color: var(--agr-brass-ink);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: var(--agr-space-3);
        padding: 0 var(--agr-space-6) var(--agr-space-6);
      }
      .actions button {
        min-inline-size: var(--agr-target);
        min-block-size: var(--agr-target);
        padding: 0 var(--agr-space-5);
        border: none;
        border-radius: var(--agr-radius-control);
        font: var(--agr-type-control);
        cursor: pointer;
      }
      .cancel {
        color: var(--agr-ink);
        background: var(--agr-surface-inset);
      }
      .confirm {
        color: var(--agr-surface);
        background: var(--agr-ink);
      }
      .confirm[aria-disabled='true'] {
        ${disabledControlDeclarations}
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;
  @property({ attribute: false }) action?: ActionRequest;

  protected override dialogRole: 'dialog' | 'alertdialog' = 'alertdialog';
  protected override closeOnBackdrop = false;
  protected override showCloseButton = false;

  #outcome: ConfirmOutcome = 'pending';
  /** The frozen, validated copy of `action` taken when the dialog opened; the only action it shows or sends. */
  #action: ActionRequest | undefined;
  /** The action is malformed or its copy could not be built: the dialog shows UNCONFIRMABLE_COPY (rule 6). */
  #unconfirmable = false;
  #gateway: ActionGateway | undefined;
  #epoch: number | undefined;
  #subscriptions: Unsubscribe[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** What this render shows, computed once per update; a Confirm click re-checks both at that moment. */
  #view: { readonly copy: ConfirmCopy | undefined; readonly availability: Availability } = {
    copy: undefined,
    availability: UNAVAILABLE,
  };

  /** How the dialog ended; 'pending' while it is open. */
  get outcome(): ConfirmOutcome {
    return this.#outcome;
  }

  /** The text the overlay host announces after the dialog closed on its own, if any. */
  get announcement(): string | undefined {
    return CONFIRM_ANNOUNCEMENTS[this.#outcome];
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#start();
  }

  override disconnectedCallback(): void {
    this.#stop();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    // A different gateway means the config changed under the dialog: never confirm against the new mapping.
    if (changed.has('services') && this.#gateway !== undefined && this.services?.gateway !== this.#gateway) {
      this.#finish('connection-changed');
    }
    this.#view = { copy: this.#confirmableCopy(), availability: this.#availability() };
    this.heading = (this.#view.copy ?? UNCONFIRMABLE_COPY).title;
  }

  protected override firstUpdated(): void {
    if (this.#outcome === 'pending') super.firstUpdated();
  }

  protected override initialFocus(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.cancel');
  }

  protected override describedBy(): string {
    return DESCRIPTION_ID;
  }

  protected override onDialogClosed(): void {
    if (this.#outcome === 'pending') this.#outcome = 'cancelled';
    this.#stop();
    super.onDialogClosed();
  }

  protected override renderBody(): TemplateResult {
    const { copy, availability } = this.#view;
    if (copy === undefined) {
      return html`<div id=${DESCRIPTION_ID}>${UNCONFIRMABLE_COPY.body.map((line) => html`<p>${line}</p>`)}</div>`;
    }
    const lines = availability.enabled ? copy.body : copy.body.slice(0, -1);
    return html`<div id=${DESCRIPTION_ID}>
      ${lines.map((line) => html`<p>${line}</p>`)}
      ${availability.enabled ? nothing : html`<p id="reason" class="reason">${availability.message}</p>`}
    </div>`;
  }

  protected override renderFooter(): TemplateResult {
    const { copy, availability } = this.#view;
    if (copy === undefined) {
      return html`<div class="actions">
        <button type="button" class="cancel" @click=${this.#onCancel} @keydown=${suppressKeyRepeat}>
          ${CLOSE_LABEL}
        </button>
      </div>`;
    }
    const enabled = availability.enabled;
    return html`<div class="actions">
      <button type="button" class="cancel" @click=${this.#onCancel} @keydown=${suppressKeyRepeat}>
        ${CANCEL_LABEL}
      </button>
      <button
        type="button"
        class="confirm"
        aria-disabled=${enabled ? nothing : 'true'}
        aria-describedby=${enabled ? nothing : 'reason'}
        @click=${this.#onConfirm}
        @keydown=${suppressKeyRepeat}
      >
        ${copy.confirmLabel}
      </button>
    </div>`;
  }

  readonly #onCancel = contained('confirm-cancel-failed', () => this.#finish('cancelled'));

  readonly #onConfirm = contained('confirm-failed', (event: MouseEvent) => {
    const services = this.services;
    const action = this.#action;
    const answerable =
      this.#outcome === 'pending' &&
      services !== undefined &&
      action !== undefined &&
      this.#confirmableCopy() !== undefined;
    if (!answerable || !this.#availability().enabled) {
      event.preventDefault();
      return;
    }
    // Minted here, at the moment of the user's answer, for exactly the action shown; the gateway spends it.
    const confirmation = mintConfirmationToken(action);
    const epoch = this.#epoch;
    const status = services.gateway.request(action, { confirmation, ...(epoch !== undefined && { epoch }) });
    if (status.phase === 'failed' && status.error?.code === 'confirmation-required') log.error('confirm-bypassed');
    this.#finish('confirmed');
  });

  /**
   * Takes the frozen action, captures the epoch, watches every input to the copy and availability, and starts the
   * auto-cancel timer. An action that never asks for confirmation cancels at once; one that cannot be confirmed
   * stays open with UNCONFIRMABLE_COPY (rule 6), watching only the epoch and the timer.
   */
  #start(): void {
    if (this.#outcome !== 'pending') return;
    const services = this.services;
    if (services === undefined || this.action === undefined) {
      log.error('confirm-copy-missing');
      this.#finish('cancelled');
      return;
    }
    this.#action = frozenActionRequest(this.action);
    const copy = this.#action === undefined ? undefined : this.#copy();
    this.#unconfirmable = this.#action === undefined || copy === null;
    if (this.#unconfirmable) {
      log.error('confirm-action-invalid');
    } else if (copy === undefined) {
      log.error('confirm-copy-missing');
      this.#finish('cancelled');
      return;
    }
    this.#gateway = services.gateway;
    this.#epoch = services.gateway.epoch();
    const rerender = contained('confirm-update-failed', () => this.requestUpdate());
    this.#subscriptions = [
      services.gateway.onEpochChange(contained('confirm-epoch-failed', () => this.#finish('connection-changed'))),
      services.gateway.subscribe('*', rerender),
    ];
    if (this.#action !== undefined && !this.#unconfirmable) {
      this.#subscriptions.push(
        services.store.subscribe(confirmWatchIds(this.#action, services.config), CONTROL_META, rerender),
      );
    }
    this.#timer = setTimeout(
      contained('confirm-timeout-failed', () => this.#finish('timed-out')),
      CONFIRM_DIALOG_TIMEOUT_MS,
    );
  }

  #stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions = [];
  }

  /** Ends the dialog once. A dialog that never opened has no native 'close' event, so it reports closing itself. */
  #finish(outcome: Exclude<ConfirmOutcome, 'pending'>): void {
    if (this.#outcome !== 'pending') return;
    this.#outcome = outcome;
    this.#stop();
    if (this.dialogElement()?.open === true) this.close();
    else queueMicrotask(() => super.onDialogClosed());
  }

  #availability(): Availability {
    const services = this.services;
    const action = this.#action;
    if (services === undefined || action === undefined || this.#unconfirmable) return UNAVAILABLE;
    return services.gateway.evaluate(action);
  }

  /** The action's own copy when it can be confirmed; undefined means UNCONFIRMABLE_COPY is shown (rule 6). */
  #confirmableCopy(): ConfirmCopy | undefined {
    if (this.#unconfirmable) return undefined;
    return this.#copy() ?? undefined;
  }

  /** The action's confirm copy; undefined when it never asks for confirmation, null when the lookup failed. */
  #copy(): ConfirmCopy | null | undefined {
    const services = this.services;
    const action = this.#action;
    if (services === undefined || action === undefined) return undefined;
    try {
      return confirmCopyFor(action, this.#context(services));
    } catch {
      log.error('confirm-copy-failed');
      return null;
    }
  }

  #context(services: DashboardServices): ConfirmContext {
    const security = services.config.security;
    const departureConfigured = security?.actions.prepare_departure !== undefined;
    if (security === undefined) return { departureConfigured };
    return { alarm: alarmDisplayFor(services.store, security.alarm), departureConfigured };
  }
}

defineOnce('agr-confirm-dialog', AgrConfirmDialog);

declare global {
  interface HTMLElementTagNameMap {
    'agr-confirm-dialog': AgrConfirmDialog;
  }
}
