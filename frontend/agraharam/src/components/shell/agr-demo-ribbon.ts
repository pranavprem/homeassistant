/**
 * The conspicuous demo label (§10.1, D5): non-dismissible, role="status", at the top of the frame whenever the card
 * runs on fictional data.
 */
import { css, html, LitElement, type TemplateResult } from 'lit';
import { renderIcon } from '../../icons/render-icon.ts';
import { defineOnce } from '../../util/define.ts';

const DEMO_RIBBON_TEXT = 'Demo mode: fictional data. Nothing here controls a real home.';

class AgrDemoRibbon extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .ribbon {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--agr-space-2);
      padding: var(--agr-space-2) var(--agr-space-4);
      border-radius: var(--agr-radius-control);
      font: var(--agr-type-meta-strong);
      color: var(--agr-brass-ink);
      background: var(--agr-brass-tint);
      text-align: center;
    }
  `;

  protected override render(): TemplateResult {
    return html`<div class="ribbon" role="status">${renderIcon('info', 18)}<span>${DEMO_RIBBON_TEXT}</span></div>`;
  }
}

defineOnce('agr-demo-ribbon', AgrDemoRibbon);

declare global {
  interface HTMLElementTagNameMap {
    'agr-demo-ribbon': AgrDemoRibbon;
  }
}
