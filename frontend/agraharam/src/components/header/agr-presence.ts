/**
 * One household member's presence (§6.4): initials only (never a photo), and a state that is never carried by color
 * alone (WCAG 1.4.1). Home is a solid olive ring with a house badge, Away a dashed ring with no badge, Unknown a
 * dotted muted ring with a "?" badge. The full header adds the visible state text; the medium header keeps it as
 * visually hidden text. Display only: nothing here is focusable.
 *
 * Variant styling uses UNNAMED container queries: agr-header is the nearest size container, and WebKit does not
 * match a container name across shadow roots (names are tree-scoped), so `@container header` would never apply here.
 * Keep agr-header the only size container between this element and the header host.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { renderIcon } from '../../icons/render-icon.ts';
import type { PresenceVM } from '../../model/types.ts';
import { HEADER_CQ } from '../../styles/breakpoints.ts';
import { visuallyHiddenDeclarations, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';

const BADGE_ICON_PX = 10;

/** The avatar with its status ring and badge; shared with the household drawer's people list. */
export function renderAvatar(person: PresenceVM): TemplateResult {
  return html`<span class="avatar" data-presence=${person.presence} aria-hidden="true">
    <span class="initials">${person.initials}</span>
    ${
      person.presence === 'home'
        ? html`<span class="badge">${renderIcon('house', BADGE_ICON_PX)}</span>`
        : person.presence === 'unknown'
          ? html`<span class="badge">?</span>`
          : nothing
    }
  </span>`;
}

/** Ring, badge and state-text styles for renderAvatar(); plain olive is a ring and badge fill, never text. */
export const avatarStyles = css`
  .avatar {
    position: relative;
    box-sizing: border-box;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    inline-size: 34px;
    block-size: 34px;
    border-radius: 50%;
    border: 2px solid var(--agr-olive);
    background: var(--agr-surface);
  }
  .initials {
    font: var(--agr-type-meta-strong);
    letter-spacing: 0.02em;
    color: var(--agr-ink);
  }
  .avatar[data-presence='away'] {
    border-style: dashed;
    border-color: var(--agr-muted);
    background: var(--agr-surface-inset);
  }
  .avatar[data-presence='unknown'] {
    border-style: dotted;
    border-color: var(--agr-muted);
    background: var(--agr-surface-inset);
  }
  .avatar[data-presence='unknown'] .initials {
    color: var(--agr-muted);
  }
  .badge {
    position: absolute;
    inset-block-end: -4px;
    inset-inline-end: -5px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 16px;
    block-size: 16px;
    border-radius: 50%;
    /* A cut-out ring in the color behind the avatar (canvas in the header, surface in drawers). */
    border: 2px solid var(--agr-avatar-cutout, var(--agr-canvas));
    /* A glyph inside a 16 px badge, sized like an icon rather than set on the text scale. */
    font: 700 9px/1 var(--agr-font-ui);
  }
  .avatar[data-presence='home'] .badge {
    color: var(--agr-surface);
    background: var(--agr-olive);
  }
  .avatar[data-presence='unknown'] .badge {
    color: var(--agr-surface);
    background: var(--agr-muted);
  }
  .state {
    font: var(--agr-type-meta);
    color: var(--agr-muted);
    white-space: nowrap;
  }
  .state[data-presence='home'] {
    color: var(--agr-olive-ink);
  }
`;

class AgrPresence extends LitElement {
  static override styles = [
    visuallyHiddenStyles,
    avatarStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: var(--agr-space-2);
      }
      /* Medium header: the ring and badge carry the state; the text stays for assistive technology. */
      @container (width < ${HEADER_CQ.full}px) {
        .state {
          ${visuallyHiddenDeclarations}
        }
      }
    `,
  ];

  @property({ attribute: false }) person?: PresenceVM;

  protected override render(): TemplateResult | typeof nothing {
    const person = this.person;
    if (person === undefined) return nothing;
    return html`${renderAvatar(person)}<span class="visually-hidden">${person.name}, </span
      ><span class="state" data-presence=${person.presence}>${person.label}</span>`;
  }
}

defineOnce('agr-presence', AgrPresence);

declare global {
  interface HTMLElementTagNameMap {
    'agr-presence': AgrPresence;
  }
}
