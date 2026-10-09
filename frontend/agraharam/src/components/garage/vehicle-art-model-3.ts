/**
 * Side-profile drawing of a 2017–2023 Tesla Model 3 in black, for the Garage & car panel (§18). Original artwork drawn
 * for this dashboard from the car's published proportions; it reproduces no photograph, logo or word mark.
 *
 * The geometry is one scale (about 0.04 units per millimetre) of the real car: 4 694 mm long, 2 875 mm wheelbase,
 * 841 mm front and 978 mm rear overhang, 1 443 mm tall, 668 mm tyres. The front faces right, as in the generic art.
 * What makes it read as the car, and what to protect when editing: the single fastback arc from the windscreen to a
 * short ducktail, the low rounded nose with no grille, short overhangs on a long wheelbase, the side glass ending in
 * a point toward the trunk, flush handles, a thin swept headlight and flat aero wheel covers.
 *
 * A static Lit template: literal path data and constant attribute values, no images or URLs. Colours come from the
 * --agr-vehicle-* tokens (tokens.ts), so the paint stays near-black in both themes and the dark theme adds a rim light
 * to keep the silhouette. Each part carries its paint as a constant inline style, so the art needs nothing from the
 * host element. It is not an <svg>-internal <style>: happy-dom parses one as raw text, drops the rest of the drawing
 * and breaks every unit test that renders it. The m3-* classes are kept as names for tests and readers.
 */
import { html, svg, type SVGTemplateResult, type TemplateResult } from 'lit';

/** Ground line y; wheel centres sit one tyre radius above it. */
const GROUND_Y = 62;
const WHEEL_CY = 48.6;
const TYRE_R = 13.4;
const RIM_R = 9.6;
const COVER_R = 8.1;
const HUB_R = 2.1;
/** Rear and front axle x: 978 mm and 978 + 2 875 mm from the rear bumper. */
const WHEEL_CX = [45.2, 160.3] as const;

/**
 * The body silhouette, greenhouse included: from the nose's frontmost point down and back along the sill (both wheel
 * arches cut in), up the near-vertical tail to the ducktail lip, along the one fastback arc over the roof, down the
 * long, raked windscreen to a cowl at the rear edge of the front wheel arch (the short, cab-forward hood is
 * about 26 % of the length), and over the front wheel to the rounded nose. The roof domes to its peak near the
 * B-pillar.
 */
const BODY =
  'M194.3 45.6C193.9 49.4 192.9 52.6 190.8 54.6L186.4 55.5L173 55.4A14.4 14.4 0 1 0 147.6 55.4L57.9 55.4' +
  'A14.4 14.4 0 1 0 32.5 55.4C25 54.2 16 50.6 11.2 48.2C8.4 46.8 6.4 42.8 6.1 38.4C5.9 35.2 6 31.4 6.4 28.4' +
  'C6.7 25.8 7.3 23.4 8.4 21.6C9.2 20.2 10.3 19.1 11.8 18.6C13.2 18.5 14.4 18.8 15.8 18.9C18.2 18.8 20.4 18.5 22.6 18.1' +
  'C40 9.4 76 4.2 90 4.2C95.5 4.2 101 5.6 106 7.4C116.5 11.2 134 18.2 144.5 22.9' +
  'C150 23.9 155.5 25 160 25.8C168 27.1 176 28.8 182.5 31.4C187.6 33.4 191.6 36.4 193.4 39.6' +
  'C194.4 41.4 194.6 43.6 194.3 45.6Z';
/** Arch interiors, drawn under the body so the cut-outs read as wheel wells rather than the panel behind. */
const WELLS = 'M32.5 55.4A14.4 14.4 0 1 1 57.9 55.4ZM147.6 55.4A14.4 14.4 0 1 1 173 55.4Z';
/** One continuous side glass (DLO): low at the A-pillar, rising to a point at the thick C-pillar. */
const GLASS =
  'M139 22.7C130 18.8 117 13.4 108.6 10.3C104 8.4 97 6.6 90 6.5C82 6.4 75 7.1 68 8.3C60 9.6 52 11.4 46 13' +
  'C42 14.3 39 15.8 36.8 17.4C56 19.2 95 20.6 139 22.7Z';
const GLASS_REFLECTION = 'M74.5 7.6L83 6.8L72 19.6L63.5 19.2Z';
/** Gloss-black B-pillar and the rear quarter-glass divider, in paint over the glass. */
const PILLARS = 'M93 6.4L92.4 20.4M52.2 11.6L54 19';
/** A door-mounted mirror at the foot of the A-pillar. */
const MIRROR =
  'M138.2 22.3C137.4 20.1 135 19.3 132.8 19.7C131.6 20 131.4 21.3 132.2 22.1C133.4 23 136 23.1 138.2 22.3Z';
/** Front door leading edge behind the short front fender, the B-pillar shut line, and the rear door's trailing edge
 *  curving round the rear arch. */
const SEAMS =
  'M139.6 23.2C140.6 31.5 141.2 42 140.6 55.2M92.6 20.6L91.9 55.2' +
  'M53.4 19.3C55.6 27 60.2 34 61.6 40.6C62.4 45.6 61.6 51.4 59.6 55.2';
/** Flush door handles: two short lines just under the beltline, near each door's trailing edge. */
const HANDLES = 'M97.5 24.2H103.6M59.6 23.2H65';
/** The shoulder highlight that makes black paint read as glossy, and a softer one low on the doors. */
const SHOULDER_SHEEN = 'M13 23.8C45 22.6 100 23.4 150 26C164 26.7 178 29.4 189 35.4';
const DOOR_SHEEN = 'M66 42.6C92 41.8 118 42 136 42.8';
/** A broad, faint reflection low on the doors and a darker sill, so the black body side never reads as a flat slab. */
const DOOR_REFLECTION = 'M57 47.6C82 45 118 45.1 143 47C118 48.3 82 48.6 57 47.6Z';
const SILL = 'M57.9 53.2H147.6V55.4H57.9Z';
/** A thin headlight swept back along the top of the front corner. */
const HEADLIGHT = 'M193 40.6C190.2 37.6 185.2 34.2 179.4 31.6C184.6 34.6 189.6 38.4 191.8 41.8Z';
/** Smoked, not red: the dashboard reserves red for warnings. */
const TAIL_LIGHT = 'M6.7 26C9.8 24.8 14.4 23.9 18.6 23.5C14.6 24.9 10.4 26.4 6.8 27.8Z';

/** The five slots of a flat aero cover, as short arcs around the hub. */
const AERO_SLOT_COUNT = 5;
const AERO_SLOT_R = 6.6;
const AERO_SLOT_SPAN_DEG = 34;

function aeroSlots(cx: number): string {
  const parts: string[] = [];
  for (let slot = 0; slot < AERO_SLOT_COUNT; slot += 1) {
    const middle = -90 + (360 / AERO_SLOT_COUNT) * slot;
    const [start, end] = [middle - AERO_SLOT_SPAN_DEG / 2, middle + AERO_SLOT_SPAN_DEG / 2].map((deg) =>
      polar(cx, WHEEL_CY, AERO_SLOT_R, deg),
    );
    parts.push(`M${start}A${AERO_SLOT_R} ${AERO_SLOT_R} 0 0 1 ${end}`);
  }
  return parts.join('');
}

function polar(cx: number, cy: number, r: number, deg: number): string {
  const rad = (deg * Math.PI) / 180;
  return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
}

/** Computed once at module load: fixed numbers, never input. */
const WHEELS = WHEEL_CX.map((cx) => ({ cx, slots: aeroSlots(cx) }));

/** Each part's paint: a token for the theme, and a literal fallback (the light theme's value) if it is missing. */
const PAINT = Object.freeze({
  shadow: 'fill: var(--agr-vehicle-shadow, rgb(44 48 41 / 0.2))',
  well: 'fill: var(--agr-vehicle-tyre, #121310)',
  body:
    'fill: var(--agr-vehicle-paint, #1b1d19); stroke: var(--agr-vehicle-edge, #1b1d19); stroke-width: 0.8; ' +
    'stroke-linejoin: round',
  sill: 'fill: var(--agr-vehicle-tyre, #121310); opacity: 0.7',
  reflectionSoft: 'fill: var(--agr-vehicle-seam, rgb(255 255 255 / 0.1))',
  glass: 'fill: var(--agr-vehicle-glass, #3d4442)',
  reflection: 'fill: var(--agr-vehicle-sheen, rgb(255 255 255 / 0.22))',
  pillar: 'fill: none; stroke: var(--agr-vehicle-paint, #1b1d19); stroke-width: 2',
  trim: 'fill: none; stroke: var(--agr-vehicle-sheen, rgb(255 255 255 / 0.22)); stroke-width: 0.5',
  mirror: 'fill: var(--agr-vehicle-paint, #1b1d19)',
  seam: 'fill: none; stroke: var(--agr-vehicle-seam, rgb(255 255 255 / 0.1)); stroke-width: 0.6',
  sheen:
    'fill: none; stroke: var(--agr-vehicle-sheen, rgb(255 255 255 / 0.22)); stroke-width: 1.1; stroke-linecap: round',
  sheenSoft:
    'fill: none; stroke: var(--agr-vehicle-seam, rgb(255 255 255 / 0.1)); stroke-width: 1; stroke-linecap: round',
  lamp: 'fill: var(--agr-vehicle-lamp, #e9e6da)',
  tail: 'fill: var(--agr-vehicle-tail, #4a3f3d)',
  tyre: 'fill: var(--agr-vehicle-tyre, #121310)',
  rim: 'fill: var(--agr-vehicle-rim, #8e9389)',
  cover: 'fill: var(--agr-vehicle-paint, #1b1d19); opacity: 0.35',
  slots: 'fill: none; stroke: var(--agr-vehicle-tyre, #121310); stroke-width: 1.4; stroke-linecap: round',
  hub: 'fill: var(--agr-vehicle-tyre, #121310)',
});

function renderWheel(wheel: { readonly cx: number; readonly slots: string }): SVGTemplateResult {
  return svg`<circle class="m3-tyre" style=${PAINT.tyre} cx=${wheel.cx} cy=${WHEEL_CY} r=${TYRE_R}></circle>
    <circle class="m3-rim" style=${PAINT.rim} cx=${wheel.cx} cy=${WHEEL_CY} r=${RIM_R}></circle>
    <circle class="m3-cover" style=${PAINT.cover} cx=${wheel.cx} cy=${WHEEL_CY} r=${COVER_R}></circle>
    <path class="m3-slots" style=${PAINT.slots} d=${wheel.slots}></path>
    <circle class="m3-hub" style=${PAINT.hub} cx=${wheel.cx} cy=${WHEEL_CY} r=${HUB_R}></circle>`;
}

export function renderModel3Art(): TemplateResult {
  return html`<svg
    class="vehicle-art"
    data-model="tesla-model-3"
    viewBox="0 0 200 66"
    aria-hidden="true"
    focusable="false"
  >
    <ellipse class="m3-shadow" style=${PAINT.shadow} cx="100" cy=${GROUND_Y + 0.6} rx="88" ry="2"></ellipse>
    <path class="m3-well" style=${PAINT.well} d=${WELLS}></path>
    <path class="m3-paint" style=${PAINT.body} d=${BODY}></path>
    <path class="m3-sill" style=${PAINT.sill} d=${SILL}></path>
    <path class="m3-reflection-soft" style=${PAINT.reflectionSoft} d=${DOOR_REFLECTION}></path>
    <path class="m3-glass" style=${PAINT.glass} d=${GLASS}></path>
    <path class="m3-reflection" style=${PAINT.reflection} d=${GLASS_REFLECTION}></path>
    <path class="m3-pillar" style=${PAINT.pillar} d=${PILLARS}></path>
    <path class="m3-trim" style=${PAINT.trim} d=${GLASS}></path>
    <path class="m3-mirror" style=${PAINT.mirror} d=${MIRROR}></path>
    <path class="m3-seam" style=${PAINT.seam} d=${SEAMS}></path>
    <path class="m3-sheen" style=${PAINT.sheen} d=${SHOULDER_SHEEN}></path>
    <path class="m3-sheen-soft" style=${PAINT.sheenSoft} d=${DOOR_SHEEN}></path>
    <path class="m3-sheen" style=${PAINT.sheen} d=${HANDLES}></path>
    <path class="m3-lamp" style=${PAINT.lamp} d=${HEADLIGHT}></path>
    <path class="m3-tail" style=${PAINT.tail} d=${TAIL_LIGHT}></path>
    ${WHEELS.map(renderWheel)}
  </svg>`;
}
