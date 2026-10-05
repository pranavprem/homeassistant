/**
 * Drawer shell (§5.2, §5.4). Every drawer renders its whole body inside one <agr-drawer heading="…" .demo=…
 * .theme=…>. agr-drawer owns the native <dialog> through the agr-dialog base: showModal() in firstUpdated (only when
 * not already open), the generated heading id and aria-labelledby, the focused <h2 tabindex="-1">, the Close
 * button, the "Demo" pill, `data-theme` on the dialog, side or bottom sheet by viewport, and closing itself on
 * disconnect. On the dialog's 'close' event it dispatches 'agr-drawer-closed' ({ bubbles: true, composed: true }).
 * Drawers never create a <dialog>, call showModal(), manage focus or render a close button themselves.
 */
import { html, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { defineOnce } from '../../util/define.ts';
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
}

defineOnce('agr-drawer', AgrDrawer);

declare global {
  interface HTMLElementTagNameMap {
    'agr-drawer': AgrDrawer;
  }
}
