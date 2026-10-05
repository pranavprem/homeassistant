/**
 * Modal dialog base (§5.2, §5.4). agr-drawer, agr-camera-dialog and agr-confirm-dialog extend it, so every overlay
 * shares one set of rules: a native <dialog> opened with showModal() (top layer, inert page), a generated heading id
 * behind aria-labelledby, initial focus, a Tab trap across the composed tree, the "Demo" pill, `data-theme` on the
 * dialog for ::backdrop and color-scheme, closing on detach, and 'agr-drawer-closed' when the dialog closes.
 *
 * A body that scrolls but holds nothing focusable (a long health or diagnostics list) becomes a labelled, focusable
 * region, because Safari scrolls with the keyboard only what has focus (WCAG 2.1.1, axe scrollable-region-focusable).
 * A body with controls stays out of the tab order, so no focusable element ever sits inside another (§12.2).
 *
 * It is abstract, so the base itself is never registered as an element.
 */
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import { dialogStyles, focusRingStyles, pillStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { tabbableElements, trapTabKey } from '../../util/focus.ts';
import { contained, log } from '../../util/log.ts';
import { closeIfNotModal, isBackdropClick, showModalSafely } from '../../util/modal.ts';
import type { DashboardServices } from '../services.ts';

let headingCount = 0;

export abstract class AgrDialog extends LitElement {
  static override styles = [focusRingStyles, visuallyHiddenStyles, pillStyles, typographyStyles, dialogStyles];

  @property() heading = '';
  /** Shows the "Demo" status pill in the dialog header (§10.1). */
  @property({ type: Boolean }) demo = false;
  /** Reflected onto the <dialog> as data-theme for the ::backdrop literal and color-scheme (§5.4 rule 13). */
  @property() theme: DashboardServices['theme'] = 'light';

  protected readonly headingId = `agr-dialog-heading-${(headingCount += 1)}`;
  /** 'centered' for dialogs; drawers use 'sheet' (side or bottom by viewport, §5.4 rule 9). */
  protected layout: 'centered' | 'sheet' = 'centered';
  protected dialogRole: 'dialog' | 'alertdialog' = 'dialog';
  /** §5.4 rule 6: a backdrop click closes drawers and the camera dialog, never the confirm dialog. */
  protected closeOnBackdrop = true;
  protected showCloseButton = true;

  /** True while the body scrolls and contains nothing focusable; it then takes focus itself. */
  @state() private bodyFocusable = false;

  #bodyObserver: ResizeObserver | undefined;
  /** What the observer watches now, so an update that renders the same elements does not re-observe them. */
  #observed: readonly Element[] = [];

  /** The dialog body (inside the scrolling region). */
  protected abstract renderBody(): TemplateResult | typeof nothing;

  /** Fixed content below the body, such as the confirm dialog's buttons. */
  protected renderFooter(): TemplateResult | typeof nothing {
    return nothing;
  }

  /** `data-sheet` for sheet layouts ('bottom' forces a bottom sheet at every width). */
  protected sheetPlacement(): string | undefined {
    return undefined;
  }

  /**
   * The id of an element in this shadow root that describes the dialog, for aria-describedby on the <dialog>.
   * The confirm dialog points it at its body, so its consequence is read along with the focused Cancel button.
   */
  protected describedBy(): string | undefined {
    return undefined;
  }

  /** Initial focus (§5.4 rule 3): Close by default; drawers focus their heading, the confirm dialog Cancel. */
  protected initialFocus(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.close') ?? this.headingElement();
  }

  /** Called when the native dialog closed for any reason (Close, Escape, backdrop, close() or detach). */
  protected onDialogClosed(): void {
    this.dispatchEvent(new CustomEvent('agr-drawer-closed', { bubbles: true, composed: true }));
  }

  /** Closes the dialog; the native 'close' event then runs onDialogClosed(). */
  close(): void {
    const dialog = this.dialogElement();
    if (dialog?.open) dialog.close();
  }

  protected dialogElement(): HTMLDialogElement | null {
    return this.renderRoot?.querySelector('dialog') ?? null;
  }

  protected headingElement(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(`#${this.headingId}`);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // §5.4 rule 11: a dialog that survived a detach is open but no longer modal; it is closed, never reopened.
    const dialog = this.dialogElement();
    if (dialog !== null) closeIfNotModal(dialog);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#bodyObserver?.disconnect();
    this.#observed = [];
    this.close();
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    this.#observeBody();
  }

  protected override firstUpdated(): void {
    const dialog = this.dialogElement();
    if (dialog === null || !this.isConnected) return;
    try {
      showModalSafely(dialog);
      this.initialFocus()?.focus();
    } catch {
      log.error('dialog-open-failed');
    }
  }

  readonly #onClose = contained('dialog-close-failed', () => this.onDialogClosed());

  readonly #onClick = contained('dialog-click-failed', (event: MouseEvent) => {
    const dialog = this.dialogElement();
    if (dialog !== null && this.closeOnBackdrop && isBackdropClick(event, dialog)) dialog.close();
  });

  readonly #onKeydown = contained('dialog-keydown-failed', (event: KeyboardEvent) => {
    const dialog = this.dialogElement();
    if (dialog !== null) trapTabKey(event, dialog);
  });

  readonly #onCloseButton = contained('dialog-close-button-failed', () => this.close());

  readonly #onBodyChange = contained('dialog-body-observe-failed', () => {
    this.#observeBody();
    this.#syncBodyFocusable();
  });

  #bodyElement(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>('.dialog-body') ?? null;
  }

  /**
   * Watches the body box and every element rendered or slotted into it: the body's own size stops changing once it
   * reaches the dialog's height cap, so only the content's size reveals that it started or stopped scrolling. The
   * observer changes only when those elements do.
   */
  #observeBody(): void {
    const body = this.#bodyElement();
    if (body === null || typeof ResizeObserver === 'undefined') return;
    const targets = [
      body,
      ...[...body.children].flatMap((child) =>
        child instanceof HTMLSlotElement ? child.assignedElements({ flatten: true }) : [child],
      ),
    ];
    if (
      targets.length === this.#observed.length &&
      targets.every((target, index) => target === this.#observed[index])
    ) {
      return;
    }
    this.#bodyObserver ??= new ResizeObserver(contained('dialog-body-resize-failed', () => this.#syncBodyFocusable()));
    this.#bodyObserver.disconnect();
    for (const target of targets) this.#bodyObserver.observe(target);
    this.#observed = targets;
  }

  #syncBodyFocusable(): void {
    const body = this.#bodyElement();
    if (body === null) return;
    const scrolls = body.scrollHeight > body.clientHeight || body.scrollWidth > body.clientWidth;
    const focusable = scrolls && tabbableElements(body).length === 0;
    if (focusable !== this.bodyFocusable) this.bodyFocusable = focusable;
  }

  protected override render(): TemplateResult {
    return html`<dialog
      class=${this.layout}
      role=${this.dialogRole === 'alertdialog' ? 'alertdialog' : nothing}
      data-sheet=${this.sheetPlacement() ?? nothing}
      data-theme=${this.theme}
      aria-labelledby=${this.headingId}
      aria-describedby=${this.describedBy() ?? nothing}
      @close=${this.#onClose}
      @click=${this.#onClick}
      @keydown=${this.#onKeydown}
    >
      <div class="surface">
        <header class="dialog-header">
          <h2 id=${this.headingId} tabindex="-1">${this.heading}</h2>
          ${this.demo ? html`<span class="pill" data-tone="attention">Demo</span>` : nothing}
          ${
            this.showCloseButton
              ? html`<button type="button" class="close" @click=${this.#onCloseButton}>
                  ${renderIcon('x')}<span class="visually-hidden">Close</span>
                </button>`
              : nothing
          }
        </header>
        <div
          class="dialog-body"
          role=${this.bodyFocusable ? 'region' : nothing}
          tabindex=${this.bodyFocusable ? '0' : nothing}
          aria-labelledby=${this.bodyFocusable ? this.headingId : nothing}
          @slotchange=${this.#onBodyChange}
        >
          ${this.renderBody()}
        </div>
        ${this.renderFooter()}
      </div>
    </dialog>`;
  }
}
