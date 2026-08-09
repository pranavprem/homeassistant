# 🏠 Home Assistant Stack

Home Assistant deployment on UGREEN NAS with dedicated Cloudflare tunnel.

**URL:** [home.pranavprem.com](https://home.pranavprem.com)

## Architecture

```
Internet → Cloudflare Tunnel → ha-cloudflared → Home Assistant / Grocy
```

The stack now follows a mediaserver-style Docker network layout. Cloudflared, Home Assistant, and Grocy share a `proxy` network so the tunnel can route directly to containers by service name. Home Assistant, Grocy, HomeButler, Mosquitto, and Govee2MQTT share an `automation` network for internal service-to-service traffic. HomeButler binds to `127.0.0.1` by default, but you can bind it to the NAS LAN IP for trusted LAN-only access.

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
   - `PROXY_SUBNET` — stable Docker subnet for the `proxy` network (default `172.31.240.0/24`)
   - `AUTOMATION_SUBNET` — stable Docker subnet for the `automation` network (default `172.31.241.0/24`)
   - `GROCY_PORT` — Grocy host port (default `9283`)
   - `HOMEBUTLER_BIND_IP` — host IP to publish HomeButler on. Leave at `127.0.0.1`; HomeButler is unauthenticated and has `docker.sock` mounted, so widening this is root-equivalent LAN exposure (see step 9)
   - `HOMEBUTLER_PORT` — HomeButler API port (default `8000`)
   - `CLOUDFLARED_TOKEN` — token for the already-existing HA tunnel

3. Deploy:
   ```bash
   make up
   ```

   `make up` now starts the stack, then runs `scripts/sync_trusted_proxies.py` to patch `configuration.yaml` with the currently detected trusted proxies and restart Home Assistant if the config changed.

4. Add to `configuration.yaml` for Cloudflare proxy support:
   ```yaml
   http:
     use_x_forwarded_for: true
     trusted_proxies:
       - 127.0.0.1
       - ::1
       - 172.31.240.0/24
   ```

   Use the same CIDR as `PROXY_SUBNET` in `.env`, not a single container IP. That makes the setup self-healing when the `ha-cloudflared` container is recreated and gets a different address.

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
   PROXY_SUBNET=172.31.240.0/24
   AUTOMATION_SUBNET=172.31.241.0/24
   GROCY_PORT=9283
   HOMEBUTLER_BIND_IP=127.0.0.1
   HOMEBUTLER_PORT=8000
   CLOUDFLARED_TOKEN=...your tunnel token...
   ```

4. Bootstrap or deploy:
   ```bash
   make bootstrap
   ```
   If you do not want the interactive bootstrap flow, use:
   ```bash
   make up
   ```

5. In Home Assistant `configuration.yaml`, make sure Cloudflare proxy support is present:
   ```yaml
   http:
     use_x_forwarded_for: true
     trusted_proxies:
       - 127.0.0.1
       - ::1
       - 172.31.240.0/24
   ```

   Keep that CIDR aligned with `PROXY_SUBNET` in `.env`. Do not pin a single `ha-cloudflared` IP.

6. If your HA MQTT integration currently uses `localhost`, change it to broker host `mosquitto`.

   To enable Zigbee2MQTT for generic Zigbee sensors without a vendor hub, deploy
   a separate Portainer Git stack from this repo with compose path
   `docker-compose.zigbee.yaml`. It joins the existing `homeassistant_automation`
   network and uses the existing Mosquitto broker plus Home Assistant MQTT
   discovery.

   Zigbee2MQTT add-on stack environment:
   ```dotenv
   HA_CONFIG_PATH=/volume1/media/config/homeassistant-config
   MQTT_USER=mqtt
   MQTT_PASSWORD=...same value as the Home Assistant stack...
   ZIGBEE_ADAPTER_DEVICE=/dev/ttyUSB0
   ZIGBEE_ADAPTER_TYPE=zstack
   ZIGBEE2MQTT_BIND_IP=127.0.0.1
   ZIGBEE2MQTT_PORT=43117
   ZIGBEE2MQTT_LOG_LEVEL=info
   ```

   Use `ZIGBEE_ADAPTER_TYPE=ember` for Home Assistant Connect ZBT-1,
   SkyConnect, or other EFR32-based coordinators.

7. In Cloudflare Zero Trust, update the tunnel public hostnames for this stack:
   - `home.pranavprem.com` → **HTTP** → `homeassistant` → port `8123`
   - `grocy.pranavprem.com` → **HTTP** → `grocy` → port `80`

   Important: these service names are resolved from inside the `ha-cloudflared` container on the Docker `proxy` network. They are meant to hit the containers directly, not NAS localhost.

8. Restart the stack if you changed `.env` or tunnel config:
   ```bash
   docker compose --env-file .env up -d
   ```

   If the Docker networks already exist with old auto-assigned subnets, recreate them once so the fixed CIDRs take effect:
   ```bash
   docker compose --env-file .env down
   docker compose --env-file .env up -d
   ```

   If `make up` fails with `Pool overlaps with other one on this address space`, set unused CIDRs in `.env` before retrying. The current safe defaults in this repo are:
   ```dotenv
   PROXY_SUBNET=172.31.240.0/24
   AUTOMATION_SUBNET=172.31.241.0/24
   ```

9. Verify locally on the NAS:
   ```bash
   docker compose ps
   curl -I http://127.0.0.1:8123
   curl -I http://127.0.0.1:9283
   curl http://${HOMEBUTLER_BIND_IP:-127.0.0.1}:${HOMEBUTLER_PORT:-8000}/health
   ```

   **Keep `HOMEBUTLER_BIND_IP=127.0.0.1`.** HomeButler has `/var/run/docker.sock` mounted
   and no authentication on its control routes, so anything that can reach its port can
   restart any registered container and run allowlisted `make` / `docker compose` actions
   against the `homeassistant`, `mediaserver`, `morpheus`, and `tor` repos. That is
   root-equivalent on the NAS. Binding it to the LAN address hands that to every device on
   the WiFi, including the IoT devices sharing that subnet.

   Neo does not need the LAN binding. Reach HomeButler **through Home Assistant** instead:
   `packages/food_stack.yaml.template` exposes every registry restart and allowlisted action
   as `rest_command` + `script` entities, and HA talks to `http://homebutler:8000` over the
   internal `automation` network. Neo drives HA (which is authenticated) via HA MCP, and HA
   drives HomeButler. See "HomeButler control plane" below.

   If you ever genuinely need direct LAN access, treat it as a change that requires auth on
   `/ops/*` first — not just a narrower bind IP. Firewall rules alone leave every device on
   the trusted subnet with full control.

10. Verify externally:
   - open `https://home.pranavprem.com`
   - open `https://grocy.pranavprem.com`

## Cloudflare Tunnel

### Self-healing proxy setup

The first fix for Cloudflared IP churn is to trust the **proxy network subnet**, not the current container IP. This repo now pins the `proxy` network to `PROXY_SUBNET` and the `automation` network to `AUTOMATION_SUBNET`, so container restarts do not change the trusted CIDR.

Synology and some Docker host setups can still surface forwarded traffic from a host-side IP instead of the container IP. For that case, this repo also ships `scripts/sync_trusted_proxies.py`, which:
- reads `PROXY_SUBNET` from `.env`
- detects the host's current LAN IP
- reads any recent `Received X-Forwarded-For header from an untrusted proxy ...` IPs from Home Assistant logs
- reads the current `ha-cloudflared` container IP when available
- patches `HA_CONFIG_PATH/configuration.yaml`
- optionally restarts Home Assistant if the trusted proxy list changed

Use it directly with:

```bash
make sync-trusted-proxies
```

`make up` already runs that script after `docker compose up --build -d`, so a normal deploy will self-heal the `http.trusted_proxies` block when possible.

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

### HomeButler Grocy migration endpoint

HomeButler binds to `127.0.0.1:8000` on the NAS by default, which makes it a
localhost-only control plane, and should stay that way — see step 9 in the deploy
steps for why. Direct live Grocy writes from Neo are intentionally blocked, so
migration bundles are applied through HomeButler instead:

```
POST http://127.0.0.1:8000/migration/grocy/apply
Content-Type: application/json
```

The JSON body is a declarative bundle with any of:
`quantity_units`, `locations`, `shopping_locations`, `task_categories`,
`chores`, `tasks`, `equipment`, `products`, `recipes`, `meal_plan`, and an
optional `meta` block. Cross-section references use names (e.g. a product's
`location` matches a location's `name`); HomeButler resolves them to Grocy
ids at apply time.

The apply is idempotent: named objects match by normalized name, recipe
ingredients match by `(recipe, product)`, meal-plan entries match by
`(day, type, note, recipe|product)`, and `stock_amount` only tops up the
delta against current on-hand stock. Re-running the same bundle after it
has already been applied is a safe no-op.

For the current rollout, the repo includes a checked-in bundle at
`migrations/grocy/2026-04-21-homebutler.json` plus a helper script and make
wrapper:

```bash
make apply-grocy-migration
```

That target posts the checked-in bundle to `http://127.0.0.1:${HOMEBUTLER_PORT}/migration/grocy/apply` using the port from `.env`, so you do not need to hand-craft the curl request on the NAS. Run it on the NAS rather than exposing the route to the LAN.

### HomeButler control plane (stacks & actions)

HomeButler exposes a typed control plane over the containers it manages:

- `GET /ops/stacks` — list all registered stacks (`homeassistant`,
  `mediaserver`, `morpheus`, `tor`) with their services, container state,
  and resolved repo paths.
- `GET /ops/stacks/{stack}/services/{service}` — inspect a single service.
- `GET .../logs`, `POST .../restart` — per-service log/restart via the
  registry.
- `GET /ops/actions` — list allowlisted higher-level actions (e.g.
  `mediaserver.update_gluetun`, `morpheus.redeploy`, `tor.restart`) with
  availability metadata.
- `POST /ops/actions/{action}/run` — execute an allowlisted action.

The Home Assistant package template exposes this control plane as
`rest_command` + `script` entities so Neo can call HomeButler through HA's
internal Docker network without publishing HomeButler directly on the LAN.
`packages/food_stack.yaml.template` currently includes restart scripts for
every service in the registry plus scripts for every allowlisted action. The
old shortcut script names for Grocy, Home Assistant, and Cloudflared remain as
compatibility aliases.

The registry is code-reviewed in `services/homebutler/app/registry/` — no
runtime/shell input, no user-supplied make targets, no user-supplied
container names. The legacy `/ops/containers*` routes remain for
compatibility. See `services/homebutler/docs/control-plane-design.md` for
the full design.

Actions need both the host repo bind-mounted into the container (see
`HOMEBUTLER_*_REPO_HOST` in `example.env`) and the required executables
(`make`, `docker`) in the HomeButler image. Until both are in place an
action is returned with `available: false` and a human-readable reason
rather than being hidden or silently failing.

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
| Zigbee2MQTT | Third Reality/Aqara/etc. Zigbee sensors | Local via Mosquitto |
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
│   └── optional add-on: zigbee2mqtt joins homeassistant_automation
├── homeassistant published on :8123
├── grocy published on :9283
└── homebutler published on ${HOMEBUTLER_BIND_IP:-127.0.0.1}:${HOMEBUTLER_PORT:-8000}
```

This keeps Cloudflare routing direct-to-container instead of bouncing through NAS localhost. Tradeoff: integrations that previously relied on host-network discovery may need manual reconfiguration or static hosts after the move.
