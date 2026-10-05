/**
 * The card header (§5.1, §6.4): identity (kolam mark, the "Agraharam" wordmark as the card's <h1>, greeting),
 * household presence, the alarm pill, the connection indicator, diagnostics and the clock.
 *
 * One DOM; the variant is pure CSS. agr-header is its own `header / inline-size` container and picks full (≥ 1040),
 * medium (760–1039) or compact (< 760; no kolam mark below 380) from its own content box, independent of the column
 * layout, so it compacts before it can overflow. Hidden parts use display: none so they also leave the
 * accessibility tree; the menu button exists in every variant and is shown only in compact, where presence,
 * the connection state and diagnostics move to the household drawer. The h1 stays for assistive technology in
 * compact (visually hidden), because it is the card's only top-level heading.
 *
 * DOM order is the full variant's reading order. Compact moves the clock beside the mark with grid areas; the clock
 * is not focusable, so the focus order (pill, then menu) still matches what is seen.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { ENABLED } from '../../ha/actions/types.ts';
import { EntityController } from '../../ha/entity-controller.ts';
import type { MetaKind } from '../../ha/host.ts';
import { headerEntityIds, selectHeader } from '../../model/header.ts';
import type { HeaderVM } from '../../model/types.ts';
import { HEADER_CQ } from '../../styles/breakpoints.ts';
import { skeletonStyles, visuallyHiddenDeclarations, visuallyHiddenStyles } from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained, log } from '../../util/log.ts';
import '../primitives/agr-icon-button.ts';
import type { DashboardServices } from '../services.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import './agr-clock.ts';
import './agr-connection-indicator.ts';
import './agr-kolam-mark.ts';
import './agr-presence.ts';
import './agr-security-pill.ts';
import { selectorInput } from '../shared/selector-input.ts';

const FALLBACK_TITLE = 'Agraharam';
/** 'clock' keeps the time, date and greeting current without any entity change; 'user' gates diagnostics. */
const HEADER_META: readonly MetaKind[] = Object.freeze(['connection', 'locale', 'clock', 'user']);

/** Before services carry a store: the pill's and the clock's shapes (the time needs HA's locale and zone). */
const LOADING_STATUS = html`<div class="status">
  <span class="skeleton ghost pill-ghost" aria-hidden="true"></span>
</div>`;
const LOADING_CLOCK = html`<span class="clock-ghost" aria-hidden="true"
  ><span class="ghost time"></span><span class="skeleton date"></span
></span>`;

const HEADER_FOCUS_KEYS = Object.freeze({ diagnostics: 'header:diagnostics', menu: 'header:menu' });

export class AgrHeader extends LitElement {
  static override styles = [
    visuallyHiddenStyles,
    skeletonStyles,
    css`
      :host {
        display: block;
        container: header / inline-size;
      }
      .bar {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto auto;
        grid-template-areas: 'identity status clock menu';
        align-items: center;
        column-gap: var(--agr-space-6);
        min-block-size: 56px;
      }
      .identity {
        grid-area: identity;
        display: flex;
        align-items: center;
        gap: var(--agr-space-3);
        min-inline-size: 0;
      }
      .titles {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      h1 {
        margin: 0;
        font: var(--agr-type-title);
        font-size: 26px; /* the wordmark sits a step above the title size (§6.5) */
        font-optical-sizing: auto;
        letter-spacing: 0.005em;
        color: var(--agr-ink);
        white-space: nowrap;
      }
      .greeting {
        margin: 0;
        font: var(--agr-type-meta);
        color: var(--agr-muted);
        white-space: nowrap;
      }
      .status {
        grid-area: status;
        justify-self: end;
        display: flex;
        align-items: center;
        gap: var(--agr-space-4);
        min-inline-size: 0;
      }
      .people {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: var(--agr-space-2) var(--agr-space-4);
        min-inline-size: 0;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .people li {
        display: flex;
      }
      agr-security-pill {
        flex: 0 1 auto;
      }
      agr-connection-indicator {
        flex: none;
      }
      agr-clock {
        grid-area: clock;
      }
      .menu {
        grid-area: menu;
        display: none;
      }
      /* Loading: the shapes of the status pill and the clock, so the header keeps its composition until the first
         states arrive instead of showing one faint bar on an empty line. */
      .skeleton {
        margin: 0;
      }
      /* Each placeholder is as tall as what replaces it, so the columns below never move when states arrive: the
         full pill has two lines (46 px); the clock's time line is its line height plus the 3 px its small-caps
         period adds, over an 18 px date line (65, 59 and 55 px in the three variants). */
      .pill-ghost {
        inline-size: 168px;
        block-size: 46px;
        border-radius: var(--agr-radius-control);
      }
      .clock-ghost {
        grid-area: clock;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }
      .clock-ghost .time {
        inline-size: 108px;
        block-size: 35px;
        margin-block: 6px;
        border-radius: var(--agr-radius-inner);
      }
      .clock-ghost .date {
        inline-size: 76px;
        block-size: 12px;
        margin: 3px 0;
      }

      /* Medium: wordmark without greeting; avatars carry presence with rings (agr-presence). */
      @container header (width < ${HEADER_CQ.full}px) {
        .bar {
          column-gap: var(--agr-space-5);
        }
        .greeting {
          display: none;
        }
        .people {
          gap: var(--agr-space-2) var(--agr-space-3);
        }
        .pill-ghost {
          inline-size: 132px;
          block-size: 44px;
        }
        .clock-ghost .time {
          block-size: 29px;
        }
      }

      /* Compact: mark, clock, pill and the menu; the rest moves to the household drawer. */
      @container header (width < ${HEADER_CQ.medium}px) {
        .bar {
          grid-template-columns: auto auto minmax(0, 1fr) auto;
          grid-template-areas: 'identity clock status menu';
          column-gap: var(--agr-space-3);
        }
        .titles {
          ${visuallyHiddenDeclarations}
        }
        .people,
        agr-connection-indicator,
        .diagnostics {
          display: none;
        }
        .menu {
          display: inline-flex;
        }
        .clock-ghost {
          align-items: flex-start;
        }
        .clock-ghost .time {
          inline-size: 88px;
          block-size: 25px;
        }
        .pill-ghost {
          inline-size: 120px;
        }
      }

      /* Narrowest phones: the mark goes; the visually hidden h1 stays out of the grid. */
      @container header (width < ${HEADER_CQ.kolam}px) {
        .bar {
          grid-template-columns: auto minmax(0, 1fr) auto;
          grid-template-areas: 'clock status menu';
        }
        .identity {
          ${visuallyHiddenDeclarations}
        }
        .mark {
          display: none;
        }
      }
    `,
  ];

  @property({ attribute: false }) services?: DashboardServices;

  constructor() {
    super();
    new EntityController(
      this,
      () => this.services?.store,
      () => (this.services?.config === undefined ? [] : headerEntityIds(this.services.config)),
      HEADER_META,
    );
  }

  protected override render(): TemplateResult {
    const vm = this.#viewModel();
    const title = vm?.title ?? this.services?.config?.title ?? FALLBACK_TITLE;
    return html`<div class="bar">
      <div class="identity">
        <agr-kolam-mark class="mark" aria-hidden="true"></agr-kolam-mark>
        <div class="titles">
          <h1>${title}</h1>
          ${vm === undefined ? nothing : html`<p class="greeting">${vm.greeting}</p>`}
        </div>
      </div>
      ${vm === undefined ? LOADING_STATUS : this.#renderStatus(vm)}
      ${vm === undefined ? LOADING_CLOCK : html`<agr-clock .clock=${vm.clock} date=${vm.date}></agr-clock>`}
      <agr-icon-button
        class="menu"
        icon="menu"
        label="Household and status"
        opens-dialog
        focus-key=${HEADER_FOCUS_KEYS.menu}
        .availability=${ENABLED}
        @agr-activate=${this.#onMenu}
      ></agr-icon-button>
    </div>`;
  }

  #renderStatus(vm: HeaderVM): TemplateResult {
    const loading = vm.connection.status === 'loading';
    return html`<div class="status">
      ${
        loading
          ? html`<span class="skeleton ghost pill-ghost" aria-hidden="true"></span>`
          : html`${
              vm.people.length === 0
                ? nothing
                : html`<ul class="people" aria-label="Presence">
                    ${vm.people.map((person) => html`<li><agr-presence .person=${person}></agr-presence></li>`)}
                  </ul>`
            }
            ${vm.security === undefined ? nothing : html`<agr-security-pill .summary=${vm.security}></agr-security-pill>`}`
      }
      <agr-connection-indicator .connection=${vm.connection}></agr-connection-indicator>
      ${
        vm.diagnosticsAvailable
          ? html`<agr-icon-button
              class="diagnostics"
              icon="info"
              label="Diagnostics"
              opens-dialog
              focus-key=${HEADER_FOCUS_KEYS.diagnostics}
              .availability=${ENABLED}
              @agr-activate=${this.#onDiagnostics}
            ></agr-icon-button>`
          : nothing
      }
    </div>`;
  }

  /** Undefined until services carry a store and reader (and on a selector failure, logged by code, §4.9). */
  #viewModel(): HeaderVM | undefined {
    const services = this.services;
    if (services?.store === undefined || services.reader === undefined) return undefined;
    try {
      return selectHeader(selectorInput(services));
    } catch {
      log.error('header-select-failed');
      return undefined;
    }
  }

  readonly #onMenu = contained('header-menu-failed', (event: Event) => {
    requestDrawer(this, { id: 'household' }, event.currentTarget as HTMLElement);
  });

  readonly #onDiagnostics = contained('header-diagnostics-failed', (event: Event) => {
    requestDrawer(this, { id: 'diagnostics' }, event.currentTarget as HTMLElement);
  });
}

defineOnce('agr-header', AgrHeader);

declare global {
  interface HTMLElementTagNameMap {
    'agr-header': AgrHeader;
  }
}
