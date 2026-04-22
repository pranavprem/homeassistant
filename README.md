# 🏠 Home Assistant Stack

Home Assistant deployment on UGREEN NAS with dedicated Cloudflare tunnel.

**URL:** [home.pranavprem.com](https://home.pranavprem.com)

## Architecture

```
Internet → Cloudflare Tunnel → ha-cloudflared → Home Assistant / Grocy
```

The stack now follows a mediaserver-style Docker network layout. Cloudflared, Home Assistant, and Grocy share a `proxy` network so the tunnel can route directly to containers by service name. Home Assistant, Grocy, HomeButler, Mosquitto, and Govee2MQTT share an `automation` network for internal service-to-service traffic. HomeButler still binds its host port to localhost only.

## Containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `homeassistant` | `ghcr.io/home-assistant/home-assistant:stable` | Smart home hub |
| `grocy` | `lscr.io/linuxserver/grocy:latest` | Household food data layer (pantry, shopping list, meal state) |
| `homebutler` | local build (`./services/homebutler`) | Internal Grocy API + local control layer for container health/restarts |
| `mosquitto` | `eclipse-mosquitto:2` | MQTT broker on the internal automation network |
| `govee2mqtt` | `ghcr.io/wez/govee2mqtt:latest` | Govee device bridge via MQTT |
| `ha-cloudflared` | `cloudflare/cloudflared:latest` | Dedicated tunnel for external access |

## Setup

### Recommended: one-step bootstrap

Run this on the NAS:

```bash
make bootstrap
```

The bootstrap flow now:
- creates or updates `.env`
- prompts for the basics it cannot safely guess
- starts Home Assistant, Grocy, HomeButler, and the existing local services
- triggers Grocy first-run init
- auto-creates a Grocy API key for HomeButler when needed
- installs a Home Assistant package scaffold into your HA config path
- reuses the existing Cloudflare tunnel config if you already have one

### Manual path

1. Copy `example.env` to `.env` and fill in values:
   ```bash
   cp example.env .env
   ```

2. Configure `.env`:
   - `HA_CONFIG_PATH` — path to HA config directory on NAS
   - `TZ`, `PUID`, `PGID` — shared container settings
   - `HOMEASSISTANT_PORT` — Home Assistant host port (default `8123`)
   - `GROCY_PORT` — Grocy host port (default `9283`)
   - `HOMEBUTLER_PORT` — local-only HomeButler API port (default `8000`)
   - `CLOUDFLARED_TOKEN` — token for the already-existing HA tunnel

3. Deploy:
   ```bash
   docker compose up -d --build
   ```

4. Add to `configuration.yaml` for Cloudflare proxy support:
   ```yaml
   http:
     use_x_forwarded_for: true
     trusted_proxies:
       - 127.0.0.1
       - ::1
       - 172.16.0.0/12
   ```

5. If your HA MQTT integration was previously pointed at `localhost`, change it to broker host `mosquitto`.

## Exact NAS Deploy Steps

Run these on the NAS from the repo root.

1. Pull the latest repo state:
   ```bash
   git pull
   ```

2. Create `.env` if this is a fresh deploy:
   ```bash
   cp example.env .env
   ```

3. Edit `.env` and set at minimum:
   ```dotenv
   HA_CONFIG_PATH=/volume1/media/config/homeassistant-config
   TZ=America/Los_Angeles
   PUID=1000
   PGID=1000
   HOMEASSISTANT_PORT=8123
   GROCY_PORT=9283
   HOMEBUTLER_PORT=8000
   CLOUDFLARED_TOKEN=...your tunnel token...
   ```

4. Bootstrap or deploy:
   ```bash
   make bootstrap
   ```
   If you do not want the interactive bootstrap flow, use:
   ```bash
   docker compose --env-file .env up -d --build
   ```

5. In Home Assistant `configuration.yaml`, make sure Cloudflare proxy support is present:
   ```yaml
   http:
     use_x_forwarded_for: true
     trusted_proxies:
       - 127.0.0.1
       - ::1
       - 172.16.0.0/12
   ```

6. If your HA MQTT integration currently uses `localhost`, change it to broker host `mosquitto`.

7. In Cloudflare Zero Trust, update the tunnel public hostnames for this stack:
   - `home.pranavprem.com` → **HTTP** → `homeassistant` → port `8123`
   - `grocy.pranavprem.com` → **HTTP** → `grocy` → port `80`

   Important: these service names are resolved from inside the `ha-cloudflared` container on the Docker `proxy` network. They are meant to hit the containers directly, not NAS localhost.

8. Restart the stack if you changed `.env` or tunnel config:
   ```bash
   docker compose --env-file .env up -d
   ```

9. Verify locally on the NAS:
   ```bash
   docker compose ps
   curl -I http://127.0.0.1:8123
   curl -I http://127.0.0.1:9283
   curl http://127.0.0.1:8000/health
   ```

10. Verify externally:
   - open `https://home.pranavprem.com`
   - open `https://grocy.pranavprem.com`

## Cloudflare Tunnel

This stack uses its own dedicated tunnel (separate from the mediaserver tunnel).

- **Dashboard:** Cloudflare Zero Trust → Networks → Tunnels
- **Route for Home Assistant:** `home.pranavprem.com` → `http://homeassistant:8123`
- **Route for Grocy:** `grocy.pranavprem.com` → `http://grocy:80`

Those routes hit the Docker containers directly, not the NAS localhost port.

## Tesla Fleet API

Tesla integration requires a public key hosted at:
```
https://home.pranavprem.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

This is served via a **Cloudflare Worker** (`tesla-public-key`) on the `home.pranavprem.com` route, since HA doesn't natively serve `/.well-known/` paths.

## Food System

The food-decision stack now lives here:
- **Grocy** stores pantry, shopping list, and meal-related state
- **Home Assistant** is the orchestration and Google Home bridge
- **HomeButler** runs inside this NAS stack as an internal API and control layer
- **Neo** is the reasoning layer for meal decisions
- **HA MCP** lives with Neo on the Mac mini so Neo can drive Home Assistant cleanly

See `FOOD_SYSTEM.md` for the full architecture.

## Integrations

| Integration | Devices | Type |
|-------------|---------|------|
| Philips Hue | Lights | Local (bridge) |
| Roborock | Robot vacuums | Cloud |
| Google Nest | Doorbell, cameras, speakers, thermostat | Cloud |
| LG ThinQ | Washer, dryer, fridge, dishwasher, TV | Cloud |
| SwitchBot | Curtains | Cloud/BLE |
| Tesla Fleet | Model 3 + Wall Connector | Cloud |
| Eight Sleep (HACS) | Pod | Cloud |
| Dreo | Fan/heater | Cloud |
| Govee | Light bar (H607C) | Cloud + LAN via govee2mqtt |
| Apple TV | Media player | Local |
| Canon Printer | Printer | Local (IPP) |
| Chromecast | Projector | Local |

### Pending
- **Konnected blaQ** — garage door (hardware on order; currently using ratgdo)
- **Levoit / VeSync** — 4x Levoit Core 200S air purifiers (WiFi enabled)
- **Non-Hue Philips light** — TBD

## Dashboard

The main dashboard ("Agraharam") uses [Mushroom cards](https://github.com/piitaya/lovelace-mushroom) from HACS. Configuration is in `dashboard.yaml`.

## Automations

25 automations in `automations/` covering lights, garage, vacuum, laundry, Tesla charging, movie mode, air purifiers, and more. See `CLAUDE.md` for the full list.

## Security

- `privileged: false` — no unnecessary host access
- `no-new-privileges: true` on all containers
- Cloudflare tunnel — no ports exposed on router
- HA has strong password + MFA enabled
- Tesla Fleet API scoped via OAuth

## Network

```
NAS
├── proxy network: homeassistant, grocy, ha-cloudflared
├── automation network: homeassistant, grocy, homebutler, mosquitto, govee2mqtt
├── homeassistant published on :8123
├── grocy published on :9283
└── homebutler published on 127.0.0.1:8000 only
```

This keeps Cloudflare routing direct-to-container instead of bouncing through NAS localhost. Tradeoff: integrations that previously relied on host-network discovery may need manual reconfiguration or static hosts after the move.
