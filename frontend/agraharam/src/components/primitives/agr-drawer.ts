/**
 * Drawer shell (§5.2, §5.4). Every drawer renders its whole body inside one <agr-drawer heading="…" .demo=…
 * .theme=…>. agr-drawer owns the native <dialog> through the agr-dialog base: showModal() in firstUpdated (only when
 * not already open), the generated heading id and aria-labelledby, the focused <h2 tabindex="-1">, the Close
 * button, the "Demo" pill, `data-theme` on the dialog, side or bottom sheet by viewport, and closing itself on
 * disconnect. On the dialog's 'close' event it dispatches 'agr-drawer-closed' ({ bubbles: true, composed: true }).
 * Drawers never create a <dialog>, call showModal(), manage focus or render a close button themselves.
 *
 * Escape (§18): the dialog's native 'cancel' is re-dispatched on this host as 'agr-drawer-cancel' (not bubbling, not
 * composed, cancelable as the native one is). A drawer whose Escape means something first (clearing a search field)
 * prevents it, and the native cancel is prevented with it. A drawer that does not listen closes exactly as before.
 */
import { html, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { AgrDialog } from './agr-dialog.ts';

export class AgrDrawer extends AgrDialog {
  /** 'bottom' keeps a bottom sheet at every width (the household drawer only opens from the compact header). */
  @property() sheet: 'auto' | 'bottom' = 'auto';

  protected override layout: 'centered' | 'sheet' = 'sheet';

  protected override renderBody(): TemplateResult {
    return html`<slot></slot>`;
  }

  protected override sheetPlacement(): string {
    return this.sheet;
  }

  /** Drawers focus their heading so screen readers announce the context (§5.4 rule 3). */
  protected override initialFocus(): HTMLElement | null {
    return this.headingElement();
  }

  /**
   * Moves focus to the heading: the last fallback of a drawer whose focused content disappeared (the sky drawer's
   * aircraft rows and controls, AIRSPACE.md §6), so focus never falls out of the modal dialog onto the page.
   */
  focusHeading(): void {
    this.headingElement()?.focus();
  }

  protected override firstUpdated(): void {
    this.dialogElement()?.addEventListener('cancel', this.#onCancel);
    super.firstUpdated();
  }

  /** Chromium makes 'cancel' non-cancelable without a fresh user activation; the drawer then closes, as before. */
  readonly #onCancel = contained('drawer-cancel-failed', (event: Event) => {
    const forwarded = new CustomEvent('agr-drawer-cancel', {
      bubbles: false,
      composed: false,
      cancelable: event.cancelable,
    });
    if (!this.dispatchEvent(forwarded)) event.preventDefault();
  });
}

defineOnce('agr-drawer', AgrDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-drawer': AgrDrawer;
  }
  interface HTMLElementEventMap {
    'agr-drawer-cancel': CustomEvent<null>;
  }
}
