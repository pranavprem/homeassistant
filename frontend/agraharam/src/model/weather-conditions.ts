/**
 * Weather condition presentation (§6.5 Today icons): HA's standard `weather` condition states mapped to a curated
 * line icon and an English label. Pure data used by the Today selector for the hero and the forecast cells; it lives
 * in the model layer because selectors must not import components.
 *
 * The hero label prefers HA's own translated state (formatEntityState); these labels are the fallback when the
 * frontend does not provide it, and the accessible label of forecast cells, which are not entities.
 */
import type { IconName } from './types.ts';

interface ConditionPresentation {
  readonly icon: IconName;
  /** Used between sunset and sunrise when the condition has a distinct night glyph. */
  readonly nightIcon?: IconName;
  readonly label: string;
}

/** HA core's condition states, labelled as HA's English translations label them. */
const CONDITIONS: Readonly<Record<string, ConditionPresentation>> = Object.freeze({
  'clear-night': { icon: 'moon', label: 'Clear, night' },
  cloudy: { icon: 'cloudy', label: 'Cloudy' },
  exceptional: { icon: 'triangle-alert', label: 'Exceptional' },
  fog: { icon: 'cloud-fog', label: 'Fog' },
  hail: { icon: 'cloud-hail', label: 'Hail' },
  lightning: { icon: 'cloud-lightning', label: 'Lightning' },
  'lightning-rainy': { icon: 'cloud-lightning', label: 'Lightning, rainy' },
  partlycloudy: { icon: 'cloud-sun', nightIcon: 'cloud-moon', label: 'Partly cloudy' },
  pouring: { icon: 'cloud-rain-wind', label: 'Pouring' },
  rainy: { icon: 'cloud-rain', label: 'Rainy' },
  snowy: { icon: 'cloud-snow', label: 'Snowy' },
  'snowy-rainy': { icon: 'cloud-snow', label: 'Snowy, rainy' },
  sunny: { icon: 'sun', label: 'Sunny' },
  windy: { icon: 'wind', label: 'Windy' },
  'windy-variant': { icon: 'wind', label: 'Windy, cloudy' },
});

/** A condition HA added after this table was written still renders: a plain cloud and its humanized name. */
const UNKNOWN_CONDITION_ICON: IconName = 'cloud';
/** No condition at all (unknown state, missing forecast field). */
export const NO_CONDITION: ConditionPresentation = Object.freeze({
  icon: 'circle-question-mark',
  label: 'Condition unknown',
});

export function conditionPresentation(condition: string | undefined): ConditionPresentation {
  if (condition === undefined || condition === '' || condition === 'unknown') return NO_CONDITION;
  // Own properties only: the condition is untrusted text, and "constructor" or "__proto__" must not resolve to an
  // Object.prototype member (which would leave the cell without an icon and throw during render).
  return Object.hasOwn(CONDITIONS, condition)
    ? (CONDITIONS[condition] as ConditionPresentation)
    : { icon: UNKNOWN_CONDITION_ICON, label: humanize(condition) };
}

/** The glyph for a condition at a given time of day. */
export function conditionIcon(condition: string | undefined, night: boolean): IconName {
  const presentation = conditionPresentation(condition);
  return night && presentation.nightIcon !== undefined ? presentation.nightIcon : presentation.icon;
}

/** "windy-variant" → "Windy variant"; runtime text is rendered through Lit bindings, so it is always escaped. */
function humanize(condition: string): string {
  const words = condition.replace(/[-_]+/g, ' ').trim();
  return words === '' ? NO_CONDITION.label : words.charAt(0).toUpperCase() + words.slice(1);
}
