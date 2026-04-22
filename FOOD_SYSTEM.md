# Food System Architecture

This document defines the full food-decision stack for the house.

## Goal

Pranav should not have to manually decide what to eat.

The system should:
- decide whether to cook or order out
- use pantry and shopping data from Grocy
- expose voice-friendly entry points through Google Home via Home Assistant
- let Neo do the reasoning
- use HomeButler as the ops/control layer for the underlying stack

## Layers

### 1. Grocy, household food data
Owns:
- pantry inventory
- stock levels
- shopping list
- products and ingredients
- meal plan state

Runs in this repo's Docker Compose stack on the NAS.

### 2. Home Assistant, orchestration and voice bridge
Owns:
- Google Home integration
- scripts and automations
- dashboards and helpers
- user-facing controls
- webhook or REST calls to Neo
- optional announcements to Nest speakers / phones

### 3. Neo / OpenClaw, reasoning engine
Owns:
- deciding what to eat
- evaluating pantry vs effort vs budget vs health mode
- avoiding repeats
- falling back to restaurant search
- deciding when Grocy or HomeButler data means the local path is broken

Neo runs on the Mac mini.

### 4. Google Places API, restaurant discovery
Owns:
- nearby restaurant search
- open-now filtering
- rating / distance / cuisine metadata

### 5. HomeButler, infra control layer
Owns:
- NAS and homelab operational control
- Docker status, logs, restarts, alerts
- service health around Grocy / Home Assistant / related stack pieces

Because NAS SSH is intentionally closed, HomeButler should live locally on the NAS side of the stack. In this repo, that means a local internal service running alongside Home Assistant and Grocy.

HomeButler is not the meal planner. It is the control plane used for local NAS intervention when the stack itself needs help.

## Direction of calls

### HA -> Neo
Home Assistant should call Neo through a dedicated bridge, not through MCP.

Reason:
- MCP is best for Neo calling tools
- Home Assistant needs a stable HTTP-style integration point
- HA automations and voice flows are much easier to manage through webhook / REST interfaces

Recommended design:
- run a small `neo-ha-bridge` service on the Mac mini next to OpenClaw
- expose authenticated webhook endpoints such as:
  - `/decide-meal`
  - `/restaurant-fallback`
  - `/shopping-sync`
  - `/announce-food-plan`
- the bridge converts HA requests into `openclaw system event` calls or direct gateway event injection for Neo
- Neo returns a compact JSON response for HA to speak, display, or act on

### Neo -> HA
Neo should use Home Assistant through an HA-native tool path:
- HA MCP when practical for tool-style reads/actions
- HA REST API or long-lived token for deterministic service calls and state reads

The intended split:
- HA asks Neo for reasoning
- Neo asks HA for action/state when needed

### HA -> HomeButler (local on NAS)
Since SSH is closed on the NAS, Home Assistant should broker HomeButler actions locally.

Recommended design:
- run HomeButler as an internal local service in this stack
- bind it to localhost only
- expose a curated set of HomeButler operations through Home Assistant REST commands and scripts
- keep these operations narrow and explicit, for example:
  - check Grocy status
  - inspect logs for a failed container
  - restart Grocy
  - check Home Assistant container health

### Neo -> HomeButler
Neo reaches HomeButler through Home Assistant, not over SSH.

Flow:
- Neo uses HA MCP
- HA invokes local HomeButler-backed REST commands on the NAS
- results come back through HA entities, script responses, or notifications

This keeps SSH closed and avoids exposing another remote control surface.

## Full runtime topology

- NAS:
  - Home Assistant
  - Grocy
  - HomeButler (internal API/control service)
  - Mosquitto
  - govee2mqtt
  - cloudflared
- Mac mini:
  - OpenClaw / Neo
  - HA MCP
  - neo-ha-bridge

## Main flows

### Decide what to eat
1. User asks Google Home or taps Home Assistant UI
2. Home Assistant calls `neo-ha-bridge /decide-meal`
3. Neo evaluates:
   - Grocy pantry and missing items
   - expiring items
   - time of day
   - effort mode
   - budget mode
   - health mode
   - recent meal history
4. Neo returns:
   - primary recommendation
   - two backups
   - explanation
   - whether to cook or order out
5. Home Assistant announces and displays the result

### Restaurant fallback
1. Neo determines local cooking is a poor fit
2. Neo queries Google Places
3. Neo ranks options against preferences
4. HA presents the best result and backups

### Shopping sync
1. Neo chooses a meal
2. Missing ingredients are derived from Grocy
3. HA adds missing items to Grocy shopping list
4. HA can announce the delta

### Incident handling
1. HA or Neo detects Grocy / service failure
2. Neo calls Home Assistant through HA MCP
3. Home Assistant invokes local HomeButler operations on the NAS
4. HomeButler inspects container health and logs
5. Neo can report the issue or recover automatically if policy allows

## Home Assistant entities to add

### Helpers
- `input_select.food_mode` (`auto`, `cook`, `order`)
- `input_boolean.low_effort_food`
- `input_boolean.use_expiring_items_first`
- `input_select.health_mode` (`normal`, `healthy`, `comfort`)
- `input_select.budget_mode` (`cheap`, `normal`, `whatever`)
- `input_number.restaurant_radius_miles`

### Scripts
- `script.decide_dinner`
- `script.order_out_recommendation`
- `script.add_missing_ingredients_to_grocy`
- `script.announce_tonights_food_plan`

### Sensors
- `sensor.tonight_food_decision`
- `sensor.tonight_food_reason`
- `sensor.grocy_expiring_items_count`
- `sensor.grocy_missing_ingredients_count`
- `sensor.restaurant_fallback_choice`

## Why this is the full implementation path

This keeps responsibilities clean:
- Grocy stores food state
- Home Assistant orchestrates the home and voice layer
- Neo does the reasoning
- Google Places handles local restaurant discovery
- HomeButler handles infra control locally on the NAS
- HA MCP gives Neo a clean tool path into Home Assistant
- the existing HA Cloudflare tunnel can be reused instead of introducing a separate tunnel stack

That gives Pranav one coherent system instead of forcing Home Assistant, Grocy, or HomeButler to do jobs they are not actually best at.
