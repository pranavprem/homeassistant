# Household readings, lighting and vehicle appearance

Optional additions to the card configuration. Every example is fictional. The optional, read-only Sky panel
(`airspace`) is documented separately in [AIRSPACE.md](AIRSPACE.md).

## 1. Room lighting switches: `rooms[].switches`

```yaml
rooms:
  - name: Study
    lights: [light.demo_study_ceiling]
    switches: [switch.demo_study_desk_lamp]     # lighting only
  - name: Loft
    switches: [switch.demo_loft_floor_lamp]     # `lights` may be omitted when `switches` is present
```

- **What it is:** a list of at most 8 `switch.*` entities per room that power **lighting only** (a lamp on a smart plug
  or relay). Existing room keys and light-only rooms behave exactly as before.
- **What never goes in:**
  - a camera privacy switch (rejected as `switch-conflict`);
  - the studio-monitor outlets, which are switched only through `studio_monitors_script`;
  - appliance, heater, fan, pump or siren plugs;
  - child-lock, LED or other settings switches. HA **usually** marks those `entity_category: config` or `diagnostic`
    (it depends on the integration), and the dashboard then shows them read-only; never bind them either way.
- **Behaviour:**
  - A switch row in the room drawer has a toggle like a light, with no brightness.
  - Room "All on", "All off" and the chip's quick toggle act on lights and switches together. That is one request,
    sending one call per kind present: `light.turn_*` for the lights and `switch.turn_*` for the switches (a
    light-only room sends exactly the same single call as before).
  - If one call fails and the other goes out, the result reads "Partly done" and asks you to check the room. It never
    claims nothing changed.
- **After every page load**, switch controls, and room actions in rooms that have switches, show "Waiting for Home
  Assistant's device list…" until HA delivers its entity registry (normally within a second). Lights and every other
  control are never held.
- **Generator:**
  1. Add a private candidates group, `groups.lighting_switches: [{ "entity_id": "switch.…" }]`.
  2. Place each switch in `overrides.rooms[].switches`.

  A listed switch that is not in that group, or is in `overrides.exclude`, stops the generator (exit 1, nothing
  written). A camera privacy switch in a room also stops it. Lighting switches are never placed in the default room
  automatically; unplaced ones are listed in the header as "(unassigned lighting switch)".
- **Residual risk:** the dashboard cannot tell a lamp plug from any other plug. Verify every switch binding in the
  read-only check before anyone sets `controls: true`.

## 2. Whole-house shortcuts: `shortcuts`

```yaml
shortcuts:
  lights_toggle: script.demo_house_lights_toggle       # the verified, existing whole-house lights toggle
  curtains_toggle: script.demo_house_curtains_toggle   # the verified, existing whole-house curtains toggle
```

- **Keys:** only these two; either may be omitted. Values are `script.*` only.
- **Rejected as `duplicate-actionable`:**
  - one script under both keys;
  - a script already used in `security.actions` or `studio_monitors_script`.

  Any other key (for example `confirmation`) is an `unknown-key`.
- **Behaviour:**
  - The Home panel shows one "Whole house" row with buttons "Lights" and "Curtains" (accessible names "Whole-house
    lights" and "Whole-house curtains").
  - A tap **always** opens a confirmation dialog; no setting can turn this off.
  - Confirm runs `script.turn_on` on that script with no data or variables. Nothing is sent while the script is
    already running.
  - The result reads "Requested", because the dashboard cannot know what the script did.
  - The dialog never claims a direction, because a toggle's direction is unknowable.
- **Bind only** the household's existing guarded toggle scripts, after verifying what each one does.

## 3. Read-only readings: `collections`

```yaml
collections:
  - name: Kitchen and laundry          # 1–40 characters, unique across groups
    icon: refrigerator                 # optional; one of the icons listed below
    entities:                          # 1–32 rows
      - entity: sensor.demo_fridge_temperature
        name: Fridge                   # optional, 1–40 characters; default: HA friendly name
        attention: { above: 41 }
      - entity: binary_sensor.demo_fridge_door
        name: Fridge door
        attention: { equals: 'on' }    # quote on and off
      - sensor.demo_washer_time_left   # shorthand, no rule
```

- **Limits:** at most 12 groups of at most 32 rows. The same entity may appear in several groups, but not twice in one.
- **Icons:** house, lightbulb, plug, printer, robot-vacuum, air-vent, battery, thermometer, droplets, wind, leaf,
  refrigerator, washing-machine, car, heart-pulse, router, wifi, lock, tv, clock.
- **Domains** (display only): sensor, binary_sensor, number, select, light, switch, fan, climate, vacuum, cover, lock,
  media_player, update, input_text, input_datetime, input_boolean, input_select, event.
  - A row is never actionable, never opens HA's more-info, and is never in the action allowlist, even with
    `controls: true`.
  - A row may also be bound elsewhere (for example a vacuum). That other binding keeps its own controls; the reading
    stays read-only.
- **Attention rules**, optional, one kind per row:
  - `below` and/or `above` (sensor and number rows only). Strictly less than or greater than the **raw state in the
    entity's own unit**, as Developer tools shows it. The bound itself is in range. `below` must be less than `above`.
  - `equals`: one raw state string, or a list of up to 8, matched exactly and untranslated (for example `error`, `on`,
    `unlocked`). It cannot be `unknown` or `unavailable`, and is not allowed on `event` or `input_datetime` rows.
  - No implicit attention: a problem sensor needs `equals: 'on'`.
- **Honesty:**
  - on rows with a rule, unknown, unavailable, missing and (under a range rule) non-numeric readings count as
    **unavailable**, never as fine; a rule-less row that is unavailable or missing also counts as unavailable (a
    rule-less unknown row just shows "Unknown");
  - "within limits" appears only when every row has a rule and passes it;
  - durations (`device_class: duration`) read as "1 h 25 min", "45 s" or "3 d 4 h";
  - timestamps, uptime, dates, `input_datetime` and events read compactly ("Tomorrow, 7:40 AM", "Since Sep 21");
  - a sensor that stops updating but stays `available` looks current; that is HA's own semantics.
- **Where it shows:**
  - a third line in the House panel ("2 readings need attention, 1 unavailable");
  - a "Readings" button that opens "House readings": grouped and collapsible, with search from 16 rows.
- **Generator:** not generated. Paste `collections` into the generated YAML from a private snippet after each run.

## 4. Vehicle appearance: `vehicle.model`

```yaml
vehicle:
  name: Demo sedan
  battery_sensor: sensor.demo_sedan_battery_level
  range_sensor: sensor.demo_sedan_battery_range
  model: tesla-model-3     # default generic (the existing drawing, unchanged)
```

- Only `generic` and `tesla-model-3`.
- The art is an original black Model 3 side profile, with no logo or text.
- **Generator:** paste privately, as with `collections`.

## 5. Unchanged

- Every existing key, default, rule and message is unchanged, so existing room, media and appliance
  bindings keep working.
- `controls` defaults to false, and no tooling ever sets it true.
- Camera privacy, live-view and security flows are unchanged. The new features add no cameras and no vehicle
  commands.

## 6. Layout note

At 1440×900 with the sidebar collapsed, the bundled `normal` example fits without scrolling, but a configuration that adds shortcuts and
collections cannot: their 89 px exceed the remaining 24 px. The page scrolls; type is never shrunk. Larger
households very likely scroll already.


## Installation and verification

Publish and install through the normal release/HACS workflow. These fields need no Home Assistant restart.
Keep `controls: false` while validating the saved configuration and reading entity states. Verify that every bound
room switch powers lighting and that each shortcut script is the intended guarded toggle before the household
enables controls. Do not execute devices to validate bindings. Camera and security configuration need no edits.

The `dense` fictional scenario exercises ten rooms, mixed and switch-only lighting, both whole-house shortcuts,
seven readings collections and the Model 3 drawing. `degraded`, `offline` and `starting` demonstrate absent and
stale readings. Browser checks cover desktop, landscape tablet and phone, search/Escape, focus restoration,
read-only rows, confirmation, accessibility and zero mutations during navigation.
