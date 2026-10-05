/**
 * Icon-only action button (§5.4 rule 10, §5.5): the agr-button contract with the label carried as visually hidden
 * text inside the native button, so the accessible name never depends on an attribute on a generic element. The
 * hit area is at least 44 × 44 even though the glyph is 20 px.
 */
import { css, html, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import type { IconName } from '../../model/types.ts';
import { defineOnce } from '../../util/define.ts';
import { AgrButton } from './agr-button.ts';

class AgrIconButton extends AgrButton {
  static override styles = [
    ...AgrButton.styles,
    css`
      button {
        inline-size: var(--agr-target);
        padding: 0;
      }
    `,
  ];

  @property() override icon: IconName = 'info';

  protected override render(): TemplateResult {
    return this.renderButton(html`${renderIcon(this.icon)}<span class="visually-hidden">${this.label}</span>`);
  }
}

defineOnce('agr-icon-button', AgrIconButton);

declare global {
  interface HTMLElementTagNameMap {
    'agr-icon-button': AgrIconButton;
  }
}
