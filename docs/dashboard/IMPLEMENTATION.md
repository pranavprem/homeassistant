# Implementation and integration contract

## Architecture

Recommended: a TypeScript/Lit custom element, registered as
`custom:agraharam-dashboard`, mounted as the **one card in a Lovelace panel view**.
Own the entire inner layout with HTML/CSS; don't assemble the design by overriding
the shadow DOM of dozens of third-party cards. HA supplies the authenticated host,
navigation and runtime data. This is a custom frontend inside HA, not a separate
website needing a second login. [Custom card API](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/),
[panel-view contract](https://www.home-assistant.io/dashboards/panel/).

Suggested layout (to be created by the implementer):

```text
frontend/agraharam/
  package.json / package-lock.json / tsconfig.json / vite.config.ts
  src/agraharam-dashboard.ts
  src/components/                 # header, weather, comfort, home, cameras, etc.
  src/styles/                    # tokens, layout, typography
  src/ha/                        # host adapter, binding validation, action gateway
  src/demo/                      # fictional fixtures and disconnected preview host
  public/                        # licensed generic assets ONLY
  tests/                         # adapter/control/component checks
  e2e/                           # fictional-data browser verification
  install/                       # generic Lovelace/resource YAML and install guide
  README.md
```

Use a single bundled ES module or a reliably versioned asset tree; resolve fonts
and assets relative to the module, not the current dashboard route. Pin the
toolchain via a lockfile and document the supported Node version. No runtime
external script imports, new container, backend API, or HomeButler modifications
are needed for this design.

### HA compatibility

Implement `setConfig` and the component lifecycle correctly; receive `hass` from
the host, don't scrape `document.querySelector('home-assistant')` for credentials.
Check the installed HA version and the current documented API before depending
on newer contexts. The current docs also describe Lit contexts for narrower data
subscriptions; don't bundle imports from unpublished HA frontend internals.
[Frontend data and methods](https://developers.home-assistant.io/docs/frontend/data/).

Keep this uncertainty behind one adapter rather than sprinkling `any` and private
HA APIs throughout the UI. If rendering a native HA camera card via available card
helpers, feature-detect that path, forward the host data, and provide a useful
fallback if helpers aren't available. Verify on the installed HA, not just a mock.

## Data and binding model

Use semantic roles (weather, primary climate, primary vacuum, garage, alarm state,
security actions, cameras, room lights) mapped to entity IDs in card configuration.
The ignored `.dashboard-local/` folder provides household-specific candidates
and provenance. Public examples use fictional `*.demo_*` entities.

Resolve each configured binding against the live host's entity state and supported
features. An ID in an old YAML file is only a candidate. Never guess an integration
or silently substitute another device when an entity is missing. Optional module
absence is different from an existing device going unavailable.

The adapter should expose:

- connection/auth status and locale/unit/time-zone formatting;
- selected entity reads and subscriptions, with cleanup on disconnect/unmount;
- explicit user-initiated, allowlisted actions;
- read-only forecast subscriptions and supported calendar reads;
- privacy-aware authenticated camera presentation, with resource cleanup.

Use host state updates rather than polling `/api/states` every second. Deduplicate
subscriptions across cards, avoid rerendering the whole dashboard for every unrelated
entity update, and reconcile current state after reconnect. Do not queue/replay
device actions while offline. Stop camera/forecast work when the component is hidden
or destroyed, as appropriate.

Entity `last_changed` is not a heartbeat: a door can be closed for weeks without
being stale. Only apply freshness rules to telemetry with a documented expected
cadence. Format unknown/missing numeric values as unavailable, not `0` or `NaN`.

Weather forecasts are not guaranteed to be an entity's `forecast` attribute. Use
the supported forecast API/subscription and negotiate hourly/daily capability.
Clean up subscriptions and display a daily/no-forecast fallback honestly.
[Weather developer contract](https://developers.home-assistant.io/docs/core/entity/weather/).

## Actions and security semantics

Every mutation belongs in one action gateway. Verify service availability, binding
domain, capability and required arguments before sending. Debounce/deduplicate
taps, show pending/error/timeout, and observe the resulting state. A fulfilled
service promise is not physical confirmation. Treat timeouts as uncertain outcomes,
not permission to blindly repeat a command.

- Lighting: explicit scoped entity/group targets, supported brightness/color controls.
- Climate/fans: supported modes, units, temperature ranges and step sizes.
- Media: show only supported transport/volume/source actions.
- Vacuum: only supported start/pause/return actions; never rewrite scheduling.
- Garage: explicit open/close with confirmation, never an ambiguous toggle.
  Existing trusted-departure preparation is separate from moving the door.
- Security: invoke only the mapped **existing guarded scripts**, never raw
  `alarm_control_panel.alarm_*`, helper writes, automation toggles, or re-created
  policy logic. Confirm actions that disarm/arm/change a hold; do not relabel a
  persistent disarm script as sound-only silence.
- Studio monitor grouping: use the existing grouped script; don't toggle outlets
  independently because mixed states can swap rather than converge.

Keep alarm state, selected policy, suggested mode, commissioning, health and
coverage separate. "Auto" is not "Armed". A live camera picture is not a verified
intrusion path. Health text is not proof of complete coverage. Detailed household
semantics are in the private handoff. Do not alter these rules during UI work.

No service calls from component initialization, route changes, passive subscriptions,
demo mode or reconnect. Raw security more-info controls must not bypass the guarded
script boundary. Do not include commissioning/walk-test controls on the normal home
screen, and never trigger a test to see whether a UI button works.

## Authentication, cameras and privacy

Use HA's injected session and methods; don't require a browser-stored long-lived
token. Demo mode uses no live connection. Runtime entity bindings belong in
authenticated dashboard configuration, not a compiled household JSON in `public/`.

`/config/www` maps to `/local` and static files there are accessible without HA
authentication. Only generic JS/CSS/fonts/icons may go there. **Never** put camera
snapshots, recordings, household inventory, live fixtures, credentials, or calendar
exports under that path. [HA resource hosting](https://developers.home-assistant.io/docs/frontend/custom-ui/registering-resources/).

Camera URLs, access tokens and signed media paths must not be logged or persisted.
Use supported HA camera/media presentation with transient authorization; where a
camera path needs a short-lived capability URL, keep it transient and redact it
from diagnostics. This is not permission to bake a long-lived token into a URL.
Do not turn privacy off to obtain a picture. Default to a private/offline tile when
state is uncertain; stream only on demand and release streams when dismissed.

## Deployment: source is not installation

Facts from this repository's deployment contract:

- HA runs as a container on a NAS; it is not HA OS with Supervisor add-ons.
- Persistent state is bound from `${HA_CONFIG_PATH}` to `/config`.
- Portainer deploys the Git stack from its own checkout. A laptop worktree does
  not appear automatically inside HA. A public branch push does not install assets.
- `automations/*.yaml`, `dashboard.yaml` and `templates/` are reference files.
- Existing Compose configs are used for selected packages; don't add a naive
  relative bind mount assuming Portainer sees the developer's checkout.
- Keep HomeButler loopback/internal-only; it has privileged control capabilities.
  It is not a new frontend proxy or file-upload endpoint.
- `make up`, bootstrap and proxy-sync can change/restart HA. They are not frontend
  preview commands. NAS SSH access must not be assumed.

Produce these reviewable artifacts before live installation:

1. Reproducible local build, versioned asset directory and checksum manifest.
2. A local/NAS install helper that defaults to dry-run, takes an explicit destination,
   copies only allowlisted build assets, preserves earlier versions, and never
   restarts HA or rewrites whole configuration files as a side effect.
3. A generic resource declaration with one module URL, and a **separate new**
   storage-mode dashboard configuration using the custom card in a panel view.
4. A private runtime binding config, excluded from the public asset bundle.
5. Exact install/readback steps for an authorized NAS/container transfer channel.
   Do not invent REST file-upload access: normal HA REST services cannot install JS.

Resource example (template; no build exists yet):

```yaml
# Register once in the appropriate Lovelace resources store, not in every view.
url: /local/agraharam/RELEASE/agraharam.js
type: module
```

Dashboard shape (fictional bindings):

```yaml
title: Agraharam Preview
views:
  - title: Home
    path: home
    type: panel
    cards:
      - type: custom:agraharam-dashboard
        demo: false
        entities:
          weather: weather.demo_home
          garage: cover.demo_garage
```

The implementer must define/validate the final configuration schema; don't claim
this provisional example is already runnable. Configure the dashboard URL as
`agraharam-next` separately from its view path `home`. Preserve existing routes,
sidebar entries and the user's default dashboard. If the route already exists,
inspect it rather than overwrite it.

Before a live save, retrieve/back up the latest resource list and relevant dashboard
config privately. Merge only the intended new objects. Avoid duplicate resource
loading. Read back configuration, then verify the rendered result in HA and the
browser console. If `www` is newly created and HA needs a restart, report that exact
requirement and arrange it separately; never restart a protected home for a UI test.

Rollback: remove only the new dashboard/resource registration or point it back to
the previous version; retain older assets until no clients reference them. Existing
dashboards and security logic remain untouched. No bulk configuration restore.

## Sources

Official docs consulted 2026-10-03; installed-version compatibility still needs
verification. These describe mechanisms, not the observed state of this home.

- [Custom card API](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/)
- [Frontend data](https://developers.home-assistant.io/docs/frontend/data/)
- [Panel view](https://www.home-assistant.io/dashboards/panel/)
- [Resource registration and static hosting](https://developers.home-assistant.io/docs/frontend/custom-ui/registering-resources/)
- [Weather entity/forecasts](https://developers.home-assistant.io/docs/core/entity/weather/)
- [WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
- [Alternative custom panels](https://developers.home-assistant.io/docs/frontend/custom-ui/creating-custom-panels/)

The last option is an alternative only if the card/panel-view approach has a
demonstrated limitation; it has different registration/installation requirements.
