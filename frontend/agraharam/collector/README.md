# Sky airspace collector

A small Python 3.10+ standard-library worker for Agraharam's optional read-only
Sky panel. It reads public aircraft broadcasts, resolves horizontal distance and
bearing locally, and publishes **one telemetry sensor** using the existing Home
Assistant MQTT integration. It cannot operate aircraft or household devices. It
does not install an HA integration, change existing dashboards or restart HA.

## Data and privacy boundaries

- Aircraft positions: [ADSB.lol](https://www.adsb.lol/docs/open-data/api/), ODbL 1.0.
  The fixed endpoint is documented by the [provider API](https://api.adsb.lol/docs).
- Reported routes: [Virtual Radar Server standing data](https://github.com/vradarserver/standing-data),
  CC0, served by ADSB.lol. These are community-maintained **reported routes**, not
  live airline schedules, confirmed destinations or arrival-time predictions.
- HA's authenticated `/api/config` supplies the private home position. It stays in
  process memory. The external position query uses a **0.1-degree grid center**
  with fixed 8 km radius padding; this reveals an approximate area, not the exact
  home point. Exact filtering and distance/bearing calculations run locally.
- Sensor attributes contain **no home/aircraft latitude or longitude**, owners,
  pilots, tokens, provider URLs or photos. Only approved relative flight fields
  leave the worker. Route-airport coordinates are consumed privately for sanity
  checking and are not emitted either.
- Provider requests go only to the fixed HTTPS position and route hosts. Redirects
  and environment HTTP proxies are disabled. HA authorization is sent only to
  the configured HA origin. The browser does not contact either provider.
- Only the collector's safe-ID MQTT namespace and one discovery record are
  mutated. No subscription, direct broker credential, device action or control
  switch is involved. Configure `HA_URL` using trusted HTTPS, or trusted LAN HTTP
  where appropriate for your installation; TLS verification is never disabled.

## Install and read-only preflight

Use a private checkout or copy `airspace.py` to your service directory. No package
installation is needed. From `frontend/agraharam`, run the offline tests:

```sh
python3 -B -m unittest discover -s collector -p 'test_*.py' -v
```

Your existing credential manager/launcher must provide `HA_URL` and `HA_TOKEN`
as environment variables. Never put a token in a command argument, tracked file,
process log, plist/unit file or dashboard YAML. The token needs authenticated HA
config reads and the MQTT publish service; HA must already have a functioning
MQTT integration. This worker does not configure a broker.

First verify reads only:

```sh
python3 -B collector/airspace.py --once --dry-run
```

Output contains only status and counts, for example:

```json
{
  "status": "dry_run",
  "nearby": 4,
  "overhead": 1,
  "recent": 1,
  "reported_routes": 2
}
```

`--dry-run` performs **no HA writes**, including on failure or shutdown. It still
performs external provider reads, unless the provider's backoff is active. It
does not print coordinates, callsigns, tokens or the HA URL. It is safe to share
these count/status logs, but full telemetry is private household data.

For an explicit private inspection artifact, `--once --dry-run --output PATH`
creates a **new**, mode-0600 JSON file containing only normalized attributes.
Choose an ignored/private directory outside public assets. Existing files and
symlinks are rejected. No raw provider response or home config is saved. Delete
the artifact after review; never add real flights to public fixtures.

## Start, verify and stop

After operator authorization, start the worker from a private credential-aware
launcher. These IDs are fictional examples; pick stable IDs for your deployment:

```sh
python3 -B collector/airspace.py \
  --object-id demo_sky_airspace \
  --unique-id demo_sky_airspace
```

Defaults are 25 km nearby radius, 3 km overhead radius and a 60-second wait after
each completed cycle. A cycle makes one position request and at most two route
lookups. Route timeouts are 5 seconds each. `--no-routes` disables enrichment.
Supported radius is 1–100 km; overhead radius must be 0.1 km through the nearby
radius. `--poll-seconds` permits 60–120 seconds, never rapid polling.

The IDs permit only lowercase letters, digits and underscores, must start with a
letter, and are at most 63 characters. Changing them creates a different entity;
do not run two workers with the same IDs. On first discovery HA requests
`sensor.demo_sky_airspace`, but an existing registry collision or user rename can
change the actual entity ID. **Read the actual entity from HA** before adding:

```yaml
airspace:
  entity: sensor.demo_sky_airspace
```

Verify the actual sensor's count, `schema_version: 1`, source `updated_at`, and
bounded `aircraft`/`recent` attributes. There is no need to enable device controls
for read-only Sky navigation. Do not change existing controls, cameras or security
configuration as part of this binding.

Use a supervisor appropriate to your host, with one process instance, protected
log permissions, and a restart delay of at least 60 seconds. `main(argv)` is
available for a private Python launcher, or execute this file normally. The
launcher should acquire a token in memory through the installation's approved
credential flow and reacquire on restart. HA 401/403 errors cause a sanitized
failure/one offline attempt and exit code 1, so the supervisor can refresh the
credential. Do not restart-loop on denied credentials. Graceful SIGTERM/Control-C
stops polling and attempts an `offline` availability message; an abrupt process
kill is handled by sensor expiry instead. A `--once` publish intentionally leaves
the sensor online only until its data expires.

## Freshness, recovery and MQTT contract

Discovery is retained at `homeassistant/sensor/<unique_id>/config` and resent at
startup and every 10 minutes. State/attributes share one **nonretained** JSON
message at `agraharam/airspace/<object_id>/state`, avoiding mismatched separate
attribute/count updates:

```json
{
  "count": 0,
  "attributes": {
    "schema_version": 1,
    "provider": "ADSB.lol",
    "attribution": "Aircraft positions: ADSB.lol (ODbL 1.0); reported routes: VRS via ADSB.lol (CC0)",
    "updated_at": "2026-01-01T12:00:00.000Z",
    "radius_km": 25,
    "overhead_radius_km": 3,
    "aircraft": [],
    "recent": []
  }
}
```

The discovery `value_template` reads `count`; `json_attributes_template` extracts
only `attributes`. `expire_after: 180` makes a stopped worker unavailable.
Availability at `agraharam/airspace/<object_id>/availability` is also nonretained:
`online` is sent **only after a valid fresh state was published**. Failures send
`offline`, never re-send previous state with a new timestamp. Retained discovery
plus periodic re-discovery and the next fresh nonretained state recover HA/broker
restarts without a worker subscription or retained stale traffic.

- Provider timestamps may be seconds or milliseconds. Snapshots more than 60
  seconds old or 60 seconds in the future fail closed. Repeated/backward snapshots
  are not re-published. `updated_at` is the provider timestamp, not the fetch time.
- Grounded aircraft, invalid coordinates, and position ages over 60 seconds
  (including snapshot lag) are excluded. Empty valid feeds are zero; malformed
  envelopes/all-malformed rows are failures, not false clear skies.
- At most 50 fresh aircraft, nearest first. `altitude_ft` is **barometric altitude
  in feet** (pressure altitude), not corrected true MSL or height above the house.
  `track_deg` is true ground track, not aircraft heading. No geometric-altitude
  substitution, future path extrapolation, ETA, guaranteed coverage or inferred
  missing values. Aircraft lacking broadcast reception cannot be displayed.
- Each aircraft has `hex`, `distance_km`, `bearing_deg`, `overhead`, `last_seen`.
  Optional fields: `callsign`, `registration`, `aircraft_type`, `altitude_ft`,
  `speed_kts`, `track_deg`, `vertical_rate_fpm`, `route`. A route has `origin`,
  `destination`, optional airport names, `flight_number` (reported callsign),
  `source: "VRS via ADSB.lol"`, `status: "reported"`. No invented airline name.
- Reported route must match callsign and airport chain, and the position must be
  within 100 km of a great-circle leg/end point. This is only a plausibility check:
  reused callsigns, old data and deviations can still make reported routes wrong.
  Uncertain/malformed/missing routes are omitted; fresh position data continues.
- Routes cache for one hour, misses for 15 minutes, at most 256 memory entries.
  Provider failures back off exponentially to an hour; a longer `Retry-After`
  remains authoritative. Position and route rate limits are independent. There
  is no provider rotation or quota bypass. Restart clears the cache/backoff, so
  supervisors must not aggressively restart after transient failures.
- `recent` is at most 12 aircraft observed **within the overhead radius in the
  last 30 minutes**, with `closest_distance_km` and last overhead `last_seen`.
  It is in-memory recent activity, **not today's total or permanent flight history**.
  Restart or changed home position clears it. Between observations a fast plane
  may traverse the overhead circle without appearing in history.
  The worker retains at most 256 recent tracks internally (64 observations each)
  so hiding a flight outside the newest 12 does not immediately lose its closest
  approach if it returns. Exceeding the internal cap evicts the oldest tracks.
- Strings/numbers are validated and bounded; serialized MQTT payload is capped
  at 60 KB. Provider error bodies, request URLs and authorization never enter
  logs. A failure to publish offline is still protected by the 180-second expiry.

## Rollback

1. Stop/disable this worker's supervisor and verify it is stopped.
2. Remove only the optional `airspace` binding from the relevant card, preserving
   the rest of the dashboard configuration.
3. With the same protected environment and **same IDs** used at installation,
   remove its retained discovery record:

   ```sh
   python3 -B collector/airspace.py --remove-discovery \
     --object-id demo_sky_airspace --unique-id demo_sky_airspace
   ```

4. Remove the private worker launcher and temporary proof artifacts if no longer
   needed. No other MQTT topic, dashboard, resource, integration or device needs
   removal or restart. Do not use a broad MQTT topic deletion command.

See Home Assistant's [MQTT sensor](https://www.home-assistant.io/integrations/sensor.mqtt/)
and [MQTT discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery)
documentation for template, expiry, availability and registry behavior.
