/**
 * The fixed list of section fixtures (§10.2). Assembly merges them generically, so a section package changes
 * its demo data only in its own fixture file and never edits this list.
 */
import type { SectionFixture } from '../fixture-types.ts';
import { camerasFixture } from './cameras.ts';
import { comfortFixture } from './comfort.ts';
import { garageFixture } from './garage.ts';
import { homeFixture } from './home.ts';
import { mediaFixture } from './media.ts';
import { peopleFixture } from './people.ts';
import { securityFixture } from './security.ts';
import { todayFixture } from './today.ts';
import { upcomingFixture } from './upcoming.ts';

type SectionFixtureName =
  'people' | 'today' | 'comfort' | 'home' | 'cameras' | 'garage' | 'media' | 'upcoming' | 'security';

export const SECTION_FIXTURES: Readonly<Record<SectionFixtureName, SectionFixture>> = Object.freeze({
  people: peopleFixture,
  today: todayFixture,
  comfort: comfortFixture,
  home: homeFixture,
  cameras: camerasFixture,
  garage: garageFixture,
  media: mediaFixture,
  upcoming: upcomingFixture,
  security: securityFixture,
});
