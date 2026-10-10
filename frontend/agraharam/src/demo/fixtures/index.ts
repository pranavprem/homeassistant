/**
 * The fixed list of section fixtures (§10.2). Assembly merges them generically, so a section package changes
 * its demo data only in its own fixture file and never edits this list.
 */
import type { SectionFixture } from '../fixture-types.ts';
import { camerasFixture } from './cameras.ts';
import { collectionsFixture } from './collections.ts';
import { comfortFixture } from './comfort.ts';
import { garageFixture } from './garage.ts';
import { homeFixture } from './home.ts';
import { mediaFixture } from './media.ts';
import { peopleFixture } from './people.ts';
import { securityFixture } from './security.ts';
import { skyFixture } from './sky.ts';
import { todayFixture } from './today.ts';
import { upcomingFixture } from './upcoming.ts';

type SectionFixtureName =
  | 'people'
  | 'today'
  | 'comfort'
  | 'home'
  | 'cameras'
  | 'garage'
  | 'media'
  | 'upcoming'
  | 'security'
  | 'collections'
  | 'sky';

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
  // House readings (§18): not a section of their own; the House panel and the readings drawer show them.
  collections: collectionsFixture,
  // Sky (AIRSPACE.md §10): only the `sky` scenario configures it.
  sky: skyFixture,
});
