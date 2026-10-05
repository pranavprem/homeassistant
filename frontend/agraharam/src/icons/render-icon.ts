/**
 * IconNode → Lit SVG template. Each supported element has a static template with bound attributes, so icon data
 * can never inject markup: no unsafe directives and no parsing of markup strings.
 */
import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import type { IconNode } from 'lucide';
import type { IconName } from '../model/types.ts';
import { CUSTOM_ICONS } from './custom-icons.ts';
import { ICONS } from './icons.ts';

/** Default glyph size in CSS px (§6.5: 18 dense, 24 hero). */
const DEFAULT_ICON_SIZE = 20;
const STROKE_WIDTH = 1.75;

type IconChild = IconNode[number];
type IconAttributeValue = IconChild[1][string];

const ICON_NODES: Readonly<Record<IconName, IconNode>> = Object.freeze({ ...ICONS, ...CUSTOM_ICONS });

function attr(value: IconAttributeValue): string | undefined {
  return value === undefined ? undefined : String(value);
}

function renderChild([tag, a]: IconChild): SVGTemplateResult | typeof nothing {
  const fill = ifDefined(attr(a['fill']));
  const stroke = ifDefined(attr(a['stroke']));
  switch (tag) {
    case 'path':
      return svg`<path d=${ifDefined(attr(a['d']))} fill=${fill} stroke=${stroke}></path>`;
    case 'circle':
      return svg`<circle cx=${ifDefined(attr(a['cx']))} cy=${ifDefined(attr(a['cy']))} r=${ifDefined(attr(a['r']))}
        fill=${fill} stroke=${stroke}></circle>`;
    case 'ellipse':
      return svg`<ellipse cx=${ifDefined(attr(a['cx']))} cy=${ifDefined(attr(a['cy']))}
        rx=${ifDefined(attr(a['rx']))} ry=${ifDefined(attr(a['ry']))} fill=${fill} stroke=${stroke}></ellipse>`;
    case 'rect':
      return svg`<rect x=${ifDefined(attr(a['x']))} y=${ifDefined(attr(a['y']))}
        width=${ifDefined(attr(a['width']))} height=${ifDefined(attr(a['height']))}
        rx=${ifDefined(attr(a['rx']))} ry=${ifDefined(attr(a['ry']))} fill=${fill} stroke=${stroke}></rect>`;
    case 'line':
      return svg`<line x1=${ifDefined(attr(a['x1']))} y1=${ifDefined(attr(a['y1']))}
        x2=${ifDefined(attr(a['x2']))} y2=${ifDefined(attr(a['y2']))} stroke=${stroke}></line>`;
    case 'polyline':
      return svg`<polyline points=${ifDefined(attr(a['points']))} fill=${fill} stroke=${stroke}></polyline>`;
    case 'polygon':
      return svg`<polygon points=${ifDefined(attr(a['points']))} fill=${fill} stroke=${stroke}></polygon>`;
    default:
      // The curated set uses only the tags above (asserted by tests/icons/icons.test.ts).
      return nothing;
  }
}

/** A decorative line icon: aria-hidden, sized in CSS px, stroked with currentColor. */
export function renderIcon(name: IconName, size: number = DEFAULT_ICON_SIZE): TemplateResult {
  return html`<svg
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${STROKE_WIDTH}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    ${ICON_NODES[name].map(renderChild)}
  </svg>`;
}
