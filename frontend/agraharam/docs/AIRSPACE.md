# Sky (airspace)

An optional, read-only panel for the aircraft near the home, fed by one Home Assistant sensor that a separate
collector publishes. Every example here is fictional. To set up the collector, see
[collector/README.md](../collector/README.md); this document covers what the card reads and how it shows it.

## 1. Configuration: `airspace`

```yaml
airspace:
  entity: sensor.demo_sky_airspace # the collector's sensor; read the actual entity ID from HA
```

- **Keys:** exactly one, `entity`, a `sensor.*`. Any other key (`unknown-key`), another domain (`wrong-domain`) or a
  bare string instead of a mapping (`wrong-type`) is reported in the card like any other configuration error.
- **Read-only:** the binding has no action role. Nothing in the Sky panel or drawer calls a service, writes to HA or
  opens HA's more-info. "Details" is navigation and is always enabled: it works with `controls: false`, for
  non-admin accounts and in the editor preview. Sky never needs `controls: true`.
- **Not configured:** no Sky panel. The card resolves, subscribes and lays out exactly as it did before.
- The same sensor may also be a row in a readings collection; read-only roles may overlap.
- **Demo cards** ignore the key with a warning; use `demo_scenario: sky` instead (§10).
- **Generator:** `config:private` never adds `airspace`. Paste it into the generated YAML after the collector is
  verified, as with `collections`.
- **Downgrade:** remove `airspace` before installing an older release (HACS Redownload of a previous version).
  Older bundles reject the unknown key and show a configuration error instead of the dashboard.

## 2. Sensor contract (`schema_version` 1)

The sensor's state is the collector's nearby count; its attributes carry the data. The card reads only the named
fields below. Unknown keys are ignored (never read, spread or iterated), so the collector may add fields without
breaking older cards. The card never reads latitude or longitude, and the collector never emits them.

A fictional example of the attributes:

```json
{
  "schema_version": 1,
  "provider": "ADSB.lol",
  "attribution": "Aircraft positions: ADSB.lol (ODbL 1.0); reported routes: VRS via ADSB.lol (CC0)",
  "updated_at": "2026-01-01T12:00:00.000Z",
  "radius_km": 25,
  "overhead_radius_km": 3,
  "aircraft": [
    {
      "hex": "001a2b",
      "callsign": "DEMO214",
      "registration": "N0214D",
      "aircraft_type": "B738",
      "distance_km": 1.4,
      "bearing_deg": 315,
      "overhead": true,
      "last_seen": "2026-01-01T11:59:58.000Z",
      "altitude_ft": 4800,
      "speed_kts": 212,
      "track_deg": 135,
      "vertical_rate_fpm": -640,
      "route": {
        "origin": "XAAA",
        "destination": "XBBB",
        "origin_name": "Example International",
        "destination_name": "Sample Regional",
        "flight_number": "DEMO214",
        "source": "VRS via ADSB.lol",
        "status": "reported"
      }
    }
  ],
  "recent": [
    {
      "hex": "003a01",
      "callsign": "TEST305",
      "aircraft_type": "A320",
      "distance_km": 2.2,
      "bearing_deg": 40,
      "overhead": true,
      "last_seen": "2026-01-01T11:48:30.000Z",
      "closest_distance_km": 0.9
    }
  ]
}
```

### Envelope

| Field                | Meaning                       | Card rule                                              |
| -------------------- | ----------------------------- | ------------------------------------------------------ |
| `schema_version`     | contract version              | exactly `1`; any other value is "Unsupported sky data" |
| `provider`           | provider label                | optional, at most 40 characters; not displayed         |
| `attribution`        | the collector's attribution   | optional, at most 160 characters; shown under Sources  |
| `updated_at`         | provider snapshot time        | ISO 8601 date and time with `Z` or a `±hh:mm` offset   |
| `radius_km`          | nearby radius                 | 1 to 100                                               |
| `overhead_radius_km` | overhead radius               | 0.1 to `radius_km`                                     |
| `aircraft`           | nearby, nearest first         | list; first 64 entries examined, at most 50 shown      |
| `recent`             | overhead passes, newest first | list; first 24 entries examined, at most 12 shown      |

If `schema_version` is missing while other envelope keys are present, or any envelope rule fails, nothing is shown
and the panel reads "Sky data could not be read".

### Aircraft rows

A row must be a plain object. A row that fails any required rule is dropped; an optional field that fails its rule
is omitted and the row stays. The first row for each `hex` wins.

| Field                 | Required | Meaning and unit                  | Card rule                                        |
| --------------------- | -------- | --------------------------------- | ------------------------------------------------ |
| `hex`                 | yes      | ICAO 24-bit address               | 6 hex digits; shown upper-case as "ICAO address" |
| `distance_km`         | yes      | horizontal distance from home, km | 0 to `radius_km` × 1.05                          |
| `bearing_deg`         | yes      | direction from home, degrees      | 0 to 360                                         |
| `overhead`            | yes      | the collector's overhead flag     | a boolean (see below)                            |
| `last_seen`           | yes      | time of the last position         | ISO instant near `updated_at` (see below)        |
| `callsign`            | no       | broadcast callsign                | 2 to 8 letters or digits                         |
| `registration`        | no       | registration mark                 | 2 to 16 letters, digits or hyphens               |
| `aircraft_type`       | no       | ICAO type designator              | 2 to 8 letters or digits                         |
| `altitude_ft`         | no       | barometric altitude, feet         | −2,000 to 100,000                                |
| `speed_kts`           | no       | ground speed, knots               | 0 to 2,000                                       |
| `track_deg`           | no       | ground track, degrees from north  | 0 to 360                                         |
| `vertical_rate_fpm`   | no       | vertical rate, feet per minute    | −20,000 to 20,000                                |
| `closest_distance_km` | recent   | closest approach in the pass, km  | 0 to `overhead_radius_km` × 1.05                 |
| `route`               | no       | a community-reported route        | see Routes                                       |

Numbers must be finite JSON numbers; numeric strings, booleans, `NaN` and infinities are rejected, never coerced.
Codes are trimmed and upper-cased. Text labels are trimmed and may not contain control or formatting characters
(including bidirectional overrides and zero-width characters), private-use characters, line separators, non-ASCII
spaces or `< > " { } \`. All text reaches the page as escaped text.

`last_seen` is checked against `updated_at`, never against this device's clock: from 120 s before it to 5 s after
for nearby aircraft, and from 35 minutes before for recent passes. "Overhead" is decided by the card from the
distance alone: a nearby aircraft is overhead when `distance_km` is at most `overhead_radius_km`. The row's own flag
is only required to be a boolean.

### Routes

| Field                                        | Rule                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `status`                                     | exactly `reported`; anything else drops the route                   |
| `source`                                     | label, at most 40 characters; shown in the route caption            |
| `origin`, `destination`                      | 3 or 4 letters or digits, and different (a round trip is not shown) |
| `origin_name`, `destination_name`, `airline` | optional labels, at most 80 characters                              |
| `flight_number`                              | never shown: it holds the callsign and would read as a schedule     |

A route is shown as "XAAA → XBBB", with the airport names beneath when supplied, captioned "Reported route ·
unverified · VRS via ADSB.lol". It is a community-reported route from VRS standing data, served by ADSB.lol. Reused
callsigns, old data and diversions can make it wrong. The card never infers a route and never shows a schedule, a
flight number, an arrival time or an ETA. An invalid route is dropped and the aircraft stays.

### Counts, caps and recent passes

- The count on the panel is the number of valid nearby rows. The sensor state is only a hint.
- **All-invalid rule:** if `aircraft` held entries but none was valid, or the state is above 0 while `aircraft` is
  empty, the panel reads "Sky data could not be read", never "Quiet skies".
- Dropped, duplicate and over-cap entries are counted per list. The panel notes nearby entries only, beside the
  nearby count ("2 entries not shown"); a drawer footnote reports nearby and recent entries separately ("2 nearby
  entries and 1 recent entry in the latest sky data could not be shown.").
- `recent` holds at most 12 aircraft that were within the overhead radius at least once in the last 30 minutes,
  newest first. The collector keeps it in memory only, so a restart clears it, and a fast aircraft can cross the
  overhead circle between two updates without appearing. It is recent activity, not history and not a daily
  total. When 12 valid passes are shown and the collector's list held at least 12, the view reads "Recent 12+";
  invalid entries never make it read "12+" above fewer rows.
- Recent passes are never drawn on the radar and never marked overhead. Their details are captioned "At last
  overhead pass", with the closest approach ("Closest 0.9 km at last overhead pass").

## 3. Units and wording

- **Altitude:** barometric pressure altitude from the aircraft's broadcast, in feet: "4,800 ft baro", captioned
  "Barometric altitude" and read aloud as "feet barometric". It is not corrected altitude above mean sea level and
  not height above the home.
- **Speed:** ground speed in knots, "212 kn", captioned "Ground speed".
- **Ground track:** the direction of travel over the ground, in degrees with a compass point. It is not the
  aircraft's heading. Radar marks point along it; an aircraft without a track is a dot.
- **Vertical speed:** "Climbing · 1,800 ft/min" or "Descending · 640 ft/min"; under 250 ft/min it reads "Level".
- **Distance and bearing:** from the home, captioned "From home". Distances use Home Assistant's length unit: miles
  when HA's unit system uses miles, otherwise kilometres (also on older HA without a length unit). One decimal below
  10, whole numbers from 10. Bearings read as a 16-point compass and three-digit degrees ("NW · 315°").
- **Ages:** minute granularity: "Updated just now", "Last update 7 min ago", "seen 4 min ago".
- **Overhead:** a brass "Overhead" chip, shown only while the data is live. Never red, never "now".

## 4. Freshness and states

The collector publishes about once a minute (it waits 60 seconds after each completed cycle). Its MQTT sensor
expires after 180 seconds without a publish, which makes a stopped collector's sensor unavailable. The card applies
its own rules on top, measured against `updated_at`:

- Data older than **180 s** is not live. Data more than **60 s ahead** of this device's clock is not shown.
- Stale or offline data stays listed for up to **15 minutes** after `updated_at`: muted, under a "Not live" banner,
  with hollow grey radar marks and no track chevrons, no "Overhead" emphasis and details prefixed "Last known".
  After 15 minutes only the state sentence remains.
- Stale or offline data is never shown as live.

| Panel reads                                    | State       | Meaning                                                              |
| ---------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| placeholder rows                               | loading     | HA has not delivered its first states yet, or is still starting      |
| "Sky sensor not found"                         | missing     | the entity is not in HA; check the collector and the entity ID       |
| "Waiting for aircraft data"                    | waiting     | HA has the sensor but no attributes yet, as after an HA restart (§5) |
| "Aircraft data unavailable"                    | unavailable | the sensor is `unavailable` or `unknown`, or cannot be read          |
| "Unsupported sky data"                         | unsupported | `schema_version` is not 1; update the dashboard                      |
| "Sky data could not be read"                   | malformed   | the envelope, or every row, failed validation (§2)                   |
| "Sky data is ahead of this device's clock"     | malformed   | `updated_at` is over 60 s in the future; check the device time       |
| "No aircraft data from the sky sensor"         | malformed   | still no aircraft data after the waiting bound                       |
| "Not live while Home Assistant is offline"     | offline     | HA is disconnected or resyncing; the shared Offline pill shows       |
| "No fresh aircraft data" and a "Not live" pill | stale       | `updated_at` is over 180 s old                                       |
| "0", "Quiet skies within 25 km"                | empty       | fresh data with no aircraft nearby                                   |
| "7", "aircraft within 25 km"                   | live        | fresh data with aircraft                                             |

A collector that stops cleanly marks its sensor offline at once, and one that is killed is caught by the MQTT
expiry, so a stopped collector reads "Aircraft data unavailable" (or "Not live" first). Offline is a layer over
live, quiet or stale data only, and only while HA is disconnected or resyncing. An unavailable, missing or
unreadable sensor keeps its own sentence while HA is offline, with the same Offline pill. After a reconnect, a
sensor whose state HA did not refresh (for example one deleted during the outage) is judged by its own
`updated_at` like any other: "Not live" after 180 s and no longer drawn after 15 minutes.

## 5. Liveness bounds

Every state is recomputed on each render; nothing clock-dependent is cached. The Sky panel and drawer re-render
every 10 seconds while an airspace entity is configured, and again as soon as the page becomes visible.

| Gate                      | Clears or shows on                 | Bound                                                               |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| Live to "Not live"        | the 10 s tick or any entity update | at most 190 s after `updated_at`, with no update needed             |
| "Not live" to not drawn   | the same                           | at most 15 min 10 s after `updated_at`                              |
| Ahead of the device clock | the same                           | shown within 10 s of coming within 60 s of the clock                |
| Waiting                   | the next publish, or the tick      | ends at most 190 s after the card first saw the sensor without data |
| Offline                   | HA's connection                    | immediate; clears with the card's post-reconnect resync             |

Waiting holds only while HA's own `last_updated` for the sensor is within the last 180 s and at most 60 s ahead, so
a sensor whose count keeps changing without attributes still reaches "No aircraft data from the sky sensor" within
the bound. The card stores only the time it first saw the sensor that way, never any data.

## 6. Panel and drawer

- **Panel "Sky":** the nearby count beside "aircraft within 25 km", a line with the update age, the overhead count
  and any entries not shown, and the nearest aircraft (the closest overhead one, else the closest). In every other
  state one sentence replaces the count and the aircraft.
- **"Details"** (read as "Sky details") opens the Sky drawer with the nearest aircraft expanded.
- **Drawer**, top to bottom: a status banner while not live; the radar; "Show" (Nearby, Overhead, Recent, with
  counts); a "Find aircraft" search from 16 aircraft, kept while a search is typed even if the count falls below 16
  (Escape clears it before closing the drawer); "Sort" (Distance, Altitude, Name, and Latest, the default, in
  Recent); the aircraft list; Conditions (cloud cover, visibility and wind) when weather is configured; footnotes
  and Sources.
- **Radar:** north up, the home at the unlabelled centre, the outer ring at `radius_km`, a dashed ring at the
  overhead radius and labelled distance rings in HA's length unit and number format. It is one image with a spoken
  summary ("7 aircraft within 25 km, 1 overhead. Nearest DEMO214, 1.4 km north-west."). Marks are current positions
  and are not focusable; clicking one expands that aircraft's current row (switching from Recent to Nearby) and
  scrolls it into view without moving focus. An expanded recent pass never highlights a mark.
- **List:** each aircraft is a button that expands its details directly beneath it; one is expanded at a time. If
  the focused control disappears after an update, focus returns to the same control when it is still there; for an
  aircraft it moves to the next row, else the previous one; otherwise, as when the search field, Show or Sort
  disappear, it moves to the drawer heading. Escape closes the drawer and returns focus to "Details".

## 7. Layout

- Not configured: no panel and an unchanged layout.
- Wide and medium layouts choose their columns exactly as without Sky. Sky then joins the column with the shortest
  estimated stack (the rightmost on a tie), above that column's quiet panels (House, Upcoming). It never stretches
  to fill a column and never decides between the wide and medium layouts.
- Phones: after Media, before the quiet panels.
- A large household may scroll vertically, as the `dense` scenario does. Type is never shrunk.

## 8. Weather details

These ship with Sky but need no `airspace` binding.

- Today's header has a "Details" button (read as "Weather details") whenever weather is configured. In a narrow
  Today panel it becomes an icon button, and the words "Sunrise" and "Sunset" are hidden visually but still read.
- The "Weather details" drawer shows the condition and temperature, then each extended condition the weather entity
  actually reports: feels like, dew point, humidity, cloud cover, UV index with its WHO category, wind, gusts, wind
  direction, visibility and pressure. Then the next sunrise and sunset from the `sun` binding.
- A condition the entity never reports is not listed. One it reports as null or out of range reads "No data", never
  0. Units come from the entity's own unit attributes (`wind_speed_unit`, `visibility_unit`, `pressure_unit` and the
  temperature unit); without one, the bare number is shown.
- The entity's friendly name is never shown, because it is often a place name. While HA is offline the values are
  the last known ones, dimmed and marked. The drawer is read-only.

## 9. Privacy, network and links

- **No network from the card** for this feature: no map tiles, images, fonts, CDNs or fetches. The radar is inline
  SVG drawn from distance and bearing. Unless someone clicks one of the links below, the browser never contacts
  ADSB.lol or VRS; only the collector does.
- **No coordinates:** the attributes hold none, the card reads none, and the home is the unlabelled centre.
- **Location sensitivity:** live sky data and screenshots of it can reveal where the home is, because an aircraft's
  identity, distance and bearing at a known time can be matched against public flight-tracking history. Keep live
  sky data, collector proof files and screenshots private. Never put real flights in fixtures, tests, issues or
  docs. `check:public` also forbids aircraft identifiers it finds in the private directory, printing counts only.
- Attribute values are never logged.

**Outbound links.** Exactly three constant URL forms, each opened only on a click, in a new tab with
`rel="noopener noreferrer external"` and `referrerpolicy="no-referrer"`, and never prefetched. The build
(`scripts/postbuild.mjs`) fails on any other URL in the bundle.

| Link text                                 | Where                                           | URL                                             |
| ----------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Track on ADSB.lol                         | an expanded aircraft (live HA only, never demo) | `https://globe.adsb.lol/?icao=<hex>`            |
| ADSB.lol · aircraft positions (ODbL 1.0)  | drawer Sources                                  | `https://www.adsb.lol/`                         |
| VRS standing data · reported routes (CC0) | drawer Sources                                  | `https://github.com/vradarserver/standing-data` |

The tracking link carries only the validated 6-digit address and no other parameter, so the tracker opens on that
aircraft. Opening any link is an ordinary visit to that site from the viewer's network.

**Licensing and attribution.** Aircraft positions come from ADSB.lol under the Open Database License (ODbL) 1.0.
Reported routes come from Virtual Radar Server standing data, dedicated to the public domain under CC0 and served by
ADSB.lol. The drawer always shows both source links and the collector's `attribution` text. The card bundles no
aircraft data.

## 10. Demo preview

`?scenario=sky` in the preview shell (`npm run dev` or `npm run preview`), or `demo_scenario: sky` on a demo card,
shows the normal fictional household with a fictional sky: eight nearby aircraft, one of them overhead with a
reported route, and three recent passes. No other scenario has a Sky panel. The fixture is built once when the
scenario loads and never refreshes, so after about three minutes of real time the preview honestly turns "Not live".

Fictional identifiers follow fixed patterns, checked by a test across `src`, `tests`, `e2e`, `docs` and `install`:
ICAO addresses in the unallocated block 000001 to 003FFF, callsigns starting `DEMO` or `TEST`, registrations
starting `N0`, route codes starting `X`, generic airport names and the airline "Example Air".

## 11. Setup, verification and rollback

1. Set up the collector and verify it with its read-only dry run: [collector/README.md](../collector/README.md).
2. Read the sensor's actual entity ID in HA (a registry collision or rename can change it) and check that its
   attributes show `schema_version: 1`, a recent `updated_at` and bounded `aircraft` and `recent` lists.
3. Add `airspace` to the card configuration. Leave `controls` as it is; camera, security and device settings need
   no edits.
4. Check that the Sky panel shows a count or "Quiet skies" and that "Details" opens the drawer.

To roll back, remove only the `airspace` key from the card configuration, then follow the collector's rollback
steps. Remove `airspace` before any HACS downgrade (§1).
