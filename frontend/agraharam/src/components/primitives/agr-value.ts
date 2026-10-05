/**
 * One value with honest absent states (§4.6, §16.10). A value renders as text (dimmed with a visually hidden "last
 * known" when stale); an absent value renders a dash glyph plus its label as meta text ("Unavailable", "No data"),
 * never 0; loading renders a skeleton bar. The field is named by visually hidden text, not by aria-label on a
 * generic element.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { Display } from '../../ha/normalize.ts';
import { numStyles, skeletonStyles, staleStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';

export type ValueSize = 'body' | 'value' | 'title' | 'hero';

const SIZE_CLASS: Readonly<Record<ValueSize, string>> = Object.freeze({
  body: 't-body',
  value: 't-value',
  title: 't-title',
  hero: 't-hero',
});

export class AgrValue extends LitElement {
  static override styles = [
    typographyStyles,
    numStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: inline-flex;
        align-items: baseline;
        gap: var(--agr-space-2);
        min-inline-size: 0;
      }
      .skeleton {
        inline-size: 4em;
        margin-block: 0;
      }
    `,
    staleStyles,
  ];

  /** What the value is ("Temperature"); read by assistive technology only. */
  @property() field = '';
  @property({ attribute: false }) display: Display = { kind: 'absent', reason: 'loading', label: 'Loading' };
  @property() size: ValueSize = 'value';

  protected override render(): TemplateResult {
    const field = html`<span class="visually-hidden">${this.field}</span>`;
    const display = this.display;
    if (display.kind === 'value') {
      return html`${field}<span class="${SIZE_CLASS[this.size]} num ${display.stale ? 'stale' : ''}"
          >${display.text}</span
        >${display.stale ? html`<span class="visually-hidden">last known</span>` : nothing}`;
    }
    if (display.reason === 'loading') {
      return html`${field}<span class="skeleton" aria-hidden="true"></span
        ><span class="visually-hidden">${display.label}</span>`;
    }
    return html`${field}<span class="${SIZE_CLASS[this.size]}" aria-hidden="true">${ABSENT_GLYPH}</span
      ><span class="t-meta">${display.label}</span>`;
  }
}

defineOnce('agr-value', AgrValue);

declare global {
  interface HTMLElementTagNameMap {
    'agr-value': AgrValue;
  }
}
