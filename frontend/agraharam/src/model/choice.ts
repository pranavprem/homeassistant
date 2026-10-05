/**
 * The choice-group builder every choice control uses (HVAC modes, fan presets, media sources; §7.2), and the option
 * text helpers that go with it. Pure: options are evaluated through the gateway, never requested.
 */
import {
  isTicketInFlight,
  type ActionGateway,
  type ActionRequest,
  type ActionStatus,
  type Availability,
} from '../ha/actions/types.ts';
import { busyAvailability } from './controls.ts';
import type { ChoiceVM } from './types.ts';

/** Option text for a raw integration value: "fan_only" → "Fan only", "sleep" → "Sleep"; mixed case is kept. */
export function humanizeOption(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  if (spaced === '' || spaced !== spaced.toLowerCase()) return spaced || value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Distinct non-empty strings from an attribute, in the integration's order; anything else yields []. */
export function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) if (typeof item === 'string' && item !== '') seen.add(item);
  return [...seen];
}

/** The disabled current option's copy varies by kind (§16.10); `player` is the media drawer's player picker. */
type ChoiceKind = 'mode' | 'preset' | 'source' | 'player';

function currentOption(message: string): Availability {
  return Object.freeze({ enabled: false, reason: 'not-applicable', message });
}

const CURRENT_OPTIONS: Readonly<Record<ChoiceKind, Availability>> = Object.freeze({
  mode: currentOption('Current mode'),
  preset: currentOption('Current preset'),
  source: currentOption('Current source'),
  player: currentOption('Current player'),
});

/**
 * The pressed option's Availability: always disabled as "Current …", so pressing it again can never send anything and
 * it says nothing a shared notice must repeat (control-notes.ts choiceControls).
 */
export function currentOptionAvailability(kind: ChoiceKind): Availability {
  return CURRENT_OPTIONS[kind];
}

interface ChoiceSpec {
  readonly label: string;
  readonly kind: ChoiceKind;
  readonly values: readonly string[];
  /** The OBSERVED current value; `pressed` never moves optimistically. */
  readonly current: string | undefined;
  readonly labelOf: (value: string) => string;
  readonly request: (value: string) => ActionRequest;
  readonly deviceName: string;
  /** The ticket on the device's action key, if any. */
  readonly pending: ActionStatus | undefined;
}

/**
 * One choice group (§7.2): the current option is disabled ("Current mode"), so activating it sends nothing; while
 * a ticket on the key is in flight every other option is disabled (busy); otherwise the gateway decides.
 */
export function selectChoice(gateway: ActionGateway, spec: ChoiceSpec): ChoiceVM {
  const busy = isTicketInFlight(spec.pending) ? busyAvailability(spec.deviceName) : undefined;
  const current = currentOptionAvailability(spec.kind);
  const options = spec.values.map((value) => {
    const pressed = value === spec.current;
    const availability = pressed ? current : (busy ?? gateway.evaluate(spec.request(value)));
    return { value, label: spec.labelOf(value), pressed, availability };
  });
  const firstValue = spec.values[0];
  const choiceKind = firstValue === undefined ? undefined : spec.request(firstValue).kind;
  const pending = spec.pending !== undefined && spec.pending.kind === choiceKind ? spec.pending : undefined;
  return {
    label: spec.label,
    ...(spec.current !== undefined && { current: spec.current }),
    options,
    ...(pending !== undefined && { pending }),
  };
}

/**
 * The visible reason for a choice group whose other options are all disabled for one shared reason. The group shows
 * per-option reasons to assistive technology only, and a disabled control's reason must also be visible (§7.2).
 */
export function choiceReason(choice: ChoiceVM): string | undefined {
  const others = choice.options.filter((option) => !option.pressed);
  const first = others[0]?.availability;
  if (first === undefined || first.enabled) return undefined;
  const shared = others.every(
    (option) => !option.availability.enabled && option.availability.message === first.message,
  );
  return shared ? first.message : undefined;
}
