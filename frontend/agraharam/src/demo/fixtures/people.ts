/**
 * People fixture (§10.2): fictional household members for the header's presence and the household drawer. States
 * carry no location attributes and no pictures (presence shows initials only).
 *
 * Scenario variants: `degraded` shows a zone name (which must read Away, never the zone) and an unavailable person
 * (Unknown); `dense` has four people for header width checks; `empty` configures nobody.
 *
 * Diagnostics is not set here: the root carries the user's own `diagnostics` flag (and title) into the demo
 * runtime config (§4.2 rule 9).
 */
import type { DemoScenarioId } from '../../config/schema.ts';
import type { HassEntityLike } from '../../ha/types.ts';
import { demoEntity, type FixtureClock, type SectionFixture } from '../fixture-types.ts';

interface DemoPerson {
  readonly entity: string;
  readonly name: string;
}

const MEERA: DemoPerson = { entity: 'person.demo_meera', name: 'Meera' };
const ARUN: DemoPerson = { entity: 'person.demo_arun', name: 'Arun' };
const KAVYA: DemoPerson = { entity: 'person.demo_kavya', name: 'Kavya' };
const DEVI: DemoPerson = { entity: 'person.demo_devi', name: 'Devi' };

/** A fictional zone name: presence must show it as Away, never as the zone. */
const DEMO_ZONE = 'Studio';
/** Minutes since a person's last state change, so last_changed is a plausible, clock-relative time. */
const ARRIVED_MIN_AGO = 95;

function peopleFor(scenario: DemoScenarioId): readonly DemoPerson[] {
  if (scenario === 'empty') return [];
  if (scenario === 'degraded') return [MEERA, ARUN, KAVYA];
  if (scenario === 'dense') return [MEERA, ARUN, KAVYA, DEVI];
  return [MEERA, ARUN];
}

function stateFor(scenario: DemoScenarioId, person: DemoPerson): string {
  if (person === MEERA) return 'home';
  if (person === ARUN) return scenario === 'degraded' ? DEMO_ZONE : 'not_home';
  if (person === KAVYA) return scenario === 'degraded' ? 'unavailable' : 'home';
  return DEMO_ZONE;
}

function personStates(scenario: DemoScenarioId, clock: FixtureClock): HassEntityLike[] {
  return peopleFor(scenario).map((person) =>
    demoEntity(clock, person.entity, stateFor(scenario, person), { friendly_name: person.name }, ARRIVED_MIN_AGO),
  );
}

export const peopleFixture: SectionFixture = {
  config: (scenario) => {
    const people = peopleFor(scenario);
    return people.length > 0 ? { people: people.map(({ entity, name }) => ({ entity, name })) } : {};
  },
  states: (scenario, clock) => personStates(scenario, clock),
};
