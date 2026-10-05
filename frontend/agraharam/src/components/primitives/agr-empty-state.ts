/**
 * A quiet, intentional empty state inside a panel or drawer (DESIGN: empty and unavailable are design states): the
 * 20 px glyph in a 40 px round well (the size every row icon uses), aligned with the heading's first line. Copy is
 * household language; configuration hints belong in Diagnostics.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import type { IconName } from '../../model/types.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';

const ICON_SIZE = 20;

class AgrEmptyState extends LitElement {
  static override styles = [
    typographyStyles,
    css`
      :host {
        display: block;
      }
      .empty {
        display: flex;
        align-items: flex-start;
        gap: var(--agr-space-3);
        padding: var(--agr-space-4);
        border-radius: var(--agr-radius-inner);
        color: var(--agr-muted);
        background: var(--agr-surface-inset);
      }
      /* Centred on the heading's first 22 px line: the well is 40 px, so it starts 9 px above that line. */
      .well {
        box-sizing: border-box;
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        inline-size: 40px;
        block-size: 40px;
        margin-block: -9px;
        border-radius: 50%;
        background: var(--agr-surface);
      }
      .text {
        min-inline-size: 0;
      }
      p {
        margin: 0;
      }
      .heading {
        color: var(--agr-ink);
      }
    `,
  ];

  @property() icon?: IconName;
  @property() heading = '';
  @property() message = '';

  protected override render(): TemplateResult {
    return html`<div class="empty">
      ${this.icon ? html`<span class="well" aria-hidden="true">${renderIcon(this.icon, ICON_SIZE)}</span>` : nothing}
      <div class="text">
        <p class="t-strong heading">${this.heading}</p>
        ${this.message ? html`<p class="t-meta">${this.message}</p>` : nothing}
      </div>
    </div>`;
  }
}

defineOnce('agr-empty-state', AgrEmptyState);

declare global {
  interface HTMLElementTagNameMap {
    'agr-empty-state': AgrEmptyState;
  }
}
