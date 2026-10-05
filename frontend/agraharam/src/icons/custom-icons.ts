/**
 * Custom line icons in Lucide's IconNode format (24 × 24 grid, stroked with currentColor), drawn for this
 * dashboard and not taken from any brand artwork (§6.5).
 */
import type { IconNode } from 'lucide';

type IconChild = IconNode[number];

/** Kolam lattice spacing: dots sit on a 3 × 3 grid at 6, 12 and 18. */
const KOLAM_DOT_POSITIONS = [6, 12, 18] as const;

function kolamDot(cx: number, cy: number): IconChild {
  return ['circle', { cx, cy, r: 1, fill: 'currentColor', stroke: 'none' }];
}

// One continuous looped stroke: rounded points enclose the four corner dots, inward notches pass between each edge
// dot and the centre, so the line weaves around the whole 3 × 3 lattice the way a pulli kolam does.
const KOLAM_LOOP =
  'M12 9C14 9 15 3 18 3A3 3 0 0 1 21 6C21 9 15 10 15 12C15 14 21 15 21 18A3 3 0 0 1 18 21' +
  'C15 21 14 15 12 15C10 15 9 21 6 21A3 3 0 0 1 3 18C3 15 9 14 9 12C9 10 3 9 3 6A3 3 0 0 1 6 3C9 3 10 9 12 9Z';

const KOLAM: IconNode = [
  ['path', { d: KOLAM_LOOP }],
  ...KOLAM_DOT_POSITIONS.flatMap((cy) => KOLAM_DOT_POSITIONS.map((cx) => kolamDot(cx, cy))),
];

/** Top view: round body, front bumper arc, centre sensor turret. */
const ROBOT_VACUUM: IconNode = [
  ['circle', { cx: 12, cy: 12, r: 9 }],
  ['path', { d: 'M6.37 8.75A6.5 6.5 0 0 1 17.63 8.75' }],
  ['circle', { cx: 12, cy: 13, r: 2 }],
];

/** Gabled garage front with a three-panel sectional door. */
const GARAGE_DOOR: IconNode = [
  ['path', { d: 'M3 21V9l9-6 9 6v12' }],
  ['path', { d: 'M7 21v-9h10v9' }],
  ['path', { d: 'M7 15h10' }],
  ['path', { d: 'M7 18h10' }],
];

/** Generic side-view sedan, facing right. */
const SEDAN: IconNode = [
  [
    'path',
    {
      d:
        'M5 16H2.5a.5.5 0 0 1-.5-.5v-2.3a1.5 1.5 0 0 1 1.1-1.45L6.5 11 9 7.8A2 2 0 0 1 10.6 7H15' +
        'a2 2 0 0 1 1.5.68L19.5 11l1.4.5a1.6 1.6 0 0 1 1.1 1.5v2.5a.5.5 0 0 1-.5.5H19',
    },
  ],
  ['path', { d: 'M9 16h6' }],
  ['path', { d: 'M6.5 11h13' }],
  ['path', { d: 'M13 7v4' }],
  ['circle', { cx: 7, cy: 16, r: 2 }],
  ['circle', { cx: 17, cy: 16, r: 2 }],
];

export const CUSTOM_ICONS = Object.freeze({
  kolam: KOLAM,
  'robot-vacuum': ROBOT_VACUUM,
  'garage-door': GARAGE_DOOR,
  sedan: SEDAN,
}) satisfies Readonly<Record<string, IconNode>>;
