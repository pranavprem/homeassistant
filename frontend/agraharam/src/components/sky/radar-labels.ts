/**
 * Where the sky radar's labels sit (AIRSPACE.md §6): pure placement from the radar view model's validated numbers.
 * Labels paint above the marks on a halo of the disc's tone, so each one is placed clear of every mark, the home
 * point, the cardinal letters, the labels already placed and the viewBox edge. Nothing is ever hidden under a label:
 *
 * - A mark label (the expanded and overhead aircraft) sits beside its mark on the side away from home, else on the
 *   other side, else above, else below. With no clear spot it keeps the side away from home, because it names the
 *   aircraft the user chose or the one overhead.
 * - A ring label sits inside its ring beside the north axis (east, then west), else beside the south axis. With no
 *   clear spot it is left out: rings are decorative and marks are not, and the drawer's caption still gives the radius.
 *
 * Mark labels are placed first, so ring labels also keep clear of them. Text boxes are estimated at
 * RADAR_TEXT_SCALE_MAX with a generous glyph width, so a placement holds at every text scale a host may set.
 */
import { RADAR_CARDINALS, type RadarMarkVM, type RadarRingVM, type RadarVM } from '../../model/radar.ts';

type LabelAnchor = 'start' | 'middle' | 'end';
type LabelBaseline = 'hanging' | 'central' | 'auto';

interface RadarLabel {
  readonly role: 'ring' | 'mark';
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor: LabelAnchor;
  readonly baseline: LabelBaseline;
  /** A mark label's aircraft. */
  readonly key?: string;
}

/** A text box in viewBox units. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Candidate {
  readonly label: RadarLabel;
  readonly box: Box;
}

/** The largest --agr-sky-radar-text-scale a host may set; label boxes are sized for it. */
export const RADAR_TEXT_SCALE_MAX = 1.5;
/** Label font sizes in viewBox units at text scale 1 (agr-sky-radar's styles scale them). */
export const RING_LABEL_PX = 8;
export const MARK_LABEL_PX = 9.5;
/** The halo around an overhead or selected mark; no label comes closer than this to any mark's centre. */
export const MARK_HALO_R = 7.5;

/** A mark label sits this far from its mark's centre. */
const MARK_LABEL_OFFSET = 9;
/** A ring label sits this far beside the north-south axis and this far inside its ring. */
const RING_LABEL_X = 3;
const RING_LABEL_INSET = 9;
/** A generous average glyph width (tabular digits and capitals in the UI face, with letter spacing). */
const GLYPH_WIDTH_EM = 0.62;
const HOME: Point = Object.freeze({ x: 0, y: 0 });
const HOME_CLEARANCE = 4;
/** Half a cardinal letter at the largest text scale. */
const CARDINAL_CLEARANCE = 7;
/** RADAR_VIEWBOX is -100 -100 200 200: a label must stay inside it. */
const VIEWBOX_EXTENT = 100;

/**
 * Every label to draw, ring labels first and mark labels after them, so a mark label paints on top. A ring with no
 * clear spot has no label.
 */
export function placeRadarLabels(vm: RadarVM): readonly RadarLabel[] {
  const placed: Candidate[] = [];
  const clear = (box: Box): boolean =>
    insideViewBox(box) &&
    !vm.marks.some((mark) => near(box, mark, MARK_HALO_R)) &&
    !near(box, HOME, HOME_CLEARANCE) &&
    !RADAR_CARDINALS.some((cardinal) => near(box, cardinal, CARDINAL_CLEARANCE)) &&
    !placed.some((other) => overlaps(box, other.box));

  const markLabels: RadarLabel[] = [];
  for (const mark of vm.marks) {
    if (mark.label === undefined) continue;
    const candidates = markLabelCandidates(mark, mark.label);
    const chosen = candidates.find((candidate) => clear(candidate.box)) ?? candidates[0];
    if (chosen === undefined) continue;
    placed.push(chosen);
    markLabels.push(chosen.label);
  }
  const ringLabels: RadarLabel[] = [];
  for (const ring of vm.rings) {
    if (ring.overhead || ring.label === '') continue;
    const chosen = ringLabelCandidates(ring).find((candidate) => clear(candidate.box));
    if (chosen === undefined) continue;
    placed.push(chosen);
    ringLabels.push(chosen.label);
  }
  return Object.freeze([...ringLabels, ...markLabels]);
}

/** Beside the mark away from home, beside it towards home, above it, below it. */
function markLabelCandidates(mark: RadarMarkVM, text: string): readonly Candidate[] {
  const away = mark.x >= 0 ? 1 : -1;
  const beside = (direction: number): Candidate =>
    candidate(
      { role: 'mark', text, key: mark.key, x: mark.x + direction * MARK_LABEL_OFFSET, y: mark.y },
      direction > 0 ? 'start' : 'end',
      'central',
    );
  return [
    beside(away),
    beside(-away),
    candidate({ role: 'mark', text, key: mark.key, x: mark.x, y: mark.y - MARK_LABEL_OFFSET }, 'middle', 'auto'),
    candidate({ role: 'mark', text, key: mark.key, x: mark.x, y: mark.y + MARK_LABEL_OFFSET }, 'middle', 'hanging'),
  ];
}

/** Inside the ring beside the north axis, east then west, then beside the south axis, east then west. */
function ringLabelCandidates(ring: RadarRingVM): readonly Candidate[] {
  return [true, false].flatMap((north) =>
    [1, -1].map((side) =>
      candidate(
        {
          role: 'ring',
          text: ring.label,
          x: side * RING_LABEL_X,
          y: north ? -ring.r + RING_LABEL_INSET : ring.r - RING_LABEL_INSET,
        },
        side > 0 ? 'start' : 'end',
        north ? 'hanging' : 'auto',
      ),
    ),
  );
}

/** A label with its estimated box: anchored at x by `anchor`, and at y by `baseline` (top, middle or bottom). */
function candidate(
  at: Omit<RadarLabel, 'anchor' | 'baseline'>,
  anchor: LabelAnchor,
  baseline: LabelBaseline,
): Candidate {
  const fontPx = (at.role === 'ring' ? RING_LABEL_PX : MARK_LABEL_PX) * RADAR_TEXT_SCALE_MAX;
  const width = at.text.length * GLYPH_WIDTH_EM * fontPx;
  const left = anchor === 'start' ? at.x : anchor === 'end' ? at.x - width : at.x - width / 2;
  const top = baseline === 'hanging' ? at.y : baseline === 'central' ? at.y - fontPx / 2 : at.y - fontPx;
  return {
    label: Object.freeze({ ...at, anchor, baseline }),
    box: { left, top, right: left + width, bottom: top + fontPx },
  };
}

function insideViewBox(box: Box): boolean {
  return (
    box.left >= -VIEWBOX_EXTENT &&
    box.right <= VIEWBOX_EXTENT &&
    box.top >= -VIEWBOX_EXTENT &&
    box.bottom <= VIEWBOX_EXTENT
  );
}

/** Whether a point is within `clearance` of the box. */
function near(box: Box, point: Point, clearance: number): boolean {
  const dx = point.x - Math.min(Math.max(point.x, box.left), box.right);
  const dy = point.y - Math.min(Math.max(point.y, box.top), box.bottom);
  return dx * dx + dy * dy < clearance * clearance;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
