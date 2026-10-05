/**
 * One comfort tile (§5.1, §6.5): an inset with a round icon, the name, a status line and a serif value, as in the
 * reference. Climate and air tiles open the climate drawer; an air tile adds a sibling power toggle (composite
 * tiles are two sibling buttons, never nested). Bed tiles are plain text: no button, no control, ever.
 *
 * A leaf: it receives a VM and emits events. Opening dispatches the overlay event itself, with its own button as the
 * trigger so focus returns there; the power toggle dispatches the shared 'agr-fan-intent' for the section to apply.
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import type { Display } from '../../ha/normalize.ts';
import { renderIcon } from '../../icons/render-icon.ts';
import type { ComfortTile } from '../../model/comfort.ts';
import type { AirTileVM, BedTileVM, ClimateTileVM, IconName } from '../../model/types.ts';
import { PANEL_CQ } from '../../styles/breakpoints.ts';
import {
  focusRingStyles,
  hyphenationDeclarations,
  numStyles,
  skeletonStyles,
  staleStyles,
  visuallyHiddenStyles,
} from '../../styles/shared.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { suppressKeyRepeat } from '../primitives/control-helpers.ts';
import '../primitives/agr-icon-button.ts';
import { requestDrawer } from '../shell/overlay-types.ts';
import { FAN_INTENT_EVENT, type FanIntent } from '../shared/agr-fan-controls.ts';
import { ABSENT_GLYPH } from '../../model/display.ts';

const TILE_ICON_SIZE = 18;
/** HA's raw value for both the off HVAC mode and the off hvac_action. */
const HVAC_OFF = 'off';

type Accent = 'cool' | 'warm' | 'on' | 'muted';

/** Off from the raw observed HVAC mode or action, never from display copy. */
function isClimateOff(vm: ClimateTileVM): boolean {
  return vm.hvacModes?.current === HVAC_OFF || vm.action === HVAC_OFF;
}

/** The equipment's current activity picks the glyph: snowflake while cooling, flame while heating (§6.5 Comfort). */
export function climateIcon(vm: ClimateTileVM): { readonly icon: IconName; readonly accent: Accent } {
  if (vm.status !== 'available' && vm.status !== 'disconnected') return { icon: 'thermometer', accent: 'muted' };
  switch (vm.action) {
    case 'cooling':
      return { icon: 'snowflake', accent: 'cool' };
    case 'heating':
    case 'preheating':
      return { icon: 'flame', accent: 'warm' };
    case 'drying':
      return { icon: 'droplets', accent: 'on' };
    case 'fan':
      return { icon: 'fan', accent: 'on' };
    default:
      return { icon: isClimateOff(vm) ? 'power' : 'thermometer', accent: 'muted' };
  }
}

function displayIsLoading(display: Display): boolean {
  return display.kind === 'absent' && display.reason === 'loading';
}

export class AgrComfortTile extends LitElement {
  static override styles = [
    focusRingStyles,
    numStyles,
    skeletonStyles,
    visuallyHiddenStyles,
    css`
      :host {
        display: block;
        min-inline-size: 0;
        container: tile / inline-size;
      }
      /* Fills the grid cell, so two tiles in a row share one height when one name takes more lines. */
      .tile {
        position: relative;
        display: flex;
        align-items: center;
        box-sizing: border-box;
        block-size: 100%;
        min-block-size: 64px;
        border-radius: var(--agr-radius-inner);
        color: var(--agr-ink);
        background: var(--agr-surface-inset);
      }
      .body {
        box-sizing: border-box;
        flex: 1 1 auto;
        min-inline-size: 0;
        min-block-size: 64px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        /* The value is centred beside the name and status pair, as in the reference. */
        grid-template-areas:
          'icon name value'
          'icon meta value';
        grid-template-rows: auto auto;
        align-content: center;
        align-items: center;
        column-gap: 10px;
        padding: 10px 12px;
        text-align: start;
      }
      button.body {
        margin: 0;
        border: none;
        border-radius: inherit;
        font: inherit;
        color: inherit;
        background: transparent;
        cursor: pointer;
        transition: box-shadow var(--agr-dur-1) var(--agr-ease);
      }
      button.body:hover {
        box-shadow: inset 0 0 0 1px var(--agr-line);
      }
      .icon {
        grid-area: icon;
        display: grid;
        place-items: center;
        inline-size: 36px;
        block-size: 36px;
        border-radius: 50%;
        color: var(--agr-muted);
        background: var(--agr-surface);
        box-shadow: var(--agr-shadow-raised);
      }
      .icon[data-accent='cool'],
      .icon[data-accent='on'] {
        color: var(--agr-olive-ink);
      }
      .icon[data-accent='warm'] {
        color: var(--agr-brass-ink);
      }
      /* Names and status lines wrap at word boundaries instead of truncating: a long device name takes a second line,
         and only a single word too long for the tile is broken (and hyphenated where the language allows). */
      .name {
        grid-area: name;
        align-self: end;
        overflow-wrap: break-word;
        ${hyphenationDeclarations}
        font: var(--agr-type-strong);
      }
      .meta {
        grid-area: meta;
        align-self: start;
        overflow-wrap: break-word;
        ${hyphenationDeclarations}
        font: var(--agr-type-meta);
        color: var(--agr-muted);
      }
      .value {
        grid-area: value;
        align-self: center;
        font: var(--agr-type-value);
        font-optical-sizing: auto;
        white-space: nowrap;
      }
      .value[data-absent] {
        color: var(--agr-muted);
      }
      .skeleton {
        inline-size: 3em;
        margin-block: 0;
      }
      .toggle {
        flex: none;
        margin-inline-end: 10px;
      }
      /* A narrow tile reads top to bottom: name, value, status. */
      @container tile (width < ${PANEL_CQ.comfortTileStacked}px) {
        .body {
          grid-template-columns: auto minmax(0, 1fr);
          grid-template-areas:
            'icon name'
            'icon value'
            'icon meta';
          grid-template-rows: auto auto auto;
        }
        .name,
        .value,
        .meta {
          align-self: start;
        }
        /* An air tile has no value to move; its power toggle needs the width, so its name takes the icon's room. */
        .tile[data-kind='air'] .icon {
          display: none;
        }
        .tile[data-kind='air'] .body {
          grid-template-columns: minmax(0, 1fr);
          grid-template-areas:
            'name'
            'meta';
          grid-template-rows: auto auto;
        }
      }
      /* Narrower still (two tiles in a tight column), the name takes the icon's room. */
      @container tile (width < ${PANEL_CQ.comfortTileIcon}px) {
        .icon {
          display: none;
        }
        .body {
          grid-template-columns: minmax(0, 1fr);
          grid-template-areas:
            'name'
            'value'
            'meta';
        }
      }
    `,
    staleStyles,
  ];

  @property({ attribute: false }) tile!: ComfortTile;
  /** Prefix of the stable data-focus-key of each button (§5.1). */
  @property({ attribute: 'focus-key' }) focusKey = '';

  readonly #open = contained('comfort-tile-open-failed', (event: MouseEvent) => {
    const tile = this.tile;
    if (tile.kind === 'bed') return;
    requestDrawer(this, { id: 'climate', entity: tile.vm.key }, event.currentTarget as HTMLElement);
  });

  readonly #toggle = contained('comfort-tile-toggle-failed', (vm: AirTileVM) => {
    if (vm.power === 'unknown') return;
    const intent: FanIntent = { kind: 'power', entity: vm.key, next: vm.power === 'on' ? 'off' : 'on' };
    this.dispatchEvent(new CustomEvent<FanIntent>(FAN_INTENT_EVENT, { bubbles: true, composed: true, detail: intent }));
  });

  protected override render(): TemplateResult | typeof nothing {
    const tile = this.tile;
    if (tile === undefined) return nothing;
    switch (tile.kind) {
      case 'climate':
        return this.#renderClimate(tile.vm);
      case 'air':
        return this.#renderAir(tile.vm);
      case 'bed':
        return this.#renderBed(tile.vm);
    }
  }

  #renderClimate(vm: ClimateTileVM): TemplateResult {
    const { icon, accent } = climateIcon(vm);
    const meta = vm.actionLabel ?? vm.modeLabel;
    return html`<div class="tile" data-kind="climate">
      <button
        type="button"
        class="body"
        aria-haspopup="dialog"
        data-focus-key=${`${this.focusKey}:open`}
        @click=${this.#open}
        @keydown=${suppressKeyRepeat}
      >
        ${this.#icon(icon, accent)}<span class="name">${vm.name}</span
        >${this.#meta(meta, vm.status, vm.current)}${this.#value(vm.current, 'currently')}
      </button>
    </div>`;
  }

  #renderAir(vm: AirTileVM): TemplateResult {
    const accent: Accent = vm.power === 'on' && vm.status === 'available' ? 'on' : 'muted';
    const meta = vm.detail.kind === 'value' ? vm.detail.text : vm.detail.label;
    const next = vm.power === 'on' ? 'off' : 'on';
    return html`<div class="tile" data-kind="air">
      <button
        type="button"
        class="body"
        aria-haspopup="dialog"
        data-focus-key=${`${this.focusKey}:open`}
        @click=${this.#open}
        @keydown=${suppressKeyRepeat}
      >
        ${this.#icon('fan', accent)}<span class="name">${vm.name}</span>${this.#meta(meta, vm.status, vm.detail)}
      </button>
      ${
        vm.power === 'unknown'
          ? nothing
          : html`<agr-icon-button
              class="toggle"
              icon="power"
              label=${`Turn ${next} ${vm.name}`}
              powered=${vm.power === 'on' && vm.status === 'available' ? 'device' : nothing}
              reason-display="hidden"
              focus-key=${`${this.focusKey}:toggle`}
              .availability=${vm.toggle}
              @agr-activate=${() => this.#toggle(vm)}
            ></agr-icon-button>`
      }
    </div>`;
  }

  #renderBed(vm: BedTileVM): TemplateResult {
    const target = vm.target?.kind === 'value' ? `Set to ${vm.target.text}` : undefined;
    const meta = target ?? (vm.current.kind === 'absent' ? vm.current.label : 'Read only');
    const stale = vm.current.kind === 'value' && vm.current.stale;
    return html`<div class="tile" data-kind="bed">
      <div class="body">
        ${this.#icon('bed-double', 'muted')}<span class="name">${vm.name}</span
        ><span class="meta ${stale ? 'stale' : ''}">${meta}</span>${this.#value(vm.current, 'bed temperature')}
      </div>
    </div>`;
  }

  #icon(icon: IconName, accent: Accent): TemplateResult {
    return html`<span class="icon" data-accent=${accent} aria-hidden="true">${renderIcon(icon, TILE_ICON_SIZE)}</span>`;
  }

  /** The status line; stale (disconnected) values dim and say "last known" to assistive technology. */
  #meta(text: string, status: ClimateTileVM['status'], display: Display): TemplateResult {
    if (displayIsLoading(display) && status === 'loading') {
      return html`<span class="meta"><span class="skeleton" aria-hidden="true"></span></span>`;
    }
    const stale = status === 'disconnected' && display.kind === 'value';
    return html`<span class="meta ${stale ? 'stale' : ''}"
      >${text}${stale ? html`<span class="visually-hidden">, last known</span>` : nothing}</span
    >`;
  }

  #value(display: Display, field: string): TemplateResult {
    const label = html`<span class="visually-hidden">, ${field}</span>`;
    if (display.kind === 'value') {
      return html`<span class="value num ${display.stale ? 'stale' : ''}">${label}${display.text}</span>`;
    }
    if (display.reason === 'loading') {
      return html`<span class="value"><span class="skeleton" aria-hidden="true"></span></span>`;
    }
    return html`<span class="value" data-absent
      >${label}<span aria-hidden="true">${ABSENT_GLYPH}</span
      ><span class="visually-hidden">${display.label}</span></span
    >`;
  }
}

defineOnce('agr-comfort-tile', AgrComfortTile);

declare global {
  interface HTMLElementTagNameMap {
    'agr-comfort-tile': AgrComfortTile;
  }
}
