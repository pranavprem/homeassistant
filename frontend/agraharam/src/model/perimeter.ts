/**
 * Perimeter entity → open, closed or unknown (§4.8), shared by House health and the security drawer
 * so the two can never disagree about an entry point.
 */
import { domainOf } from '../config/entity-id.ts';
import { ABSENT_LABELS, type NormalizedEntity } from '../ha/normalize.ts';

export type PerimeterPosition = 'closed' | 'open' | 'unknown';

const COVER_OPEN_STATES: ReadonlySet<string> = new Set(['open', 'opening', 'closing']);
const POSITION_LABELS: Readonly<Record<Exclude<PerimeterPosition, 'unknown'>, string>> = Object.freeze({
  closed: 'Closed',
  open: 'Open',
});

/** binary_sensor on = open and off = closed; cover closed = closed and open, opening or closing = open. Anything
 *  else, including a stale value while disconnected, is unknown and labelled by its normalized status. */
export function perimeterPosition(entry: NormalizedEntity): {
  readonly position: PerimeterPosition;
  readonly label: string;
} {
  if (entry.status === 'available') {
    const position = livePosition(domainOf(entry.id), entry.entity?.state ?? '');
    if (position !== 'unknown') return { position, label: POSITION_LABELS[position] };
    return { position, label: ABSENT_LABELS.unknown };
  }
  const reason = entry.status === 'privacy' ? 'unknown' : entry.status;
  return { position: 'unknown', label: ABSENT_LABELS[reason] };
}

function livePosition(domain: string, state: string): PerimeterPosition {
  if (domain === 'binary_sensor') {
    if (state === 'on') return 'open';
    if (state === 'off') return 'closed';
    return 'unknown';
  }
  if (domain === 'cover') {
    if (state === 'closed') return 'closed';
    if (COVER_OPEN_STATES.has(state)) return 'open';
  }
  return 'unknown';
}
