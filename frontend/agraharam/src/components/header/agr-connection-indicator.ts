/**
 * Connection indicator (§6.4, §9.1): a dot plus a label ("Connected", "Reconnecting", "Disconnected", "Starting",
 * "Demo"). The dot's shape changes with the state (filled when live, a hollow ring otherwise), so the label is not
 * the only cue and color is never the only one. The medium header, where the quiet label is hidden, shows an 18 px
 * wifi glyph instead of the lone dot (a dot without its label read as stray punctuation), and wifi-off with the
 * label when the connection is lost; the label stays available to assistive technology either way (`show-label`
 * keeps the dot and label, for the household drawer). Not a live region: the alert banner announces changes.
 *
 * Variant styling uses unnamed container queries; see agr-presence.ts.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import type { ConnectionVM, IconName } from '../../model/types.ts';
import { HEADER_CQ } from '../../styles/breakpoints.ts';
import { toneStyles, visuallyHiddenDeclarations, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';

/** Statuses that need no attention: the medium header shows them as the dot alone. */
const QUIET_STATUSES: ReadonlySet<ConnectionVM['status']> = new Set(['connected', 'demo']);
const GLYPH_SIZE = 18;
/** The medium header's glyph per status; demo and loading keep the dot (nothing real is connected yet). */
const GLYPHS: Readonly<Partial<Record<ConnectionVM['status'], IconName>>> = Object.freeze({
  connected: 'wifi',
  starting: 'wifi',
  resyncing: 'wifi',
  disconnected: 'wifi-off',
});

class AgrConnectionIndicator extends LitElement {
  static override styles = [
    toneStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: var(--agr-space-2);
        min-block-size: var(--agr-target);
        white-space: nowrap;
      }
      .dot {
        box-sizing: border-box;
        flex: none;
        inline-size: 9px;
        block-size: 9px;
        border-radius: 50%;
        border: 2px solid var(--agr-muted);
      }
      .dot[data-status='connected'] {
        border-color: var(--agr-olive);
        background: var(--agr-olive);
      }
      .dot[data-status='demo'] {
        border-color: var(--agr-brass);
        background: var(--agr-brass);
      }
      .dot[data-status='resyncing'],
      .dot[data-status='starting'] {
        border-color: var(--agr-brass);
      }
      .label {
        font: var(--agr-type-meta-strong);
      }
      .glyph {
        display: none;
        color: var(--agr-muted);
      }
      .glyph[data-status='disconnected'] {
        color: var(--agr-brass-ink);
      }
      @container (width < ${HEADER_CQ.full}px) {
        .glyph {
          display: inline-flex;
        }
        .glyph + .dot {
          display: none;
        }
        .label.quiet {
          ${visuallyHiddenDeclarations}
        }
      }
    `,
  ];

  @property({ attribute: false }) connection?: ConnectionVM;
  /** Always show the label (the household drawer), whatever the nearest container's width. */
  @property({ type: Boolean, attribute: 'show-label' }) showLabel = false;

  protected override render(): TemplateResult | typeof nothing {
    const connection = this.connection;
    if (connection === undefined) return nothing;
    const quiet = !this.showLabel && QUIET_STATUSES.has(connection.status);
    const glyph = this.showLabel ? undefined : GLYPHS[connection.status];
    return html`${
        glyph === undefined
          ? nothing
          : html`<span class="glyph" data-status=${connection.status} aria-hidden="true"
              >${renderIcon(glyph, GLYPH_SIZE)}</span
            >`
      }<span class="dot" data-status=${connection.status} aria-hidden="true"></span
      ><span class="visually-hidden">Connection: </span
      ><span class="label ${quiet ? 'quiet' : ''}" data-tone=${connection.tone}>${connection.label}</span>`;
  }
}

defineOnce('agr-connection-indicator', AgrConnectionIndicator);

declare global {
  interface HTMLElementTagNameMap {
    'agr-connection-indicator': AgrConnectionIndicator;
  }
}
