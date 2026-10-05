/**
 * Generic side-view sedan line art for the Garage & car panel (DESIGN: "minimal silhouette/line art rather than
 * scraping branded car images"). Drawn for this dashboard; it depicts no make or model. A static Lit SVG template
 * stroked with currentColor, so it themes with the panel and can never inject markup.
 */
import { html, svg, type TemplateResult } from 'lit';

/** Body outline, facing right: rear bumper, short deck, fastback glass, roof arc, windscreen, hood and nose, with
 *  both wheel arches cut into the sill. */
const BODY =
  'M15 46H26.5A12 12 0 0 1 49.5 46H110.5A12 12 0 0 1 133.5 46H146C149 46 151 44 151 41V38.5' +
  'C151 35.5 149 34 145 33.2L119 28.6C111.5 22 104 17.6 95 16.6C86 15.6 70 15.6 62 16.8' +
  'C52 18.4 42.5 23.6 34.5 28C26.5 29.2 18.5 30.2 14 31.5C11.2 32.4 10 34.4 10 37V42C10 44.6 12 46 15 46Z';
const REAR_WINDOW = 'M41.5 27.6C48 23.4 54.5 20.4 62 19.8L77 19.4V27.6Z';
const FRONT_WINDOW = 'M80.5 19.4L94 19.8C101 20.6 107 23.6 112.5 27.6H80.5Z';
const DOOR_SEAM = 'M78.7 29V45';
const SHOULDER_LINE = 'M15 34.2C48 32.4 108 31.8 146 34.8';
const DOOR_HANDLES = 'M60 34.4H65M93 34.4H98';
const MIRROR = 'M113.5 28.2L117.5 26.8';
const HEADLIGHT = 'M140.5 35.4L147.5 36.6';
const TAIL_LIGHT = 'M11 35.8H15.5';
const GROUND = 'M4 56.5H156';

const WHEELS = [38, 122] as const;
const TYRE_RADIUS = 9.5;
const HUB_RADIUS = 3.6;

/** Width and height of the drawing in its own units; the panel scales it with CSS. */
const VEHICLE_ART_VIEWBOX = Object.freeze({ width: 160, height: 60 });

/** The outer <svg> is an html template (Lit renders svg`` only inside an <svg>); the parts are svg templates. */
export function renderVehicleArt(): TemplateResult {
  return html`<svg
    class="vehicle-art"
    viewBox="0 0 ${VEHICLE_ART_VIEWBOX.width} ${VEHICLE_ART_VIEWBOX.height}"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path class="ground" d=${GROUND}></path>
    <path class="glass" d=${REAR_WINDOW}></path>
    <path class="glass" d=${FRONT_WINDOW}></path>
    <path d=${BODY}></path>
    <path class="detail" d=${SHOULDER_LINE}></path>
    <path class="detail" d=${DOOR_SEAM}></path>
    <path class="detail" d=${DOOR_HANDLES}></path>
    <path class="detail" d=${MIRROR}></path>
    <path d=${HEADLIGHT}></path>
    <path d=${TAIL_LIGHT}></path>
    ${WHEELS.map(
      (cx) => svg`<circle class="tyre" cx=${cx} cy="46" r=${TYRE_RADIUS}></circle>
        <circle class="detail" cx=${cx} cy="46" r=${HUB_RADIUS}></circle>`,
    )}
  </svg>`;
}
