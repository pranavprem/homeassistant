/**
 * The header security pill (§6.4, §8.1): a button that opens the security drawer. Line one is ALWAYS the alarm
 * panel's actual state ("Armed away", "Disarmed", "Alarm state unknown"); line two is a separate element: the
 * policy ("Policy: Auto") in the full header, or "Last known" in every variant when the value is stale. A policy of
 * "Auto" therefore can never read as an alarm state. The text never truncates; in the compact header the label may
 * wrap and the pill grows taller.
 *
 * Variant styling uses unnamed container queries; see agr-presence.ts for why agr-header must stay the nearest size
 * container.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { alarmIcon } from '../../model/alarm-labels.ts';
import { displayText } from '../../model/display.ts';
import type { SecuritySummaryVM } from '../../model/types.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import { HEADER_CQ } from '../../styles/breakpoints.ts';
import { focusRingStyles, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import { requestDrawer } from '../shell/overlay-types.ts';

const PILL_ICON_PX = 18;
const SECURITY_PILL_FOCUS_KEY = 'header:security';

class AgrSecurityPill extends LitElement {
  static override styles = [
    focusRingStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: inline-flex;
        min-inline-size: 0;
      }
      button {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        gap: var(--agr-space-2);
        min-inline-size: 0;
        min-block-size: var(--agr-target);
        padding: 6px var(--agr-space-4) 6px var(--agr-space-3);
        border: none;
        border-radius: var(--agr-radius-control);
        color: var(--agr-ink);
        background: var(--agr-surface);
        box-shadow: var(--agr-shadow-raised);
        text-align: start;
        cursor: pointer;
        transition: box-shadow var(--agr-dur-1) var(--agr-ease);
      }
      button:active {
        box-shadow: var(--agr-shadow-pressed);
      }
      .icon {
        display: inline-flex;
        flex: none;
      }
      .lines {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
      }
      .label {
        font: var(--agr-type-control);
        white-space: nowrap;
      }
      .detail {
        font: var(--agr-type-meta);
        color: var(--agr-muted);
        white-space: nowrap;
      }
      button[data-tone='ok'] {
        color: var(--agr-olive-ink);
        background: var(--agr-olive-tint);
        box-shadow: none;
      }
      button[data-tone='attention'] {
        color: var(--agr-brass-ink);
        background: var(--agr-brass-tint);
        box-shadow: none;
      }
      button[data-tone='danger'] {
        color: var(--agr-danger);
        background: var(--agr-danger-tint);
        box-shadow: none;
      }
      button[data-tone='muted'] {
        color: var(--agr-muted);
        background: var(--agr-surface-inset);
        box-shadow: none;
      }
      /* Medium and compact: the full alarm label only; the policy moves to the security drawer. */
      @container (width < ${HEADER_CQ.full}px) {
        .policy {
          display: none;
        }
      }
      /* Compact: the label wraps rather than truncating ("Alarm state unknown" at 390 px). */
      @container (width < ${HEADER_CQ.medium}px) {
        .label {
          white-space: normal;
        }
      }
    `,
  ];

  @property({ attribute: false }) summary?: SecuritySummaryVM;

  readonly #onClick = contained('security-pill-click-failed', (event: MouseEvent) => {
    const trigger = event.currentTarget as HTMLElement;
    requestDrawer(this, { id: 'security' }, trigger);
  });

  protected override render(): TemplateResult | typeof nothing {
    const summary = this.summary;
    if (summary === undefined) return nothing;
    const { alarm, policy } = summary;
    return html`<button
      type="button"
      data-tone=${alarm.tone}
      data-focus-key=${SECURITY_PILL_FOCUS_KEY}
      aria-haspopup="dialog"
      @click=${this.#onClick}
      @keydown=${suppressKeyRepeat}
    >
      <span class="icon">${renderIcon(alarmIcon(alarm), PILL_ICON_PX)}</span>
      <span class="lines">
        <span class="visually-hidden">Alarm: </span><span class="label">${alarm.label}</span>
        ${
          alarm.stale
            ? html`<span class="detail stale">Last known</span>`
            : policy !== undefined
              ? html`<span class="detail policy">Policy: ${displayText(policy)}</span>`
              : nothing
        }
      </span>
    </button>`;
  }
}

defineOnce('agr-security-pill', AgrSecurityPill);

declare global {
  interface HTMLElementTagNameMap {
    'agr-security-pill': AgrSecurityPill;
  }
}
