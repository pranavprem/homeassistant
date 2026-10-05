/**
 * The header clock and date (§6.4): serif tabular digits, the period in small caps, the date beneath. Display only:
 * agr-header re-renders it on the store's minute-aligned 'clock' meta (§9.1), and the text comes from the
 * Formatter, so the user's language, 12/24-hour setting and local or server time zone all apply.
 *
 * Sizes follow the header variant: 40 px full, 34 px medium, 30 px compact (unnamed container queries; see
 * agr-presence.ts for why the `header` name cannot be used from here).
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { ClockParts } from '../../ha/host.ts';
import { HEADER_CQ } from '../../styles/breakpoints.ts';
import { defineOnce } from '../../util/define.ts';

class AgrClock extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      text-align: end;
      white-space: nowrap;
    }
    p {
      margin: 0;
    }
    .time {
      font-family: var(--agr-font-display);
      font-optical-sizing: auto;
      font-variant-numeric: tabular-nums lining-nums;
      font-size: 40px;
      line-height: 44px;
      font-weight: 420;
      letter-spacing: -0.01em;
      color: var(--agr-ink);
    }
    .period {
      margin-inline-start: 0.12em;
      font-size: 0.6em;
      font-variant-caps: all-small-caps;
      letter-spacing: 0.04em;
    }
    .date {
      font: var(--agr-type-meta);
      color: var(--agr-muted);
    }
    @container (width < ${HEADER_CQ.full}px) {
      .time {
        font-size: 34px;
        line-height: 38px;
      }
    }
    @container (width < ${HEADER_CQ.medium}px) {
      :host {
        align-items: flex-start;
        text-align: start;
      }
      .time {
        font-size: 30px;
        line-height: 34px;
      }
    }
  `;

  @property({ attribute: false }) clock?: ClockParts;
  @property() date = '';

  protected override render(): TemplateResult {
    const clock = this.clock;
    return html`<p class="time">
        ${clock?.hm ?? ''}${clock?.period ? html`<span class="period">${clock.period}</span>` : nothing}
      </p>
      <p class="date">${this.date}</p>`;
  }
}

defineOnce('agr-clock', AgrClock);

declare global {
  interface HTMLElementTagNameMap {
    'agr-clock': AgrClock;
  }
}
