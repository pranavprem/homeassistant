# 🏠 Home Assistant Stack

Home Assistant deployment on UGREEN NAS with dedicated Cloudflare tunnel.

**URL:** [home.pranavprem.com](https://home.pranavprem.com)

## Architecture

```
Internet → Cloudflare Tunnel → ha-cloudflared → localhost:8123 → Home Assistant
```

Both containers run with `network_mode: host` so cloudflared can reach HA on localhost. This also allows HA to discover local IoT devices via mDNS/SSDP/Bluetooth.

## Containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `homeassistant` | `ghcr.io/home-assistant/home-assistant:stable` | Smart home hub |
| `ha-cloudflared` | `cloudflare/cloudflared:latest` | Dedicated tunnel for external access |

## Setup

1. Copy `example.env` to `.env` and fill in values:
   ```bash
   cp example.env .env
   ```

2. Configure `.env`:
   - `HA_CONFIG_PATH` — path to HA config directory on NAS
   - `CLOUDFLARED_TOKEN` — token from dedicated Cloudflare tunnel

3. Deploy:
   ```bash
   docker compose up -d
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

## Cloudflare Tunnel

This stack uses its own dedicated tunnel (separate from the mediaserver tunnel).

- **Dashboard:** Cloudflare Zero Trust → Networks → Tunnels
- **Route:** `home.pranavprem.com` → `http://localhost:8123`

## Tesla Fleet API

Tesla integration requires a public key hosted at:
```
https://home.pranavprem.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

This is served via a **Cloudflare Worker** (`tesla-public-key`) on the `home.pranavprem.com` route, since HA doesn't natively serve `/.well-known/` paths.

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
| Govee | Light bar (H607C) | Cloud (needs govee2mqtt for LAN) |
| Apple TV | Media player | Local |
| Canon Printer | Printer | Local (IPP) |
| Chromecast | Projector | Local |

### Pending
- **Konnected blaQ** — garage door (hardware on order)
- **Govee LAN** — govee2mqtt + Mosquitto for local control
- **Non-Hue Philips light** — TBD

## Security

- `privileged: false` — no unnecessary host access
- `no-new-privileges: true` on all containers
- Cloudflare tunnel — no ports exposed on router
- HA has strong password + MFA enabled
- Tesla Fleet API scoped via OAuth

## Network

```
NAS (host network)
├── homeassistant (:8123)
└── ha-cloudflared (tunnel to Cloudflare)
```

All IoT devices on local WiFi are reachable via host networking. No VLANs currently.
