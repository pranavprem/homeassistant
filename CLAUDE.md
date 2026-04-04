# CLAUDE.md

## Project Overview
Pranav's Home Assistant setup running on a UGREEN NAS (10.0.0.116) via Docker Compose with host networking. Externally accessible at `home.pranavprem.com` via a dedicated Cloudflare tunnel.

## Architecture
```
Internet → Cloudflare Tunnel → ha-cloudflared → localhost:8123 → Home Assistant
NAS (host network)
├── homeassistant (:8123) — smart home hub
├── mosquitto (:1883)     — MQTT broker
├── govee2mqtt             — Govee LAN/cloud bridge via MQTT
└── ha-cloudflared         — Cloudflare tunnel
```

- All containers run with `network_mode: host` for mDNS/SSDP/BLE device discovery
- IoT devices on local WiFi (2.4GHz, same subnet as NAS)
- Security: `no-new-privileges: true` on all containers, no router ports exposed

## Repository Structure
```
├── CLAUDE.md              — this file
├── README.md              — setup & architecture docs
├── docker-compose.yaml    — 4 services (HA, mosquitto, govee2mqtt, cloudflared)
├── example.env            — template for .env (HA_CONFIG_PATH, MQTT, Govee, Cloudflare)
├── .gitignore             — excludes .env
├── dashboard.yaml         — "Agraharam" dashboard (Mushroom cards)
├── automations/           — 25 automation YAML files
│   └── *.yaml
└── templates/
    └── bed_occupancy.yaml — Eight Sleep bed occupancy template
```

## Dashboard
- **Name:** Agraharam
- **Style:** Mushroom cards (via HACS `custom:mushroom-*-card`)
- **Layout:** Sections view, max 3 columns
- **Features:** Status bar (persons, weather, lights count, garage), quick controls (all lights on/off), room controls

## Automations (25 total, as of April 2026)
All automations are in `automations/` as individual YAML files:

| File | Description |
|------|-------------|
| `air_purifier_mode.yaml` | State-triggered air purifier mode changes |
| `dishwasher_done.yaml` | Dishwasher completion notification |
| `dreo_follows_eightsleep.yaml` | Dreo fan/heater follows Eight Sleep state (temp-based mode) |
| `fridge_door_open.yaml` | Fridge door left open alert |
| `garage_close_on_leave.yaml` | Auto-close garage when leaving |
| `garage_left_open.yaml` | Garage left open alert |
| `garage_open_on_arrive.yaml` | Auto-open garage on arrival |
| `kanta_bai_offline.yaml` | Robot vacuum offline alert (30min threshold) |
| `laundry_done.yaml` | Washer/dryer completion notification |
| `low_battery_alert.yaml` | Low battery alerts for sensors |
| `low_range_reminder.yaml` | Tesla low range reminder |
| `nobody_home_lights_off.yaml` | Turn off lights when nobody home |
| `projector_movie_mode.yaml` | Movie mode when projector turns on |
| `projector_off_restore.yaml` | Restore settings when projector turns off |
| `shanta_bai_maintenance.yaml` | Daily vacuum maintenance check at 6pm |
| `sleep_summary.yaml` | Eight Sleep sleep summary |
| `speaker_announcements.yaml` | Smart speaker announcements |
| `tesla_charge_complete.yaml` | Tesla charge completion notification |
| `tesla_charge_cost.yaml` | Tesla charge cost calculation (PG&E EV2-A TOU rates) |
| `tv_off_restore.yaml` | Restore settings when TV turns off |
| `tv_on_movie_mode.yaml` | Movie mode when TV turns on (with sunset threshold) |
| `vacuum_when_away.yaml` | Run Kanta Bai vacuum when away |
| `welcome_display.yaml` | Welcome display automation |
| `welcome_home.yaml` | Welcome home automation |

### Device Nicknames
- **Kanta Bai** — primary robot vacuum (runs when away)
- **Shanta Bai** — secondary robot vacuum (runs on her own schedule, daily maintenance check)

### Automation Patterns
- Phone notifications go to both Pranav and Abhinaya on most automations
- Movie mode: triggered by TV/projector on, respects sunset threshold (10° elevation)
- Dreo fan/heater: follows Eight Sleep state, uses room temperature for mode selection (not month-based), ignores unavailable→off transitions
- Vacuum: uses time_pattern (30min) for presence checks (more reliable than state triggers)

## Installed Integrations

| Integration | Devices | Type |
|-------------|---------|------|
| Philips Hue | Lights (living room, couch lamp, painting, bedrooms, guest room) | Local (bridge) |
| Roborock | Robot vacuums (Kanta Bai, Shanta Bai) | Cloud |
| Google Nest | Doorbell, cameras, speakers, thermostat | Cloud |
| LG ThinQ | Washer, dryer, fridge, dishwasher, TV | Cloud |
| SwitchBot | Curtains | Cloud/BLE |
| Tesla Fleet | Model 3 + Wall Connector | Cloud (OAuth) |
| Eight Sleep (HACS) | Pod (smart mattress) | Cloud |
| Dreo | Tower fans, portable AC, heater | Cloud |
| Govee | Light bar (H607C) | Cloud + LAN via govee2mqtt |
| Apple TV | Media player | Local |
| Canon Printer | Printer | Local (IPP) |
| Chromecast | Projector | Local |
| HACS | Community Store | — |
| Mosquitto | MQTT broker | Local |

### Pending Integrations
- **Konnected blaQ** — garage door opener (hardware on order; currently using ratgdo)
- **Levoit / VeSync** — 4x Levoit Core 200S air purifiers (WiFi enabled)
- **Non-Hue Philips light** — TBD

### Tesla Fleet API
- Public key hosted at `https://home.pranavprem.com/.well-known/appspecific/com.tesla.3p.public-key.pem`
- Served via Cloudflare Worker (`tesla-public-key`) since HA doesn't serve `/.well-known/`
- Scoped via OAuth

## Key Technical Details
- **PG&E EV2-A TOU rates** used for Tesla charge cost calculation
- **Eight Sleep** installed via HACS (not native integration)
- **Garage door** currently uses `cover.ratgdo_garage_door` entity
- **Mushroom cards** required from HACS for the dashboard
- **Config path on NAS:** `/volume1/media/config/homeassistant-config` (set in .env)

## Deployment
```bash
# On the NAS
cd /path/to/homeassistant
cp example.env .env  # fill in values
docker compose up -d
```

HA `configuration.yaml` needs trusted proxies for Cloudflare:
```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
    - 172.16.0.0/12
```

## Remotes
- **GitHub:** https://github.com/pranavprem/homeassistant
- **Branch:** main

## Household Context
- Pranav and wife Abhinaya live at 319 Otono Ct, San Jose, CA 95111
- Tesla Model 3 LR 2020 (Pranav) — never charges past 80%
- Toyota GR86 2024 (Abhinaya)
- 4x Levoit Core 200S/200S-P air purifiers throughout house

## Owner
Pranav Prem (pranavprem93@gmail.com)

## Recent History (as of April 2026)
- Agraharam dashboard built with Mushroom cards (status bar, quick controls, all-lights toggles)
- Tesla charge cost updated to PG&E EV2-A TOU rates
- Welcome display, speaker announcements, Tesla charge cost automations added
- Shanta Bai daily maintenance check added
- 5 new automations: battery, fridge, projector, air purifiers
- Vacuum automation iterated through v1-v5 (settled on time_pattern every 30min)
- Dreo decoupled from bed automations → follows Eight Sleep state directly
- Govee2mqtt + Mosquitto added to docker-compose
