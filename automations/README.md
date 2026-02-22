# Home Assistant Automations

Neo-built automations managed via HA REST API. These YAML files are reference copies — the live automations are in HA's `automations.yaml`.

## Automations

### Bedtime & Wake
- **bedtime.yaml** — When either person gets in bed: lights off, Eight Sleep on, white noise on, Dreo fan/AC on
- **everyone_up.yaml** — When both people leave bed: turn everything off

### Living Room
- **tv_on_movie_mode.yaml** — TV turns on: close curtains, dim living room lights
- **tv_off_restore.yaml** — TV turns off: open curtains, restore lights

### Tesla
- **abhinaya_morning_tesla.yaml** — 30 min after Abhinaya gets up on weekdays: preheat Tesla
- **low_range_reminder.yaml** — If Tesla < 100mi range at bedtime and not plugged in: notify

### Appliances
- **laundry_done.yaml** — Notify when washer or dryer cycle finishes

### Presence
- **nobody_home_lights_off.yaml** — All lights off when nobody's home
