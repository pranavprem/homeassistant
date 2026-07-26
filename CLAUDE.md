# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The Docker Compose deployment + configuration source for Pranav's Home Assistant stack on a
UGREEN NAS (`10.0.0.116`), externally reachable at `home.pranavprem.com` through a dedicated
Cloudflare tunnel. It contains three fairly different kinds of content:

1. **Infrastructure** — `docker-compose.yaml`, `Makefile`, `scripts/`, `example.env`
2. **A Python service** — `services/homebutler/` (FastAPI control plane, the only real "code")
3. **Home Assistant configuration** — `automations/`, `dashboard.yaml`, `packages/`, `templates/`

Only #3's `packages/` is actually mounted into Home Assistant. See "How config reaches HA" below —
this is the most common source of confusion.

## Commands

```bash
make bootstrap        # interactive first-run: writes .env, starts stack, inits Grocy,
                      # creates a Grocy API key, installs the HA package scaffold
make up               # docker compose up --build -d, then sync_trusted_proxies.py
make down / logs / config
make smoke            # compileall + `docker compose --env-file example.env config` — the
                      # closest thing to CI; run before committing infra changes
make sync-trusted-proxies      # patch HA configuration.yaml trusted_proxies + restart HA
make apply-grocy-migration     # POST migrations/grocy/*.json to HomeButler
make patch-eight-sleep-alarm-switch
```

HomeButler tests (run from the service directory — `conftest.py` puts that dir on `sys.path`):

```bash
cd services/homebutler
python3 -m pytest -q                        # 64 tests, ~2s
python3 -m pytest tests/test_ops_action_routes.py::test_run_action_ok -q
```

`pytest`, `httpx`, and `fastapi.testclient` are **not** in `requirements.txt` — that file is
runtime-only. Tests stub the `docker` SDK (`conftest.py::_install_docker_stub`) so they run without
a Docker daemon. There is no linter or formatter configured; match surrounding style.

Almost every command above only does something meaningful **on the NAS**. On a laptop, `make smoke`
and the pytest suite are what you can actually run.

## How config reaches Home Assistant

This is not obvious and gets it wrong easily:

- **`automations/*.yaml` are reference copies, not deployed.** The live automations live in HA's own
  `automations.yaml` and are written through the HA REST API. Editing a file here changes nothing
  until it is pushed to HA. Same for `dashboard.yaml` and `templates/`.
- **`packages/kasa_bridge.yaml` is mounted as a Compose `config`**, not a bind mount, landing at
  `/config/packages/kasa_bridge.yaml`. This is deliberate: Portainer Git stacks deploy from their own
  clone, so a relative bind mount can point at a path that isn't the checkout and HA silently never
  sees the file.
- **`packages/food_stack.yaml.template`** is rendered by `scripts/bootstrap.sh` into
  `$HA_CONFIG_PATH/packages/food_stack.yaml`, substituting `__HOMEBUTLER_PORT__`. It is not mounted;
  re-run bootstrap (or copy it manually) after editing.
- Packages require `homeassistant: packages: !include_dir_named packages` in `configuration.yaml`;
  `bootstrap.sh::ensure_packages_include` adds it.
- `HA_CONFIG_PATH` (`/volume1/media/config/homeassistant-config`) is a host bind mount holding all
  persistent HA state. Grocy and Mosquitto data live as siblings via `${HA_CONFIG_PATH}/../`.

## Deployment model

The stack is deployed as a **Portainer Git stack** pointed at this repo (`docs/portainer-stack-migration.md`).
`name: homeassistant` is pinned at the top of `docker-compose.yaml` so Compose converges on the
existing containers instead of spawning a duplicate project. Portainer itself lives outside this
stack so redeploying HA doesn't kill the UI driving it. `make up` on the NAS is the manual fallback.

Networks are pinned to fixed CIDRs (`PROXY_SUBNET` 172.31.240.0/24, `AUTOMATION_SUBNET` 172.31.241.0/24)
so `http.trusted_proxies` can trust a stable subnet rather than a churning container IP:

- `proxy` — homeassistant, grocy, ha-cloudflared (tunnel routes direct to container names)
- `automation` — homeassistant, grocy, homebutler, mosquitto, govee2mqtt

Cloudflared routes to `homeassistant:8123` and `grocy:80` by service name, resolved from inside the
tunnel container — never NAS localhost. If HA still logs untrusted-proxy warnings (Synology can
surface host-side IPs), `scripts/sync_trusted_proxies.py` reconciles the list from the env subnet,
host LAN IP, HA logs, and the live container IP.

## HomeButler (`services/homebutler/`)

FastAPI service that is the local control plane. Bound to `127.0.0.1:8000`; HA reaches it at
`http://homebutler:8000` over the `automation` network.

**Do not widen `HOMEBUTLER_BIND_IP`.** There is no auth on the control routes and `docker.sock` is
mounted, so exposing the port is root-equivalent access to the NAS for anything on the WiFi — which
includes the IoT devices on that subnet. Neo does not need it: HA bridges to HomeButler internally
via the `rest_command` + `script` entities in `packages/food_stack.yaml.template`. Adding direct LAN
access is a change that requires authentication on `/ops/*` first, not just a narrower bind IP.

Layers: `api/routes/` (system, shopping, ops, migration) → `registry/` → `clients/` + `services/`.

Non-negotiable invariants, enforced at import time and covered by tests:

- The **registry is source code**, not config. `registry/stacks.py` (stack → service → container for
  `homeassistant`, `mediaserver`, `morpheus`, `tor`) and `registry/actions.py` (allowlisted
  `make`/`docker compose` invocations) are frozen dataclasses validated on import, so a bad entry
  fails startup rather than a request.
- **No shell, ever.** `services/command_runner.py` uses `subprocess.run(argv, shell=False)` with a
  scratch-built env allowlist and a mandatory timeout. No request input reaches argv, cwd, targets,
  or env. `RunActionRequest` is `extra="forbid"` and empty — v1 actions take no parameters.
- `HOMEBUTLER_CONTROLLED_CONTAINERS` is **additive only**; it can extend the registry allowlist,
  never shrink it.
- Actions degrade visibly: a missing repo mount or executable yields `available: false` with a
  reason, never a silent failure or a 404.
- `/ops/containers*` is the legacy flat view, kept for compatibility. Prefer `/ops/stacks*`.
- `HOMEBUTLER_ACTIONS_ENABLED=false` is the kill switch for `/ops/actions*`.

Full rationale in `services/homebutler/docs/control-plane-design.md`. Grocy migrations are
declarative, name-referenced bundles applied idempotently via `POST /migration/grocy/apply`
(`migrations/grocy/*.json`); direct Grocy writes from Neo are intentionally blocked.

## Automation conventions

See `automations/README.md` for the per-automation index; it is the file to update when adding one.

- **Notification policy:** phone notifications are reserved for actionable alerts — safety/security,
  low battery, doors left open, offline devices, failed maintenance. Everything else uses
  `logbook.log` so it lands in the Logbook and traces without pinging phones. Welcome Home is the
  one deliberate exception. Recent commits converted many automations from `notify.*` to
  `logbook.log`; don't reintroduce notifications for success/debug events.
- Actionable notifications go to both people: `notify.mobile_app_pranav_s_pocket_tv` and
  `notify.mobile_app_iphone_14_pro`.
- Automation ids are prefixed `neo_` (they were created by Neo through the HA REST API).
- Movie mode (TV/projector on) respects a sunset threshold rather than a fixed time.
- Presence-dependent automations use `time_pattern` polling (30 min) instead of state triggers —
  state triggers proved unreliable here; the vacuum automation went through five revisions to land
  on this.
- Dreo fan/heater follows Eight Sleep state directly and picks its mode from room temperature (not
  the month), and ignores `unavailable → off` transitions.
- Guard templates against `unknown`/`unavailable`, not just the happy-path state (see
  `arlo_sync_presence_mode.yaml`).
- HA can't resolve mDNS `.local` names from the bridge networks — always use the NAS LAN IP
  (`10.0.0.116`) for host-networked services like Kasa Bridge.

## Secrets

`.env` and `.mcp.json` are gitignored and must stay that way — the repo is public, and Portainer
deploys from its own clone using stack environment variables, not the NAS-local `.env`. Cloudflare
tunnel tokens, MQTT/Govee credentials, Grocy API keys, and the Slack bot token in `.mcp.json` never
belong in a commit. `command_runner.py` redacts known secret values from captured output.

## Household context

- Household is Pranav and Abhinaya. Dashboard is named "Agraharam" (Mushroom cards from HACS,
  sections view). **This repo is public — keep the street address, precise coordinates, and any
  other locating detail out of it.** HA already knows the home location from its own
  `configuration.yaml` on the NAS, which is not in git.
- **Kanta Bai** — primary robot vacuum (runs when away). **Shanta Bai** — secondary, own schedule,
  daily 6pm maintenance check.
- Tesla Model 3 LR 2020 (Pranav; never charges past 80%), Toyota GR86 2024 (Abhinaya). Charge cost
  uses PG&E EV2-A TOU rates.
- Integrations: Hue, Roborock, Google Nest, LG ThinQ, SwitchBot, Tesla Fleet, Eight Sleep (HACS, not
  native), Dreo, Govee (via govee2mqtt + Mosquitto), Arlo, Apple TV, Canon IPP, Chromecast, Kasa
  Bridge. Garage is `cover.ratgdo_garage_door` (Konnected blaQ pending). Levoit/VeSync pending.
- Tesla Fleet needs its public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem`, served
  by a Cloudflare Worker (`tesla-public-key`) because HA won't serve `/.well-known/`.
- The food stack (Grocy + HomeButler + Neo) is documented in `FOOD_SYSTEM.md`. HA MCP runs with Neo
  on the Mac mini; SSH to the NAS is intentionally closed, which is why HomeButler exists.
