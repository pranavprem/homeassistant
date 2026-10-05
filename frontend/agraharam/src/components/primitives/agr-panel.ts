/**
 * Section frame (§5.5, §6.5). The heading, its id and the labelled <section> live in ONE shadow tree, because
 * IDREFs do not resolve across shadow roots.
 *
 * The host is the `panel` size container that panel internals query (§6.1), and it carries the surface and the
 * padding, so the measured content box excludes the padding. The container is the host rather than the inner
 * <section> because WebKit resolves a container for slotted content only through light-tree ancestors: content
 * nested inside a slotted element (Today's hero number) never matched a container inside this shadow tree there.
 * WebKit also scopes container names to the tree that declares them, so the section hosts re-declare the name from
 * their own tree (`sectionHostStyles`).
 *
 * The `actions` slot holds the header's trailing content: buttons, or one short meta line such as Today's sunset
 * time. A panel that absorbs its column's slack (§6.2) never distributes it between its children, which turned a
 * stretched panel into scattered islands: by default the content stays packed under the header and the slack
 * collects at the bottom, and `centered` keeps the content together as one group in the middle of the free height
 * (Today, the anchor), so its internal spacing never changes.
 *
 * The slotted content sits in one stack that never stretches, so its size is the panel's natural content size. When
 * it changes the panel dispatches PANEL_RESIZE_EVENT (composed), and the card root re-measures how much column slack
 * a stretched panel may take (§16.14): the root owns the columns, the panel only reports.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { Tone } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { IconName } from '../../model/types.ts';
import { pillStyles } from '../../styles/shared.ts';
import { typographyStyles } from '../../styles/typography.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';

type PanelSurface = 'hero' | 'raised' | 'quiet';
export interface PanelPill {
  readonly label: string;
  readonly tone: Tone;
  /** A leading glyph, for a pill whose word alone could be misread (the connection's "Offline"). */
  readonly icon?: IconName;
}

/** Dispatched (bubbling, composed) whenever the panel's natural content size changes. */
export const PANEL_RESIZE_EVENT = 'agr-panel-resize';

/** §6.5: panel labels carry a 16 px line icon. */
const PANEL_ICON_SIZE = 16;
const PILL_ICON_SIZE = 14;

export class AgrPanel extends LitElement {
  static override styles = [
    typographyStyles,
    pillStyles,
    css`
      :host {
        container: panel / inline-size;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
        padding: var(--agr-panel-pad);
        border-radius: var(--agr-radius-panel);
        color: var(--agr-ink);
        background: var(--agr-surface);
        box-shadow: var(--agr-shadow-panel);
      }
      section {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-inline-size: 0;
      }
      .content {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-inline-size: 0;
      }
      /* The slot is display: contents, so the slotted children are the stack's items. The stack keeps its content
         height in a stretched panel, so its box is the natural size the card root measures. */
      .stack {
        display: flex;
        flex-direction: column;
        min-inline-size: 0;
      }
      /* safe: content taller than the panel is never pushed above it (plain center where safe is unsupported). */
      :host([centered]) .content {
        justify-content: center;
        justify-content: safe center;
      }
      /* The hero keeps its roomier sides and foot, but its label sits on the same line as the other panels'. */
      :host([surface='hero']) {
        padding: var(--agr-hero-pad, var(--agr-panel-pad));
        padding-block-start: var(--agr-panel-pad);
        background: var(--agr-surface-hero);
      }
      :host([surface='quiet']) {
        /* Placeholder bars on the translucent quiet surface need a deeper fill than the inset tone to show. */
        --agr-ghost-fill: var(--agr-ghost-quiet);
        background: var(--agr-surface-quiet);
        box-shadow: none;
      }
      header {
        display: flex;
        align-items: center;
        gap: var(--agr-space-2);
        min-block-size: 24px;
        margin-block-end: var(--agr-space-3);
        color: var(--agr-muted);
      }
      h2:focus {
        outline: none;
      }
      h2:focus-visible {
        outline: 2px solid var(--agr-focus);
        outline-offset: 2px;
      }
      .trailing {
        display: flex;
        align-items: center;
        gap: var(--agr-space-2);
        margin-inline-start: auto;
      }
    `,
  ];

  @property() heading = '';
  /** Stable per section; the focus fallback target when a trigger is gone (§5.4 rule 7). */
  @property({ attribute: 'heading-id' }) headingId = '';
  /** 16 px line icon before the uppercase label, as in the reference. */
  @property() icon?: IconName;
  /** Right-aligned header status pill ("Cooling"). */
  @property({ attribute: false }) pill?: PanelPill;
  @property({ reflect: true }) surface: PanelSurface = 'raised';
  /** In a stretched panel, the content is centred as one group in the free height instead of packed at the top. */
  @property({ type: Boolean, reflect: true }) centered = false;

  #stackObserver: ResizeObserver | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.#observeStack();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#stackObserver?.disconnect();
  }

  protected override firstUpdated(): void {
    this.#observeStack();
  }

  /** Observes the stack once it exists; a re-attached panel observes again (disconnect dropped the targets). */
  #observeStack(): void {
    const stack = this.renderRoot?.querySelector('.stack');
    if (stack === null || stack === undefined || typeof ResizeObserver === 'undefined') return;
    this.#stackObserver ??= new ResizeObserver(
      contained('panel-resize-failed', () => {
        this.dispatchEvent(new Event(PANEL_RESIZE_EVENT, { bubbles: true, composed: true }));
      }),
    );
    this.#stackObserver.observe(stack);
  }

  protected override render(): TemplateResult {
    return html`<section aria-labelledby=${this.headingId}>
      <header>
        ${this.icon ? renderIcon(this.icon, PANEL_ICON_SIZE) : nothing}
        <h2 id=${this.headingId} class="t-label" tabindex="-1">${this.heading}</h2>
        <span class="trailing">
          ${this.pill ? renderPill(this.pill) : nothing}
          <slot name="actions"></slot>
        </span>
      </header>
      <div class="content">
        <div class="stack"><slot></slot></div>
      </div>
    </section>`;
  }
}

function renderPill(pill: PanelPill): TemplateResult {
  return html`<span class="pill" data-tone=${pill.tone}
    >${pill.icon ? renderIcon(pill.icon, PILL_ICON_SIZE) : nothing}${pill.label}</span
  >`;
}

defineOnce('agr-panel', AgrPanel);

declare global {
  interface HTMLElementTagNameMap {
    'agr-panel': AgrPanel;
  }
}
