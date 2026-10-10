/**
 * Sky radar (AIRSPACE.md §6, ARCHITECTURE.md §19): an inline, North-up vector picture of the nearby aircraft around
 * the unlabelled home at its centre. No tiles, images, fonts or network: one <svg role="img"> whose accessible name is
 * the radar summary ("7 aircraft within 25 km, 1 overhead. Nearest …"), so its parts are not read one by one.
 *
 * Every coordinate, radius and rotation comes from the pure radar view model (model/radar.ts), which builds them from
 * validated numbers only, and radar-labels.ts places the labels from those numbers. Text reaches the SVG through Lit
 * text bindings. Marks are not focusable: the aircraft list
 * below is the keyboard path. A pointer on a mark's invisible hit circle dispatches 'agr-sky-mark' with its key, and
 * the drawer expands that aircraft's row.
 *
 * Calm by design: a flat inset disc, hairline range rings, one dashed brass-ink overhead ring, ink marks (ground
 * track chevrons, or dots without a track), brass-ink with a halo for the overhead and selected aircraft. While the
 * data is not live every mark is a hollow grey circle without a chevron. No sweep, gradient, glow or animation.
 *
 * Labels stay readable without hiding an aircraft: they paint above the marks on a halo of the disc's own tone, so
 * no mark, ring or axis cuts through a letter, and radar-labels.ts places each one clear of every mark. Text sizes are
 * in viewBox units; a host drawn smaller sets --agr-sky-radar-text-scale (default 1, at most RADAR_TEXT_SCALE_MAX) so
 * its labels keep their size on screen.
 */
import { css, html, LitElement, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import {
  RADAR_CARDINALS,
  RADAR_HIT_R,
  RADAR_OUTER_R,
  RADAR_VIEWBOX,
  type RadarMarkVM,
  type RadarRingVM,
  type RadarVM,
} from '../../model/radar.ts';
import { defineOnce } from '../../util/define.ts';
import { contained } from '../../util/log.ts';
import { MARK_HALO_R, MARK_LABEL_PX, placeRadarLabels, RING_LABEL_PX } from './radar-labels.ts';

export interface SkyMarkDetail {
  readonly key: string;
}

/** A ground-track chevron pointing north before rotation, in viewBox units. */
const CHEVRON_PATH = 'M0 -5.5 L4 4.5 L0 2 L-4 4.5 Z';
const DOT_R = 2.6;
const HOLLOW_R = 3;
const HOME_R = 2.2;

export class AgrSkyRadar extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    svg {
      display: block;
      inline-size: 100%;
      block-size: auto;
      overflow: visible;
    }
    svg * {
      pointer-events: none;
    }
    .disc {
      fill: var(--agr-surface-inset);
    }
    .axis,
    .ring {
      fill: none;
      stroke: var(--agr-radar-ring);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .ring.overhead {
      stroke: var(--agr-brass-ink);
      stroke-width: 1.5;
      stroke-dasharray: 4 3;
    }
    .home {
      fill: var(--agr-surface);
      stroke: var(--agr-ink);
      stroke-width: 1.25;
      vector-effect: non-scaling-stroke;
    }
    .mark {
      fill: var(--agr-ink);
      stroke: none;
    }
    .mark.emphasis {
      fill: var(--agr-brass-ink);
    }
    .mark.hollow {
      fill: var(--agr-surface-inset);
      stroke: var(--agr-muted);
      stroke-width: 1.25;
      vector-effect: non-scaling-stroke;
    }
    .halo {
      fill: none;
      stroke: var(--agr-brass-ink);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .hit {
      fill: transparent;
      pointer-events: all;
      cursor: pointer;
    }
    /* SVG text is selected by element and role, never as text.<class>: that shape reads as an entity ID to the
       bundle's public-literal scan (text is a Home Assistant domain). Fills are ink or muted only (a fitness rule). */
    text {
      font-family: var(--agr-font-ui);
      font-variant-numeric: tabular-nums lining-nums;
    }
    text[data-role='cardinal'] {
      font-size: calc(9px * var(--agr-sky-radar-text-scale, 1));
      font-weight: 650;
      letter-spacing: 0.06em;
      fill: var(--agr-muted);
      text-anchor: middle;
      dominant-baseline: central;
    }
    /* Labels inside the disc get a halo of the disc's own tone and paint above the marks, so a ring, an axis or a
       mark never cuts through their letters (radar-labels.ts keeps them clear of the marks themselves). Their
       anchor and baseline are presentation attributes set by the placement. */
    text[data-role='ring'],
    text[data-role='mark'] {
      paint-order: stroke fill;
      stroke: var(--agr-surface-inset);
      stroke-width: calc(3px * var(--agr-sky-radar-text-scale, 1));
      stroke-linejoin: round;
    }
    text[data-role='ring'] {
      font-size: calc(${RING_LABEL_PX}px * var(--agr-sky-radar-text-scale, 1));
      font-weight: 550;
      fill: var(--agr-muted);
    }
    text[data-role='mark'] {
      font-size: calc(${MARK_LABEL_PX}px * var(--agr-sky-radar-text-scale, 1));
      font-weight: 650;
      letter-spacing: 0.02em;
      fill: var(--agr-ink);
    }
    text[data-role='mark'][data-muted] {
      fill: var(--agr-muted);
    }
  `;

  @property({ attribute: false }) vm?: RadarVM;

  protected override render(): TemplateResult | typeof nothing {
    const vm = this.vm;
    if (vm === undefined) return nothing;
    return html`<svg
      viewBox=${RADAR_VIEWBOX}
      role="img"
      aria-label=${vm.summary}
      data-live=${vm.live ? 'true' : 'false'}
      focusable="false"
    >
      <circle class="disc" cx="0" cy="0" r=${RADAR_OUTER_R}></circle>
      <line class="axis" x1="0" y1=${-RADAR_OUTER_R} x2="0" y2=${RADAR_OUTER_R}></line>
      <line class="axis" x1=${-RADAR_OUTER_R} y1="0" x2=${RADAR_OUTER_R} y2="0"></line>
      ${vm.rings.map(renderRing)}
      ${RADAR_CARDINALS.map(
        (cardinal) => svg`<text data-role="cardinal" x=${cardinal.x} y=${cardinal.y}>${cardinal.label}</text>`,
      )}
      <circle class="home" cx="0" cy="0" r=${HOME_R}></circle>
      ${repeat(
        vm.marks,
        (mark) => mark.key,
        (mark) => this.#renderMark(mark, vm.live),
      )}
      ${placeRadarLabels(vm).map(
        (label) => svg`<text
          data-role=${label.role}
          data-key=${label.key ?? nothing}
          ?data-muted=${label.role === 'mark' && !vm.live}
          x=${label.x}
          y=${label.y}
          text-anchor=${label.anchor}
          dominant-baseline=${label.baseline}
        >${label.text}</text>`,
      )}
    </svg>`;
  }

  #renderMark(mark: RadarMarkVM, live: boolean): SVGTemplateResult {
    const emphasis = mark.expanded || (live && mark.overhead);
    return svg`<g class="aircraft" data-key=${mark.key} data-emphasis=${emphasis ? 'true' : 'false'}>
      ${emphasis ? svg`<circle class="halo" cx=${mark.x} cy=${mark.y} r=${MARK_HALO_R}></circle>` : nothing}
      ${renderShape(mark, live, emphasis)}
      <circle class="hit" cx=${mark.x} cy=${mark.y} r=${RADAR_HIT_R}
        @click=${() => this.#onMark(mark.key)}></circle>
    </g>`;
  }

  readonly #onMark = contained('sky-radar-mark-failed', (key: string) => {
    const detail: SkyMarkDetail = { key };
    this.dispatchEvent(new CustomEvent('agr-sky-mark', { bubbles: false, composed: false, detail }));
  });
}

function renderRing(ring: RadarRingVM): SVGTemplateResult {
  return svg`<circle class=${ring.overhead ? 'ring overhead' : 'ring'} cx="0" cy="0" r=${ring.r}></circle>`;
}

/** Live: a chevron along the ground track, or a dot without one. Not live: a hollow grey circle, no direction. */
function renderShape(mark: RadarMarkVM, live: boolean, emphasis: boolean): SVGTemplateResult {
  if (!live) return svg`<circle class="mark hollow" cx=${mark.x} cy=${mark.y} r=${HOLLOW_R}></circle>`;
  const tone = emphasis ? 'mark emphasis' : 'mark';
  if (mark.rotation === undefined) return svg`<circle class=${tone} cx=${mark.x} cy=${mark.y} r=${DOT_R}></circle>`;
  return svg`<path class=${tone} d=${CHEVRON_PATH}
    transform="translate(${mark.x} ${mark.y}) rotate(${mark.rotation})"></path>`;
}

defineOnce('agr-sky-radar', AgrSkyRadar);

declare global {
  interface HTMLElementTagNameMap {
    'agr-sky-radar': AgrSkyRadar;
  }
  interface HTMLElementEventMap {
    'agr-sky-mark': CustomEvent<SkyMarkDetail>;
  }
}
