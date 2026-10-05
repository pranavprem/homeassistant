/**
 * In-card configuration error panel (D4, §4.2). HA shows a thrown setConfig message only in edit-mode preview and
 * non-admins see only an icon, so issues render here instead. Admins see each issue's path, code and full message;
 * everyone else (and everyone until hass has arrived) sees only the path and code, because full messages quote
 * entity IDs.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { ConfigIssue } from '../../config/validate.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';

const HEADING = 'Configuration needs attention';
const NON_ADMIN_HINT = 'Ask an administrator to check the dashboard configuration.';
const ADMIN_HINT = 'Fix these in the dashboard raw configuration editor, then save.';

export class AgrConfigError extends LitElement {
  static override styles = [
    typographyStyles,
    css`
      :host {
        display: block;
      }
      section {
        box-sizing: border-box;
        max-inline-size: 760px;
        margin-inline: auto;
        padding: var(--agr-space-6);
        border-radius: var(--agr-radius-panel);
        background: var(--agr-surface);
        box-shadow: var(--agr-shadow-panel);
      }
      header {
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
        color: var(--agr-danger);
      }
      h2 {
        margin: 0;
        font: var(--agr-type-title);
        color: var(--agr-ink);
      }
      ul {
        margin: var(--agr-space-4) 0;
        padding: 0;
        list-style: none;
      }
      li {
        padding: var(--agr-space-3) 0;
        border-block-start: 1px solid var(--agr-line);
        overflow-wrap: anywhere;
      }
      .path {
        font-weight: 620;
      }
      p {
        margin: var(--agr-space-1) 0 0;
      }
    `,
  ];

  @property({ attribute: false }) issues: readonly ConfigIssue[] = [];
  /** True only for HA administrators (hass.user.is_admin). */
  @property({ type: Boolean }) detailed = false;

  protected override render(): TemplateResult {
    return html`<section aria-labelledby="config-error-heading">
      <header>
        ${renderIcon('circle-alert')}
        <h2 id="config-error-heading">${HEADING}</h2>
      </header>
      <ul>
        ${this.issues.map((issue) => this.#renderIssue(issue))}
      </ul>
      <p class="t-meta">${this.detailed ? ADMIN_HINT : NON_ADMIN_HINT}</p>
    </section>`;
  }

  #renderIssue(issue: ConfigIssue): TemplateResult {
    return html`<li>
      <span class="path t-body">${issue.path || 'configuration'}</span>
      <span class="t-meta">${issue.code}</span>
      ${this.detailed ? html`<p class="t-body">${issue.message}</p>` : nothing}
    </li>`;
  }
}

defineOnce('agr-config-error', AgrConfigError);

declare global {
  interface HTMLElementTagNameMap {
    'agr-config-error': AgrConfigError;
  }
}
