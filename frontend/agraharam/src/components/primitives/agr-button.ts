/**
 * Action button (§5.5, §7.2). A native <button>. A disabled Availability sets aria-disabled="true" plus a click
 * guard (never the native `disabled` attribute), so the button stays reachable and announces its reason through
 * aria-describedby. Emits 'agr-activate' (no detail, { bubbles: true, composed: false }) once per click, Enter or
 * Space; repeated keydowns (`KeyboardEvent.repeat`) are suppressed so a held Enter cannot click repeatedly.
 *
 * Status text is static: the section's live region is the only live region (§16.10).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { isTicketInFlight, type ActionStatus, type Availability } from '../../ha/actions/types.ts';
import { ticketShortText } from '../../model/action-copy.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { IconName } from '../../model/types.ts';
import {
  disabledControlDeclarations,
  focusRingStyles,
  pendingSweepStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { suppressKeyRepeat, type ReasonDisplay } from './control-helpers.ts';

type ButtonVariant = 'quiet' | 'primary' | 'confirm';
/**
 * Set when the device a power or light toggle switches is on, so the toggle shows its own state (§6.5): `device` is
 * a solid olive fill with a surface glyph (mirroring the plum primary transport), `light` a brass tint with a brass
 * ring. The label ("Turn off …") states the same fact, so color is never the only cue. A disabled toggle keeps the
 * shared disabled look.
 */
type PoweredTone = 'device' | 'light';

const buttonStyles = css`
  :host {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--agr-space-1);
    min-inline-size: 0;
  }
  button {
    position: relative;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--agr-space-2);
    min-inline-size: var(--agr-target);
    min-block-size: var(--agr-target);
    padding: 0 var(--agr-space-4);
    border: none;
    border-radius: var(--agr-radius-control);
    font: var(--agr-type-control);
    color: var(--agr-ink);
    background: var(--agr-surface);
    box-shadow: var(--agr-shadow-raised);
    cursor: pointer;
    transition:
      background var(--agr-dur-1) var(--agr-ease),
      box-shadow var(--agr-dur-1) var(--agr-ease);
  }
  button:active:not([aria-disabled='true']) {
    box-shadow: var(--agr-shadow-pressed);
  }
  button[data-variant='primary'] {
    color: var(--agr-surface);
    background: var(--agr-plum);
  }
  button[data-variant='confirm'] {
    color: var(--agr-surface);
    background: var(--agr-ink);
  }
  button[data-powered='device']:not([aria-disabled='true']) {
    color: var(--agr-surface);
    background: var(--agr-olive);
  }
  button[data-powered='light']:not([aria-disabled='true']) {
    color: var(--agr-brass-ink);
    background: var(--agr-brass-tint);
    box-shadow: inset 0 0 0 1px var(--agr-brass);
  }
  /* A pressed toggle sits in: an olive-tinted well with an inset edge, so "on" never relies on color alone and never
     looks like a solid primary action. */
  button[aria-pressed='true']:not([aria-disabled='true']) {
    color: var(--agr-olive-ink);
    background: var(--agr-olive-tint);
    box-shadow:
      var(--agr-shadow-pressed),
      inset 0 0 0 1px var(--agr-olive);
  }
  button[aria-disabled='true'] {
    ${disabledControlDeclarations}
  }
  .reason,
  .status {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
  }
  .status[data-phase='uncertain'] {
    color: var(--agr-brass-ink);
  }
  .status[data-phase='failed'] {
    color: var(--agr-danger);
  }
`;

export class AgrButton extends LitElement {
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static override styles = [focusRingStyles, visuallyHiddenStyles, pendingSweepStyles, buttonStyles];

  @property() label = '';
  @property() icon?: IconName;
  /** Stable `data-focus-key` used to restore focus after a layout change (§5.1). */
  @property({ attribute: 'focus-key' }) focusKey = '';
  /** Disabled → aria-disabled="true" + click guard (§7.2); the reason is wired through aria-describedby. */
  @property({ attribute: false }) availability!: Availability;
  /** "Sending", "Done", … rendered as its own static status text. */
  @property({ attribute: false }) status?: ActionStatus;
  @property() variant: ButtonVariant = 'quiet';
  @property() powered?: PoweredTone;
  /**
   * Set for a state toggle ("Power"): `aria-pressed` reports the observed state, and activation asks for the other
   * one. Undefined for plain actions, which carry no aria-pressed at all.
   */
  @property({ attribute: false }) pressed?: boolean;
  @property({ attribute: 'reason-display' }) reasonDisplay: ReasonDisplay = 'visible';
  /** Set when activation opens a drawer or dialog: `aria-haspopup="dialog"` says so before the user activates it. */
  @property({ type: Boolean, attribute: 'opens-dialog' }) opensDialog = false;

  protected readonly onClick = contained('button-click-failed', (event: MouseEvent) => {
    if (!this.canActivate()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.dispatchEvent(new CustomEvent('agr-activate', { bubbles: true, composed: false }));
  });

  /** A ticket in flight blocks repeat activation even before the section re-renders a busy Availability. */
  protected canActivate(): boolean {
    return this.availability?.enabled === true && !isTicketInFlight(this.status);
  }

  /** The reason a disabled button cannot act, or undefined when it can. */
  protected disabledReason(): string | undefined {
    const availability = this.availability;
    return availability !== undefined && !availability.enabled ? availability.message : undefined;
  }

  protected renderButton(content: TemplateResult): TemplateResult {
    const reason = this.disabledReason();
    const statusText = this.status === undefined ? undefined : ticketShortText(this.status);
    const describedBy = [reason ? 'reason' : '', statusText ? 'status' : ''].filter(Boolean).join(' ');
    return html`<button
        type="button"
        class="sweep"
        data-variant=${this.variant}
        data-powered=${this.powered ?? nothing}
        data-phase=${this.status?.phase ?? nothing}
        data-focus-key=${this.focusKey || nothing}
        aria-pressed=${this.pressed === undefined ? nothing : String(this.pressed)}
        aria-haspopup=${this.opensDialog ? 'dialog' : nothing}
        aria-disabled=${this.canActivate() ? nothing : 'true'}
        aria-describedby=${describedBy || nothing}
        @click=${this.onClick}
        @keydown=${suppressKeyRepeat}
      >
        ${content}
      </button>
      ${
        reason
          ? html`<span id="reason" class=${this.reasonDisplay === 'visible' ? 'reason' : 'visually-hidden'}
              >${reason}</span
            >`
          : nothing
      }
      ${statusText ? html`<span id="status" class="status" data-phase=${this.status?.phase}>${statusText}</span>` : nothing}`;
  }

  protected override render(): TemplateResult {
    return this.renderButton(html`${this.icon ? renderIcon(this.icon) : nothing}<span>${this.label}</span>`);
  }
}

defineOnce('agr-button', AgrButton);

declare global {
  interface HTMLElementTagNameMap {
    'agr-button': AgrButton;
  }
  interface HTMLElementEventMap {
    'agr-activate': CustomEvent<null>;
  }
}
