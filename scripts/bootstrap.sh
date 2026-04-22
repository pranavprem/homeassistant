#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Error: docker compose is required." >&2
  exit 1
fi

for bin in curl awk grep sed mktemp python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Error: missing required command: $bin" >&2
    exit 1
  fi
done

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/example.env"
PACKAGE_TEMPLATE="$ROOT_DIR/packages/food_stack.yaml.template"

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
fi

get_env() {
  local key="$1"
  local file="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' "$file"
}

set_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print key "=" value
      }
    }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

trim() {
  local value="$1"
  value="${value#${value%%[![:space:]]*}}"
  value="${value%${value##*[![:space:]]}}"
  printf '%s' "$value"
}

prompt() {
  local env_name="$1"
  local label="$2"
  local default_value="$3"
  local current_override="${!env_name:-}"
  local input=""

  if [ -n "$current_override" ]; then
    printf '%s' "$current_override"
    return 0
  fi

  if [ -n "$default_value" ]; then
    read -r -p "$label [$default_value]: " input
  else
    read -r -p "$label: " input
  fi

  input="$(trim "$input")"
  if [ -n "$input" ]; then
    printf '%s' "$input"
  else
    printf '%s' "$default_value"
  fi
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
}

create_grocy_api_key() {
  local username="$1"
  local password="$2"
  local description="$3"
  local grocy_port="$4"
  local cookie headers html location key description_query

  cookie="$(mktemp)"
  headers="$(mktemp)"
  html="$(mktemp)"
  trap 'rm -f "$cookie" "$headers" "$html"' RETURN

  curl -fsS -c "$cookie" -b "$cookie" "http://127.0.0.1:${grocy_port}/login" >/dev/null

  curl -sS -D "$headers" -o /dev/null -c "$cookie" -b "$cookie" \
    -X POST "http://127.0.0.1:${grocy_port}/login" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "username=${username}" \
    --data-urlencode "password=${password}"

  location="$(awk 'tolower($1) == "location:" { print $2 }' "$headers" | tr -d '\r' | tail -n 1)"
  if ! printf '%s' "$location" | grep -Eq '/$|/stockoverview|/manageapikeys'; then
    return 1
  fi

  description_query="${description// /%20}"
  curl -fsS -L -c "$cookie" -b "$cookie" \
    "http://127.0.0.1:${grocy_port}/manageapikeys/new?description=${description_query}" > "$html"

  key="$(grep -o 'data-apikey-key="[^"]*"' "$html" | tail -n 1 | sed 's/^data-apikey-key="//; s/"$//')"
  if [ -z "$key" ]; then
    return 1
  fi

  printf '%s' "$key"
}

autodetect_tz() {
  if [ -n "${TZ:-}" ]; then
    printf '%s' "$TZ"
    return 0
  fi

  if [ -f /etc/timezone ]; then
    cat /etc/timezone
    return 0
  fi

  if [ -L /etc/localtime ]; then
    readlink /etc/localtime | sed 's#^.*/zoneinfo/##'
    return 0
  fi

  printf 'America/Los_Angeles'
}

ensure_packages_include() {
  local config_file="$1"
  if [ ! -f "$config_file" ]; then
    cat > "$config_file" <<'EOF'
homeassistant:
  packages: !include_dir_named packages
EOF
    return 0
  fi

  if grep -q 'packages: !include_dir_named packages' "$config_file"; then
    return 0
  fi

  python3 - "$config_file" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
if 'packages: !include_dir_named packages' in text:
    raise SystemExit(0)
lines = text.splitlines()
out = []
inserted = False
for i, line in enumerate(lines):
    out.append(line)
    if not inserted and line.strip() == 'homeassistant:':
        out.append('  packages: !include_dir_named packages')
        inserted = True
if not inserted:
    if out and out[-1].strip():
        out.append('')
    out.extend(['homeassistant:', '  packages: !include_dir_named packages'])
path.write_text('\n'.join(out) + '\n')
PY
}

render_package() {
  local dest="$1"
  local homebutler_port="$2"
  python3 - "$PACKAGE_TEMPLATE" "$dest" "$homebutler_port" <<'PY'
from pathlib import Path
import sys
src = Path(sys.argv[1])
dest = Path(sys.argv[2])
homebutler_port = sys.argv[3]
text = src.read_text()
text = text.replace('__HOMEBUTLER_PORT__', homebutler_port)
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(text)
PY
}

CURRENT_UID="$(id -u 2>/dev/null || printf '1000')"
CURRENT_GID="$(id -g 2>/dev/null || printf '1000')"
CURRENT_TZ="$(autodetect_tz)"

DEFAULT_HA_CONFIG_PATH="$(get_env HA_CONFIG_PATH "$ENV_FILE")"
DEFAULT_PUID="$(get_env PUID "$ENV_FILE")"
DEFAULT_PGID="$(get_env PGID "$ENV_FILE")"
DEFAULT_TZ="$(get_env TZ "$ENV_FILE")"
DEFAULT_GROCY_PORT="$(get_env GROCY_PORT "$ENV_FILE")"
DEFAULT_HOMEBUTLER_PORT="$(get_env HOMEBUTLER_PORT "$ENV_FILE")"
DEFAULT_HOMEASSISTANT_PORT="$(get_env HOMEASSISTANT_PORT "$ENV_FILE")"
DEFAULT_KEY="$(get_env GROCY_API_KEY "$ENV_FILE")"
DEFAULT_CLOUDFLARE_TOKEN="$(get_env CLOUDFLARED_TOKEN "$ENV_FILE")"

DEFAULT_HA_CONFIG_PATH="${DEFAULT_HA_CONFIG_PATH:-/volume1/media/config/homeassistant-config}"
DEFAULT_PUID="${DEFAULT_PUID:-$CURRENT_UID}"
DEFAULT_PGID="${DEFAULT_PGID:-$CURRENT_GID}"
DEFAULT_TZ="${DEFAULT_TZ:-$CURRENT_TZ}"
DEFAULT_GROCY_PORT="${DEFAULT_GROCY_PORT:-9283}"
DEFAULT_HOMEBUTLER_PORT="${DEFAULT_HOMEBUTLER_PORT:-8000}"
DEFAULT_HOMEASSISTANT_PORT="${DEFAULT_HOMEASSISTANT_PORT:-8123}"

cat <<EOF
Home Assistant food-stack bootstrap

This target will:
- create or update .env
- start Grocy and the local HomeButler service inside this stack
- trigger Grocy's first-run database init
- create a Grocy API key for HomeButler when needed
- install the Home Assistant package scaffold for food + HomeButler controls
- reuse the existing HA Cloudflare tunnel if it is already configured

If you need help finding values:
- HA config path: current NAS Home Assistant config directory
- PUID: run 'id -u'
- PGID: run 'id -g'
- Timezone: run 'cat /etc/timezone' or 'timedatectl'
EOF

echo
HA_CONFIG_PATH_VALUE="$(prompt HB_BOOTSTRAP_HA_CONFIG_PATH "Home Assistant config path" "$DEFAULT_HA_CONFIG_PATH")"
PUID="$(prompt HB_BOOTSTRAP_PUID "PUID for Docker volume ownership" "$DEFAULT_PUID")"
PGID="$(prompt HB_BOOTSTRAP_PGID "PGID for Docker volume ownership" "$DEFAULT_PGID")"
TZ_VALUE="$(prompt HB_BOOTSTRAP_TZ "Timezone" "$DEFAULT_TZ")"
GROCY_PORT_VALUE="$(prompt HB_BOOTSTRAP_GROCY_PORT "Grocy host port" "$DEFAULT_GROCY_PORT")"
HOMEBUTLER_PORT_VALUE="$(prompt HB_BOOTSTRAP_HOMEBUTLER_PORT "HomeButler local port" "$DEFAULT_HOMEBUTLER_PORT")"

set_env HA_CONFIG_PATH "$HA_CONFIG_PATH_VALUE" "$ENV_FILE"
set_env TZ "$TZ_VALUE" "$ENV_FILE"
set_env PUID "$PUID" "$ENV_FILE"
set_env PGID "$PGID" "$ENV_FILE"
set_env HOMEASSISTANT_PORT "$DEFAULT_HOMEASSISTANT_PORT" "$ENV_FILE"
set_env GROCY_PORT "$GROCY_PORT_VALUE" "$ENV_FILE"
set_env HOMEBUTLER_PORT "$HOMEBUTLER_PORT_VALUE" "$ENV_FILE"
set_env HOMEBUTLER_ENV "production" "$ENV_FILE"
set_env HOMEBUTLER_LOG_LEVEL "info" "$ENV_FILE"
set_env HOMEBUTLER_CONTROLLED_CONTAINERS "grocy,homeassistant,ha-cloudflared,mosquitto,govee2mqtt,homebutler" "$ENV_FILE"
set_env GROCY_BASE_URL "http://grocy" "$ENV_FILE"
set_env GROCY_TIMEOUT_SECONDS "10" "$ENV_FILE"
set_env GROCY_VERIFY_SSL "false" "$ENV_FILE"

mkdir -p \
  "$HA_CONFIG_PATH_VALUE" \
  "$HA_CONFIG_PATH_VALUE/packages" \
  "$HA_CONFIG_PATH_VALUE/../grocy" \
  "$HA_CONFIG_PATH_VALUE/../mosquitto/config" \
  "$HA_CONFIG_PATH_VALUE/../mosquitto/data" \
  "$HA_CONFIG_PATH_VALUE/../mosquitto/log"

"${COMPOSE[@]}" up -d --build homeassistant grocy homebutler mosquitto govee2mqtt
if [ -n "$DEFAULT_CLOUDFLARE_TOKEN" ]; then
  "${COMPOSE[@]}" up -d cloudflared
fi

wait_for_http "http://127.0.0.1:${GROCY_PORT_VALUE}/login" "Grocy login"
curl -fsS -L "http://127.0.0.1:${GROCY_PORT_VALUE}/" >/dev/null 2>/dev/null || true
wait_for_http "http://127.0.0.1:${HOMEBUTLER_PORT_VALUE}/health" "HomeButler health"

EXISTING_API_KEY="$(get_env GROCY_API_KEY "$ENV_FILE")"
if [ -z "$EXISTING_API_KEY" ]; then
  echo
  echo "No GROCY_API_KEY found in .env, generating one for HomeButler..."

  ADMIN_USER="admin"
  ADMIN_PASS="admin"
  GENERATED_KEY=""

  for _ in 1 2 3; do
    if GENERATED_KEY="$(create_grocy_api_key "$ADMIN_USER" "$ADMIN_PASS" "HomeAssistant bootstrap" "$GROCY_PORT_VALUE" 2>/dev/null)"; then
      break
    fi
    sleep 2
  done

  if [ -z "$GENERATED_KEY" ]; then
    echo "Default admin/admin did not work. If this is not a brand-new Grocy install, enter a Grocy admin account now."
    ADMIN_USER="$(prompt HB_BOOTSTRAP_GROCY_ADMIN_USER "Grocy admin username" "admin")"
    read -r -s -p "Grocy admin password: " ADMIN_PASS
    echo
    GENERATED_KEY="$(create_grocy_api_key "$ADMIN_USER" "$ADMIN_PASS" "HomeAssistant bootstrap" "$GROCY_PORT_VALUE")"
  fi

  set_env GROCY_API_KEY "$GENERATED_KEY" "$ENV_FILE"
  "${COMPOSE[@]}" up -d --build homebutler >/dev/null
fi

wait_for_http "http://127.0.0.1:${HOMEBUTLER_PORT_VALUE}/health" "HomeButler health" 60
SHOPPING_STATUS="$(curl -fsS "http://127.0.0.1:${HOMEBUTLER_PORT_VALUE}/shopping")"
if ! printf '%s' "$SHOPPING_STATUS" | grep -q '"status":"ready"'; then
  echo "HomeButler came up, but Grocy shopping sync is not ready yet:" >&2
  echo "$SHOPPING_STATUS" >&2
  exit 1
fi

render_package "$HA_CONFIG_PATH_VALUE/packages/food_stack.yaml" "$HOMEBUTLER_PORT_VALUE"
ensure_packages_include "$HA_CONFIG_PATH_VALUE/configuration.yaml"

echo
echo "Bootstrap complete."
echo "- Home Assistant: http://localhost:${DEFAULT_HOMEASSISTANT_PORT}"
echo "- Grocy: http://localhost:${GROCY_PORT_VALUE}"
echo "- HomeButler: http://127.0.0.1:${HOMEBUTLER_PORT_VALUE}"
echo "- HA package installed: $HA_CONFIG_PATH_VALUE/packages/food_stack.yaml"
if [ -n "$DEFAULT_CLOUDFLARE_TOKEN" ]; then
  echo "- Existing Cloudflare tunnel is configured. Recommended routes:"
  echo "  - home.pranavprem.com  -> http://homeassistant:8123"
  echo "  - grocy.pranavprem.com -> http://grocy:80"
fi

echo
echo "Recommended next steps:"
echo "1. Sign into Grocy and change the admin password if this was a fresh install."
echo "2. Restart Home Assistant or reload configuration so the package is picked up."
echo "3. If your HA MQTT integration was pointed at localhost before, change it to host 'mosquitto'."
echo "4. Keep HomeButler internal. Reuse the HA tunnel only for Grocy or HA surfaces you actually want exposed."
