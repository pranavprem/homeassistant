# Agraharam dashboard: architecture (v1)

Status: revision 4, approved for implementation by the round-4 confirmation review (both lenses, no blocking
issues). §16.10 lists the lead's implementation addenda from that review. Date: 2026-10-03.
Baseline: HA core 2026.9.2, frontend 20260826.7 (lit 3.3.3, home-assistant-js-websocket 9.6.0).
Spot-checked against frontend 20260930.0 (2026.10 beta); the host contract files are unchanged.
Inputs: `docs/dashboard/{PROMPT,README,DESIGN,IMPLEMENTATION,ACCEPTANCE}.md`, the team lead's decisions and three
verified research reports. This repository is public. Every entity ID in this document is fictional (`*.demo_*`).

---

## 1. Problem, constraints, non-goals

### 1.1 Problem

The household needs a calm, composed control surface inside Home Assistant (HA) that matches the reference
dashboard's quality: cream surfaces, olive and brass accents, editorial type, three balanced columns. It must show
the household's real devices honestly, including missing, unavailable, private and offline states, and it must
never become an unsafe remote control for security, the garage or cameras.

### 1.2 Constraints

1. Runs **inside HA** as one custom Lovelace card (`custom:agraharam-dashboard`) in a panel view on a new
   storage-mode dashboard: `url_path: agraharam-next`, view `path: home`. Existing dashboards, resources and
   defaults are not modified.
2. No backend, no new container, no HomeButler change, no custom sidebar panel, no long-lived token, no runtime CDN.
3. Uses only the `hass` object HA passes to the card. Never reads `document.querySelector('home-assistant')`.
4. **Zero service calls** on mount, render, route change, reconnect, edit-mode preview, detach and re-attach,
   passive subscription and in demo mode. Reads (states, forecast subscription, camera snapshots, calendar GETs)
   are allowed.
5. Every mutation goes through one action gateway, which applies an allowlist, capability checks, confirmation,
   dedupe and observed-state confirmation, and never queues, replays or sends a follow-up without a fresh gesture
   after an uncertain or failed outcome. Controls start **off** (`controls: false`, §4.1) and are enabled by the
   operator only after the read-only verification in §13.5.
5a. State is live only when it is current. After any reconnect, values stay "last known", controls stay paused
   and cameras stay closed until Home Assistant has delivered a fresh state snapshot (the resync barrier, §4.4).
6. Security actions call **only** existing guarded `script.*` entities via `script.turn_on`. Raw
   `alarm_control_panel.alarm_*`, helper writes and automation toggles are impossible by construction.
7. Static files under `/config/www` (served as `/local`) are **unauthenticated**. Only generic JS, fonts and
   licenses go there. Never camera images, household data or private configuration.
8. Deployment is a Portainer Git stack. A git push installs nothing. Assets reach HA only through an authorized
   file channel to the NAS's HA config directory.
9. Toolchain: Node 24 LTS, npm lockfile, TypeScript strict, Vite 8, Lit 3, Vitest, Playwright and axe.
10. Accessibility: 44 px targets, visible focus, trapped and restored dialog focus, text contrast of at least
    4.5:1, reduced motion respected, no horizontal scroll at 390 px.
11. Browser floor: Safari and iOS 16.4+, Chrome and Edge 108+, Firefox 110+. Native `<dialog>`, container
    queries, `dvh` and ES2022 output set this floor. `@starting-style` and `::backdrop` custom-property
    inheritance are progressive enhancements with literal fallbacks. The bundle contains no regex lookbehind, which
    is a parse-time `SyntaxError` for the whole module before Safari 16.4, and no ES2023 array-copy methods
    (`toSorted`, `toReversed`, `toSpliced`, `with`), which Chrome 108 and Firefox 110 lack. `tsconfig` uses
    `lib: ES2022` so `tsc` rejects them, and postbuild greps the bundle for both (§11.2, §11.5). Lit `css`
    templates never pass through a CSS transpiler, so a fitness test rejects native nesting (`&`), `:has(`,
    `color-mix(`, `light-dark(` and `subgrid` in `src/**`; raising the floor to allow one needs a recorded
    justification (§12.1 row 11). The wall tablet
    has not been chosen, so this floor is stated in `README.md` and checked by the WebKit e2e project (§12.2).

### 1.3 Non-goals (v1)

- Changing automations, security policy, camera privacy or detection, schedules, or the current armed/hold state.
- Commissioning or walk-test controls (never shown anywhere in this UI).
- Vehicle remote controls (climate, locks, trunk). Telemetry only.
- Media artwork. `entity_picture` for media players carries a non-rotating per-entity token, so v1 shows an icon.
- A visual card editor (`getConfigElement`). Configuration is YAML in the dashboard's raw editor.
- Photos on presence avatars (initials only), zone names, travel or location detail.
- Freshness or heartbeat rules built on `last_changed`.
- Using the `todo` shopping list.
- Offline action queues, automatic retries, browser-side policy logic.

---

## 2. Architecture overview

### 2.1 Component and data-flow diagram

```text
 Home Assistant frontend (authenticated session, owns the WebSocket)
 ┌───────────────────────────────────────────────────────────────────────────────────┐
 │ hui-panel-view ─► hui-card ─► <agraharam-dashboard>  (sets .hass on every update,  │
 │                                 setConfig(), .preview, .layout='panel')            │
 └──────────────────────────────────────┬────────────────────────────────────────────┘
                                        │ hass (new object identity on every update)
 ┌──────────────────────────────────────▼────────────────────────────────────────────┐
 │ agraharam-dashboard  (composition root, src/agraharam-dashboard.ts)                │
 │   setConfig ─► config/validate ─► ResolvedConfig | ConfigIssue[] (in-card error)  │
 │   demo? ── yes ─► DemoHost (fixtures, no network; real hass ignored except theme)  │
 │        └─ no ──► HassHost.update(hass)                                             │
 │                                                                                     │
 │   HostRuntime { reader: HostReader, port: ServicePort }                             │
 │        reader ───────────────► EntityStore (diff bound IDs by reference,            │
 │          │                       per-entity + meta fan-out)                         │
 │          │                         │ EntityController (ReactiveController)          │
 │          │                         ▼                                                │
 │          │   sections: agr-header, agr-today, agr-comfort, agr-home, agr-cameras,  │
 │          │             agr-garage, agr-media, agr-upcoming, agr-health              │
 │          │      │ pure selectors src/model/* ─► view models ─► leaf components     │
 │          │      │ forecast/camera/calendar reads via reader (controllers)          │
 │          │      ▼ user gesture                                                     │
 │          │   ActionGateway.evaluate()/request() ◄── agr-confirm-dialog (confirmed) │
 │          │      │ allowlist ► domain ► availability ► features ► service ► args    │
 │          │      ▼                                                                  │
 │          └── port.invoke() ─► live-socket check ─► hass.callService(d, s, data,      │
 │                (DemoHost port mutates fixtures)       target, false, false)          │
 │   agr-overlay-host: drawers and confirm dialogs (native <dialog>, top layer);      │
 │                     the root routes overlay events to it (sibling of the columns)  │
 └───────────────────────────────────────────────────────────────────────────────────┘
 Reads used:   hass.states/entities/services/connected/locale/config/themes/user,
               connection.connected (live socket getter, checked before every call),
               connection.addEventListener('ready' | 'disconnected') (once per connection, module-level
                 ResyncTracker: socket generation + post-reconnect snapshot barrier, §4.4),
               connection.subscribeMessage(weather/subscribe_forecast, {resubscribe:false}),
               fetchWithAuth('/api/camera_proxy/<id>?width&height') → Blob → object URL,
               window.loadCardHelpers() → picture-entity (camera_view: live) for live view,
               callApi('GET', 'calendars/<id>?<URLSearchParams>'), formatEntityState (feature-detected).
 Writes used:  hass.callService only, only from ServicePort.invoke, only called by ActionGateway.
```

### 2.2 Data flow per hass update

1. `hui-card` assigns `card.hass = hass`. The root's `hass` setter is a plain accessor, not a Lit reactive
   property, so the root does **not** re-render.
2. `HassHost.update(hass)` builds a `StoreSnapshot` (`hass.states`, `connected` and meta identity tokens) and calls
   `EntityStore.ingest`.
3. The store compares `next.states[id] !== prev.states[id]` **only for bound IDs**, so the cost is O(bound) at
   about 100 entities. Meta tokens are compared with `Object.is`. An identity-only hass update, such as HA's empty
   `_updateHass({})` after a brands token refresh, produces no notification.
4. Subscribers whose IDs or meta kinds changed get one callback each. Their `EntityController` calls
   `requestUpdate()`, and Lit batches the updates into a microtask.
5. A section re-renders by running its pure selector (`src/model/<section>.ts`) and passing view models to leaves.
   Camera tiles and live streams subscribe only to their camera and privacy entities.

### 2.3 Key decisions

| Decision | Choice | Alternatives considered | Why |
|---|---|---|---|
| Host integration | One Lit custom card in a panel view | Custom sidebar panel; separate site | Reuses HA auth and navigation; no restart or backend; brief recommends it |
| Data feed | `hass` setter + reference diff | HA Lit contexts (`'states'`, `'hassConnection'`) | `hass` is pushed through 2026.10 beta; only `'states'` is a documented context key. The adapter isolates a future switch |
| Context sharing inside the card | Property drilling of one `DashboardServices` object | `@lit/context` | Depth is 2 (root → section). Avoids a dependency and any key collisions with HA's string context keys |
| Overlays | Native `<dialog>` + `showModal()` in one overlay host | Fixed-position divs | Top layer is immune to ancestor `transform`/`contain`; built-in inertness and Escape handling; survives layout changes. Detach closes every overlay (§5.4 rule 11) because a detached modal dialog loses modality |
| Camera stills | `fetchWithAuth` → Blob → object URL | `auth/sign_path` URL in `<img src>` | Stills never put a capability URL in the DOM, diagnostics or history. `fetchWithAuth` refreshes the access token itself. Default 10 s visible-only cadence as in HA, configurable per camera. A 401 on any camera stops every camera fetch until reconnect or a user change (§9.3), so `http.ban` sees at most one attempt. (HA's native stream element used for live view does use short-lived token URLs internally; we never read, log or inspect them, §9.4) |
| Live camera | Card helpers `picture-entity` with `camera_view: live`, inside an event-containment wrapper | Direct `<ha-camera-stream>` | See Deviations D1 |
| Gateway lifetime | One gateway per accepted config; survives detach and re-attach for up to `ORPHAN_DISPOSE_MS` (60 s), then is disposed with the runtime; plus a module-level in-flight registry | Dispose on detach and recreate on attach | Edit-mode toggles and HA's hidden-tab panel removal re-attach the **same** element. Locks must survive so the garage cannot be confirmed a second time while the first call is in flight; the in-flight registry keeps them across the 60 s disposal of an orphaned card (§9.1) |
| Choice controls | A group of native `<button aria-pressed>`; activation only by click, Enter or Space | Radio group; `<select>`; listbox | Radios and selects change value on arrow keys, which would send a device action while a keyboard or screen-reader user is only browsing options (§7.2) |
| Fonts | Newsreader Variable (display and all data numerals) + Hanken Grotesk Variable (labels, controls, body) | Atkinson Hyperlegible Next; Literata + Instrument Sans | Newsreader has an optical-size axis up to 72 and lining, tabular digits by default; setting tile values and forecast temperatures in it is the strongest cue of the reference's editorial feel. Hanken's digits are always tabular (advance 560). Research found nothing disqualifying. Atkinson is the documented swap if wall-tablet legibility testing fails |
| TypeScript | 6.0.3 (pinned) | 7.0.2 (native port) | TS 7 has no JS API, which breaks ts-lit-plugin and editor tooling; both versions type-check the Lit setup |
| Decorators | Legacy (`experimentalDecorators`, `useDefineForClassFields: false`) | TC39 standard `accessor` decorators | Vite 8/Oxc cannot lower standard decorators, and all current browsers throw on the raw syntax (verified) |
| Unit DOM | happy-dom | jsdom | happy-dom exercises Lit's `adoptedStyleSheets` and `:host` styles; jsdom 30 does not |
| Formatter | Prettier 3.9.9, `format:check` in `verify` | none | Costs one devDependency; keeps several parallel developers consistent |

### 2.4 Deviations from IMPLEMENTATION.md and the lead decisions

- **D1. Live view uses `picture-entity` via `window.loadCardHelpers()`, not a directly created `<ha-camera-stream>`.**
  Research shows `<ha-camera-stream>` is defined lazily (only after `picture-entity`/`picture-glance` or more-info
  load), has had **no `hass` property since 2026.7** (it consumes the `hassConfig`, `hassApi` and
  `hassConnection` contexts), and its properties are internal. `picture-entity` has a public, documented config
  contract, wraps `ha-camera-stream` through `hui-image`, handles stream negotiation (MJPEG, HLS, WebRTC), and works
  on both sides of the 2026.7 change because we forward `hass` to the card. Context requests from inside our shadow
  root and the dialog's top layer still bubble (`composed`) up to HA's root provider. The fallback, a clearly
  labeled 2 s refreshing snapshot, is unchanged. Feature detection is `typeof window.loadCardHelpers === 'function'`
  plus a 3 s timeout. Because the embedded card is a full Lovelace card holding the real `hass`, it is mounted in
  a containment wrapper that stops `ll-upgrade`, `ll-rebuild`, `ll-custom`, `card-visibility-changed`,
  `hass-more-info` and `hass-action` from reaching our card (an escaped `ll-rebuild` makes `hui-card` rebuild the
  whole dashboard), handles `ll-upgrade` itself by re-assigning `hass`, and sets every tap, hold and double-tap
  action to `none` (§9.4). The wrapper stops **only** those six event types. `context-request` must keep
  bubbling, because on 2026.7+ `ha-camera-stream` receives `hassConnection`, `hassApi` and `hassConfig` only
  through it.
- **D2. Column membership is chosen in TypeScript from the card's own measured width, not with CSS `order`.**
  A `ResizeObserver` on the card **host element** (inline size only) picks `wide | medium | narrow` (thresholds in
  §6.1, with 16 px hysteresis), and the root applies the new mode in the next `requestAnimationFrame`, so a
  layout switch never resizes an observed box during ResizeObserver delivery (no "loop completed with undelivered
  notifications" error). The **initial** mode is measured synchronously: `connectedCallback` reads
  `this.getBoundingClientRect().width` once, and if it is above 0 the first render already uses
  `layoutFor(width)`. If it is 0 (not laid out yet), the root renders the header and an empty frame, with no
  sections, until the first ResizeObserver callback. Sections are therefore never created in a guessed mode and
  then re-created, which would fetch thumbnails twice and churn the forecast subscription on every mount.
  The root renders a matching column template. The DOM order therefore equals the visual order at every
  breakpoint (WCAG 1.3.2 and 2.4.3). CSS-only reordering (`order`, `display: contents`) would make keyboard and
  screen-reader order diverge from the phone priority flow. CSS **container queries** still drive everything
  inside panels: each panel is an `inline-size` container. The lead's intent, responding to the card's width
  rather than the viewport, is preserved. The header picks its variant from its own container query (§6.4), so
  it compacts before it overflows regardless of the column mode.
- **D3. Fonts are registered with the `FontFace` API (`document.fonts.add`) the first time the card connects.**
  The lead said to inject `@font-face` into `document.head`. `FontFace` gives the same document-level scope (shadow-root
  `@font-face` is ignored in Chromium and Firefox; document faces were verified working in Chromium 153, Firefox 153
  and WebKit 26.5), leaves no `<style>` in HA's head, and avoids fetching fonts on other dashboards. Lovelace
  resources load on **every** dashboard page.
- **D4. Config validation errors render inside the card instead of being thrown from `setConfig`.** HA shows a
  thrown message only in edit-mode preview, and non-admins see only an icon. `setConfig` throws only when the config
  is not an object. All other issues produce an in-card "Configuration needs attention" panel. Admins
  (`hass.user.is_admin`) see each issue's path, code and full message. Everyone else, and everyone until `hass`
  has arrived, sees only the path and code plus "Ask an administrator to check the dashboard configuration",
  because full messages quote entity IDs.
- **D5. The demo label reads "Demo mode: fictional data"**, not "Demo · fictional data". The same brief bans
  middle-dot meta strings.

Additions beyond the lead list, each small and justified:

- `title`, `demo_scenario` and `controls` config keys, and per-camera `thumbnails` and `snapshot_interval` (§4.1).
  `controls` defaults to `false`: staged enablement, so pasting the generated config shows real state before
  any button can act (§13.5).
- A `confirmed: true` flag that only `agr-confirm-dialog` sets. The gateway refuses confirm-required actions without
  it, which is defense in depth for acceptance item 7. Confirm copy comes from one catalog keyed by the action, so
  the text shown cannot differ from the action executed (§5.2). `evaluate()` reports `confirm: true` on an enabled
  `Availability` instead of disabling the control; only `request()` can return `confirmation-required` (§4.7).
- The Garage panel's Open confirmation warns when the alarm is armed or arming (§8.5). The actions stay separate
  and are never chained.
- Silence Sound skips confirmation only while the alarm is `triggered` or `pending`. At any other time it asks for
  confirmation, which limits the damage of a mislabeled script binding (§7.1).
- Controls are disabled while `preview` is true (edit mode).
- Vacuum battery derivation from the same device's `battery` sensor when `battery_sensor` is not configured. Core
  2026.9 removed the vacuum `battery_level` attribute; this matches HA's own more-info lookup and is labeled as
  "derived" in diagnostics. Derived IDs are never actionable.
- A module-level in-flight registry, garage reversal detection, and a `clock` meta signal (§4.4, §4.7).
- A socket generation counter, so a subscription from a closed socket is never unsubscribed on the new one, and a
  post-reconnect snapshot barrier, so pre-outage states never count as live (§4.4, §9.2).
- A small `StatusBoard` in `DashboardServices` that controllers write to and diagnostics reads (§5.1).

---

## 3. Directory layout (`frontend/agraharam/`)

```text
.nvmrc                         24 (Node 24 LTS)
.npmrc                         engine-strict=true, save-exact=true
package.json                   pinned deps, engines {"node": ">=24 <25"}, scripts (§11.1)
package-lock.json              committed
tsconfig.json                  strict TS config (§11.2)
build-env.ts                   version and git SHA read once; shared by the Vite, Vitest and harness configs
vite.config.ts                 card bundle build + dev server (127.0.0.1:5173)
vite.harness.config.ts         builds harness.html into dist/preview; preview server 127.0.0.1:4173
vitest.config.ts               two projects: `dom` (happy-dom + tests/setup.ts; every test except the next two
                               folders) and `node` (tests/scripts/**, tests/install/**: they spawn git, bash
                               and node, so no DOM globals or DOM setup apply)
playwright.config.ts           e2e projects, webServer = vite preview of dist/preview
.prettierrc.json / .prettierignore   ignore: dist, test-results, playwright-report, docs/ (hand-wrapped design docs
                               whose wide tables Prettier would re-pad)
index.html                     dev preview page (fake HA shell + card source with HMR)
harness.html                   e2e/preview page (fake HA shell + BUILT bundle from /local/agraharam/<v>/;
                               page-error counters, §4.9)
README.md                      commands, preview, commit procedure, install pointer
docs/ARCHITECTURE.md           this file
scripts/
  postbuild.mjs                move maps out, copy OFL texts, allowlist + privacy scan, manifest.json, SHA256SUMS
  stage-preview.mjs            copy dist/agraharam/<v> into dist/preview/local/agraharam/<v> (byte-identical)
  generate-private-config.mjs  .dashboard-local candidates → .dashboard-local/agraharam-next.dashboard.yaml only
  lib/private-config.mjs       pure mapping functions (unit-tested)
  check-public.mjs             public-repo scan: tracked, untracked-not-ignored and staged files, staged blobs,
                               and dist (§11.1)
  lib/public-scan.mjs          pure forbidden-set builder, matcher and public-literal checker, shared by
                               check-public, postbuild and tests/scripts/public-literals.test.ts
  public-exemptions.json       reviewed generic IDs allowed in public files (for example sun.sun)
src/
  agraharam.ts                 bundle entry: imports all elements, pushes window.customCards entry
  agraharam-dashboard.ts       root card: setConfig, hass setter, runtime, layout, overlay routing, lifecycle
  version.ts                   APP_VERSION / GIT_SHA from define
  env.d.ts                     declares __APP_VERSION__, __GIT_SHA__, window.loadCardHelpers, customCards
  config/
    schema.ts                  input and resolved config types, roles, domains-by-role
    validate.ts                validateConfig(input) → ValidationResult (pure; runnable by Node type stripping;
                               imports only src/config/*; no demo substitution)
    entity-id.ts               isValidEntityId() (no regex lookbehind), domainOf()
    limits.ts                  list and string size limits
  ha/
    types.ts                   narrow HassLike, HassEntityLike, RegistryEntryLike, ConnectionLike
    host.ts                    HostReader, ServicePort, HostRuntime, Formatter, forecast, camera, calendar types
    hass-host.ts               HassHost (wraps injected hass; the only file that touches hass)
    hass/forecast.ts           subscribeForecast(conn, …) via connection.subscribeMessage (seam, §4.4)
    hass/camera.ts             fetchSnapshot(hass, …) + openLiveStream(ctx, …) with event containment (seam)
    hass/calendar.ts           fetchCalendarEvents(hass, …) via callApi + URLSearchParams (seam)
    entity-store.ts            EntityStore (diff + fan-out) and the read-only StoreView type
    resync.ts                  module-level ResyncTracker per connection: hajs events, generation, snapshot barrier
    entity-controller.ts       EntityController (ReactiveController)
    status-board.ts            StatusBoard: controller status lines read by diagnostics (§5.1)
    forecast-controller.ts     forecast lifecycle (§9.2)
    snapshot-controller.ts     camera thumbnail lifecycle (§9.3)
    calendar-controller.ts     calendar refresh lifecycle (§9.5)
    camera-gate.ts             pure privacy/availability gate
    normalize.ts               EntityStatus normalization + Display builders
    derive.ts                  derived bindings (vacuum battery via registry)
    features.ts                core feature-bit values as `as const` objects (no TS enums) + hasFeatures()
    format.ts                  Formatter implementations (hass-backed + Intl fallback)
    errors.ts                  HostError mapping (HTTP status, WS codes)
    actions/
      types.ts                 ActionKind, ActionRequest, ActionStatus, ActionError, Availability, ActionGateway
      catalog.ts               static action specs (§7)
      validate-args.ts         range/step/allowed-list checks + strict request shape check
      error-map.ts             HA rejection → ActionError
      messages.ts              user-facing copy per ActionErrorCode
      gateway.ts               createGateway(); seeded by WP0 returning the null gateway, implemented by WP1
      inflight.ts              module-level in-flight registry keyed by target entity (survives card instances)
      action-controller.ts     ReactiveController: ticket status + debounced drafts (§4.7, §7.2)
      null-gateway.ts          always-disabled stub (the WP0 seed of createGateway, and the config-error state)
  model/
    types.ts                   all view-model types (§4.8)
    display.ts                 Display/Tone helpers shared by selectors
    alarm-labels.ts            alarm state → label + tone (shared by header and security)
    perimeter.ts               perimeter entity → open/closed/unknown (shared by health and security)
    action-copy.ts             security button labels, consequences, confirm and ticket copy; garage confirm copy
    budget.ts                  per-panel content limits (§6.2.1)
    steps.ts                   stepValue(): step-grid snapping and clamping shared by agr-stepper and the gateway
    air.ts                     selectAirTile(): fan/purifier VM shared by Comfort and Home (seeded WP0, owned WP4)
    header.ts today.ts comfort.ts home.ts cameras.ts garage.ts media.ts upcoming.ts security.ts health.ts
    diagnostics.ts             pure selectors per section
  components/
    services.ts                DashboardServices type + memoizeServices() (§5.1)
    primitives/                agr-panel, agr-button, agr-icon-button, agr-status-pill, agr-dialog, agr-drawer,
                               agr-confirm-dialog, agr-slider, agr-stepper, agr-choice-group, agr-value, agr-icon,
                               agr-empty-state (one file each, kebab-case filenames = tag names; public API §5.5)
    shared/                    agr-fan-controls.ts (power, speed, presets; used by the climate and room drawers;
                               seeded WP0, owned WP4)
    shell/                     agr-overlay-host.ts, overlay-types.ts (DrawerRequest, DrawerElement, DRAWER_TAGS,
                               event details), agr-config-error.ts, agr-demo-ribbon.ts, agr-alert-banner.ts
    header/                    agr-header.ts, agr-presence.ts, agr-security-pill.ts, agr-connection-indicator.ts,
                               agr-clock.ts, agr-kolam-mark.ts, agr-household-drawer.ts
    today/                     agr-today.ts, agr-forecast-strip.ts, weather-icons.ts
    comfort/                   agr-comfort.ts, agr-comfort-tile.ts, agr-climate-drawer.ts
    home/                      agr-home.ts, agr-room-chip.ts, agr-vacuum-row.ts, agr-appliance-row.ts,
                               agr-room-drawer.ts, agr-home-drawer.ts ("All rooms and devices")
    cameras/                   agr-cameras.ts, agr-camera-tile.ts, agr-camera-dialog.ts, agr-cameras-drawer.ts
    garage/                    agr-garage.ts, agr-vehicle.ts, vehicle-art.ts
    media/                     agr-media.ts, agr-media-drawer.ts
    upcoming/                  agr-upcoming.ts
    security/                  agr-security-drawer.ts, security-copy.ts
    health/                    agr-health.ts, agr-health-drawer.ts
    diagnostics/               agr-diagnostics-drawer.ts
  styles/
    tokens.ts                  light + dark custom properties (§6.5)
    typography.ts              type scale classes
    breakpoints.ts             BREAKPOINTS, layoutFor(width, previous)
    layout.ts                  frame/column CSS per layout mode
    shared.ts                  focus ring, visually-hidden, num (tabular) utilities
    fonts.ts                   ensureFonts(): FontFace registration (idempotent)
  icons/
    icons.ts                   the full curated set of named imports from 'lucide' (§6.5), landed in M0.1
    custom-icons.ts            kolam mark, robot vacuum, garage door, sedan (IconNode format)
    render-icon.ts             IconNode → Lit svg template (7 tags; no unsafeSVG)
  demo/
    fixture-types.ts           SectionFixture, DemoBehavior, ScenarioSpec, FixtureClock (M0.1 contract, §10.2)
    scenarios.ts               DemoScenarioId specs + generic assembly (merges fixtures/*; never edited per section)
    configs.ts                 demoCardInput(scenario): CardConfigInput (generic merge of fixture config fragments)
    simulate.ts                simulateServiceCall(call, states): state transitions for every §7.1 service
    demo-host.ts               DemoHost (HostRuntime) over the assembled scenario + behaviors + simulate
    demo-stream.ts             animated SVG "live" placeholder element for demo live view
    fixtures/                  index.ts (WP0: the fixed list) + people.ts today.ts comfort.ts home.ts cameras.ts
                               garage.ts media.ts upcoming.ts security.ts (one per section, fictional)
  dev/                         NOT in the bundle
    main-dev.ts                index.html entry: imports ../agraharam.ts + shell (the only dev file allowed to
                               import element source)
    main-harness.ts            harness.html entry: shell + dynamic import of the built bundle URL
    ha-shell.ts                <dev-ha-shell>: fake toolbar + collapsible sidebar + switchers + remount modes
    fake-hass.ts               FakeHass: HassLike over the same assembled scenario + behaviors + simulate, with
                               HA's real two-step reconnect order (§10.3)
  util/
    log.ts                     the only console access; codes only, never objects/URLs
    focus.ts                   composed-tree focusable walker, deep activeElement
    define.ts                  defineOnce(tag, ctor) with version-conflict detection
    time.ts                    minute-aligned ticker (realigns on visibilitychange), visibility helpers
tests/                         Vitest (§12); tests/scripts/fixtures/candidates.fictional.json is a fictional
                               candidates file shaped like the private one
e2e/                           Playwright (§12)
install/
  README.md                    deployment guide (§13)
  install.sh                   dry-run-by-default copier
  resource.yaml                single module resource
  dashboard.example.yaml       panel view with fictional bindings and controls: false
  dashboard.demo.yaml          panel view with demo: true (first render)
  overrides.example.json       shape of the private generator overrides (fictional; includes camera_thumbnails)
```

No module names shadow Node built-ins: scripts import `node:*` explicitly. No Python is added.
`dist/`, `test-results/` and `playwright-report/` are already gitignored at the repo root.

---

## 4. Contracts (TypeScript)

All relative imports use explicit `.ts` extensions (`allowImportingTsExtensions`), so `src/config/*` can be run by
Node 24 type stripping from the private-config generator. Files under `src/config/` use erasable syntax only:
no enums, namespaces, parameter properties or decorators. `erasableSyntaxOnly: true` in `tsconfig.json` makes
`tsc` enforce this everywhere (decorators are exempt from that flag, so Lit components are unaffected); constant
tables such as feature bits are `as const` objects. `src/config/*` imports nothing outside `src/config/`.

### 4.1 Card configuration (`src/config/schema.ts`)

```ts
export type EntityId = string & { readonly __brand: 'EntityId' };
export type EntityRefInput = string | { entity: string; name?: string };
export type DemoScenarioId =
  | 'normal' | 'degraded' | 'offline' | 'empty' | 'alert' | 'loading' | 'restricted' | 'starting' | 'dense';
export type SecurityActionRole =
  | 'disarm_hold' | 'silence_sound' | 'resume_auto'
  | 'hold_night' | 'hold_away' | 'hold_vacation' | 'prepare_departure';

/** As written in Lovelace YAML. Unknown keys are rejected (except HA-managed keys, see validate). */
export interface CardConfigInput {
  type: string;                                   // 'custom:agraharam-dashboard'
  title?: string;                                 // default 'Agraharam', ≤ 40 chars
  demo?: boolean;                                 // default false
  demo_scenario?: DemoScenarioId;                 // default 'normal'; only meaningful with demo: true
  /** default false. While false every action is disabled with 'controls-off' (§4.7 step 2a); reads still work.
   *  Set true only after the read-only verification in §13.5. Ignored in demo mode (demo controls are on). */
  controls?: boolean;
  diagnostics?: boolean;                          // default false; drawer shown to admins only
  people?: EntityRefInput[];                      // person.*
  weather?: string;                               // weather.*
  sun?: string;                                   // sun.*
  climate?: EntityRefInput[];                     // climate.* (controllable)
  air?: EntityRefInput[];                         // fan.* purifiers (controllable)
  bed_comfort?: EntityRefInput[];                 // climate.* (read-only, never actionable)
  rooms?: { name: string; lights: string[]; curtains?: string[]; purifier?: string }[];
  vacuums?: { entity: string; name?: string; battery_sensor?: string }[];
  appliances?: { name: string; status_sensor: string; remaining_sensor?: string }[];
  media?: EntityRefInput[];                       // media_player.*
  cameras?: {
    entity: string; name: string;
    privacy_entity?: string;
    privacy_on_value?: 'on' | 'off';             // default 'on'; exactly these two strings (lowercase)
    thumbnails?: boolean;                         // default true; false = live view on request only
    snapshot_interval?: number;                   // seconds, integer 5..600, default 10
  }[];
  garage?: { cover: string; name?: string };
  vehicle?: {
    name: string; battery_sensor: string; range_sensor: string;
    charger_status?: string; charger_power?: string; session_energy?: string;
    charge_limit_pct?: number;                    // 50..100, integer
  };
  security?: {
    alarm: string;                                // alarm_control_panel.*
    policy: string;                               // input_select.* | select.*
    suggested_mode?: string;                      // input_select.* | select.* | sensor.*
    commissioning?: string;                       // input_boolean.* | binary_sensor.*
    health_text?: string;                         // input_text.* | text.* | sensor.*
    perimeter?: EntityRefInput[];                 // binary_sensor.* | cover.*
    actions?: Partial<Record<SecurityActionRole, string>>; // script.* only
  };
  studio_monitors_script?: string;                // script.*
  calendars?: EntityRefInput[];                   // calendar.*
}

export type BindingRole =
  | 'person' | 'weather' | 'sun' | 'climate' | 'air' | 'bed_comfort'
  | 'room_light' | 'room_curtain' | 'room_purifier'
  | 'vacuum' | 'vacuum_battery' | 'appliance_status' | 'appliance_remaining'
  | 'media' | 'camera' | 'camera_privacy' | 'garage_cover'
  | 'vehicle_battery' | 'vehicle_range' | 'vehicle_charger_status' | 'vehicle_charger_power'
  | 'vehicle_session_energy'
  | 'alarm' | 'policy' | 'suggested_mode' | 'commissioning' | 'health_text'
  | 'perimeter' | 'security_action' | 'studio_monitors' | 'calendar';

export const DOMAINS_BY_ROLE: Readonly<Record<BindingRole, readonly string[]>>; // e.g. camera_privacy:
// ['switch','binary_sensor','input_boolean'], security_action: ['script'], perimeter: ['binary_sensor','cover']

/** Declared here (re-exported by src/ha/actions/types.ts) so src/config imports nothing outside itself. */
export type ActionFamily = 'light' | 'room' | 'climate' | 'fan' | 'vacuum' | 'garage' | 'curtain'
                         | 'media' | 'security' | 'studio_monitors';
/** Roles that can be targeted by the gateway, grouped by action family. */
export const ACTIONABLE_ROLE_FAMILY: Readonly<Partial<Record<BindingRole, ActionFamily>>>;
// climate→climate, air→fan, room_purifier→fan, room_light→light, room_curtain→curtain, vacuum→vacuum,
// media→media, garage_cover→garage, security_action→security, studio_monitors→studio_monitors

export interface Ref { readonly entity: EntityId; readonly name?: string }
export interface ResolvedConfig {
  readonly title: string;
  readonly demo: boolean;
  readonly demoScenario: DemoScenarioId;
  readonly controls: boolean;
  readonly diagnostics: boolean;
  readonly people: readonly Ref[];
  readonly weather?: EntityId;
  readonly sun?: EntityId;
  readonly climate: readonly Ref[];
  readonly air: readonly Ref[];
  readonly bedComfort: readonly Ref[];
  readonly rooms: readonly { readonly name: string; readonly lights: readonly EntityId[];
                             readonly curtains: readonly EntityId[]; readonly purifier?: EntityId }[];
  readonly vacuums: readonly { readonly entity: EntityId; readonly name?: string; readonly batterySensor?: EntityId }[];
  readonly appliances: readonly { readonly name: string; readonly status: EntityId; readonly remaining?: EntityId }[];
  readonly media: readonly Ref[];
  readonly cameras: readonly { readonly entity: EntityId; readonly name: string;
                               readonly privacy?: { readonly entity: EntityId; readonly onValue: 'on' | 'off' };
                               readonly thumbnails: boolean; readonly snapshotIntervalMs: number }[];
  readonly garage?: { readonly cover: EntityId; readonly name: string };       // name default 'Garage'
  readonly vehicle?: { readonly name: string; readonly battery: EntityId; readonly range: EntityId;
                       readonly chargerStatus?: EntityId; readonly chargerPower?: EntityId;
                       readonly sessionEnergy?: EntityId; readonly chargeLimitPct?: number };
  readonly security?: { readonly alarm: EntityId; readonly policy: EntityId; readonly suggested?: EntityId;
                        readonly commissioning?: EntityId; readonly healthText?: EntityId;
                        readonly perimeter: readonly Ref[];
                        readonly actions: Readonly<Partial<Record<SecurityActionRole, EntityId>>> };
  readonly studioMonitors?: EntityId;
  readonly calendars: readonly Ref[];
  /** Configured entity → roles. Built once, deeply frozen, never extended. It is the ONLY input to the gateway
   *  allowlist. Derived IDs (vacuum battery) live in EntityStore's separate derived set (§4.5). Empty when
   *  demo is true: the root validates demoCardInput(scenario) separately (§4.2 rule 9). */
  readonly bindings: ReadonlyMap<EntityId, readonly BindingRole[]>;
}
```

### 4.2 Validation (`src/config/validate.ts`, `entity-id.ts`, `limits.ts`)

```ts
// Equivalent to HA core's valid_entity_id pattern, written WITHOUT lookbehind: core's literal pattern uses (?<!_),
// which is a parse-time SyntaxError for the whole bundle on Safari < 16.4. Each part is lowercase alphanumeric
// runs joined by single underscores: no leading, trailing or doubled underscore.
const SLUG_RE = /^[\da-z]+(?:_[\da-z]+)*$/;
export function isValidEntityId(s: string): boolean {
  if (s.length > 255) return false;
  const dot = s.indexOf('.');
  if (dot <= 0 || dot !== s.lastIndexOf('.')) return false;
  return SLUG_RE.test(s.slice(0, dot)) && SLUG_RE.test(s.slice(dot + 1));
}

export type ConfigIssueCode =
  | 'not-object' | 'unknown-key' | 'wrong-type' | 'required' | 'invalid-entity-id' | 'wrong-domain'
  | 'invalid-value' | 'too-many' | 'too-long' | 'out-of-range' | 'duplicate-actionable'
  | 'duplicate-security-script' | 'ignored-in-demo'
  | 'demo-config-invalid';                    // produced by the root only (rule 9), never by validateConfig
export interface ConfigIssue { readonly path: string; readonly code: ConfigIssueCode; readonly message: string }
export type ValidationResult =
  | { readonly ok: true; readonly config: ResolvedConfig; readonly warnings: readonly ConfigIssue[] }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export function validateConfig(input: unknown): ValidationResult;

export const LIMITS = { people: 8, climate: 8, air: 12, bed_comfort: 4, rooms: 12, lightsPerRoom: 20,
  curtainsPerRoom: 6, vacuums: 6, appliances: 10, media: 6, cameras: 8, perimeter: 16, calendars: 4,
  nameChars: 60, titleChars: 40 } as const;
```

Rules:

1. Top level must be a plain object. Otherwise `setConfig` throws `Error('Agraharam: card configuration must be a mapping.')`.
2. Allowed keys are the `CardConfigInput` keys plus HA-managed keys (`type`, `view_layout`, `layout_options`,
   `grid_options`, `visibility`). Anything else is `unknown-key`, with a "did you mean" hint from edit distance
   of 2 or less.
3. Every entity reference must pass `isValidEntityId`, and its domain must be listed in `DOMAINS_BY_ROLE`.
   Messages name the path and the expected domains: `cameras[2].privacy_entity: expected a switch, binary_sensor
   or input_boolean entity, got "light.demo_lamp".`
4. An entity may hold actionable roles from **one action family only** (`duplicate-actionable`). For example, the
   garage cover cannot also be a curtain. Read-only roles may overlap: the garage cover may also be a perimeter
   entry. A garage, gate or door cover listed **only** as a curtain cannot be caught here (the device class is
   unknown at `setConfig`), so the gateway refuses `curtain.*` on such covers at request time (§4.7 step 5a).
5. `security.actions.*` and `studio_monitors_script` must be `script.*`. Raw alarm or helper entities there are
   `wrong-domain`, so there is no way to configure a raw arm or disarm.
6. **One script per security role** (`duplicate-security-script`): a script ID may appear in at most one
   `security.actions` role. Otherwise, for example, `silence_sound` and `disarm_hold` could name the same
   persistent-disarm script, and a tap meant to silence the sound would persistently disarm. Script names cannot be
   trusted to describe behavior, so the binding is the only thing validation can check. The gateway repeats this
   check at request time (§4.7 step 4).
7. `cameras[].privacy_on_value` must be exactly `'on'` or `'off'` (`invalid-value`; `"On"`, `"true"` and
   `"enabled"` are rejected, never coerced). These are the only meaningful states of the allowed privacy domains.
   `snapshot_interval` must be an integer from 5 to 600 (`out-of-range`).
8. `vehicle.charge_limit_pct` must be an integer from 50 to 100. Names are trimmed, must be non-empty, and are
   limited to `LIMITS.nameChars`.
9. **No demo substitution in `src/config`.** With `demo: true`, `validateConfig` returns `ok: true` with
   `demo: true`, `demoScenario`, the title and diagnostics flag, empty binding lists and an empty `bindings` map.
   Any other binding keys, and `controls`, are still validated, and their issues (plus the presence of `controls`)
   become `ignored-in-demo` warnings shown in diagnostics. The **root** then calls
   `validateConfig(demoCardInput(scenario))` (an input with no `demo` key and `controls: true`)
   to obtain the runtime config. If that fails, which would be our bug, the card renders the config-error panel
   with code `demo-config-invalid`. The validity of every scenario's demo input is a unit test, not module-load
   code, so there is no `validate.ts` ↔ `demo/configs.ts` import cycle and the generator's type-stripping import of
   `validate.ts` stays self-contained.
10. The result is deeply frozen. `bindings` holds configured IDs only and is never extended. Derived IDs (vacuum
    battery) are owned by `HassHost`/`EntityStore` in a separate set; **derived IDs are never actionable**, because
    the gateway allowlist reads only `config.bindings` (tested).

### 4.3 Host types (`src/ha/types.ts`)

Narrow local interfaces. No import from HA's unpublished `src/types.ts` or from `custom-card-helpers`.

```ts
export interface HassEntityLike {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly last_changed: string;
  readonly last_updated: string;
  readonly context: { readonly id: string; readonly parent_id: string | null; readonly user_id: string | null };
}
export interface RegistryEntryLike {
  readonly entity_id: string; readonly device_id?: string | null; readonly area_id?: string | null;
  readonly name?: string | null; readonly hidden?: boolean; readonly display_precision?: number;
}
export interface LocaleLike {
  readonly language: string;
  readonly number_format: 'language' | 'system' | 'comma_decimal' | 'decimal_comma' | 'quote_decimal' | 'space_comma' | 'none';
  readonly time_format: 'language' | 'system' | '12' | '24';
  readonly time_zone: 'local' | 'server';
}
/** Deliberately omits latitude/longitude/location_name: code cannot reference them. */
export interface ConfigLike {
  readonly unit_system: { readonly temperature: string; readonly length: string };
  readonly time_zone: string;
  readonly state?: 'NOT_RUNNING' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FINAL_WRITE';
  readonly version?: string;
}
export interface ConnectionLike {
  /** hajs live getter: socket exists and readyState is OPEN. Read at call time, never cached. It is false while
   *  the frontend has suspended a hidden tab, when hajs queues messages and would send them on reconnect. */
  readonly connected: boolean;
  subscribeMessage<T>(cb: (msg: T) => void, msg: Readonly<Record<string, unknown>>,
                      options?: { resubscribe?: boolean }): Promise<() => Promise<void>>;
  /** hajs public event API. Local listener registration only: sends nothing. 'ready' fires for every new socket,
   *  'disconnected' when a socket closes (including the hidden-tab suspend). Feature-detected. */
  addEventListener?(type: 'ready' | 'disconnected', cb: () => void): void;
  removeEventListener?(type: 'ready' | 'disconnected', cb: () => void): void;
}
export interface HassLike {
  readonly states: Readonly<Record<string, HassEntityLike>>;
  readonly entities?: Readonly<Record<string, RegistryEntryLike>>;
  readonly services: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly connected: boolean;
  readonly connection: ConnectionLike;
  readonly locale?: LocaleLike;
  readonly config: ConfigLike;
  readonly themes?: { readonly darkMode?: boolean };
  readonly user?: { readonly id: string; readonly is_admin: boolean };
  callService(domain: string, service: string, data?: Record<string, unknown>,
              target?: { entity_id: string | string[] }, notifyOnError?: boolean,
              returnResponse?: boolean): Promise<{ context: { id: string } }>;
  callApi<T>(method: 'GET', path: string): Promise<T>;            // GET only, by type
  fetchWithAuth(path: string, init?: RequestInit): Promise<Response>;
  formatEntityState?(stateObj: HassEntityLike, state?: string): string;
  formatEntityAttributeValue?(stateObj: HassEntityLike, attribute: string, value?: unknown): string;
}
```

### 4.4 Host adapter (`src/ha/host.ts`)

```ts
export type HostKind = 'hass' | 'demo';
/** 'resyncing': the socket is open again but the post-reconnect state snapshot has not been ingested yet. Every
 *  consumer treats it exactly like 'disconnected' (stale values, controls paused, cameras closed, no forecast or
 *  calendar restart); only the labels differ ("Reconnecting"). */
export type ConnectionPhase = 'loading' | 'connected' | 'resyncing' | 'disconnected';
export interface ConnectionInfo {
  readonly phase: ConnectionPhase;
  readonly haState?: ConfigLike['state'];   // 'STARTING' → header shows "Starting"
  readonly haVersion?: string;              // diagnostics only
}
/** 'clock' is emitted by EntityStore.tick() from the root's minute-aligned ticker (§9.1), not by hass. */
export type MetaKind = 'connection' | 'locale' | 'theme' | 'registry' | 'services' | 'user' | 'clock';
export interface HostChange { readonly entities: ReadonlySet<EntityId>; readonly meta: ReadonlySet<MetaKind> }
export type Unsubscribe = () => void;

export interface ClockParts { readonly hm: string; readonly period?: string }   // "5:51", "PM"
export interface Formatter {
  readonly temperatureUnit: string;                       // hass.config.unit_system.temperature
  entityState(e: HassEntityLike): string;                 // hass.formatEntityState if present, else fallback
  attribute(e: HassEntityLike, attribute: string): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  temperature(value: number, unit: string | undefined): string;   // "69°" or "21.5 °C" per locale
  time(value: Date): string;
  hour(value: Date): string;                              // "7 PM" / "19": forecast cells (locale, 12/24 h, zone)
  clock(value: Date): ClockParts;
  date(value: Date, style: 'long' | 'weekday-short' | 'month-day'): string;
  duration(ms: number): string;                           // "35 min", "1 h 10 min"
}

export type ForecastType = 'daily' | 'hourly' | 'twice_daily';
export interface ForecastItem {
  readonly datetime: string; readonly condition?: string; readonly temperature?: number | null;
  readonly templow?: number | null; readonly precipitation_probability?: number | null;
  readonly is_daytime?: boolean;
}
export interface ForecastPayload { readonly type: ForecastType; readonly forecast: readonly ForecastItem[] | null }
export interface ForecastHandlers { next(p: ForecastPayload): void; error(e: HostError): void }

export type HostErrorCode =
  | 'disconnected' | 'unsupported' | 'not-found' | 'permission-denied' | 'unavailable'
  | 'network' | 'aborted' | 'bad-response' | 'unknown';
export interface HostError { readonly code: HostErrorCode; readonly status?: number; readonly haCode?: string }

export interface CameraSnapshotRequest { readonly width: number; readonly height: number; readonly signal: AbortSignal }
export type LiveStreamHandle =
  | { readonly kind: 'native'; readonly element: HTMLElement; dispose(): void;
      /** Fires once if the embedded card fails after mounting (a contained ll-rebuild, §9.4). */
      onFail(listener: (reason: 'helpers-failed') => void): Unsubscribe }
  | { readonly kind: 'demo'; readonly element: HTMLElement; dispose(): void }
  | { readonly kind: 'unsupported'; readonly reason: 'no-helpers' | 'helpers-failed' | 'timeout' };

export interface CalendarEventLike {
  readonly key: string; readonly summary: string; readonly start: string; readonly end: string;
  readonly allDay: boolean;   // location/description are deliberately dropped at the adapter
}

/** Everything UI code may use. No mutation methods. */
export interface HostReader {
  readonly kind: HostKind;
  readonly store: StoreView;              // read-only view; ingest/tick/setDerived are not reachable from UI code
  /** HassHost: 'connected' only if the last ingested hass.connected is true AND hass.connection.connected (live
   *  getter) is true right now AND the resync barrier is clear; 'resyncing' when both flags are true but the
   *  barrier is armed. The live getter catches a stale phase while the panel was detached or suspended. */
  connection(): ConnectionInfo;
  /** Socket generation, read from the connection's ResyncTracker. Increments on every hajs 'ready' and
   *  'disconnected' event, on every observed transition of the phase away from 'connected', and when the
   *  hass.connection object identity changes. A subscription is valid only while the generation it was created
   *  in is current (§9.2). DemoHost: increments on setConnected(false). */
  connectionGeneration(): number;
  registry(id: EntityId): RegistryEntryLike | undefined;
  entitiesOnDevice(deviceId: string): readonly EntityId[];
  hasService(domain: string, service: string): boolean;
  formatter(): Formatter;                 // stable until 'locale' meta changes
  isDarkMode(): boolean;
  isAdmin(): boolean;
  subscribeForecast(id: EntityId, type: ForecastType, h: ForecastHandlers): Unsubscribe;
  fetchCameraSnapshot(id: EntityId, req: CameraSnapshotRequest): Promise<Blob>;   // rejects with HostError
  openLiveStream(id: EntityId): Promise<LiveStreamHandle>;
  fetchCalendarEvents(id: EntityId, range: { start: Date; end: Date }, signal: AbortSignal)
    : Promise<readonly CalendarEventLike[]>;
}

export type ServiceDomain = 'light' | 'climate' | 'fan' | 'vacuum' | 'cover' | 'media_player' | 'script';
export interface ServiceCall {
  readonly domain: ServiceDomain; readonly service: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly target: { readonly entity_id: EntityId | readonly EntityId[] };
}
export interface ServiceCallResult { readonly contextId: string }
/** Rejection used when the port refused to call (the request never left the browser). */
export interface PortNotSent { readonly portError: 'not-sent'; readonly reason: 'disconnected' | 'disposed' }
/** Handed ONLY to ActionGateway by the composition root. */
export interface ServicePort { invoke(call: ServiceCall): Promise<ServiceCallResult> }

export interface HostRuntime {
  readonly reader: HostReader; readonly port: ServicePort;
  /** Identity of the runtime: host kind, demo scenario and the sorted bound set (§9.1). */
  readonly key: string;
  readonly status: StatusBoard;          // per runtime (§5.1)
  tick(): void;                          // EntityStore.tick(); the root's only store mutation
  dispose(): void;
}
```

Adapter seams (part of M0.1, so `HassHost` in WP0 and the `src/ha/hass/*` modules in WP3, WP6 and WP9 compile
against each other from day one; WP0 seeds each module with an implementation that reports `unsupported`):

```ts
// src/ha/hass/forecast.ts (WP3)
export function subscribeForecast(conn: ConnectionLike, id: EntityId, type: ForecastType,
                                  h: ForecastHandlers,
                                  generation: () => number): Unsubscribe; // synchronous; safe to call at any time
// src/ha/hass/camera.ts (WP6)
export function fetchSnapshot(hass: HassLike, id: EntityId, req: CameraSnapshotRequest): Promise<Blob>;
export interface LiveStreamContext {
  hass(): HassLike;                              // current hass at call time
  track(el: HTMLElement): Unsubscribe;           // HassHost assigns el.hass on every update until unsubscribed
}
export function openLiveStream(ctx: LiveStreamContext, id: EntityId): Promise<LiveStreamHandle>;
// src/ha/hass/calendar.ts (WP9)
export function fetchCalendarEvents(hass: HassLike, id: EntityId, range: { start: Date; end: Date },
                                    signal: AbortSignal): Promise<readonly CalendarEventLike[]>;
```

`HassHost` delegates its `HostReader` methods to these functions and owns the live-element forward set behind
`track()`. Section packages never edit `hass-host.ts`.

**Resync barrier** (`src/ha/resync.ts`, WP0, M0.1). On a reconnect, hajs 9.6.0 re-sends `subscribe_entities` and
fires `ready` synchronously; the frontend's `ready` handler immediately pushes `hass` with `connected: true`, but
the full state snapshot arrives at least one round trip later, and the hajs store is never cleared. For that
window (hundreds of ms over the tunnel, longer on a hidden-tab resume) `hass.states` still holds pre-outage
objects while both connection flags read true. A privacy switch turned on during the outage would read as off.

```ts
/** Module scope: one tracker per hass.connection object (WeakMap), shared by every HassHost in the page, so a
 *  runtime rebuilt during an outage (§9.1 orphan disposal) still knows a snapshot is outstanding. It is the ONLY
 *  code that calls connection.addEventListener, once per connection object; its listeners retain only the
 *  tracker's own small state (generation, flags, base), never a HassHost, store or card. */
export type StatesMap = Readonly<Record<string, HassEntityLike>>;
export interface ResyncTracker {
  generation(): number;                  // the socket generation exposed by HostReader.connectionGeneration()
  armed(): boolean;                      // a reconnect was signalled and no fresh snapshot has been observed yet
  /** hass.states reference current when the barrier last armed; kept until the next arm (one superseded states
   *  map stays in memory, an accepted cost). undefined if it never armed. */
  base(): StatesMap | undefined;
  /** HassHost.update calls this BEFORE ingest, with the same states reference it ingests (never a copy). */
  observe(states: StatesMap, connected: boolean): void;
  subscribe(listener: (e: 'ready' | 'disconnected' | 'armed' | 'cleared') => void): Unsubscribe;
}
export function resyncTrackerFor(conn: ConnectionLike, previous?: ResyncTracker): ResyncTracker;
```

- **Arms** on: hajs `ready` (base = the last observed states reference); an observed `connected` false → true
  (base = the states reference observed before that update, then the current update is evaluated); a new
  `hass.connection` identity (`resyncTrackerFor(newConn, oldTracker)` starts armed with base = the old tracker's
  last observed reference). Arming also increments the generation.
- **Clears** on the first `observe()` whose states reference differs from `base()`. In 20260826.7 the
  `connected: true` push, config re-fetch, registry refresh and brands-token updates all keep the states
  reference, so the next new reference is the snapshot. A barrier with no state change holds (fails closed).
- `HassHost` passes `{armed, base}` into every `StoreSnapshot` (§4.5) and re-ingests its last `hass` on every
  tracker event, so phase changes notify the `connection` meta at once. A brand-new tracker (first page load)
  is not armed: HA renders panels only after the first states arrive.
- Per-entity defense in depth: `StoreView.freshSinceResync(id)` is true when `base()` is undefined or the
  entity's current object differs from `base()[id]`. The snapshot replaces every entity object, so an entity
  deleted during the outage keeps its old object and is never fresh. The camera gate requires a fresh privacy
  entity (§9.3).

Implementation rules:

- `HassHost` (`hass-host.ts`): `constructor(bound: Iterable<EntityId>)` and `update(hass: HassLike): void`.
  It is the **only** module that reads `hass`, with exactly two listed exceptions in the root card:
  `hass?.user?.is_admin` (to choose the config-error detail level before a runtime exists, D4) and
  `hass?.themes?.darkMode` (to theme demo mode, §10.1). A fitness test pins both. It never caches `hass.config`,
  `hass.auth` or `hass.user` beyond the fields it needs. It never registers listeners on `hass.connection`
  itself: it subscribes to `resyncTrackerFor(hass.connection)` (moving to a new tracker when the connection
  identity changes) and unsubscribes in `dispose()`, so a disposed host is collectable. `port.invoke(call)`
  first requires `connection().phase === 'connected'`, which includes a fresh read of
  `hass.connection.connected === true` and a clear resync barrier, and that the host is not disposed.
  Otherwise it rejects with `PortNotSent` and **does not call**. This closes the hajs gap where `sendMessagePromise` pushes a call into its
  internal queue while a hidden tab is suspended and sends it on the next socket: that queue only exists while the
  socket is not open. It then calls `hass.callService(domain, service, {...data}, {entity_id}, false, false)`;
  `notifyOnError=false` because the dashboard renders its own errors. It forwards every new `hass` to elements
  registered through `track()` (§9.4). `formatEntityState` and `formatEntityAttributeValue` are feature-detected,
  and their identity is part of the `locale` meta token. It computes derived IDs (`derive.ts`) and hands them to
  `EntityStore.setDerived`, never to the config. Derived IDs are recomputed on a `registry` meta change, when
  `haState` becomes `RUNNING`, on the ingest that clears the resync barrier, and when a state first appears for any
  entity on a bound vacuum's device (a small `deviceId → entity IDs` index built from the registry). The
  `battery` `device_class` is a state attribute, not a registry field, so a battery sensor whose state arrives
  after the registry (normal at HA startup) would otherwise be missed.
- `fetchSnapshot`: `hass.fetchWithAuth('/api/camera_proxy/' + encodeURIComponent(id) + '?' + new
  URLSearchParams({ width, height }), { signal, cache: 'no-store' })`. A non-2xx response maps through `errors.ts`:
  401/403 → `permission-denied`, 404 → `not-found`, 503 → `unavailable`, and anything else →
  `network`/`bad-response`. A body whose type is not `image/*` → `bad-response`. URLs are never logged.
- **Camera session denial** (`HassHost.fetchCameraSnapshot`): a **401** from any camera sets one host-level flag.
  While it is set, every `fetchCameraSnapshot` call, from any tile or from the live-view fallback, rejects at once
  with `{code: 'permission-denied', status: 401}` and makes no request. A Bearer-authenticated 401 means session
  trouble, not one camera, and each attempt counts toward `http.ban`. The flag clears when
  `connectionGeneration()` changes (reconnect) or the `user` meta changes, so each reconnect allows at most one
  counted attempt. A 403 stays per camera (that tile's `denied`). `DemoHost` mirrors this for `unauthorized`
  (401) and `forbidden` (403) snapshot behaviors.
- `fetchCalendarEvents`: `hass.callApi('GET', 'calendars/' + encodeURIComponent(id) + '?' + new
  URLSearchParams({ start: start.toISOString(), end: end.toISOString() }))`, so a `+` in an offset can never be
  misread. The result is mapped to `CalendarEventLike` (summary truncated to 120 characters). Results that arrive
  after `signal` aborts are discarded.
- `DemoHost` (`demo/demo-host.ts`): `constructor(scenario: DemoScenarioId, opts?: { latencyMs?: [number, number];
  random?: () => number; now?: () => number })`, plus `setConnected(b: boolean)`, `releaseFirstIngest()` (for
  `loading`) and `setScenario(id)`. It builds its states, behaviors, forecasts and calendar events from
  `assembleScenario(id, fixtureClock(now()))` (§10.2; `now` defaults to `Date.now`, which e2e pins) and applies
  `simulateServiceCall` after the simulated latency, unless a `DemoBehavior` for the target says otherwise. It
  makes no `fetch`, `WebSocket` or `XMLHttpRequest` calls. Snapshots are locally generated SVG Blobs, or
  rejections when a behavior says `unauthorized`, `forbidden` or `unavailable`.

### 4.5 Entity store and controller (`entity-store.ts`, `entity-controller.ts`)

```ts
export interface StoreSnapshot {
  /** hass.states itself (same reference, never copied): the resync barrier compares references. */
  readonly states: Readonly<Record<string, HassEntityLike | undefined>>;
  readonly connected: boolean;
  readonly resync: { readonly armed: boolean; readonly base?: StatesMap };   // from the ResyncTracker (§4.4)
  /** Meta tokens. Each is a single reference or a fixed-length tuple, compared ELEMENT-WISE with Object.is
   *  (a fresh array per update must not notify): locale = [locale, formatEntityState, formatEntityAttributeValue,
   *  unit_system], connection = [connected, resync.armed, config.state], theme = darkMode boolean,
   *  registry = hass.entities, services = hass.services, user = hass.user. 'clock' is not in snapshots. */
  readonly meta: Readonly<Record<Exclude<MetaKind, 'clock'>, unknown>>;
}

/** The only store type UI code, selectors and controllers see (HostReader.store, DashboardServices.store). */
export interface StoreView {
  get(id: EntityId): HassEntityLike | undefined;    // from the latest snapshot (stale while disconnected)
  isDerived(id: EntityId): boolean;
  isReady(): boolean;                               // at least one ingest
  isConnected(): boolean;                           // connected AND resync barrier clear (states are current)
  isResyncing(): boolean;                           // connected but barrier armed (labels only; §4.4)
  freshSinceResync(id: EntityId): boolean;          // entity object replaced since the last barrier arm (§4.4)
  haState(): ConfigLike['state'];                   // undefined treated as 'RUNNING'
  subscribe(ids: readonly EntityId[], meta: readonly MetaKind[],
            listener: (change: HostChange) => void): Unsubscribe;
}

/** Constructed and mutated only by HassHost, DemoHost and the root (tick). */
export class EntityStore implements StoreView {
  constructor(bound: Iterable<EntityId>);
  setDerived(ids: Iterable<EntityId>): void;        // separate derived set; new derived IDs reported changed
  ingest(next: StoreSnapshot): HostChange;          // first ingest: all bound + derived IDs and all meta changed
  tick(): HostChange;                               // emits meta 'clock' only (minute ticker, visibility realign)
  // …plus every StoreView member
}

/** Sections that render controls subscribe to these, because Availability depends on all of them:
 *  services (service-missing while HA starts), user (sticky denial reset), registry (derived battery). */
export const CONTROL_META: readonly MetaKind[] = ['connection', 'locale', 'services', 'user', 'registry'];

export class EntityController implements ReactiveController {
  constructor(host: ReactiveControllerHost,
              store: () => StoreView | undefined,
              ids: () => readonly EntityId[],
              meta?: readonly MetaKind[]);           // default ['connection', 'locale']
  hostConnected(): void;      // subscribe
  hostDisconnected(): void;   // unsubscribe
  /** Resubscribes when the store() IDENTITY or the ids() signature (joined string) changed, unsubscribing from
   *  the old store first. A setConfig that rebuilds the runtime therefore moves every section to the new store,
   *  including sections whose own IDs did not change. */
  hostUpdate(): void;
}
```

A listener exception is caught, logged with code `store-listener-failed`, and does not stop other listeners.
After a reconnect the full `subscribe_entities` snapshot gives every entity a new identity, so each subscriber is
notified exactly once (in the same ingest that clears the barrier). That is expected and cheap. Header, Today,
Upcoming and Home (relative appliance times) add `'clock'` to their meta, so the greeting, "next 8 hours", today/tomorrow grouping and "Done 7:40 PM" stay
current without any entity change.

### 4.6 Entity-state normalization and null numerics (`normalize.ts`, `model/display.ts`)

```ts
export type EntityStatus =
  | 'available' | 'unavailable' | 'unknown' | 'missing-binding' | 'privacy'
  | 'disconnected' | 'loading' | 'permission-denied';

export interface NormalizedEntity {
  readonly id: EntityId;
  readonly status: EntityStatus;
  readonly entity?: HassEntityLike;   // present for available/unknown, and for disconnected when last known exists
  readonly stale: boolean;            // true when disconnected and showing last known values
}
export function normalizeEntity(store: StoreView, id: EntityId): NormalizedEntity;

export type Tone = 'neutral' | 'ok' | 'attention' | 'danger' | 'muted';
export type Display =
  | { readonly kind: 'value'; readonly text: string; readonly stale: boolean }
  | { readonly kind: 'absent'; readonly reason: Exclude<EntityStatus, 'available'> | 'no-data';
      readonly label: string };
export function numericDisplay(n: NormalizedEntity, read: (e: HassEntityLike) => unknown,
                               format: (v: number) => string): Display;
export function textDisplay(n: NormalizedEntity, read: (e: HassEntityLike) => string | undefined): Display;
```

Precedence in `normalizeEntity`, first match wins:

1. Store not ready → `loading`.
2. ID absent from `states`: not live (`!store.isConnected()`, which includes resyncing) → `disconnected` (no
   last known); `haState()` is `NOT_RUNNING` or `STARTING` → `loading` (integrations are still setting up, so
   the health panel does not list "missing" devices during every HA restart); else `missing-binding`.
3. Not live (disconnected **or resyncing**) → `disconnected` with `entity` = last known and `stale: true`.
4. `state === 'unavailable'` → `unavailable`.
5. `state === 'unknown'` or empty → `unknown`.
6. Otherwise → `available`.

`privacy` is assigned only by `camera-gate.ts`. `permission-denied` is assigned by the gateway's sticky denial
(controls) or by a camera 401/403.

Rendering rules for values:

- Numeric parse: `typeof v === 'number' && Number.isFinite(v)`, or a string matching `/^-?\d+(\.\d+)?$/`.
  `null`, `undefined`, `''`, `'unknown'`, `'unavailable'`, `NaN` and `Infinity` yield
  `{kind: 'absent', reason: 'no-data', label: 'No data'}`. **Never `0`.**
- Absent labels: unavailable "Unavailable", unknown "Unknown", missing-binding "Not found", disconnected "Offline",
  loading "Loading" (rendered as a skeleton bar, no text), permission-denied "No access", privacy "Privacy on".
- `agr-value` renders `absent` as a dash glyph (U+2014) in the value slot plus the label in meta text, with
  `aria-label="<field> <label>"`. A stale value renders dimmed with visually hidden "last known".
- Progress bars (vehicle battery, vacuum battery) render an empty hatched track for `absent`, never a 0% fill.
- Unit sources: weather values use the entity's `*_unit` attributes, climate uses
  `formatter.temperatureUnit`, sensors use `formatEntityState` (unit and display precision). `°F` is never
  hardcoded.

### 4.7 Action gateway (`src/ha/actions/*`)

```ts
export type { ActionFamily, SecurityActionRole } from '../../config/schema.ts';
export type ActionKind =
  | 'light.turn_on' | 'light.turn_off' | 'light.set_brightness'
  | 'room.lights_on' | 'room.lights_off'
  | 'climate.set_temperature' | 'climate.set_hvac_mode'
  | 'fan.turn_on' | 'fan.turn_off' | 'fan.set_percentage' | 'fan.set_preset_mode'
  | 'vacuum.start' | 'vacuum.pause' | 'vacuum.return_to_base'
  | 'garage.open' | 'garage.close' | 'curtain.open' | 'curtain.close'
  | 'media.play' | 'media.pause' | 'media.next' | 'media.previous'
  | 'media.volume_set' | 'media.volume_mute' | 'media.select_source'
  | 'security.run' | 'studio_monitors.run';

/** Callers never pass domain, service, data or script entity IDs. */
export type ActionRequest =
  | { kind: 'light.turn_on' | 'light.turn_off'; entity: EntityId }
  | { kind: 'light.set_brightness'; entity: EntityId; pct: number }
  | { kind: 'room.lights_on' | 'room.lights_off'; room: number }          // index into config.rooms
  | { kind: 'climate.set_temperature'; entity: EntityId; temperature: number }
  | { kind: 'climate.set_hvac_mode'; entity: EntityId; mode: string }
  | { kind: 'fan.turn_on' | 'fan.turn_off'; entity: EntityId }
  | { kind: 'fan.set_percentage'; entity: EntityId; percentage: number }
  | { kind: 'fan.set_preset_mode'; entity: EntityId; preset: string }
  | { kind: 'vacuum.start' | 'vacuum.pause' | 'vacuum.return_to_base'; entity: EntityId }
  | { kind: 'garage.open' | 'garage.close' }                               // target = config.garage.cover
  | { kind: 'curtain.open' | 'curtain.close'; entity: EntityId }
  | { kind: 'media.play' | 'media.pause' | 'media.next' | 'media.previous'; entity: EntityId }
  | { kind: 'media.volume_set'; entity: EntityId; level: number }
  | { kind: 'media.volume_mute'; entity: EntityId; muted: boolean }
  | { kind: 'media.select_source'; entity: EntityId; source: string }
  | { kind: 'security.run'; role: SecurityActionRole }                     // script from config only
  | { kind: 'studio_monitors.run' };

export type ActionKey = `entity:${string}` | `room:${number}` | 'garage' | 'security' | 'studio_monitors';
export type ActionPhase = 'pending' | 'sent' | 'confirmed' | 'uncertain' | 'failed';

export type ActionErrorCode =
  | 'disconnected' | 'preview' | 'controls-off' | 'not-allowed' | 'domain-mismatch' | 'missing-entity' | 'unavailable'
  | 'state-unknown' | 'not-applicable' | 'unsupported' | 'service-missing' | 'invalid-argument'
  | 'confirmation-required' | 'busy' | 'permission-denied'
  | 'not-sent'                                   // disposed gateway or stale gesture epoch: invoke never called
  | 'rejected' | 'bad-request' | 'device-error' | 'connection-lost' | 'timeout'
  | 'reversed'                                   // garage observed moving back the other way (§7.1)
  | 'unknown';
export interface ActionError {
  readonly code: ActionErrorCode; readonly message: string;   // user-facing, actionable (§7.3)
  readonly haCode?: string | number;                          // diagnostics only
}
/** `confirm: true` means the UI must route the gesture through agr-confirm-dialog (agr-request-confirm) instead of
 *  calling request() directly. It is computed from the same state as request() step 11, so it is live (for
 *  example Silence Sound flips to confirm: false while the alarm is triggered). */
export type Availability =
  | { readonly enabled: true; readonly confirm: boolean }
  | { readonly enabled: false; readonly reason: ActionErrorCode; readonly message: string };

export interface ActionStatus {
  readonly id: number; readonly key: ActionKey; readonly kind: ActionKind;
  readonly phase: ActionPhase;
  readonly progress?: 'moving';            // e.g. garage 'opening' observed while awaiting 'open'
  readonly error?: ActionError;            // failed | uncertain
  /** Monotonic milliseconds (performance.now()), never Date.now(): e2e pins Date with page.clock.setFixedTime,
   *  which would freeze wall-clock durations and in-flight expiry. Diagnostics shows durations only. */
  readonly startedAt: number; readonly settledAt?: number;
}

export interface RequestOptions {
  readonly confirmed?: boolean;            // set only by agr-confirm-dialog
  /** Gesture epoch captured when the user started the gesture (drafts, confirm dialogs). A mismatch with
   *  epoch() at request time → failed('not-sent'), invoke never called. */
  readonly epoch?: number;
}
export interface ActionGateway {
  /** Pure: no side effects. Runs pipeline steps 0–10, 12 and 13 and NEVER returns 'confirmation-required':
   *  step 11 becomes the `confirm` flag of an enabled Availability. Sections render it; the confirm dialog
   *  re-runs it while open to re-check every precondition. */
  evaluate(req: ActionRequest): Availability;
  /** Never throws. Returns 'failed' immediately if any precheck fails; otherwise 'pending'. */
  request(req: ActionRequest, opts?: RequestOptions): ActionStatus;
  status(key: ActionKey): ActionStatus | undefined;
  subscribe(key: ActionKey | '*', listener: (s: ActionStatus) => void): Unsubscribe;
  /** Last 20 settled or failed tickets, newest first (ring buffer; diagnostics only). Empty in the null gateway. */
  recent(): readonly ActionStatus[];
  /** Increments on dispose(), on every transition of the connection phase away from 'connected', and on
   *  invalidate(). Drafts and open confirm dialogs that captured an older epoch are discarded. */
  epoch(): number;
  onEpochChange(listener: (epoch: number) => void): Unsubscribe;
  invalidate(reason: 'preview'): void;     // the root calls this when preview turns on
  dismiss(key: ActionKey): void;           // clears a terminal status from the UI
  /** Clears timers; non-terminal tickets → uncertain; in-flight registry entries are KEPT until they expire
   *  (the call may still be executing). After dispose, request() returns failed('not-sent') without invoking. */
  dispose(): void;
  readonly disposed: boolean;
}
/** src/ha/actions/gateway.ts. WP0 seeds it returning createNullGateway(); the root imports it from day one, so
 *  WP1 replaces the body without ever editing the root. */
export function createGateway(deps: {
  readonly port: ServicePort; readonly reader: HostReader; readonly config: ResolvedConfig;
  readonly isPreview: () => boolean;
  readonly now?: () => number;             // default () => performance.now() (monotonic)
  readonly inflight?: InflightRegistry;    // tests inject one; production uses the module singleton
}): ActionGateway;

/** src/ha/actions/inflight.ts: module scope, shared by every gateway and card instance in the page. Keyed by
 *  resolved TARGET entity ID (not ActionKey), so a new card instance after a real route change, or a gateway
 *  rebuilt by setConfig, still sees the garage door as busy while an earlier open_cover may be executing.
 *  `until` and `now` are monotonic performance.now() values. */
export interface InflightRegistry {
  mark(targets: readonly EntityId[], until: number): void;   // until = start + family timeout
  clear(targets: readonly EntityId[]): void;                 // on confirmed, failed or reversed only
  isBusy(target: EntityId, now: number): boolean;            // expired entries are pruned on read
}

export const ACTION_TIMEOUT_MS: Readonly<Record<ActionFamily, number>> = {
  light: 10_000, room: 15_000, climate: 20_000, fan: 20_000, vacuum: 30_000,
  garage: 60_000, curtain: 60_000, media: 10_000, security: 10_000, studio_monitors: 10_000,
};
export const CONFIRMED_DISPLAY_MS = 4_000;     // confirmed/"Requested" shown, then auto-dismissed
export const CONFIRM_DIALOG_TIMEOUT_MS = 60_000; // an unanswered confirm dialog cancels itself
export const SLIDER_COMMIT_DEBOUNCE_MS = 400;  // agr-slider: commit on change, debounced
export const STEPPER_COMMIT_DEBOUNCE_MS = 800; // agr-stepper: accumulate taps, one call
```

Pipeline for `request` (first failure wins; `evaluate` runs the same checks except that step 11 only sets
`confirm`):

0. `disposed`, or `opts.epoch` given and `!== epoch()` → `not-sent`. Nothing is stored and `invoke` is not called.
1. **Runtime shape check** (`validate-args.ts`): `req` must be a plain object with exactly the keys of its `kind`
   variant. Extra keys such as `domain`, `service`, `data` or `entity_id` give `not-allowed`.
2. `isPreview()` → `preview`.
   2a. `config.controls !== true` → `controls-off` (staged enablement, §4.1, §13.5). Nothing is stored.
3. `reader.connection().phase !== 'connected'` (disconnected, loading or **resyncing**) → `disconnected`.
   **Nothing is stored.**
4. Resolve target(s) from the config: `security.run` → `config.security.actions[role]`, `garage.*` →
   `config.garage.cover`, `room.*` → the room's lights, `studio_monitors.run` → `config.studioMonitors`. A target
   that is not configured, or an `entity` whose `config.bindings` roles do not include the spec's allowed roles →
   `not-allowed`. Derived IDs are not in `config.bindings`, so they can never pass. For `security.run`, the
   resolved script must appear in **exactly one** `security.actions` role, else `not-allowed` (repeats §4.2 rule 6
   in case a config bypassed validation).
5. Target domain ≠ the spec's domain → `domain-mismatch`. This is defense in depth on top of config validation.
   5a. `curtain.*` on a cover whose `attributes.device_class` is `garage`, `gate` or `door` → `not-allowed`.
   Curtain actions have no confirmation, so a garage cover listed as a curtain would bypass the garage
   confirmation. The home selector renders such covers read-only with "Garage, gate and door covers can only be
   moved from the Garage panel."
6. Entity normalization: missing → `missing-entity`, unavailable → `unavailable`. `unknown` is allowed only where
   the §7.1 "Unknown state" column says `allow`; every `deny` row returns `state-unknown`. Garage always denies.
7. Spec precondition (state-based, §7.1) → `not-applicable` (for example "Already open" or "Already running").
8. Capability: `hasFeatures(supported_features, spec.requires)` (all bits of any listed mask), or
   brightness-capable color modes for brightness → `unsupported`.
9. `reader.hasService(domain, service)` → `service-missing`.
10. Arguments (§7.1 validation column) → `invalid-argument`.
11. Confirmation required by the spec (for `silence_sound`, only when the alarm is not `triggered` or `pending`)
    and `opts.confirmed !== true` → `confirmation-required`. **`request()` only.** In `evaluate()` this step sets
    `confirm` on the enabled result and never disables the control.
12. Sticky denial for (family, target) recorded after an earlier `Unauthorized` → `permission-denied`. This resets
    when the `user` meta changes.
13. Lock: a non-terminal ticket on the same `ActionKey`, or `inflight.isBusy(target)` for any resolved target →
    `busy`. All security roles share the `'security'` key.

Then: snapshot `before` state, create a ticket in phase `pending`, `inflight.mark(targets, now + timeout)`, call
`port.invoke(call)` once, and start the family timeout. Observation runs on every store change for the target(s)
while the ticket is `pending` or `sent`:

- Predicate true while `pending` → mark `observedEarly`; on resolve → `confirmed`.
- Promise resolves → `sent`, or `confirmed` if `observedEarly` or the predicate is already true. For scripts, a
  `context.id` match also confirms.
- Predicate true while `sent` → `confirmed`. A `progress` predicate sets `progress: 'moving'`.
- Reversal (garage only): after `progress` was observed, the opposite motion or end state (`opening`/`open` on a
  close request, `closing`/`closed` on an open request) → `failed` with code `reversed` at once, instead of
  waiting out the 60 s timeout.
- Promise rejects with `PortNotSent` → `failed('disconnected')`; the copy says nothing was sent, which is true
  because the port refused before calling.
- Promise rejects otherwise → `error-map.ts`. A connection loss (bare `3` or `{error: {code: 3}}`) → `uncertain`
  (`connection-lost`). Everything else → `failed`.
- Timeout → `uncertain` (`timeout`). **No automatic retry, ever.** A later tap is a new deliberate request.
- On `confirmed`, `failed` or `reversed`: `inflight.clear(targets)`. On `uncertain`: the registry entry stays until
  it expires at the family timeout, because the call may still be executing.

HA rejection mapping (`error-map.ts`): `not_found` → `service-missing`; `invalid_format` → `bad-request` (our
bug, logged); `service_validation_error` → `rejected`, with HA's message escaped and capped at 160 characters;
`home_assistant_error` with message `Unauthorized` or code `unauthorized` → `permission-denied` (sticky); other
`home_assistant_error` → `device-error`; `3` or `{error: {code: 3}}` → `connection-lost`; anything else → `unknown`.
On the bare `3`: in hajs 9.6.0 it means `sendMessage` threw because the socket was closed, so the message was
probably never sent. We still map it to `uncertain` rather than `failed`, because the copy for `failed` would claim
"nothing changed" on the strength of a library detail. The port's own live-socket check (above) catches the
known never-sent path first and reports it truthfully as `failed('disconnected')`.

Ticket and draft controller (`action-controller.ts`, WP0, M0.1 contract). Every section uses it; leaves never call
the gateway and own no timers.

```ts
export type DraftState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'drafting'; readonly value: number }   // debounce timer running ("Setting 72°")
  | { readonly phase: 'held'; readonly value: number }       // waiting for this key's in-flight ticket
  | { readonly phase: 'not-sent'; readonly value: number;    // shown as observed value + "Not sent"
      readonly reason: 'disconnected' | 'preview' | 'uncertain' | 'failed' | 'config' };

export class ActionController implements ReactiveController {
  constructor(host: ReactiveControllerHost, services: () => DashboardServices | undefined,
              keys: () => readonly ActionKey[]);
  status(key: ActionKey): ActionStatus | undefined;
  evaluate(req: ActionRequest): Availability;                 // enabled results carry `confirm`
  /** Immediate gestures (toggles, transport, one activated choice option). For an Availability with
   *  confirm: true the section dispatches agr-request-confirm instead; calling request() anyway returns
   *  failed('confirmation-required'). */
  request(req: ActionRequest): ActionStatus;
  /** Debounced gestures (sliders, steppers). Starts or restarts the timer; captures gateway.epoch() on the
   *  FIRST gesture of a draft. */
  draft(key: ActionKey, value: number, build: (v: number) => ActionRequest, debounceMs: number,
        observed: () => number | null): void;
  draftState(key: ActionKey): DraftState;
  clearDraft(key: ActionKey): void;                          // user dismissed "Not sent"
  hostConnected(): void;    // subscribe to gateway tickets + epoch
  hostDisconnected(): void; // cancel EVERY draft timer, drafts → idle, unsubscribe
}
```

Draft rules (these close the blind-repeat path):

1. Timer fires: if a non-terminal ticket exists on the key → `held`. Otherwise `request(build(value), { epoch })`.
2. A `held` draft is sent **only** when that ticket settles `confirmed`, the epoch is unchanged, the phase is still
   `connected`, the host is still connected, and `value` differs from `observed()`. If it equals the observed
   value, the draft becomes `idle`.
3. The ticket settles `uncertain` or `failed` → the draft becomes `not-sent` (`uncertain`/`failed`). Nothing is
   sent until a new gesture starts a new draft.
4. Epoch change → every timer is cancelled and every draft becomes `not-sent` with reason `disconnected`,
   `preview` or (gateway disposed) `config`. A reconnect never revives a draft.
5. `services()` returns a different gateway (config change) → timers cancelled, drafts `not-sent('config')`.
6. `hostDisconnected` (unmount, route change, edit-mode toggle) → timers cancelled, drafts dropped to `idle`.
   Nothing fires after the element leaves the DOM.
7. Even if a timer escaped these rules, the stale epoch makes the gateway return `not-sent` without invoking.

### 4.8 View models (`src/model/types.ts`)

All VMs are readonly plain data built by pure selectors `select<Section>(input): <Section>VM`. The input is a
`SelectorInput` plus section-specific controller state (forecast, calendar).

```ts
export interface SelectorInput { readonly config: ResolvedConfig; readonly store: StoreView;
  readonly reader: HostReader; readonly gateway: ActionGateway; readonly now: Date }
/** Literal union, so an icon missing from the curated set (§6.5) is a compile error, not a blank glyph. */
export type IconName = keyof typeof ICONS | keyof typeof CUSTOM_ICONS;   // src/icons/{icons,custom-icons}.ts

export interface ConnectionVM {
  readonly status: 'loading' | 'connected' | 'resyncing' | 'disconnected' | 'starting' | 'demo';
  readonly label: string; readonly tone: Tone }                  // resyncing → "Reconnecting"
export interface PresenceVM { readonly key: string; readonly name: string; readonly initials: string;
                              readonly presence: 'home' | 'away' | 'unknown';
                              readonly label: 'Home' | 'Away' | 'Unknown' }
export interface AlarmDisplay { readonly state: string; readonly label: string; readonly tone: Tone;
                                readonly stale: boolean }
export interface SecuritySummaryVM { readonly alarm: AlarmDisplay; readonly policy?: Display }
export interface HeaderVM {
  readonly title: string; readonly greeting: string;        // "Good evening" from local time
  readonly date: string; readonly clock: ClockParts;
  readonly people: readonly PresenceVM[]; readonly security?: SecuritySummaryVM;
  readonly connection: ConnectionVM; readonly demo: boolean; readonly diagnosticsAvailable: boolean;
}

export interface MetricVM { readonly key: 'feels' | 'wind' | 'humidity'; readonly label: string; readonly value: Display }
export interface ForecastItemVM { readonly key: string; readonly label: string; readonly icon: IconName;
  readonly conditionLabel: string; readonly temperature: Display; readonly low?: Display;
  readonly precipitation?: string }
export type ForecastVM =
  | { readonly kind: 'loading' }
  | { readonly kind: 'hourly'; readonly items: readonly ForecastItemVM[] }                     // 8 items
  | { readonly kind: 'daily-fallback'; readonly items: readonly ForecastItemVM[]; readonly note: string } // 5
  | { readonly kind: 'unavailable'; readonly reason: 'unsupported' | 'error' | 'disconnected' | 'entity';
      readonly note: string };
export interface TodayVM {
  readonly status: EntityStatus; readonly name: string;
  readonly temperature: Display; readonly unit?: string;
  readonly condition: { readonly key: string; readonly label: string; readonly icon: IconName };
  readonly high?: Display; readonly low?: Display;
  readonly highLowDay?: 'today' | 'tomorrow';   // 'tomorrow' when the first daily item is not local today
  readonly metrics: readonly MetricVM[];
  readonly sun?: { readonly kind: 'sunset' | 'sunrise'; readonly time: string };
  readonly forecast: ForecastVM;
}

export interface StepperVM { readonly value: number; readonly min: number; readonly max: number;
  readonly step: number; readonly unit: string; readonly availability: Availability }
/** Rendered only by agr-choice-group (§5.5, §7.2). `pressed` follows the OBSERVED state, never an optimistic one;
 *  the current option's availability is disabled('not-applicable', "Current mode"), so activating it sends nothing. */
export interface ChoiceOptionVM { readonly value: string; readonly label: string; readonly pressed: boolean;
  readonly availability: Availability }
export interface ChoiceVM { readonly label: string; readonly current?: string;
  readonly options: readonly ChoiceOptionVM[]; readonly pending?: ActionStatus }
export interface ClimateTileVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly current: Display; readonly target?: Display; readonly modeLabel: string;
  readonly action?: string; readonly actionLabel?: string;   // "Cooling to 72°"
  readonly setTemperature?: StepperVM; readonly hvacModes?: ChoiceVM; readonly pending?: ActionStatus }
export interface AirTileVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly power: 'on' | 'off' | 'unknown'; readonly detail: Display;           // preset or speed
  readonly toggle: Availability; readonly percentage?: StepperVM; readonly presets?: ChoiceVM;
  readonly pending?: ActionStatus }
export interface BedTileVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly current: Display; readonly target?: Display }        // read-only by construction
export interface ComfortVM { readonly summary?: { readonly label: string; readonly tone: Tone };
  readonly climate: readonly ClimateTileVM[]; readonly air: readonly AirTileVM[]; readonly bed: readonly BedTileVM[];
  readonly overflow: number }                   // tiles beyond the budget (§6.2.1), listed in the climate drawer

export interface LightVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly on: boolean | null; readonly brightnessPct: number | null;
  readonly toggle: Availability; readonly brightness?: { readonly availability: Availability };
  readonly pending?: ActionStatus }
export interface CurtainVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly label: string; readonly open: Availability; readonly close: Availability; readonly pending?: ActionStatus }
export interface RoomVM { readonly index: number; readonly name: string; readonly summary: string; readonly tone: Tone;
  readonly lightsOn: number; readonly lightsTotal: number; readonly lightsUnavailable: number;
  readonly quickToggle?: { readonly next: 'on' | 'off'; readonly availability: Availability };
  readonly lights: readonly LightVM[]; readonly curtains: readonly CurtainVM[]; readonly purifier?: AirTileVM;
  readonly pending?: ActionStatus }
export interface VacuumVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly activity: string; readonly activityLabel: string; readonly tone: Tone;
  readonly battery?: Display; readonly batteryDerived: boolean;
  readonly start?: Availability; readonly pause?: Availability; readonly returnHome?: Availability;
  readonly pending?: ActionStatus }
export interface ApplianceVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly statusText: Display; readonly remaining?: Display; readonly active: boolean }
/** Overview lists are already cut to the §6.2.1 budget; the *Overflow counts open agr-home-drawer. */
export interface HomeVM { readonly rooms: readonly RoomVM[]; readonly roomsOverflow: number;
  readonly vacuums: readonly VacuumVM[]; readonly vacuumsOverflow: number;
  readonly appliances: readonly ApplianceVM[];  // active first; idle ones beyond the budget become idleCount
  readonly idleCount: number;
  readonly studioMonitors?: { readonly availability: Availability; readonly pending?: ActionStatus } }

export type CameraGate =
  | { readonly kind: 'allowed' } | { readonly kind: 'loading' }
  | { readonly kind: 'privacy'; readonly certainty: 'on' | 'unknown'; readonly label: string }
  | { readonly kind: 'offline' | 'missing' | 'disconnected' | 'denied'; readonly label: string };
export interface CameraTileVM { readonly key: EntityId; readonly name: string; readonly gate: CameraGate;
  readonly thumbnails: boolean; readonly intervalMs: number; readonly live: Availability }
export interface CamerasVM { readonly tiles: readonly CameraTileVM[];   // first 4
  readonly overflow: number; readonly privateCount: number }

export interface GarageDoorVM { readonly name: string; readonly status: EntityStatus;
  readonly position: 'open' | 'closed' | 'opening' | 'closing' | 'unknown'; readonly label: string;
  readonly tone: Tone; readonly open?: Availability; readonly close?: Availability; readonly pending?: ActionStatus }
export interface VehicleVM { readonly name: string; readonly battery: Display; readonly batteryPct: number | null;
  readonly range: Display; readonly chargeLimitPct?: number;
  readonly charger?: { readonly status: Display; readonly power?: Display; readonly session?: Display;
                       readonly charging: boolean } }
export interface GarageVM { readonly door?: GarageDoorVM; readonly vehicle?: VehicleVM }

export interface MediaPlayerVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly playback: string; readonly playbackLabel: string;
  readonly title?: string; readonly subtitle?: string; readonly app?: string; readonly source?: string;
  readonly play?: Availability; readonly pause?: Availability; readonly next?: Availability;
  readonly previous?: Availability;
  readonly volume?: { readonly level: number | null; readonly availability: Availability };
  readonly mute?: { readonly muted: boolean | null; readonly availability: Availability };
  readonly sources?: ChoiceVM; readonly pending?: ActionStatus }
export interface MediaVM { readonly players: readonly MediaPlayerVM[]; readonly activeKey?: EntityId }
// active = first 'playing', else first 'paused', else first available, else first configured

export interface UpcomingEventVM { readonly key: string; readonly time: string; readonly title: string;
  readonly allDay: boolean; readonly calendarName: string }
export interface UpcomingVM { readonly state: 'loading' | 'ready' | 'error' | 'disconnected';
  readonly groups: readonly { readonly label: string; readonly events: readonly UpcomingEventVM[] }[];
  readonly note?: string }                                   // max 4 events, today + tomorrow

export interface PerimeterItemVM { readonly key: EntityId; readonly name: string; readonly status: EntityStatus;
  readonly position: 'closed' | 'open' | 'unknown'; readonly label: string }
export interface SecurityActionVM { readonly role: SecurityActionRole;
  readonly group: 'sound' | 'disarm' | 'hold' | 'auto' | 'departure';
  readonly label: string; readonly consequence: string;   // both from model/action-copy.ts, keyed by role
  readonly availability: Availability;                     // enabled → `confirm` decides the confirm route;
  readonly status?: ActionStatus }                         // copy is looked up by the dialog, never passed
export interface SecurityVM { readonly alarm: AlarmDisplay; readonly policy?: Display; readonly suggested?: Display;
  readonly commissioning?: { readonly status: EntityStatus; readonly on: boolean | null; readonly label: string };
  readonly health?: Display; readonly perimeter: readonly PerimeterItemVM[];
  readonly actions: readonly SecurityActionVM[] }            // only configured roles

export interface HealthVM {
  readonly perimeter?: { readonly closed: number; readonly total: number;
                         readonly open: readonly string[]; readonly unknown: readonly string[] };
  readonly devices: { readonly reporting: number; readonly total: number;
    readonly notReporting: readonly { readonly name: string; readonly status: 'unavailable' | 'missing-binding' | 'unknown' }[] };
  readonly headline: string; readonly tone: Tone;            // never "All systems normal"
}
export interface DiagnosticsVM { readonly version: string; readonly gitSha: string; readonly hostKind: HostKind;
  readonly connection: ConnectionVM; readonly haVersion?: string; readonly controls: boolean;   // config.controls
  readonly bindings: readonly { readonly role: BindingRole; readonly entity: EntityId; readonly status: EntityStatus;
                                readonly derived: boolean; readonly features?: string }[];
  readonly forecast: string;   // from services.status ('forecast'), written by the forecast controller (§5.1)
  readonly liveView?: 'native' | 'fallback' | 'demo';   // from services.status ('live-view')
  readonly cameras: readonly { readonly name: string; readonly gate: string }[];
  readonly recentActions: readonly { readonly kind: ActionKind; readonly phase: ActionPhase;
                                     readonly code?: ActionErrorCode; readonly ms?: number }[];   // gateway.recent()
  readonly configWarnings: readonly ConfigIssue[] }                                              // services.warnings
```

Selector rules worth fixing in place:

- Presence: `home` → Home. `unknown`, `unavailable` or a missing binding → Unknown. **Any other state**
  (`not_home` or a zone name) → Away. The raw state is never rendered.
- Health devices are bound entities in the roles `weather, climate, air, bed_comfort, room_light, room_curtain,
  room_purifier, vacuum, appliance_status, media, camera, camera_privacy, garage_cover, vehicle_*, alarm,
  perimeter`, de-duplicated by entity. Perimeter mapping lives in one WP0 module, `model/perimeter.ts`, used by
  both House health (WP11) and the security drawer (WP10) so they cannot drift: `binary_sensor` `on` = open,
  `off` = closed; `cover` `closed` = closed, `open`/`opening`/`closing` = open; anything else follows the
  normalization status. Headline example: "4 of 4 monitored entry points closed. 31 of 33 devices reporting."
  The word "monitored" is mandatory, so health text is never read as proof of complete coverage (IMPLEMENTATION:
  "Health text is not proof of complete coverage"). The perimeter clause appears only if a perimeter is
  configured. While `haState()` is not `RUNNING`, absent devices count as "Loading", not "Not found".
- Overview lists are cut to the content budget (§6.2.1) by the selectors, which do not depend on width. The one
  width-dependent cut is the forecast strip (8, 6 or 4 items by container query), done with `display: none` so
  hidden items also leave the accessibility tree. Forecast-strip temperatures are rounded to integers
  (`Math.round`, then the formatter): "21.5°" in 22 px Newsreader is about 45 px and does not fit a 40 px cell.
  Cell labels use `formatter.hour()` ("7 PM", "19"), never `time()`, and the strip has no horizontal padding
  inside the panel content box. The hero and metrics keep the entity's precision.
- Appliance remaining: a sensor with `device_class: timestamp` renders "Done 7:40 PM", `duration` or a numeric
  minutes value renders "35 min left", and anything else uses `formatEntityState`.

### 4.9 Error containment (HA's logging mixin turns our errors into service calls)

HA frontend 20260826.7 (`src/state/logging-mixin.ts`) converts every uncaught window `error` into
`hass.callService('system_log', 'write', {message, level: 'error'})` with the error text and stack, and every
`unhandledrejection` into `system_log.write` at level `debug`. Only ResizeObserver loop messages are filtered. An
escaped error from our card is therefore a service call made on our behalf, which the zero-service-call invariant
forbids, and its message lands in HA's log. Rules:

1. Every promise we create or receive ends in a terminal `.catch` that maps the failure to a `log.ts` code. This
   covers snapshot aborts (`AbortError`), forecast subscribe and unsubscribe promises, `face.load()`, calendar
   reads, `loadCardHelpers()` and every `port.invoke`. `void promise` without a catch is a fitness-test failure
   (grep for `void ` followed by a call that has no `.catch(` on the same statement).
2. The root's `hass` setter body, `setConfig` (apart from the deliberate not-an-object throw, D4), every Lit
   event handler and every `ReactiveController` callback are wrapped in `try/catch` that logs a code. A throw in
   the `hass` setter would also make `hui-card` replace the whole card with an error card.
3. Errors created by our code carry a code, never a URL, entity ID or HA message. `HostError` has no message
   field by design.
4. Vitest keeps its default of failing a run on unhandled errors and rejections (`dangerouslyIgnoreUnhandledErrors`
   stays false).
5. e2e: `harness.html` installs `error` and `unhandledrejection` listeners that count into
   `window.__agrPageErrors` (mirroring what HA's mixin would turn into `system_log.write`), and every spec also
   registers `page.on('pageerror')`. Every spec asserts both are 0 at the end (`e2e/helpers/errors.ts`).

---

## 5. Component tree, drawers and focus

### 5.1 Tree (all custom elements prefixed `agr-` except the card)

```text
agraharam-dashboard                       root; props: (setConfig), hass (plain setter), preview
├─ agr-config-error                       issues[] (invalid config only; replaces everything below)
├─ agr-demo-ribbon                        demo only, non-dismissible, role="status"
├─ agr-header                             HeaderVM; emits agr-open-drawer {security|household|diagnostics}
│                                         (the root listens on its shadow root and routes every overlay event)
│  ├─ agr-kolam-mark                      decorative, aria-hidden
│  ├─ agr-presence ×n                     PresenceVM (display only, not focusable)
│  ├─ agr-security-pill                   SecuritySummaryVM; <button> → security drawer
│  ├─ agr-connection-indicator            ConnectionVM
│  └─ agr-clock                           minute-aligned ticker, formatter.clock/date
├─ agr-alert-banner                       disconnected | HA starting | alarm triggered (role="alert" for alarm)
├─ columns (per layout mode, §6.2)
│  ├─ agr-home       rooms grid (agr-room-chip ≤ budget), agr-vacuum-row ×≤2, agr-appliance-row (active first),
│  │                 studio monitors; "All rooms and devices" → home drawer when anything overflows
│  ├─ agr-upcoming   only if calendars configured
│  ├─ agr-health     HealthVM; "Details" → health drawer
│  ├─ agr-today      TodayVM; agr-forecast-strip
│  ├─ agr-comfort    agr-comfort-tile ×≤2 (climate, then air, then bed); "+N more" → climate drawer
│  ├─ agr-media      active MediaPlayerVM only; transport, volume (agr-slider, plum), source → media drawer
│  ├─ agr-cameras    agr-camera-tile ×≤4; "All cameras (n)" → cameras drawer when > 4
│  └─ agr-garage     GarageDoorVM + agr-vehicle
└─ agr-overlay-host                       open(detail) / confirm(detail) / closeAll(), called by the root
   ├─ (one drawer at a time) agr-room-drawer | agr-home-drawer | agr-climate-drawer | agr-security-drawer |
   │   agr-media-drawer | agr-health-drawer | agr-household-drawer | agr-diagnostics-drawer | agr-cameras-drawer
   ├─ agr-camera-dialog                   live view (can open from a tile or from the cameras drawer)
   └─ agr-confirm-dialog                  stacked above any drawer
```

Each section receives one property, `.services: DashboardServices`, declared in `src/components/services.ts`
(WP0, M0.1):

```ts
export interface DashboardServices {
  readonly config: ResolvedConfig;          // the runtime config (the demo config in demo mode)
  readonly reader: HostReader;
  readonly store: StoreView;                // read-only (§4.5)
  readonly gateway: ActionGateway;
  readonly status: StatusBoard;             // runtime.status
  readonly warnings: readonly ConfigIssue[];  // ValidationResult warnings of the accepted input (diagnostics)
  readonly mode: 'live' | 'demo';
  readonly preview: boolean;
  readonly theme: 'light' | 'dark';         // reflected onto every dialog element by the overlay host (§5.4)
}
/** Returns the previous object unless runtime, gateway, config, warnings, mode, preview or theme changed; frozen. */
export function memoizeServices(prev: DashboardServices | undefined, next: DashboardServices): DashboardServices;

// src/ha/status-board.ts (WP0): one line per source, written by controllers, read by diagnostics only.
export type StatusSource = 'forecast' | 'calendar' | 'live-view' | 'bundle';
export interface StatusBoard {
  set(source: StatusSource, line: string): void;     // short code-like text, never a URL or entity ID
  get(source: StatusSource): string | undefined;
  subscribe(listener: () => void): Unsubscribe;
}
```

The root publishes services through `memoizeServices`, so a root render that changes nothing else passes the same
object and no section re-renders. Leaf components receive VMs and emit events, and never see `services`. The
forecast controller writes `forecast` (for example "hourly live", "daily fallback", "unsupported", "error
forecast_not_supported"), the camera dialog writes `live-view` ("native", "fallback", "demo"), the calendar
controller writes `calendar`, and `defineOnce` writes `bundle` on a version conflict. The diagnostics drawer
subscribes to the board and to `gateway.subscribe('*')`, and reads `services.warnings` and `gateway.recent()`,
so it needs no access to section internals and loses nothing while it is closed.

Headings: the wordmark is the card's `<h1>`. Every panel is a `<section aria-labelledby>` whose visible label is
an `<h2>` (styled `.t-label`), both rendered by `agr-panel` in one shadow tree (§5.5); drawer headings are
`<h2>`, and groups inside drawers are `<h3>`. Focus fallbacks (§5.4 rule 7) target these headings.
Sections must keep no state that matters across a re-render. A layout change re-creates them: thumbnails refetch
once, which is acceptable. Every focusable control carries a stable `data-focus-key` (for example
`room:2:toggle`); when a layout change re-creates sections, the root restores focus to the element with the same
key if focus was inside the columns. Overlays live outside the columns, so a rotation or sidebar toggle never
closes an open drawer.

Overlay events bubble (composed) from sections and drawers to the root's shadow root, not to the overlay host,
which is a sibling of the columns. The root listens there, stops propagation, and calls `overlayHost.open(detail)`
or `overlayHost.confirm(detail)`.

Composite tiles (room chips, comfort tiles) are two **sibling** buttons (open drawer, quick toggle), never nested
interactive elements.

### 5.2 Overlay events and drawer contract (`src/components/shell/overlay-types.ts`)

```ts
export type DrawerRequest =
  | { id: 'room'; room: number } | { id: 'home' } | { id: 'climate'; entity?: EntityId } | { id: 'security' }
  | { id: 'media'; entity: EntityId } | { id: 'health' } | { id: 'household' } | { id: 'diagnostics' }
  | { id: 'cameras' } | { id: 'camera'; entity: EntityId };
export interface OpenDrawerDetail { readonly request: DrawerRequest; readonly trigger: HTMLElement }
/** No caller-supplied copy: the dialog derives title, body and button label from the action itself. */
export interface ConfirmDetail { readonly action: ActionRequest; readonly trigger: HTMLElement }
// new CustomEvent<OpenDrawerDetail>('agr-open-drawer', { bubbles: true, composed: true, detail })
// new CustomEvent<ConfirmDetail>('agr-request-confirm', { bubbles: true, composed: true, detail })
```

The root stops propagation of both events. `agr-confirm-dialog` is the **only** caller of
`gateway.request(action, { confirmed: true, epoch })`, and an architecture test enforces it. A section dispatches
`agr-request-confirm` exactly when the control's `Availability` is `{enabled: true, confirm: true}` (§4.7).

**Drawer element contract** (M0.1, `src/components/shell/overlay-types.ts`, WP0):

```ts
/** Every drawer file (agr-room-drawer, agr-security-drawer, …) is a LitElement implementing this. */
export interface DrawerElement<R extends DrawerRequest = DrawerRequest> extends HTMLElement {
  services: DashboardServices;              // set by the overlay host before first render, updated on publish
  request: R;                               // narrowed by id, for example { id: 'room'; room: number }
}
/** Owned by WP0. The overlay host alone decides which drawer is mounted. */
export const DRAWER_TAGS: Readonly<Record<Exclude<DrawerRequest['id'], 'camera'>, string>>;
// room→agr-room-drawer, home→agr-home-drawer, climate→agr-climate-drawer, security→agr-security-drawer,
// media→agr-media-drawer, health→agr-health-drawer, household→agr-household-drawer,
// diagnostics→agr-diagnostics-drawer, cameras→agr-cameras-drawer   ('camera' mounts agr-camera-dialog)
// new CustomEvent('agr-drawer-closed', { bubbles: true, composed: true })   dispatched by agr-drawer
```

- Each drawer renders its whole body inside one `<agr-drawer heading="…" .demo=${services.mode === 'demo'}
  .theme=${services.theme}>`. Drawers never create a `<dialog>`, call `showModal()`, manage focus or render a
  close button themselves.
- `agr-drawer` (primitive, WP0) owns the `<dialog>`, calls `showModal()` in `firstUpdated` (guarded by rule 12),
  generates the heading id and sets `aria-labelledby`, renders the `<h2 tabindex="-1">` heading and gives it
  initial focus, renders the Close button and the "Demo" pill (§10.1), reflects `theme` onto the dialog as
  `data-theme` (§5.4 rule 13), chooses side or bottom sheet by viewport (§5.4 rule 9), and on the dialog's
  `close` event (Close button, Escape, backdrop, or `close()`) dispatches `agr-drawer-closed`.
- `agr-overlay-host` creates the element from `DRAWER_TAGS[request.id]`, sets `services` and `request`, mounts
  it, unmounts it on `agr-drawer-closed`, and restores focus (§5.4 rule 7). `closeAll()` unmounts the drawer;
  `agr-drawer.disconnectedCallback` closes its own dialog (§5.4 rule 11).
- `agr-camera-dialog` and `agr-confirm-dialog` extend the `agr-dialog` base (same heading, focus, theme and close
  rules, centered layout). `agr-camera-dialog` implements `DrawerElement<{ id: 'camera'; entity: EntityId }>`,
  dispatches the same `agr-drawer-closed`, stacks above the cameras drawer (it does not replace it) and restores
  focus to the tile that opened it. It disposes its live handle (or stops its fallback) on its dialog's
  `close` event **and** in `disconnectedCallback`, so `closeAll()`, Escape, backdrop and unmount all release the
  stream. `agr-confirm-dialog` sets `role="alertdialog"` on its `<dialog>`.

Confirm dialog integrity (`agr-confirm-dialog`, copy from `model/action-copy.ts`):

1. Copy is looked up by `confirmCopyFor(action, context)`: `garage.open`, `garage.close`, or `security.run`
   keyed by `role`. `context` is `{ alarm?: AlarmDisplay; departureConfigured: boolean }`, read from the store by
   the dialog and used only for the garage Open warning line (§8.5). There is no other path to dialog text, and a
   test asserts the dialog's confirm label equals the drawer or panel button label for every role and both garage
   actions.
2. On open it captures `gateway.epoch()`. It re-runs `gateway.evaluate(action)` on every gateway, target-entity,
   alarm-entity and connection change, and recomputes the copy on alarm changes. If the result is disabled, the
   confirm button is disabled and the reason is shown in place of the body's last line.
3. An epoch change (disconnect, preview, gateway disposed) closes the dialog as cancelled and announces "Not sent.
   The connection changed while this was open." Reconnecting never reopens it.
4. After `CONFIRM_DIALOG_TIMEOUT_MS` (60 s) with no response, it cancels itself with "Not sent. Confirmation timed
   out."
5. Cancel, Escape and auto-cancel send nothing.

### 5.3 Drawers and dialogs

| Element | Opened from | Content | Layout |
|---|---|---|---|
| `agr-room-drawer` | room chip | each light: toggle + brightness slider (if supported); curtains open/close (read-only with reason for garage/gate/door covers); room purifier via `agr-fan-controls` | side/bottom sheet |
| `agr-home-drawer` | "All rooms and devices" | every room (opens its room drawer), every vacuum row, every appliance row | side/bottom sheet |
| `agr-climate-drawer` | climate or air tile, "+N more" | climate: current, stepper (target), HVAC mode choice group; fan: `agr-fan-controls` (power, speed slider, preset choice group); without an entity: every comfort tile | side/bottom sheet |
| `agr-security-drawer` | header security pill, alert banner | §8 | side/bottom sheet |
| `agr-camera-dialog` | camera tile, cameras drawer | live view (embedded card with `aspect_ratio: '16:9'`, `fit_mode: 'contain'`) or snapshot fallback; name; privacy/offline states | centered, min(960px, 94vw), 16:9 |
| `agr-cameras-drawer` | "All cameras (n)" | all configured camera tiles (visible ones fetch) | side/bottom sheet |
| `agr-media-drawer` | media source chip | player picker (configured players; local view state, buttons), source list (`source_list`) as a vertical choice group, mute | side/bottom sheet |
| `agr-health-drawer` | health "Details" | perimeter list, devices not reporting, then reporting (names + status) | side/bottom sheet |
| `agr-household-drawer` | compact header menu | presence list, date, connection, Diagnostics link (admin + enabled) | bottom sheet |
| `agr-diagnostics-drawer` | header icon button (full and medium header) or household drawer | DiagnosticsVM; entity IDs appear only here | side/bottom sheet, admin only |
| `agr-confirm-dialog` | `agr-request-confirm` | title, body, confirm label from `confirmCopyFor(action, context)`; Cancel (default focus); confirm button | centered, max 420px |

### 5.4 Focus and dialog rules (`agr-dialog` base, `util/focus.ts`)

1. Every overlay is a native `<dialog>` opened with `showModal()`, which puts it in the top layer and makes the
   rest of the document inert. Each has `aria-labelledby` pointing to its heading.
2. On open, the overlay records the `trigger` from the event detail. If the trigger is gone, it falls back to the
   deep `activeElement` (walking `shadowRoot.activeElement`).
3. Initial focus: drawers focus their heading (`tabindex="-1"`) so screen readers announce context. The confirm
   dialog focuses **Cancel**, so Enter never confirms by accident. The camera dialog focuses Close.
4. Trap: on top of native inertness, a keydown handler on the dialog wraps Tab and Shift+Tab across the
   composed-tree focusables (`util/focus.ts` walks shadow roots and respects `delegatesFocus`), so focus never
   escapes to browser chrome. Tab with `altKey` is treated exactly like Tab: Safari's default moves focus to
   buttons only with Option+Tab, and Playwright's WebKit on macOS follows it.
5. Escape: the native `cancel` event closes the **topmost** dialog only. In a confirm dialog, Escape equals Cancel
   and sends no action.
6. A backdrop click closes drawers and the camera dialog, but never the confirm dialog.
7. Close restores focus to the trigger if it is still connected. Otherwise (a layout change re-created it) it
   focuses the element carrying the trigger's `data-focus-key`, recorded at open; then the originating section's
   heading; and failing that the card frame (`tabindex="-1"`).
8. Opening a drawer while another is open replaces it, and the restore target stays the original trigger.
   Confirm dialogs stack above drawers and return focus to the drawer button that opened them.
9. Dialog sizing uses viewport `@media` queries, because top-layer content should not depend on the card's
   container. Content scrolls internally with `overscroll-behavior: contain`. Viewport width ≥ 720 px: side
   sheet on the inline end, `inline-size: min(440px, 92vw)`, full viewport height. Below 720 px: bottom sheet,
   full width, `max-block-size: 92dvh`, `env(safe-area-inset-bottom)` padding. `agr-household-drawer` is always
   a bottom sheet (it only opens from the compact header).
10. Every interactive element is at least 44×44 CSS px, including icon buttons (the hit area may extend past the
    glyph). The focus ring is `outline: 2px solid var(--agr-focus); outline-offset: 2px`, shown on `:focus-visible`.
11. **Detach closes overlays.** A modal `<dialog>` that is detached and re-attached stays `open` but loses
    modality (no inertness, no backdrop, focus escapes), and a later `showModal()` throws `InvalidStateError`.
    HA detaches the card on every edit-mode toggle and after a hidden tab's panel is removed. Therefore
    `agr-overlay-host.disconnectedCallback` calls `closeAll()`: `dialog.close()` on every open dialog, dispose of
    any live-stream handle, cancel any confirm (no action), clear restore targets. Each `agr-dialog` also closes
    itself in its own `disconnectedCallback`, and in `connectedCallback` closes any dialog that is `open` but not
    `:modal`. Nothing reopens automatically after re-attach.
12. `showModal()` is called only when `!dialog.open`; otherwise `close()` first. This also covers replacing one
    drawer with another.
13. `::backdrop` uses a literal fallback, `background: var(--agr-backdrop, rgb(32 34 29 / .38))`, because custom
    properties only recently started inheriting into `::backdrop`. `:host-context()` is not cross-browser, so
    the theme reaches each dialog explicitly: the overlay host passes `services.theme` to every drawer and dialog
    element, `agr-drawer`/`agr-dialog` reflect it onto their `<dialog data-theme>`, and the dark literal is set
    by `dialog[data-theme='dark']::backdrop { background: rgb(0 0 0 / .55) }`. Each dialog also sets
    `color-scheme` from the same attribute, so native controls inside it match the theme.
14. Test split: happy-dom has `showModal()` but no inertness, no `:modal`, no Escape → `cancel`, and no
    `:focus-visible`. Unit tests therefore cover the state logic only (restore-target choice, Cancel focused by
    default, the `confirmed` flag, `closeAll()` on disconnect, rule 12). Inertness, Escape closing only the topmost
    dialog, backdrop clicks, Tab wrapping, the focus-visible ring and rule 11 are verified in
    `e2e/keyboard.spec.ts` in Chromium and WebKit.

### 5.5 Primitive contracts (`src/components/primitives/*`, M0.1)

IDREFs (`aria-labelledby`, `aria-describedby`) resolve only inside one shadow tree, and `ariaDescribedByElements`
is below the browser floor. Every primitive therefore renders its own label, reason text (visible meta, or
visually hidden when space is short) and status text **inside its own shadow root** and points to them there.
Nothing the association depends on is slotted. Events are dispatched on the primitive host with
`{ bubbles: true, composed: false }`, so they reach the section that rendered the primitive and no further.

```ts
interface AgrPanel {           // <section aria-labelledby=headingId><header>[icon] <h2 id=headingId>…</h2> [pill]
  heading: string;             //   <slot name="actions">(buttons only)</header><slot></slot></section>
  headingId: string;           // stable per section; focus fallback target (§5.4 rule 7)
  icon?: IconName;             // 16 px line icon before the uppercase label, as in the reference
  pill?: { readonly label: string; readonly tone: Tone };   // right-aligned header status pill ("Cooling")
  surface: 'hero' | 'raised' | 'quiet';
}
interface AgrButton {          // native <button>; emits 'agr-activate' (no detail) once per click/Enter/Space
  label: string; icon?: IconName; focusKey: string;
  availability: Availability;  // disabled → aria-disabled="true" + click guard (§7.2); reason via aria-describedby
  status?: ActionStatus;       // "Sending", "Done", … rendered in its own polite text
  variant: 'quiet' | 'primary' | 'confirm';
}
interface AgrChoiceGroup {     // role="group" aria-label=label; one native <button aria-pressed> per option
  label: string; focusKeyPrefix: string;
  options: readonly ChoiceOptionVM[];
  orientation: 'horizontal' | 'vertical';   // vertical for long lists (media sources), scrolls in the drawer
}                              // emits 'agr-choose' { value } once per activation of an ENABLED option
interface AgrSlider {          // native input[type=range]; emits 'agr-draft' { value } on 'change' only
  label: string; focusKey: string; value: number | null; min: number; max: number; step: number;
  valueText(v: number): string; availability: Availability; draft: DraftState;
}
interface AgrStepper {         // two buttons; emits 'agr-draft' { value } per tap, value = stepValue(base, ±1, …)
  label: string; focusKey: string; value: number | null; min: number; max: number; step: number;
  unit: string; availability: Availability; draft: DraftState;   // base = draft value while drafting/held, else value
}
```

Every button-like primitive (including each `agr-choice-group` option) calls `preventDefault()` on a `keydown`
with `event.repeat`, because held Enter would otherwise click repeatedly. That is the only key handling in
`agr-choice-group`: it never handles navigation keys (rule in §7.2).

---

## 6. Layout and visual system

### 6.1 Breakpoints (`src/styles/breakpoints.ts`)

```ts
export const BREAKPOINTS = { wide: 1080, medium: 640 } as const;   // card HOST inline-size, CSS px (D2)
export const HYSTERESIS_PX = 16;      // step down only below (bp - 16): no flapping when a scrollbar toggles
export type LayoutMode = 'wide' | 'medium' | 'narrow';
export function layoutFor(width: number, previous?: LayoutMode): LayoutMode;
/** Header variant thresholds on agr-header's own content box (`container: header / inline-size`), §6.4.
 *  Independent of LayoutMode, so the header compacts before it overflows (for example medium at 640–799). */
export const HEADER_CQ = { full: 1040, medium: 760, kolam: 380 } as const;  // below medium: compact; below
                                                                           // kolam: compact without the mark
/** Thresholds on the PANEL CONTENT BOX (container size queries measure the container's content box, i.e. after
 *  the panel's own padding). Derived from the column table below. */
export const PANEL_CQ = {
  hero96: 360,      // Today hero number 96 px
  hero80: 300,      // 80 px; below this 68 px
  forecast8: 320,   // 8 forecast cells of ≥ 40 px (cells are not interactive, so the 44 px target rule doesn't apply)
  forecast6: 240,   // 6 cells; below this 4
  cameraGrid: 280,  // 2×2 tiles; below this 1 column
} as const;
```

Panel content widths at the reference viewports (frame padding and gaps from §6.5; panel padding 20 wide, 18
medium, 16 narrow):

| Card width | Mode | Column width | Panel content box | Hero | Forecast cells | Header box → variant |
|---|---|---|---|---|---|---|
| 1384 (1440, sidebar collapsed) | wide | (1384 − 48 − 32) / 3 ≈ 435 | ≈ 395 | 96 | 8 | 1336 → full |
| 1184 (1440, sidebar expanded) | wide | (1184 − 48 − 32) / 3 ≈ 368 | ≈ 328 | 80 | 8 | 1136 → full |
| 1138 (1194, sidebar collapsed) | wide | (1138 − 48 − 32) / 3 ≈ 353 | ≈ 313 | 80 | 6 | 1090 → full |
| 1080 (wide threshold; 1136, collapsed) | wide | ≈ 333 | ≈ 293 | 68 | 6 | 1032 → medium |
| 938 (1194, sidebar expanded) | medium | (938 − 40 − 16) / 2 ≈ 441 | ≈ 405 | 96 | 8 | 898 → medium |
| 720 (720 viewport, HA narrow) | medium | (720 − 40 − 16) / 2 = 332 | ≈ 296 | 68 | 6 | 680 → compact |
| 640 (medium threshold; 640 viewport) | medium | ≈ 292 | ≈ 256 | 68 | 6 | 600 → compact |
| 390 (phone) | narrow | 390 − 24 = 366 | ≈ 334 | 80 | 8 | 366 → compact |

At the primary 1440×900 viewport the strip therefore shows 8 hours in both sidebar states, as in the wide
wireframe and the reference; the 96 px hero appears with the sidebar collapsed. The 1080, 720 and 640 rows are
the tightest content boxes at each mode's edge; `e2e/layout.spec.ts` asserts every row of this table.

Expected modes, using HA's 256 px expanded and 56 px collapsed sidebar (to be verified live, §15):

| Viewport | Sidebar | Card width | Mode |
|---|---|---|---|
| 1440×900 | expanded | ~1184 | wide |
| 1440×900 | collapsed | ~1384 | wide |
| 1194×834 | expanded | ~938 | medium |
| 1194×834 | collapsed | ~1138 | wide |
| 1136×800 | collapsed | ~1080 | wide |
| 720×900 | hidden (HA narrow) | 720 | medium |
| 640×900 | hidden (HA narrow) | 640 | medium |
| 390×844 | hidden (HA narrow) | 390 | narrow |

The root sets `data-layout` on `.frame`. Frame-level CSS keys off `[data-layout=…]`. Each panel declares
`container: panel / inline-size`, and panel internals use `@container panel (…)` with `PANEL_CQ` values,
interpolated through `unsafeCSS` from the same constants. The frame has `max-inline-size: 1680px` and centers
when wider.

### 6.2 Column assignment and order (DOM order = visual order)

| Mode | Columns | Column 1 | Column 2 | Column 3 |
|---|---|---|---|---|
| wide | `repeat(3, minmax(0, 1fr))` | Home, Upcoming?, House health | Today, Climate, Media | Cameras, Garage & car |
| medium | `repeat(2, minmax(0, 1fr))` | Today, Climate, Home | Cameras, Garage & car, Media, House health, Upcoming? | |
| narrow | `1fr` | Today, Climate, Home, Cameras, Garage & car, Media, House health, Upcoming? | | |

Medium reads column 1 then column 2 in exactly the narrow priority order, and balances at the 938 px card
(about 1,000 px against 950 px of content). Each column is a flex stack (`gap: var(--agr-gap)`). The **last
raised panel in each column** (hero or raised surface, never a quiet one) gets `flex: 1 1 auto`, so column
bottoms align as in the reference without stretching a transparent bordered box into empty space; quiet panels
below it keep their content height. A hidden optional panel (no cameras, no calendars, no vehicle and no
garage) is simply omitted and its column rebalances. If an entire column would be empty in wide mode (for
example the empty scenario has no cameras or garage), the root falls back to the medium template. The alert
banner is not a column item: it renders full-width above the columns in every mode.

#### 6.2.1 Content budget (`src/model/budget.ts`)

The overview is curated (DESIGN "curated overview"; ACCEPTANCE "balanced panels"). Real device counts are far
larger than the `normal` demo, so each panel has a fixed budget, applied by its selector in every layout mode:

| Panel | Overview shows | Overflow goes to |
|---|---|---|
| Climate | at most 2 tiles (one row, as in the reference): climate first, then air, then bed | "+N more" → climate drawer (all tiles) |
| Home: rooms | at most 6 room chips (rooms with lights on first, then config order) | "All rooms and devices" → home drawer |
| Home: vacuums | at most 2 rows (error, then cleaning or returning, then the rest) | home drawer |
| Home: appliances | active appliances (at most 3); idle ones collapse into one "N idle" row | home drawer |
| Media | the active player only (§4.8 rule) | media drawer (player picker) |
| Cameras | at most 4 tiles | "All cameras (n)" → cameras drawer |
| House health | headline + at most 3 named problems | health drawer |
| Upcoming | at most 4 events | none (today and tomorrow only) |

**Height targets** (wide, 1440×900, sidebar collapsed, `normal`). Column height available: 900 − 56 (HA
toolbar) − 48 (frame padding) − 72 (header) − 16 (gap) = 708 px. Each package designs its panel to its target
so every column stays at or below 700 px:

| Column | Panel targets (max height, px) | Sum incl. 16 px gaps |
|---|---|---|
| 1 | Home 352 (4 room chips 2×2, 1 vacuum row, 1 active appliance, studio monitors); Upcoming 180 (2 events); House health 136 | 700 |
| 2 | Today 360 (hero, metrics, 8-hour strip); Climate 140 (one row of 2 tiles); Media 168 (active player) | 700 |
| 3 | Cameras 380 (2×2 grid at the 395 px content box); Garage & car 304 | 700 |

Gates, asserted in `e2e/layout.spec.ts` with `host=fake-hass` (live-mode chrome: the demo ribbon exists only in
demo mode, where the same layout may scroll by the ribbon's height, which is reported):

- **Hard gate:** the `normal` scenario at 1440×900 with the sidebar collapsed fits the viewport height with no
  page scroll, and wide-mode column bottoms align within 2 px. Each panel's measured height and its target are
  also written to `test-results/metrics/layout.json`, so a miss names the owning package.
- **`dense` at 1440×900 (both sidebar states):** no horizontal overflow anywhere and column bottoms aligned
  within 2 px. Vertical overflow is allowed and is **reported, not failed** in the same metrics file, and WP14
  tracks it. More rooms, vacuums, appliances and health problems make a hard dense fit unreachable without
  shrinking type, which is not allowed.
- If `normal` does not fit, the budget constants are tightened in one file (for example a rooms budget of 4,
  or metrics placed inline beside the hero); panels never shrink type or targets to fit.

### 6.3 Wireframes

Wide (card at or above 1080 px):

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⁘ Agraharam                    (M) Home   (A) Away    [⛉ Armed away   ]  ● Connected    5:51 PM │
│   Good evening                                         Policy: Auto              Wed, Sep 30 │
├──────────────────────────────┬────────────────────────────────┬──────────────────────────────┤
│ HOME                         │ TODAY                Sunset 6:37│ CAMERAS            2 private │
│ ┌───────────┐ ┌───────────┐  │  ☁  69°     Partly cloudy       │ ┌──────────┐ ┌──────────┐    │
│ │Courtyard  │ │Reading rm │  │             High 71°  Low 58°   │ │Front gate│ │Side path │    │
│ │2 of 3 on ⏻│ │Off       ⏻│  │ Feels like 69°  Wind 5 mph  Hum │ └──────────┘ └──────────┘    │
│ └───────────┘ └───────────┘  │ Now 7PM 8PM 9PM 10PM 11PM 12 1  │ ┌──────────┐ ┌──────────┐    │
│ Pebble    Docked  82% [Start]│  ☁   ☁   ☾   ☾   ☾    ☾   ☾  ☾  │ │ Privacy  │ │ Offline  │    │
│ Dishwasher  Washing  35 min  ├────────────────────────────────┤ └──────────┘ └──────────┘    │
│ Studio monitors  [Toggle]    │ CLIMATE               Cooling   ├──────────────────────────────┤
├──────────────────────────────┤ ┌Bedroom cooler───┐┌Purifier──┐│ GARAGE & CAR                 │
│ UPCOMING  (only if configured)│ │74° Cooling to 72││On  Sleep  ││ Closed        [Open garage]  │
├──────────────────────────────┤ └─────────────────┘└──────────┘│  ⌐sedan¬  Demo sedan          │
│ HOUSE                        ├────────────────────────────────┤  62% ▓▓▓▓▓▓▓░░│░ 210 mi       │
│ 4 of 4 monitored entry points│ MEDIA                           │  Charger: Charging  7.2 kW   │
│ closed. 31 of 33 devices     │ ▢ Title of show   Living room  │                              │
│ reporting.        [Details]  │   ⏮  ⏯  ⏭      🔈 ──────●───    │                              │
└──────────────────────────────┴────────────────────────────────┴──────────────────────────────┘
```

Medium (640 to 1079 px; the header is shown in its medium variant, and card widths below 800 use the compact
header, §6.4):

```text
┌───────────────────────────────────────────────────────────────────────┐
│ ⁘ Agraharam        (M)(A)   [⛉ Armed away]   ●         5:51 PM Wed 30 │
├───────────────────────────────────┬───────────────────────────────────┤
│ TODAY (hero)                      │ CAMERAS 2×2                       │
│ CLIMATE                           │ GARAGE & CAR                      │
│ HOME                              │ MEDIA                             │
│                                   │ HOUSE                             │
│                                   │ UPCOMING?                         │
└───────────────────────────────────┴───────────────────────────────────┘
```

Narrow (under 640 px):

```text
┌──────────────────────────────────┐
│ ⁘  5:51 PM   [⛉ Armed away] [≡] │   ≡ opens household drawer: presence, date, connection, diagnostics
│    Wed, Sep 30                   │
│ ! Connection lost … (if any)     │
│ TODAY  69° Partly cloudy         │
│ CLIMATE                          │
│ HOME (rooms 2-up, vacuum, appl.) │
│ CAMERAS 2×2                      │
│ GARAGE & CAR                     │
│ MEDIA                            │
│ HOUSE                            │
│ UPCOMING?                        │
└──────────────────────────────────┘
```

The glyphs in the wireframes are placeholders for Lucide line icons. In the wide pill, "Policy: Auto" is a
separate second-line element, not part of the alarm label. No UI string uses middle dots.

### 6.4 Header variants (`agr-header` container query, `HEADER_CQ`)

`agr-header` is its own `container: header / inline-size` and picks its variant from its content box, not from
the column `LayoutMode` (table in §6.1). The header renders one DOM; variants differ by CSS only, and hidden parts
use `display: none` so they also leave the accessibility tree. The menu button exists in the DOM in every variant
and is shown only in compact.

- **full** (header box ≥ 1040): kolam mark (28 px, brass) + wordmark "Agraharam" (serif 26 px, `<h1>`) +
  greeting (meta). On the right: presence chips with initials and visible "Home"/"Away"/"Unknown" text; the
  security pill (actual alarm state on line one, "Policy: <value>" on line two as a separate element); the
  connection indicator (dot + label); the clock (serif 40 px tabular, period in small caps) with the date
  beneath. Diagnostics is an icon button, shown only when enabled and the user is an admin.
- **medium** (760–1039): wordmark without greeting. Presence avatars show status rings with visually hidden
  labels, and the state is never carried by color alone (WCAG 1.4.1): Home is a solid ring with a small house
  glyph badge, Away a dashed ring with no badge, Unknown a dotted muted ring with a "?" badge. The pill shows the
  full alarm label (policy appears in the drawer). The connection indicator is a dot whose label becomes visible
  when not connected. The clock is 34 px. Diagnostics is the same icon button as in full.
- **compact** (< 760): kolam mark, clock (30 px) + short date beneath, security pill with the **full** alarm label
  ("Armed away", never a truncated "Armed"), menu button. Presence and diagnostics move to the household drawer.
  The disconnected state appears in the alert banner. At 390 px the longest label ("Alarm state unknown")
  needs about 373 px against a 366 px header box, so in compact the pill's label line may **wrap** onto a
  second line (the pill grows taller, `min-inline-size: 0`), and below `HEADER_CQ.kolam` (380 px header box)
  the kolam mark is hidden.
- Pill text never truncates. When the alarm value is stale (disconnected), line one is the alarm label and line
  two reads "Last known" in every variant, instead of a single long "Last known: Armed vacation" line. The
  longest labels ("Alarm state unknown", stale "Armed vacation") are covered by `layout.spec` (the `dense`
  scenario uses `armed_vacation`, `offline` shows the stale form), which asserts that the header has no
  overflow at every width in the §6.1 table.

### 6.5 Design tokens (`src/styles/tokens.ts`)

Contrast was computed with the WCAG formula for these exact values. **Text colors come only from** `--agr-ink`,
`--agr-muted`, `--agr-olive-ink`, `--agr-brass-ink`, `--agr-danger` and `--agr-plum`; every one of them is at or
above 4.5:1 on canvas, surface, inset and hero in both themes (light muted 5.04–5.83, danger 4.75–5.50; every
dark text pair 5.1 or above). Plain `--agr-olive` (3.98:1 on canvas, 4.16:1 on inset) and `--agr-brass`
(2.6–3.0:1) are for fills, hairlines, decoration and icons that reach 3:1 against their background, never for
text and never as the only indicator of state. Tone `ok` therefore renders text in olive-ink and tone
`attention` in brass-ink. A fitness test greps component styles for `color: var(--agr-olive)` and
`color: var(--agr-brass)` and fails on either.

```css
:host {                                     /* light: primary acceptance reference */
  --agr-canvas: #e7e5d9;   --agr-surface: #f5f3e9;   --agr-surface-inset: #ebeade;
  --agr-surface-hero: #f7f5ec;              /* Today panel only */
  --agr-ink: #2c3029;      --agr-muted: #5c6155;                        /* muted 5.73:1 on surface */
  --agr-olive: #62745c;    --agr-olive-ink: #4f6249;  --agr-olive-tint: #dfe5d3;   /* ink 5.94:1 */
  --agr-brass: #a18b50;    --agr-brass-ink: #6f5c2b;  --agr-brass-tint: #efe6cc;   /* ink 5.82:1 */
  --agr-plum: #69536f;     --agr-plum-tint: #e9e1ea;                    /* 6.15:1; surface on plum 6.15:1 */
  --agr-danger: #a4453d;   --agr-danger-tint: #f3dcd7;                  /* 5.40:1; on tint 4.58:1 */
  --agr-line: #d6d3c3;     --agr-focus: #3d4f37;                        /* focus 7.96:1 */
  --agr-shadow-panel: 0 1px 0 rgb(255 255 255 / .55) inset, 0 1px 2px rgb(44 48 41 / .05),
                      0 10px 28px -18px rgb(44 48 41 / .22);
  --agr-shadow-raised: 0 1px 0 rgb(255 255 255 / .7) inset, 0 1px 1px rgb(44 48 41 / .10);
  --agr-shadow-pressed: inset 0 1px 2px rgb(44 48 41 / .14);
  --agr-shadow-overlay: 0 24px 64px -24px rgb(28 30 26 / .45);
  --agr-backdrop: rgb(32 34 29 / .38);
  color-scheme: light;                      /* native range inputs, scrollbars, dialog defaults */
  accent-color: var(--agr-plum);
}
:host([data-theme='dark']) {                /* follows hass.themes.darkMode */
  color-scheme: dark;
  --agr-canvas: #171915;   --agr-surface: #21241e;   --agr-surface-inset: #2a2e26;
  --agr-surface-hero: #242820;
  --agr-ink: #eceadf;      --agr-muted: #aeb2a3;
  --agr-olive: #8ea47e;    --agr-olive-ink: #a9bf98;  --agr-olive-tint: #2f3a2a;
  --agr-brass: #c9b072;    --agr-brass-ink: #d8c48e;  --agr-brass-tint: #3a3323;
  --agr-plum: #c3abc9;     --agr-plum-tint: #352b38;
  --agr-danger: #e8897c;   --agr-danger-tint: #43231f;
  --agr-line: #363a31;     --agr-focus: #cfe0bd;
  --agr-shadow-panel: 0 1px 0 rgb(255 255 255 / .04) inset, 0 12px 32px -20px rgb(0 0 0 / .6);
  --agr-shadow-raised: 0 1px 0 rgb(255 255 255 / .05) inset, 0 1px 1px rgb(0 0 0 / .35);
  --agr-shadow-pressed: inset 0 1px 2px rgb(0 0 0 / .45);
  --agr-shadow-overlay: 0 24px 64px -24px rgb(0 0 0 / .7);
  --agr-backdrop: rgb(0 0 0 / .55);
}
:host {
  --agr-font-display: 'Agraharam Serif', 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
  --agr-font-ui: 'Agraharam Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --agr-radius-panel: 24px; --agr-radius-inner: 15px; --agr-radius-control: 999px;
  --agr-space-1: 4px; --agr-space-2: 8px; --agr-space-3: 12px; --agr-space-4: 16px;
  --agr-space-5: 20px; --agr-space-6: 24px; --agr-space-8: 32px;
  --agr-gap: 16px; --agr-frame-pad: 24px; --agr-panel-pad: 20px;  /* medium 16/20/18, narrow 12/12/16 */
  --agr-ease: cubic-bezier(.2, .7, .2, 1);
  --agr-dur-1: 120ms; --agr-dur-2: 200ms; --agr-dur-3: 320ms;
  --agr-target: 44px;
}
@media (prefers-reduced-motion: reduce) { :host { --agr-dur-1: 0ms; --agr-dur-2: 0ms; --agr-dur-3: 0ms; } }
:host {                                     /* reset what HA's body and hui-card would otherwise leak in */
  font: 450 15px/22px var(--agr-font-ui); color: var(--agr-ink);
  letter-spacing: normal; text-transform: none; text-align: start; font-style: normal;
  -webkit-font-smoothing: antialiased;
}
```

Card height and canvas: `:host { display: block; min-block-size: 100%; background: var(--agr-canvas) }`. The host
paints the canvas, so HA's view background never shows below the fold when content is taller than the viewport
(phone, `dense`); a fixed `height: 100%` would let content overflow the host instead. `.frame` has
`min-block-size: 100%`, `padding-block: var(--agr-frame-pad)` and `padding-inline: max(var(--agr-frame-pad),
env(safe-area-inset-left)) max(var(--agr-frame-pad), env(safe-area-inset-right))`, because HA pads only the
top, right and bottom safe areas (phones in landscape).

The dev shell (§10.3) applies HA-like body typography (Roboto-like stack, 14 px, `letter-spacing: .0178em`,
`line-height: 1.43`) to its own page, so any style that leaks through the reset shows up in preview and
screenshots.

Typefaces, registered by `ensureFonts()` (§11.4):

| Family name | Source file (latin) | Axes | Size | Use |
|---|---|---|---|---|
| `Agraharam Serif` | `@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2` | wght 200–800, opsz 6–72 | 132,000 B | weather hero, clock, tile values, forecast temperatures, percentages, wordmark, condition text |
| `Agraharam Sans` | `@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2` | wght 100–900 | 34,704 B | labels, controls, names, meta and body text |

Type scale (`typography.ts` classes; `font-optical-sizing: auto` on serif):

| Token / class | Font | Size / line | Weight | Notes |
|---|---|---|---|---|
| `.t-hero` | serif | 96/0.9 (content ≥ `hero96`), 80 (≥ `hero80`), 68 | 380 | weather temperature; degree sign at 0.45em, raised |
| `.t-clock` | serif | 40/44 wide, 34 medium, 30 narrow | 420 | `tabular-nums lining-nums` |
| `.t-title` | serif | 24/30 | 450 | condition text, wordmark (26), vehicle percentage |
| `.t-value` | serif | 22/26 | 450 | tile values (72°, 82%), forecast temperatures, percentages; `font-optical-sizing: auto`, tabular lining digits |
| `.t-body` | sans | 15/22 | 450 | names, rows |
| `.t-strong` | sans | 15/22 | 620 | primary row labels |
| `.t-meta` | sans | 13/18 | 500 | secondary text (minimum size for non-label text) |
| `.t-label` | sans | 12/16 | 650 | uppercase section labels, `letter-spacing: .08em`, `--agr-muted` |

All changing numbers carry `.num { font-variant-numeric: tabular-nums lining-nums; }`.

Surfaces and hierarchy, to avoid identical cards everywhere:

- **hero** (Today): `--agr-surface-hero`, padding 24, panel shadow.
- **raised** (Home, Climate, Media, Cameras, Garage): `--agr-surface`, panel shadow.
- **quiet** (House health, Upcoming): transparent on canvas, 1 px `--agr-line` border, no shadow.
- Insets (tiles, rows): `--agr-surface-inset`, radius 15, no shadow and no border.
- Controls: pill radius, `--agr-shadow-raised`, pressed `--agr-shadow-pressed`. The primary transport button is a
  solid plum fill with surface-colored glyphs. Confirm buttons use an ink fill. Red is used only for a triggered
  alarm, the disconnected banner and failed-action text.
- Icons: Lucide IconNodes, `stroke-width: 1.75`, 20 px default (18 dense, 24 hero), `currentColor`. The full
  curated set is listed below and lands in M0.1.
- Motion: drawers slide 24 px and fade over `--agr-dur-2` (`@starting-style`; without support they simply
  appear). Pending feedback is a 2 px brass underline sweep on the button plus the text "Sending". With reduced
  motion, durations are 0, there is no sweep, the `agr-demo-stream` animation is stopped on a static frame, and
  the text alone remains. No spinners, gradients or glow.
- Camera tiles: `aspect-ratio: 4 / 3`, image `object-fit: cover`, in every state (privacy, offline and loading
  tiles keep the same box, so the panel never jumps). At the 395 px wide-mode content box the 2×2 grid is about
  300 px tall, which leaves the Garage panel a balanced share of the column instead of a large empty flex area.
  The name sits in an opaque `--agr-surface` pill (`.t-meta`, ink) inset 8 px from the bottom-left of the image,
  so its contrast never depends on the picture. No gradient scrim. Privacy, offline and "No access" tiles use the
  inset surface with an eye-off or unplug line icon, the name and the reason.
- Identity: one kolam mark beside the wordmark (a 3×3 dot lattice with one continuous looped stroke, brass, 28
  px, `aria-hidden`). It appears nowhere else.
- Avoid: middle-dot meta strings, arrow-suffixed buttons ("See all →"), monospace data labels, gradient washes,
  neon accents, and entity IDs or service names in normal UI.

Curated icon set (`src/icons/icons.ts`, M0.1). Canonical Lucide 1.51.0 file names, every one verified to exist in
the pinned package; aliases are not used (for example `circle-question-mark`, not `circle-help`). The registry key
is the kebab-case name, imported as the PascalCase export. A unit test asserts every key resolves to an IconNode.

| Area | Icons |
|---|---|
| Shell and header | `shield`, `shield-check`, `shield-alert`, `shield-off`, `menu`, `x`, `check`, `info`, `wifi`, `wifi-off`, `house`, `circle-question-mark`, `circle-alert`, `triangle-alert` |
| Today | `sun`, `moon`, `cloud`, `cloudy`, `cloud-sun`, `cloud-moon`, `cloud-rain`, `cloud-drizzle`, `cloud-rain-wind`, `cloud-snow`, `cloud-hail`, `cloud-lightning`, `cloud-fog`, `wind`, `tornado`, `snowflake`, `droplets`, `thermometer`, `sunrise`, `sunset` |
| Comfort | `thermometer`, `snowflake`, `flame`, `fan`, `wind`, `droplets`, `power`, `bed-double`, `minus`, `plus`, `leaf`, `moon` |
| Home | `lightbulb`, `lightbulb-off`, `blinds`, `power`, `play`, `pause`, `house`, `washing-machine`, `timer`, `speaker`, `plug`, `unplug` |
| Cameras | `camera`, `camera-off`, `video`, `eye-off`, `unplug`, `lock` |
| Garage and car | `car`, `zap`, `plug-zap`, `battery-charging` |
| Media | `play`, `pause`, `skip-back`, `skip-forward`, `volume`, `volume-1`, `volume-2`, `volume-x`, `tv`, `speaker`, `music` |
| Upcoming | `calendar-days`, `clock` |
| Security and health | `bell-off`, `door-open`, `door-closed`, `circle-check`, `circle-alert` |
| Custom (`custom-icons.ts`) | `kolam`, `robot-vacuum`, `garage-door`, `sedan` |

After WP0, `src/icons/*` passes to WP14. A section that needs an unlisted icon uses the closest listed one and
asks the lead to route a one-line addition to the WP14 owner; it never edits `icons.ts` itself.

---

## 7. Action semantics

### 7.1 Catalog (`src/ha/actions/catalog.ts`)

Feature masks are core 2026.9.2 values (`features.ts`). "Confirm" means the UI routes through
`agr-confirm-dialog` and the gateway requires `confirmed: true`. "Observed" is the predicate on the target
entity's state. A † marks a progress predicate.

| Kind | Allowed roles | Service | Data built by gateway | Capability | Precondition (else `not-applicable`) | Unknown state | Arg validation | Confirm | Observed | Timeout |
|---|---|---|---|---|---|---|---|---|---|---|
| light.turn_on | room_light | light.turn_on | `{}` | — | state ≠ on | allow | — | no | state = on | 10 s |
| light.turn_off | room_light | light.turn_off | `{}` | — | state ≠ off | allow | — | no | state = off | 10 s |
| light.set_brightness | room_light | light.turn_on | `{brightness_pct}` | `supported_color_modes` ∩ {brightness, color_temp, hs, xy, rgb, rgbw, rgbww, white} ≠ ∅ | — | deny | integer 1–100 | no | on and \|round(brightness/2.55) − pct\| ≤ 2 | 10 s |
| room.lights_on | room index | light.turn_on, target = available room lights | `{}` | — | ≥1 available light off | deny (unknown lights are left out of the target) | room index exists | no | every targeted light on | 15 s |
| room.lights_off | room index | light.turn_off, target = available room lights | `{}` | — | ≥1 available light on | deny (unknown lights are left out of the target) | room index exists | no | every targeted light off | 15 s |
| climate.set_temperature | climate | climate.set_temperature | `{temperature}` | TARGET_TEMPERATURE (1) | — | deny | finite; min_temp ≤ t ≤ max_temp; t on the step grid (multiple of step: `target_temp_step`, else 1 for °F / 0.5 for °C; tolerance 1e-6) **or** exactly min_temp or max_temp (`stepValue`, below) | no | \|attributes.temperature − t\| < step/2 | 20 s |
| climate.set_hvac_mode | climate | climate.set_hvac_mode | `{hvac_mode}` | — | mode ≠ state | deny | ∈ `hvac_modes` | no | state = mode | 20 s |
| fan.turn_on | air, room_purifier | fan.turn_on | `{}` | TURN_ON (32) | state ≠ on | allow | — | no | state = on | 20 s |
| fan.turn_off | air, room_purifier | fan.turn_off | `{}` | TURN_OFF (16) | state ≠ off | allow | — | no | state = off | 20 s |
| fan.set_percentage | air, room_purifier | fan.set_percentage | `{percentage}` | SET_SPEED (1) | — | deny | integer 1–100 | no | \|percentage − p\| ≤ max(1, percentage_step/2) | 20 s |
| fan.set_preset_mode | air, room_purifier | fan.set_preset_mode | `{preset_mode}` | SET_SPEED (1) **or** PRESET_MODE (8) | preset ≠ current | deny | ∈ `preset_modes` | no | preset_mode = preset | 20 s |
| vacuum.start | vacuum | vacuum.start | `{}` | START (8192) | state ≠ cleaning | deny | — | no | state = cleaning | 30 s |
| vacuum.pause | vacuum | vacuum.pause | `{}` | PAUSE (4) | state ∈ {cleaning, returning} | deny | — | no | state ∈ {paused, idle} | 30 s |
| vacuum.return_to_base | vacuum | vacuum.return_to_base | `{}` | RETURN_HOME (16) | state ∉ {docked, returning} | allow | — | no | state ∈ {returning, docked} | 30 s |
| garage.open | garage_cover | cover.open_cover | `{}` | OPEN (1) | state = closed | **deny** | — | **yes** | † opening; ✓ open; after †, closing/closed → `reversed` | 60 s |
| garage.close | garage_cover | cover.close_cover | `{}` | CLOSE (2) | state = open | **deny** | — | **yes** | † closing; ✓ closed; after †, opening/open → `reversed` | 60 s |
| curtain.open | room_curtain | cover.open_cover | `{}` | OPEN (1) | state ∉ {open, opening}; `device_class` ∉ {garage, gate, door} (else `not-allowed`) | allow | — | no | † opening; ✓ open or current_position = 100 | 60 s |
| curtain.close | room_curtain | cover.close_cover | `{}` | CLOSE (2) | state ∉ {closed, closing}; `device_class` ∉ {garage, gate, door} (else `not-allowed`) | allow | — | no | † closing; ✓ closed or current_position = 0 | 60 s |
| media.play | media | media_player.media_play | `{}` | PLAY (16384) | state ∈ {paused, idle, on} | deny | — | no | state = playing | 10 s |
| media.pause | media | media_player.media_pause | `{}` | PAUSE (1) | state ∈ {playing, buffering} | deny | — | no | state ∈ {paused, idle} | 10 s |
| media.next | media | media_player.media_next_track | `{}` | NEXT_TRACK (32) | state ∈ {playing, paused} | deny | — | no | media_title or media_content_id ≠ before | 10 s |
| media.previous | media | media_player.media_previous_track | `{}` | PREVIOUS_TRACK (16) | state ∈ {playing, paused} | deny | — | no | media_title or media_content_id ≠ before | 10 s |
| media.volume_set | media | media_player.volume_set | `{volume_level}` (rounded to 0.01) | VOLUME_SET (4) | state ≠ off | deny | finite 0–1 | no | \|volume_level − level\| ≤ 0.02 | 10 s |
| media.volume_mute | media | media_player.volume_mute | `{is_volume_muted}` | VOLUME_MUTE (8) | state ≠ off | deny | boolean | no | is_volume_muted = muted | 10 s |
| media.select_source | media | media_player.select_source | `{source}` | SELECT_SOURCE (2048) | source ≠ current | deny | ∈ `source_list` (exact) | no | attributes.source = source | 10 s |
| security.run | security_action | script.turn_on, target = `config.security.actions[role]` | `{}` (never `variables`) | domain = script | script state ≠ on ("Already running") | deny | role ∈ configured roles; script bound to exactly one role | **yes**; `silence_sound` skips it only while the alarm state is `triggered` or `pending` | last_triggered ≠ before, or state on observed, or entity `context.id` = call context | 10 s |
| studio_monitors.run | studio_monitors | script.turn_on, target = `config.studioMonitors` | `{}` | domain = script | script state ≠ on | deny | — | no | same as security.run | 10 s |

Step grid (`src/model/steps.ts`, WP0): `stepValue(base, direction, { min, max, step })` returns the next grid
value strictly above (`+1`) or below (`-1`) `base`, then clamps to `[min, max]`, rounded to 6 decimals. An
off-grid observed target therefore snaps first (22.3 with step 0.5 → `+` 22.5, `−` 22.0), and a converted,
off-grid `min_temp` (7.2) stays reachable as the clamp result. `agr-stepper` produces values only through it,
and the gateway's validation accepts exactly its outputs, so the UI and validation cannot disagree (fan
percentages, whose `percentage_step` can be fractional, additionally round to an integer for the `integer 1–100`
rule). A null or unknown observed target disables the stepper (`state-unknown`).

"Unknown state" applies when the target's normalized status is `unknown` (state `unknown` or empty, §4.6):
`allow` lets the pipeline continue (the precondition still runs, and an unknown state passes "≠" and "∉" tests),
`deny` returns `state-unknown` at step 6. The rule is conservative: only on/off toggles, curtain moves and
"return to dock", which are safe to issue blind, are allowed. Room actions target lights whose status is
`available` only. Garage always denies. A table-driven test covers every row.

The catalog contains no entry for `alarm_control_panel`, `input_*`, `select`, `switch`, `automation` or
`camera`, and no script service other than `turn_on`. Unit and fitness tests enforce this. Camera live view is
a read, not an action.

### 7.2 UI binding rules

- Toggles choose the opposite action from the observed state. If the state is unknown, the toggle becomes two
  explicit buttons ("On" and "Off", or "Open" and "Close") only where the §7.1 "Unknown state" column says
  `allow` for both kinds; otherwise it is disabled with the `state-unknown` reason.
- Confirm routing: when a control's `Availability` is `{enabled: true, confirm: true}`, the gesture dispatches
  `agr-request-confirm` and never calls `request()`. `confirmation-required` is therefore never a disabled
  reason in the UI; it can only come back from a `request()` that bypassed the dialog (a bug, logged).
- Action buttons that are unavailable use `aria-disabled="true"` plus a click guard (which also blocks Enter and
  Space), not the native `disabled` attribute. They stay in the tab order, so keyboard and screen-reader users
  can reach the button and hear its `aria-describedby` reason. Native `disabled` is used only for range inputs and
  steppers while a draft cannot be accepted, where the reason is rendered next to the control.
- Sliders (`agr-slider`, native `input[type=range]`) and steppers (`agr-stepper`) are display-and-gesture leaves:
  they emit `agr-draft` (`{ value }`) on `change` or tap and render the `DraftState` they are given. They own no
  timers and never call the gateway. The section passes each gesture to `ActionController.draft()` with
  `SLIDER_COMMIT_DEBOUNCE_MS` or `STEPPER_COMMIT_DEBOUNCE_MS`. Keyboard steps and repeated taps coalesce into one
  request. Sliders and steppers are value controls: an arrow key on a focused slider is a deliberate value change
  and becomes a draft. That is the only place an arrow key can lead to a call.
- **Choice controls** (HVAC mode, fan preset, media source, and any future option group that maps to a service)
  use exactly one pattern, `agr-choice-group` (§5.5):
  1. A `role="group"` labelled by the control name, containing one native `<button>` per option, each at least
     44×44 and each in the tab order (no roving tabindex in v1). The observed current option has
     `aria-pressed="true"`; all others `aria-pressed="false"`.
  2. **Activation is the only trigger.** One click, Enter or Space on an enabled option emits one `agr-choose`,
     and the section makes exactly one `ActionController.request()` (never a draft). Key repeat is ignored.
  3. **Arrow, Home, End, PageUp and PageDown do nothing**: the group handles no navigation keys (its only key
     handler suppresses key repeat), so browsing the options with the keyboard or a screen reader can never
     send an action.
  4. The current option is disabled (`not-applicable`, "Current mode"), so activating it sends nothing. While a
     ticket on the key is in flight, every option is disabled (`busy`); `pressed` moves only when the observed
     state changes, never optimistically.
  5. Never used for actuating choices: `<input type="radio">`, `role="radio"`/`radiogroup` (selection follows
     focus), `<select>` (Chromium fires `change` on arrow keys while closed) and `role="listbox"`. The only
     permitted alternative, a listbox whose arrows move a local selection plus a separate explicit Apply button,
     is not used in v1. A fitness test rejects these patterns in `src/components/**`.
  Long lists (media sources) use `orientation: 'vertical'` inside the drawer's scroll area. The media drawer's
  player picker is local view state, not an action, and uses plain buttons.
- Draft lifecycle (rules in §4.7): `drafting` shows "Setting 72°". While this key's ticket is in flight, more
  gestures update the draft (`held`). The held draft is sent once more **only** if that ticket settles
  `confirmed`, the connection is still up, nothing was invalidated and the value still differs from the observed
  target. After `uncertain` or `failed`, and on disconnect, preview, config change or unmount, the draft is
  discarded: the control shows the **observed** value with "Not sent" and waits for a new gesture.
- Range inputs carry `aria-valuetext` with units ("72 degrees", "40 percent", "Volume 35 percent").
- Status presentation: `pending` → "Sending". `sent` → "Waiting for <name>". `confirmed` → a check icon and "Done"
  for 4 s ("Requested" for scripts). `uncertain` → brass-ink text plus the message and a Dismiss button.
  `failed` → danger text plus the message and Dismiss. Every status is announced through one polite live region
  per section.
- A disabled control always exposes its reason as visible meta text when space allows, and always as an
  `aria-describedby` association.

### 7.3 Error copy (`messages.ts`; `{name}` = friendly name, never an entity ID)

| Code | Message |
|---|---|
| disconnected | Paused while Home Assistant is disconnected. While resyncing: "Paused until Home Assistant sends current states." (After a request: "Not sent: Home Assistant was disconnected. Nothing was changed.") |
| preview | Controls are off while you edit the dashboard. |
| controls-off | Controls are turned off in the dashboard configuration. |
| not-allowed / domain-mismatch | This control isn't set up for {name} in the dashboard configuration. |
| missing-entity | {name} wasn't found in Home Assistant. Check the dashboard configuration. |
| unavailable | {name} is unavailable right now. |
| state-unknown | {name} hasn't reported its state, so this control is paused until it does. (Garage: "The garage door hasn't reported its position, so it can't be moved from here.") |
| not-applicable | (contextual, e.g. "Already open", "Already running") |
| unsupported | {name} doesn't support this control. |
| service-missing | Home Assistant isn't offering this control right now. The integration may still be loading. |
| invalid-argument | That value is outside what {name} accepts. |
| confirmation-required | Confirm this action first. (Returned only by `request()`; never shown as a disabled reason, §7.2) |
| busy | Waiting for {name} to respond to the last request. |
| permission-denied | Your Home Assistant user can't control {name}. Ask an administrator for access. |
| not-sent | Not sent. Nothing was changed. Use the control again to send it. |
| reversed | {name} reversed before finishing. Check it before trying again. (garage copy in §8.5) |
| rejected | Home Assistant didn't accept the request: {haMessage} |
| bad-request | The dashboard sent a request Home Assistant couldn't read. Nothing changed. Please report this. |
| device-error | {name} reported an error: {haMessage}. Check the device, then try again. |
| connection-lost | The connection dropped while sending. The request may or may not have reached {name}. Check it before trying again. |
| timeout | {name} didn't confirm within {seconds} seconds. It may still respond. Check it before trying again. |
| unknown | Something went wrong sending the request. Nothing will be retried automatically. |

---

## 8. Security drawer: content and copy (`agr-security-drawer`, `security-copy.ts`)

Heading: **Security**. Three groups, in order: Status, Actions, Monitored entry points. Every value is rendered
as text (escaped). Status rows are separate elements, and the UI never combines them into one sentence.

### 8.1 Status (read-only)

| Row label | Source | Value rendering | Helper text (always shown, meta) |
|---|---|---|---|
| Alarm | `security.alarm` state | `alarm-labels.ts` (below) | Actual protection reported by the alarm panel. |
| Policy | `security.policy` | `formatEntityState` (option text verbatim) | Chooses how the house arms. It is not the alarm state. |
| Suggested mode | `security.suggested_mode` | `formatEntityState` | What the controller would choose right now. |
| Commissioning | `security.commissioning` | on → "Interlock on"; off → "Off"; other → status label | Managed outside this dashboard. |
| Health | `security.health_text` | text, capped at 200 chars | Reported by the security controller. Not a coverage test. |

Alarm labels and tones (`src/model/alarm-labels.ts`, shared with the header pill): disarmed "Disarmed" (neutral);
armed_home "Armed home", armed_away "Armed away", armed_night "Armed night", armed_vacation "Armed vacation",
armed_custom_bypass "Armed custom" (ok: olive-ink text); arming "Arming", pending "Entry delay", disarming
"Disarming" (attention: brass-ink text); triggered "Alarm triggered" (danger); unavailable "Alarm unavailable",
unknown "Alarm state unknown", missing-binding "Alarm not found" (muted); disconnected → the last known label with
`stale: true` (muted), always accompanied by a separate "Last known" text element (header pill line two, drawer
row meta). A policy value of "Auto" never changes the alarm label or tone.

### 8.2 Actions (only configured roles render; each button has its consequence line beneath)

All copy in this table, and the ticket copy below, lives in `src/model/action-copy.ts` (WP0) keyed by role.
The drawer reads button labels and consequence lines from it, and `agr-confirm-dialog` reads the confirm copy from
it by the action it will execute.

| Group heading | Button label | Consequence line | Confirm title | Confirm body | Confirm button |
|---|---|---|---|---|---|
| Sound | Silence Sound | Stops the alarm sound. Protection and the current policy stay the same. | none while the alarm is `triggered` or `pending`; otherwise "Silence Sound?" | (otherwise) Stops the alarm sound. Protection and the current policy stay the same. | Silence Sound |
| Disarm | Disarm & Hold | Turns protection off and keeps it off until you resume Auto arming or choose another hold. | Disarm and hold? | Protection turns off and stays off until you resume Auto arming or choose another hold. This is not the same as silencing the sound. | Disarm & Hold |
| Holds | Hold Night | Requests Night protection and keeps it until you resume Auto arming. | Hold Night? | The security controller will arm Night and keep it until you resume Auto arming. | Hold Night |
| Holds | Hold Away | Requests Away protection and keeps it until you resume Auto arming. | Hold Away? | The security controller will arm Away and keep it until you resume Auto arming. | Hold Away |
| Holds | Hold Vacation | Requests Vacation protection and keeps it until you resume Auto arming. | Hold Vacation? | The security controller will arm Vacation and keep it until you resume Auto arming. | Hold Vacation |
| Auto | Resume Auto Arming | Ends the current hold so the Auto policy chooses the mode again. Commissioning is not changed. | Resume Auto arming? | The Auto policy will choose the mode, which may arm or disarm the house right away. Commissioning is not changed. | Resume Auto Arming |
| Departure | Prepare garage departure | Disarms for a trusted departure through the garage. It does not open the garage door. | Prepare garage departure? | This disarms the house so you can leave through the garage. The garage door does not move. Open it separately from the Garage panel. | Prepare garage departure |

Every confirm dialog has **Cancel** as its default-focused secondary button, and Cancel sends nothing. Ticket copy
for security actions:

- pending: "Sending request"
- sent: "Request sent. Waiting for the security controller."
- confirmed: "Requested. The alarm state above updates when the controller responds."
- uncertain: "No response from the security controller after 10 seconds. Check the alarm state before trying
  again."
- failed: the §7.3 message.

The UI never claims an arm or disarm happened. Only the live Alarm row reports it.

### 8.3 Monitored entry points

A list of `security.perimeter` entries, each with name and Closed/Open/Unavailable/Not found. Footer meta:
"Only the sensors listed here are shown. A camera picture is not a monitored entry point."

### 8.4 Placement rules

- The security drawer opens from the header pill or from the alert banner's "Open Security" button.
- "Prepare garage departure" appears **only** in this drawer. The Garage panel's Open/Close buttons are
  separate, each with its own confirmation, and departure never chains a door action.
- No commissioning, walk-test, siren-test or camera-detection controls exist anywhere.
- Studio monitors (in the Home panel) shows label "Studio monitors", button "Toggle monitors", consequence
  "Switches both monitors together.", and after the tap "Requested". It never claims an outlet state.

### 8.5 Garage panel copy (`agr-garage`)

- Door states: Closed, Open, Opening, Closing, Position unknown, Unavailable, Not found.
- Buttons: "Open garage" when the door is closed; "Close garage" when it is open. Both are disabled while the
  door is moving or its position is unknown, with the reason shown.
- Open confirm: title "Open the garage door?", body "The door starts moving when you confirm. Make sure the
  doorway is clear.", button "Open garage".
- Open confirm, alarm-aware line (`confirmCopyFor(garage.open, context)`, recomputed live while the dialog is
  open). The garage cover is commonly also a perimeter entry, so opening it while the house is armed can set
  off the alarm. When `security.alarm` is configured, one extra body line is added before the last line:
  - alarm `armed_*` or `arming`: "The alarm is {alarm label}. Opening the garage may set it off." followed, when
    `prepare_departure` is configured, by "To leave without setting it off, use Prepare garage departure in
    Security first."
  - alarm `unknown`, `unavailable`, missing or stale (disconnected): "The alarm state isn't available right now.
    Opening the garage may set it off if the house is armed."
  - `disarmed`, `pending`, `triggered`, `disarming`: no extra line.
  The line is information only. The dialog never offers a shortcut to Security, never chains the departure
  script, and the Open button keeps its own single confirmation. Close confirm has no alarm line (closing does
  not open an entry point).
- Close confirm: title "Close the garage door?", body "The door starts moving when you confirm. Make sure
  nothing is in the doorway.", button "Close garage".
- Uncertain: "The door hasn't reported open after 60 seconds. Check the garage before trying again." (or
  "closed" for a close request).
- Reversed (close request): "The door reversed and is opening again. Check the doorway before trying again."
  Reversed (open request): "The door stopped opening and is closing again. Check the garage before trying again."
  Both show at once when the reversal is observed, in danger text.
- Confirm copy above lives in `model/action-copy.ts`, keyed by `garage.open` and `garage.close`, with the alarm
  line built from `model/alarm-labels.ts`.

---

## 9. Lifecycles

### 9.1 Root and connection

HA detaches and re-attaches the **same** card element on every edit-mode toggle (`hui-panel-view` moves `hui-card`
into `hui-card-options` and back) and after a tab has been hidden for 5 minutes (`partial-panel-resolver` removes
and re-appends the panel; `suspendWhenHidden` is on by default, so a sleeping wall tablet hits this daily). After
an admin saves the dashboard elsewhere, `lovelace_updated` makes `hui-card` call `setConfig` again on the live
element. The root's lifecycle is therefore explicit:

| Event | Root does | Survives | Torn down |
|---|---|---|---|
| `setConfig` invalid | overlay host `closeAll()`; render `agr-config-error`; dispose gateway and runtime | nothing | overlays, runtime, gateway, services |
| `setConfig` valid, same runtime key | overlay host `closeAll()`; dispose the old gateway; create a new gateway from the new config; publish new services | host, store, in-flight registry | open drawers and dialogs (a drawer keyed by room index could otherwise show a different room), old gateway (its tickets → uncertain; drafts → `not-sent('config')`) |
| `setConfig` valid, new runtime key | overlay host `closeAll()`; dispose gateway and runtime; build both lazily on next `hass`/connect; publish new services | in-flight registry | open drawers and dialogs (a live stream's `track()` registration dies with the host and its embedded card would keep a stale `hass`), host, store, gateway; every `EntityController` resubscribes to the new store |
| `set hass` (live) | `ensureRuntime()`; `HassHost.update(h)` | everything | nothing |
| `set hass` (demo) | read `h?.themes?.darkMode` only → `data-theme` | everything | nothing |
| `preview` true | `gateway.invalidate('preview')`; publish services (`preview: true`) | tickets, locks | drafts, open confirm dialogs (epoch change) |
| `disconnectedCallback` | stop the `ResizeObserver` and the minute ticker; overlay host `closeAll()` (§5.4 rule 11); controllers cancel drafts; start the orphan timer (`ORPHAN_DISPOSE_MS = 60_000`) | runtime, store, **gateway with its tickets and locks** (until the orphan timer fires) | dialogs, live streams, drafts, debounce timers, snapshot timers, forecast and calendar work (controllers) |
| orphan timer fires (detached 60 s) | dispose gateway (tickets → uncertain) and runtime (unsubscribes from the ResyncTracker); drop services | in-flight registry, ResyncTracker (module level) | gateway, runtime, store and the last `hass` they held |
| `connectedCallback` | cancel the orphan timer; `ensureFonts()`; measure the initial layout (D2); `ensureRuntime()`, which recreates the runtime and gateway if missing or `disposed` (lazily on the next `hass`); publish services (memoized); restart the observer and ticker; `runtime.tick()` | | |

The `hass` setter body and `setConfig` (after the deliberate not-an-object throw) run inside `try/catch` that logs
a code (§4.9), so one bad update can never escape to HA's logging mixin or make `hui-card` swap in an error card.
An accepted `setConfig` that is deep-equal to the current input is a no-op (HA re-sends identical configs after
`lovelace_updated`), so an unrelated dashboard save does not close an open drawer.

Runtime key = `hostKind + '|' + demoScenario + '|' + sorted bound IDs`. A `setConfig` that flips `demo` with
identical bindings therefore always replaces the host, so a `HassHost` can never stay alive under the demo label,
nor a `DemoHost` under a live one. The gateway is rebuilt on **every** accepted config, even with the same key,
because role assignments (for example which script is `disarm_hold`) can change without changing the bound set.

Why the gateway survives detach: its timers only settle tickets (they never send), and nothing can call
`request()` while the card is detached, because drafts and dialogs are torn down. Keeping it means a quick
edit-mode toggle cannot erase the garage lock while an `open_cover` is in flight. The module-level in-flight
registry (§4.7) extends the same protection to a brand-new card instance after a real route change, and across
the orphan disposal. HA leaves old card instances behind on route changes and rebuilds the element on preview
config changes; after 60 s detached, the orphan timer disposes the runtime and gateway, so nothing on the
page-lifetime `hass.connection` (only the module-level ResyncTracker listens there) retains the detached card
tree, its store or its last states map. A hidden-tab resume after the timer simply rebuilds the runtime from the
next `hass`; the tracker still knows whether a snapshot is outstanding.

The minute ticker (`util/time.ts`) fires on minute boundaries and on `visibilitychange` to visible (realigning
after sleep), and calls `runtime.tick()` (which calls `EntityStore.tick()`), emitting meta `'clock'`.

```text
Connection phase (store meta 'connection', the live socket getter and the resync barrier, §4.4):
  loading      ──first ingest, barrier clear──────────────────────► connected
  loading      ──first ingest, barrier armed (tracker shared)─────► resyncing
  connected    ──connected=false──────────────────────────────────► disconnected
  connected    ──'ready' or new connection object, no disconnect seen► resyncing
  disconnected ──connected=true or 'ready'────────────────────────► resyncing
  resyncing    ──ingest with a hass.states reference ≠ base()─────► connected
  resyncing    ──connected=false──────────────────────────────────► disconnected
  on → disconnected or resyncing (leaving connected): gateway epoch increments (drafts and confirm dialogs
         discarded as "Not sent"); reader.connectionGeneration() increments (old subscriptions are never
         unsubscribed later, §9.2); banner "Connection to Home Assistant lost. Showing last known values.
         Controls are paused until it reconnects." (resyncing: indicator "Reconnecting", banner "Reconnecting
         to Home Assistant. Showing last known values until current states arrive."); every Availability →
         disabled('disconnected'); values stale ("Last known"); forecast subscriptions closed; every camera
         image revoked AT ONCE and the tile shows the disconnected state (the privacy state behind a picture is
         unknown while disconnected, so uncertainty defaults to private/offline); pending tickets settle
         through their promise or timeout; nothing is queued.
  on resyncing → connected (the ingest that clears the barrier, never earlier): banner removed; every entity re-notified
         once (new identities); forecast resubscribes; visible cameras whose gate is allowed fetch once
         (privacy entity fresh, §9.3); calendars refresh once. Zero service calls; no replay; no draft revived.
  config.state = STARTING: connection indicator "Starting", banner "Home Assistant is starting. Some devices may
         show as unavailable."
```

### 9.2 Weather forecast (`forecast-controller.ts`, `ha/hass/forecast.ts`)

```text
Inputs: weather binding W, store (connected, W entity, supported_features), host attached.
Needed types from features: hourly if HOURLY(2); daily if DAILY(1), else twice_daily if TWICE_DAILY(4).
States per type: idle → subscribing → live(payload) | unsupported | error
  start when: element connected ∧ phase=connected (so never during resyncing: a restart waits for the
       post-reconnect snapshot) ∧ W bound ∧ W present and not unavailable ∧ bit present
  stop (call unsub once, mark idle) when: element disconnected ∨ phase≠connected ∨ W changes ∨
       W becomes unavailable/missing ∨ the relevant feature bit disappears
  restart when the start conditions become true again (a new subscription object, not a hajs replay)
  message: {type:'weather/subscribe_forecast', entity_id: W, forecast_type: T}, options {resubscribe:false}
  events after stop are ignored (the controller's own request counter, distinct from the socket generation);
  forecast:null → live with an empty list
  errors: 'forecast_not_supported' → unsupported; 'invalid_entity_id' → error('entity'); other → error
  retry: error('entity') (likely while HA is starting) gets ONE new attempt when haState becomes RUNNING and
       one on each 'registry' meta change; no timers, no other automatic retry
  teardown details (subscribeForecast in ha/hass/forecast.ts returns a synchronous Unsubscribe):
    - the stop path NEVER awaits subscribeMessage: a subscribe started while the socket is closing with
      resubscribe:false may never settle in hajs
    - socket generation: the seam records g0 = generation() when it calls subscribeMessage. A hajs unsub is
      called ONLY while generation() === g0. If the generation moved on, the unsub is dropped, never called:
      the server-side subscription died with the old socket, and hajs 9.6.0 resets commandId to 1 on close,
      so the new socket reuses low IDs for HA's own resubscriptions (subscribe_entities, registries). An old
      unsub would then see connected === true, send unsubscribe_events with the old ID and delete
      commands[oldId], killing HA's own subscription: hass.states would freeze while connected stays true,
      showing stale alarm and garage states as live. The stop-on-disconnect path normally runs first, but a
      card that was detached across a reconnect (hidden-tab suspend) reaches stop only afterwards.
    - stop before subscribeMessage resolved → mark cancelled; when it resolves, call the returned unsub
      immediately if generation() === g0, otherwise drop it (same reason)
    - every permitted unsub call ends in `.catch(() => log('forecast-unsub-failed'))` (§4.9); a rejection is
      logged, never thrown
    - writes services.status 'forecast' on every state change (§5.1)
VM mapping: hourly live → 'hourly' (next 8 from now);
            no hourly but daily/twice_daily → 'daily-fallback' (5 days) +
              note "Hourly forecast isn't provided by this weather source.";
            neither → 'unavailable' + "This weather source doesn't provide a forecast.";
            error → 'unavailable' + "Forecast couldn't be loaded. Current conditions are still live.";
            disconnected → 'unavailable' + "Forecast paused while disconnected."
High/low: first daily item (temperature, templow); twice_daily → first daytime temperature / first night
          temperature (or templow); absent otherwise. Never inferred from hourly data. Some integrations return
          tomorrow as the first daily item in the evening: the item's local date (in the formatter's time zone)
          is compared with today, and the label reads "Tomorrow: High 71° Low 58°" when they differ.
Sun: sun.sun state below_horizon → "Sunrise <next_rising>", else "Sunset <next_setting>" (formatter.time).
No timers. Teardown leaves zero subscriptions.
```

### 9.3 Camera thumbnail (`snapshot-controller.ts`, `camera-gate.ts`, `agr-camera-tile`)

```text
gate = cameraGate({ready, live, resyncing, camera, privacy?: {state, onValue, fresh}}), first match (fails
CLOSED). live = store.isConnected() (false while disconnected AND while resyncing); fresh =
store.freshSinceResync(privacy entity):
  !ready → loading
  !live → disconnected ("Paused while disconnected"; resyncing: "Reconnecting")
  privacy configured:
    offValue = (onValue === 'on' ? 'off' : 'on')
    privacy entity missing ∨ !fresh ∨ state ≠ offValue → state = onValue ∧ fresh ? privacy(on) "Privacy on"
                                                       : privacy(unknown) "Privacy status unavailable"
    (so unknown, unavailable, empty and ANY unexpected string such as "On", "true" or "enabled" block the
     camera, as does a privacy entity whose object the post-reconnect snapshot did not replace, for example
     one deleted during the outage; only the exact opposite value, freshly delivered, lets the checks below run)
  camera missing → missing "Camera not found"
  camera unavailable → offline "Offline"
  else → allowed
fetchAllowed = gate=allowed ∧ thumbnails ∧ tile intersecting (IntersectionObserver, threshold 0.1)
               ∧ document.visibilityState = 'visible' ∧ !denied
States: idle ─fetchAllowed─► fetching ─ok─► showing ─interval─► fetching …   (interval = snapshot_interval,
                                                                              default 10 s, min 5 s)
                                       └err─► error(backoff interval→×2→…→120 s) | denied (401/403: stop)
  401 is session-level: HassHost's camera session denial (§4.4) makes every other tile's next fetch, and the
      live-view fallback, reject at once without a request, so all tiles show "No access" after ONE counted
      attempt; it clears on reconnect or a 'user' meta change. 403 stays per tile.
  fetchAllowed → false (hidden/offscreen): abort in-flight, clear timer, KEEP the current image
  gate → disconnected | privacy | offline | missing: abort, clear timer, REVOKE the object URL, drop the image
         immediately. This includes disconnect and resync for every camera, with or without a privacy binding:
         while the state is uncertain the tile is offline, never a dimmed "last image"
  result arriving after the generation changed (gate changed, bound ID changed, unmount): revoke, discard
  min refetch interval = interval − 1 s; size = tile box × devicePixelRatio rounded up to a 160 px step
  (max 640 wide)
  unmount: abort, clear timers, revoke, disconnect observers, remove visibility listener
"Changed" means the bound camera ID, the privacy ID or the gate result changed, never a new state object: the
camera's access_token attribute rotates every 5 minutes, which creates a new entity object each time.
denied resets on a bound-ID change, reconnect or 'user' meta change. URLs and Blobs are never logged or stored.
Privacy tiles: inset surface, eye-off line icon, name, "Privacy on"/"Privacy status unavailable", no live button.
thumbnails: false tiles: inset surface, camera line icon, name, "Live view on request", live button (gated the
same way). Cameras without a privacy binding use this mode by default in the generated private config (§13.4);
the operator opts a camera in explicitly. install/README.md explains why.
Every tile, in every state, is a 4:3 box (§6.5).
```

### 9.4 Camera live view (`agr-camera-dialog`, `ha/hass/camera.ts`)

```text
open(entity): require gate=allowed ∧ !preview, else the dialog shows the gate reason and never starts
  handle = await reader.openLiveStream(entity)
    HassHost → openLiveStream(ctx, entity) in ha/hass/camera.ts:
              window.loadCardHelpers (3 s timeout) → createCardElement({type:'picture-entity', entity,
              camera_view:'live', aspect_ratio:'16:9', fit_mode:'contain', show_name:false,
              show_state:false, tap_action:{action:'none'}, hold_action:{action:'none'},
              double_tap_action:{action:'none'}}); el.hass = ctx.hass();
              untrack = ctx.track(el) (every HassHost.update assigns el.hass; never recreated by updates)
              containment wrapper: el is mounted inside a <div> that listens (capture: false) for EXACTLY
              ll-upgrade, ll-rebuild, ll-custom, card-visibility-changed, hass-more-info and hass-action and
              calls stopPropagation() on each, so none reaches hui-card or HA's root (an escaped ll-rebuild would
              rebuild the whole Agraharam card; hass-more-info would open HA's raw more-info controls).
              Every other event passes untouched. In particular `context-request` MUST keep bubbling: on 2026.7+
              ha-camera-stream gets hassConnection, hassApi and hassConfig only through it, so stopping it would
              silently break native live view. No catch-all listener, no stopImmediatePropagation.
              ll-upgrade is handled locally by re-assigning el.hass. A contained ll-rebuild means the embedded
              card's setConfig threw after the upgrade and the box is now empty: the handle fires
              onFail('helpers-failed'), and the dialog disposes it and switches to the snapshot fallback (after
              re-running the gate). handle.element is the wrapper. The wrapper sets --ha-card-background and
              --card-background-color to near-black rgb(17 18 16) in both themes, so fit_mode 'contain'
              letterbox bars match video rather than HA's theme card color.
    DemoHost: {kind:'demo', element: <agr-demo-stream>}
  native|demo → mount handle.element in a 16:9 box (--ha-card-border-radius / box-shadow overridden);
                aspect_ratio + fit_mode make the embedded card fill that box instead of sizing to the stream
  unsupported → snapshot fallback: fetchCameraSnapshot every 2 s while open+visible; label
                "Snapshot view. Refreshes every 2 seconds."
  writes services.status 'live-view' = native | fallback | fallback (helpers-failed) | demo
dispose (handle.dispose(): untrack, remove listeners, detach element; fallback: abort + revoke + clear timer)
  on: the dialog's 'close' event (covers Close, Escape, backdrop and closeAll) ∨ disconnectedCallback (unmount,
      card detach) ∨ gate leaves 'allowed' (privacy on/unknown, offline, disconnect) ∨ document hidden
      ("Paused while this tab is hidden")
  resume after hidden → visible while the dialog is still open: re-run the FULL open gate (gate=allowed ∧
      !preview ∧ phase=connected, all read fresh) before calling openLiveStream again; if any check fails,
      the dialog shows that reason and starts nothing (privacy may have turned on while the tab was hidden)
At most one live stream exists at a time (a single agr-camera-dialog instance).
```

HA's native stream element uses short-lived token URLs internally (MJPEG `?token=`, HLS path tokens). Our code
never reads its attributes, children or network activity; diagnostics reports only "native", "fallback" or
"demo" for the live view and never inspects the embedded element. Our own stills path never places a URL in the
DOM.

### 9.5 Calendar (`calendar-controller.ts`, `ha/hass/calendar.ts`)

The calendar is active only when `calendars[]` is configured. It fetches on connect, then every 15 minutes while
`phase = connected ∧ document visible`, and once when the phase returns to `connected` after a reconnect (that
is, after the resync barrier clears, never during it). The window is now → end of tomorrow. Each refresh uses a
new AbortController, and earlier results are discarded. Teardown aborts and clears the timer. Errors show
"Calendar couldn't be loaded." and keep the previous events, marked stale. The request path and query are built
with `encodeURIComponent` and `URLSearchParams` (§4.4). Today/tomorrow grouping re-runs on the `'clock'` meta, so
the groups roll over at midnight without a refetch.

---

## 10. Demo host, scenarios and fake HA shell

### 10.1 Demo isolation

- With `config.demo === true`, the root constructs `DemoHost` and **never** constructs `HassHost`. The gateway
  receives `DemoHost.port`. The real `hass` is read for `themes.darkMode` only. No `callService`, `callApi`,
  `fetchWithAuth` or `subscribeMessage` happens on the real object (tested with spies). The runtime config is
  `validateConfig(demoCardInput(scenario))`, computed by the root (§4.2 rule 9).
- `DemoHost` uses only in-memory fixtures and timers. Actions simulate a 400–1200 ms latency, then mutate
  fixtures so observed-state confirmation runs through the real gateway logic.
- Labeling: `agr-demo-ribbon` at the top of the frame reads "Demo mode: fictional data. Nothing here controls a
  real home." (non-dismissible, `role="status"`). The connection indicator reads "Demo", and each drawer header
  shows a small "Demo" status pill, rendered by the `agr-drawer` primitive (and the `agr-dialog` base) from
  `services.mode`, never by individual drawers (§5.2).
- Fixtures are fictional: people "Meera" and "Arun", rooms "Courtyard", "Reading room", "Kitchen", "Workshop",
  robot "Pebble", vehicle "Demo sedan", cameras "Front gate", "Side path", "Courtyard", "Hall". All IDs are
  `*.demo_*`, enforced for every public test, demo, dev and install file by the public-literal test (§11.1).
  Demo camera images are generated SVG scenes, never photos.

### 10.2 Scenarios (`?scenario=` in the dev shell; `demo_scenario` in card config)

Fixture contract (`src/demo/fixture-types.ts`, WP0, M0.1). Each section package owns exactly one fixture file and
never edits `configs.ts`, `scenarios.ts`, `simulate.ts`, `demo-host.ts` or `fake-hass.ts`:

```ts
/** Every time in a fixture is relative to `now`, so `npm run dev` on any day shows "next 8 hours", today/tomorrow
 *  groups, sunset and "Done 7:40 PM" correctly, and e2e (pinned clock) sees the same layout. */
export interface FixtureClock {
  readonly now: Date;
  at(offsetMin: number): string;                               // ISO string, now + offset
  dayAt(dayOffset: number, hour: number, minute: number): string;   // local wall time on today + dayOffset
}
export function fixtureClock(nowMs: number): FixtureClock;
export interface SectionFixture {
  config(s: DemoScenarioId): Partial<CardConfigInput>;        // this section's binding keys only (no times)
  states(s: DemoScenarioId, clock: FixtureClock): readonly HassEntityLike[];
  registry?(s: DemoScenarioId): readonly RegistryEntryLike[];
  behaviors?(s: DemoScenarioId): readonly DemoBehavior[];
  forecasts?(s: DemoScenarioId, clock: FixtureClock): Partial<Record<ForecastType, readonly ForecastItem[] | 'error'>>;
  calendarEvents?(s: DemoScenarioId, clock: FixtureClock): Readonly<Record<string, readonly CalendarEventLike[]>>;
}
export interface DemoBehavior {
  readonly entity: EntityId;
  readonly onInvoke?: 'apply' | 'reject-validation' | 'reject-unauthorized' | 'never-confirm' | 'connection-lost';
  /** unauthorized = 401 (session-level, §4.4); forbidden = 403 (this tile only); unavailable = 503. */
  readonly snapshot?: 'ok' | 'unauthorized' | 'forbidden' | 'unavailable';
}
/** Host-level scenario facts, owned by WP0 in scenarios.ts. */
export interface ScenarioSpec {
  readonly id: DemoScenarioId;
  readonly connection: 'connected' | 'drop-after-first-ingest';
  readonly haState: 'RUNNING' | 'STARTING';
  readonly haVersion: string;                                  // diagnostics; fictional-safe, e.g. '2026.9.2'
  readonly user: { readonly is_admin: boolean };               // 'restricted': false
  /** 'domain.service' strings removed from hass.services ('starting': one, to show service-missing). */
  readonly missingServices: readonly string[];
  readonly holdFirstIngest: boolean;                           // 'loading'
  readonly defaultInvoke?: DemoBehavior['onInvoke'];           // 'restricted': reject-unauthorized
  readonly defaultSnapshot?: DemoBehavior['snapshot'];         // 'restricted': unauthorized
}
export interface AssembledScenario {
  readonly spec: ScenarioSpec; readonly input: CardConfigInput; readonly states: readonly HassEntityLike[];
  readonly registry: readonly RegistryEntryLike[]; readonly behaviors: ReadonlyMap<EntityId, DemoBehavior>;
  readonly forecasts: Partial<Record<ForecastType, readonly ForecastItem[] | 'error'>>;
  readonly calendarEvents: Readonly<Record<string, readonly CalendarEventLike[]>>;
}
export function assembleScenario(id: DemoScenarioId, clock: FixtureClock): AssembledScenario;   // scenarios.ts
export function demoCardInput(id: DemoScenarioId): CardConfigInput;  // configs.ts: merged config fragments only,
                                                                     // plus controls: true (no clock needed)
export function simulateServiceCall(call: ServiceCall, states: ReadonlyMap<EntityId, HassEntityLike>,
                                    now: number): readonly { atMs: number; state: HassEntityLike }[]; // simulate.ts
```

Assembly is generic: `fixtures/index.ts` lists the nine section fixtures (fixed by WP0). Config fragments are
deep-merged (arrays concatenated, objects merged; two fixtures setting the same scalar key is a test failure),
states concatenated (a duplicate `entity_id` is a test failure), behaviors keyed by entity. `simulateServiceCall`
covers every service in §7.1 (for example covers go `opening` then `open`, scripts get a new `last_triggered` and
`context`, lights get `brightness`), returning timed steps. `DemoHost` and `FakeHass` both consume the same
`AssembledScenario` and `simulateServiceCall`, so the browser preview and the unit tests can never disagree. A
test asserts that `validateConfig(demoCardInput(id))` is `ok` with no warnings for every scenario.

| ID | Purpose | Contents |
|---|---|---|
| normal | primary visual reference; the §6.2.1 hard gate | everything available; daily+hourly forecast; alarm disarmed, policy "Auto"; comfort exactly 1 climate + 1 air purifier (2 tiles, no overflow, no bed tile); home 4 rooms, 1 vacuum, 1 active appliance, studio monitors; 2 media players (one playing, one `off`; the overview shows the playing one); 4 cameras (one privacy on); garage closed, vehicle 62% charging; 2 upcoming events today; 4 perimeter sensors closed. Fits the §6.2.1 height targets |
| degraded | honest-state review | one light unavailable; one purifier unavailable; one camera offline, one privacy on, one privacy entity unknown, one privacy entity reporting an unexpected string; **daily-only** forecast; vacuum error; appliance remaining `null`; one configured appliance status sensor **missing** ("Not found"); one perimeter door open; vehicle range unavailable; garage cover in `unknown` position ("Position unknown", Open/Close disabled); a light that rejects actions (`reject-validation`); a fan that never confirms (`never-confirm` → uncertain timeout); every media player `off` (the overview shows the compact "Off" row), and the first one rejects calls with `connection-lost` (→ `uncertain('connection-lost')` after a tap); a curtain whose cover has `device_class: garage` (read-only) |
| offline | disconnected review | initial snapshot, then `connected=false` (and the live socket getter false): stale values, banner, stale "Last known" alarm pill, all controls unavailable |
| empty | missing integrations | weather only, with **no forecast feature bits** ("This weather source doesn't provide a forecast."), + a configured but missing garage cover; no cameras, media, vehicle or calendars → panels hidden, layout rebalances |
| alert | danger styling | alarm `triggered`, policy "Hold Away", alert banner; Silence Sound without confirmation; its script has `never-confirm`, so `screenshots.spec` taps it to capture the sent ticket and, after advancing the clock 10 s, the uncertain ticket (tickets cannot be preloaded through a fixture) |
| loading | first paint | `DemoHost` holds back the first ingest until the shell's "Deliver first update" control (or `releaseFirstIngest()`): skeletons everywhere, no "Not found" |
| restricted | non-admin, limited user | snapshots `unauthorized` (401: every camera tile "No access" after one attempt, no retries); every action rejected as Unauthorized, so the first tap shows the permission message and the control stays disabled; diagnostics hidden (`is_admin: false`); the weather entity itself `unavailable` (the Today hero's unavailable state, no forecast subscription) |
| starting | HA restart | `haState: 'STARTING'`; several bound IDs absent (→ "Loading", not "Not found"); one service missing via `missingServices` (→ `service-missing`); forecast subscription returns an **error** ("Forecast couldn't be loaded. Current conditions are still live."); "Starting" indicator and banner |
| dense | real-world density | near the configuration limits, fictional names: 1 climate, 4 air, 2 bed, 8 cameras (2 with privacy), 3 vacuums, 4 media players, 9 lights in 7 rooms, 4 curtains, 4 appliances, 4 perimeter sensors; long names and media titles to test truncation; alarm `armed_vacation` (longest pill label); hourly forecast; the second camera `forbidden` (403: only that tile "No access"); used for the §6.2.1 metrics |

Every designed fallback therefore has a scenario for screenshot review: daily-only (degraded), no forecast
(empty), forecast error (starting), weather unavailable (restricted), unknown garage position (degraded),
privacy on, unknown and unexpected (degraded), session 401 (restricted) and single-tile 403 (dense), media off
and `uncertain('connection-lost')` (degraded), uncertain security ticket (alert, driven by e2e), non-admin
(restricted), stale alarm (offline).

### 10.3 Fake HA shell (`src/dev/ha-shell.ts`, `index.html`, `harness.html`; not in the bundle)

- `<dev-ha-shell>` reproduces HA's chrome: a 56 px top toolbar and a sidebar that is 256 px expanded, 56 px
  collapsed, and hidden below a 870 px viewport (HA narrow, with a menu button). The main area is
  `min-height: 100vh` minus the toolbar, matching the panel view's chain (the card host gets `display: block;
  min-block-size: 100%`, §6.5).
- Toolbar controls: Scenario select, Theme (light/dark), Sidebar (expanded/collapsed), Host (`demo` |
  `fake-hass`), Connection (fake-hass only), "Deliver first update" (`loading` only), and three remount modes on
  the **same** element: "Route change" (remove, wait 1 s, re-append), "Edit-mode toggle" (move the element into a
  wrapper, set `preview = true`, then move it back and set `preview = false`, as `hui-card-options` does), and
  "Hidden 5 min" (set visibility hidden, drop the connection with `connected=false` and the socket getter false,
  remove the panel, then re-append, run FakeHass's two-step reconnect below and set visibility visible), plus
  "Outage change" (fake-hass only: while disconnected, queue a change such as a privacy switch turning on, to be
  delivered only in the reconnect snapshot). Query params: `scenario`, `theme`, `sidebar`, `host`; the shell
  keeps no other state (no storage APIs, §12.1 row 11). The toolbar title reads "Agraharam preview (not Home
  Assistant)". The shell page uses HA-like body typography (§6.5) so style leaks are visible.
- `host=fake-hass`: the card runs with `demo: false`, the card input from `demoCardInput(scenario)`, and a
  `FakeHass` object (`src/dev/fake-hass.ts`) built from the same `assembleScenario(scenario, fixtureClock(Date.now()))` and
  `simulateServiceCall` as `DemoHost`. FakeHass is a full `HassLike` (including `connection.connected` and the
  `ready`/`disconnected` events, with a hajs-like command ID that resets to 1 on reconnect) that records every
  method call on `window.__agrCalls`, applies behaviors and `ScenarioSpec.user`/`missingServices`/`haVersion`,
  and lets the shell flip `connected` and push new identities. It also implements, as recording spies, the
  members real `hass` has but our types omit (`callWS`, `connection.sendMessage`, `connection.sendMessagePromise`),
  so indirect use is caught at runtime. **Reconnect follows HA's real order**: `reconnect({ snapshotDelayMs })`
  sets the socket getter true, fires `ready` synchronously, pushes `hass` with `connected: true` and the **same**
  `states` reference (as the frontend's `ready` handler does), and only after `snapshotDelayMs` (tests: one
  macrotask; shell: 400 ms) pushes the snapshot: a new states map in which every entity is a new object, queued
  outage changes are applied, and entities "deleted during the outage" keep their old objects. It exercises the
  **real** `HassHost`, resync barrier and gateway in the browser with no network.
  `loadCardHelpers` is absent, so the live view uses the snapshot fallback; tests that need the native path stub
  it.
- Import boundary: `main-dev.ts` is the only dev file that imports element source (`../agraharam.ts`).
  `main-harness.ts`, `ha-shell.ts` and `fake-hass.ts` import only `src/demo/{fixture-types,scenarios,configs,
  simulate}.ts`, `src/demo/fixtures/*`, `src/config/*` and type-only modules, never `src/agraharam*.ts`,
  `src/components/**` or `src/demo/{demo-host,demo-stream}.ts`. Otherwise `defineOnce` would let elements built
  from source silently stand in for the built bundle in e2e. A fitness test walks the import graph to enforce it.
- Both pages install `error` and `unhandledrejection` counters (`window.__agrPageErrors`, §4.9), which stand in
  for HA's logging mixin; the shell shows a red count in its toolbar when it is non-zero.
- `npm run dev` serves `index.html` with HMR at `http://127.0.0.1:5173/` (loopback only, `strictPort`).
  `npm run preview` serves the **built** bundle through `harness.html` at
  `http://127.0.0.1:4173/harness.html`, loading `/local/agraharam/<version>/agraharam.js`.

---

## 11. Build and packaging

### 11.1 Dependencies and scripts (`package.json`)

- dependencies, all bundled: `lit 3.3.3`, `lucide 1.51.0`, `@fontsource-variable/newsreader 5.3.0`,
  `@fontsource-variable/hanken-grotesk 5.3.0`.
- devDependencies: `vite 8.3.2`, `typescript 6.0.3`, `vitest 5.0.3`, `happy-dom 20.14.5`,
  `@playwright/test 1.63.0`, `@axe-core/playwright 4.13.0`, `prettier 3.9.9`, `@types/node 24.19.1`.
- `engines: {"node": ">=24 <25"}`; `.nvmrc` `24`; `.npmrc` `engine-strict=true`, `save-exact=true`.

```json
{
  "dev": "vite",
  "build": "vite build && node scripts/postbuild.mjs",
  "build:harness": "vite build --config vite.harness.config.ts && node scripts/stage-preview.mjs",
  "preview": "npm run build && npm run build:harness && vite preview --config vite.harness.config.ts",
  "typecheck": "tsc -p tsconfig.json",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "npm run build && npm run build:harness && playwright test",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "config:private": "node scripts/generate-private-config.mjs",
  "check:public": "node scripts/check-public.mjs",
  "verify": "npm run format:check && npm run typecheck && npm test && npm run build && npm run check:public"
}
```

Playwright 1.63 does not reuse the cached 1.62 browser builds. Because `e2e/keyboard.spec.ts` always runs in
WebKit (§12.2), the README documents `npx playwright install chromium webkit` as the **default** setup step, so
`npm run test:e2e` works on a clean machine, and `npx playwright install firefox` for the opt-in project.

`scripts/check-public.mjs` (WP12; seeded by WP0) protects source that is about to be committed, which the dist
scan alone does not. The whole `frontend/` tree starts untracked, and developers are told to read
`.dashboard-local`, so a real ID copied into a new fixture, test or doc is the most likely leak. The scan must
therefore cover files **before** they are staged, and it must know every real ID a developer may have read.

- **Files scanned** (all paths limited to `frontend/agraharam/`, listed with `execFileSync('git', [...])`, no
  shell, NUL-separated with `-z`):
  - tracked: `git ls-files -z -- frontend/agraharam`;
  - untracked and not ignored: `git ls-files -z --others --exclude-standard -- frontend/agraharam` (this is the
    case the round-1 design missed: new files before `git add`);
  - staged: `git diff --cached --name-only -z --diff-filter=ACMR -- frontend/agraharam`, and for each staged path
    the **index blob** as well (`git show :<path>` via `execFileSync`), so content staged and then fixed only in
    the working tree is still caught;
  - every file in `dist/agraharam/<version>/` (as before).
  The union is de-duplicated; missing paths are skipped. Gitignored paths (`node_modules/`, `dist/`,
  `test-results/`, `playwright-report/` per the repo `.gitignore`) are excluded by `--exclude-standard`, and dist
  is scanned separately. Binary files (fonts, PNGs) are scanned as latin1 text, so an ID in PNG metadata is found.
- **Forbidden set** (`scripts/lib/public-scan.mjs`, `buildForbiddenSet(privateFiles, exemptions)`), built from
  **every** `*.json` file under the repo-root `.dashboard-local/` (recursive, symlinks not followed). That is
  the bindings candidates file, the much larger saved HA context file the private README tells developers to
  read, any §13.5 backups, and any file added later. The candidates file alone holds only a small fraction of the
  real IDs a developer will have seen. A private JSON file that fails to parse exits 1, because a file the
  scanner cannot read must not silently weaken the scan.
  1. Walk each file **recursively** and collect every object key and string value that passes `isValidEntityId`
     (imported from `src/config/entity-id.ts` by Node type stripping). This includes nested fields such as
     `camera_candidates[].privacy_entity`, `guarded_actions[].entity_id` and
     `guarded_actions[].invocation.data.entity_id`, not only the top-level groups.
  2. Inside longer strings (for example `known_ambiguities` prose or context notes), also collect substrings
     shaped like an entity ID whose domain is a known HA entity domain (the union of `DOMAINS_BY_ROLE` values
     plus `sensor`, `switch`, `automation`, `device_tracker`, `todo`, `button`, `number`, `lock`, `scene`,
     `zone`, `update`). The domain list keeps prose such as "e.g" out of the set.
  3. **Bare object IDs**: for each collected ID whose object part is at least 8 characters and contains an
     underscore or a digit, also forbid the object part on its own (matched case-insensitively, with
     non-`[A-Za-z0-9_]` boundaries), so `const FRONT = 'xyz_front_door'` without its domain is caught.
     Single-word object IDs are matched only in full `domain.object` form, because a bare dictionary word would
     fire on ordinary prose.
  4. Optional extra literals from a private `.dashboard-local/public-denylist.txt` (one per line, for example
     household names or locating words), matched case-insensitively with word boundaries.
  5. Minus `scripts/public-exemptions.json` (`{ "entity_ids": [...], "object_ids": [...], "service_names":
     [...] }`, reviewed generic values such as `sun.sun`). The context file also lists HA's service registry,
     so any collected `<domain>.<service>` whose service is in `service_names` (`turn_on`, `turn_off`,
     `open_cover`, `media_play`, …) is dropped **before** rule 3; otherwise `light.turn_off` would forbid
     `turn_off` (and `TURN_OFF`) everywhere. Service strings that embed household names (for example a
     `notify.mobile_app_*` service) stay forbidden. A Vitest case asserts `service_names` covers every §7.1
     catalog service, so `check-public.mjs` needs no TypeScript import beyond `entity-id.ts`.
  The matcher tokenizes each scanned file once and looks tokens up in Sets, so its cost is linear in the scanned
  bytes whatever the size of the forbidden set. Friendly names are **not** harvested automatically: generic
  multi-word names would collide with fictional fixture names; household names go in the private denylist.
- **Public literals** (positive check, needs no private files; `checkPublicLiterals()` in the same module, run by
  `tests/scripts/public-literals.test.ts` over every tracked and untracked-not-ignored file): every
  entity-ID-shaped literal (a string literal, JSON or YAML scalar, or prose substring that passes
  `isValidEntityId` with a known HA domain from rule 2) in `src/demo/**`, `src/dev/**`, `tests/**` (including
  `tests/scripts/fixtures/*.json`), `e2e/**` and `install/**` must (a) have an object ID starting with `demo_`,
  (b) be listed in `scripts/public-exemptions.json` (reviewed generic values, including the service strings
  the fitness tests assert are absent, such as `alarm_control_panel.alarm_disarm`), or (c) be a `domain.service`
  pair from the §7.1 catalog. Anything else fails with `path:line:column` and rule `public-literal`. This
  enforces §10.1's "all IDs are `*.demo_*`" even on a machine without `.dashboard-local/`, and catches a real ID
  that the private files happen not to contain. Planted IDs in scanner tests therefore use `demo_` object IDs.
- **Output**: each hit prints `path:line:column` and the rule (`entity-id`, `object-id` or `denylist`), never the
  matched value or its surrounding line, and the script exits 1. `--dist <dir>` limits the scan to one built
  directory (used by `install.sh`). Without any private JSON file it prints "skipped: no private files" and
  exits 0. The postbuild dist scan (§11.5) uses the same `public-scan.mjs` forbidden set, matcher and
  exemptions.
- **Commit procedure** (README, and WP14's handoff): `npm run verify` (which runs `check:public`, now covering
  untracked files), then `git add …`, then run `npm run check:public` **again** so the staged blobs are scanned,
  then commit. The lead's commit step in the pipeline runs the same sequence. No git hook is installed
  automatically, because hooks would affect the rest of the repository.

### 11.2 TypeScript (`tsconfig.json`)

`target ES2022`, `module ESNext`, `moduleResolution bundler`, `lib [ES2022, DOM, DOM.Iterable]` (ES2022, not
ES2023: the ES2023 array-copy methods are below the browser floor, §1.2 item 11), `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noEmit`,
`allowImportingTsExtensions`, `experimentalDecorators: true`, `useDefineForClassFields: false`,
`verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `skipLibCheck`, `allowJs` (for `scripts/*.mjs` imports
in tests),
`types [vite/client, node]`. `include` lists **every** compiled file: `src`, `tests`, `e2e`, `scripts`,
`build-env.ts`, `vite*.config.ts`, `vitest.config.ts`, `playwright.config.ts`. Files outside `include` silently
lose the decorator and `verbatimModuleSyntax` settings, and the build still succeeds; research reproduced this.
Elements register through `defineOnce` side effects. Tests use side-effect imports
(`import '../src/components/...ts'`), never type-only value imports.

### 11.3 Vite (`vite.config.ts`): plain build, not library mode

Library mode force-inlines fonts as base64 (verified), so the bundle uses a plain Rolldown build:

```ts
import { defineConfig } from 'vite';
import { APP_VERSION, GIT_SHA } from './build-env.ts';

export default defineConfig({
  base: './',                                     // asset URLs become new URL('fonts/x.woff2', import.meta.url)
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __GIT_SHA__: JSON.stringify(GIT_SHA) },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: `dist/agraharam/${APP_VERSION}`,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: 'hidden',                          // .map produced, no sourceMappingURL; moved out by postbuild
    modulePreload: false,
    assetsInlineLimit: 0,
    copyPublicDir: false,
    license: { fileName: 'LICENSES/THIRD_PARTY_LICENSES.md' },
    rolldownOptions: {
      input: 'src/agraharam.ts',
      preserveEntrySignatures: 'exports-only',
      output: { format: 'es', entryFileNames: 'agraharam.js',
                assetFileNames: 'fonts/[name]-[hash][extname]', codeSplitting: false },
    },
  },
});
```

`build-env.ts` reads `package.json` (`with { type: 'json' }`), runs `execFileSync('git', ['rev-parse',
'--short=12', 'HEAD'])` (no shell; `'unknown'` on failure), and gets `commitTime` from
`git log -1 --format=%cI` plus `dirty` from `git status --porcelain -- .`. `vite.harness.config.ts` uses
`base: '/'`, input `harness.html`, `outDir: dist/preview`, defines `__HARNESS_BUNDLE_URL__ =
'/local/agraharam/<v>/agraharam.js'`, and sets its preview server to `127.0.0.1:4173`, `strictPort`.

A literal `import(__HARNESS_BUNDLE_URL__)` fails the harness build (Vite 8.3.2 reports `[UNRESOLVED_IMPORT]`
once `define` turns it into a literal; reproduced in review). `main-harness.ts` therefore does
`const url = String(__HARNESS_BUNDLE_URL__); await import(/* @vite-ignore */ url);`, and
`vite.harness.config.ts` also sets `rolldownOptions.external: [/^\/local\//]` as a second guard. The card class
exposes `static readonly version = APP_VERSION`; `e2e/bundle.spec.ts` asserts that
`customElements.get('agraharam-dashboard').version` equals `manifest.json.version`, proving the element came from
the built module.

`defineOnce(tag, ctor)` (`util/define.ts`): if the tag is already defined by a constructor with the same
`version`, it does nothing. If the existing constructor reports a different version (for example a stale second
resource URL), it logs `version-conflict` with both versions, does not redefine, and the running card shows the
conflict in diagnostics and as a one-line admin-only notice, so a stale bundle never runs silently.

The `customCards` entry is `{ type: 'agraharam-dashboard', name: 'Agraharam', description: …, preview: false }`,
so HA's card picker does not start a full demo.

### 11.4 Fonts (`src/styles/fonts.ts`)

```ts
import serifUrl from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?url';
import sansUrl from '@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2?url';
let registered = false;
/** Called from the root's connectedCallback. Never at module load: the resource loads on every dashboard. */
export function ensureFonts(): void {
  if (registered || typeof FontFace === 'undefined' || !document.fonts) return;
  registered = true;
  for (const [family, url, weight] of [['Agraharam Serif', serifUrl, '200 800'],
                                       ['Agraharam Sans', sansUrl, '100 900']] as const) {
    const face = new FontFace(family, `url(${url}) format('woff2')`, { weight, display: 'swap' });
    document.fonts.add(face);
    void face.load().catch(() => log.warn('font-load-failed'));   // falls back to system stacks
  }
}
```

### 11.5 Install bundle layout (`dist/agraharam/<version>/`)

```text
agraharam.js                         single ES module (target ≤ 220 KB minified; Lit + app + demo fixtures)
fonts/newsreader-latin-opsz-normal-<hash>.woff2
fonts/hanken-grotesk-latin-wght-normal-<hash>.woff2
LICENSES/THIRD_PARTY_LICENSES.md     Vite build.license (lit BSD-3, lucide ISC + Feather MIT, Fontsource OFL)
LICENSES/OFL-1.1-Newsreader.txt      copied from the package LICENSE
LICENSES/OFL-1.1-Hanken-Grotesk.txt
manifest.json                        {name, version, git_sha, git_dirty, commit_time, node, entry,
                                      resource_url:'/local/agraharam/<v>/agraharam.js',
                                      files:[{path, bytes, sha256}]}  (sorted; reproducible)
SHA256SUMS                           "<sha256>  <path>" for every file above, sorted; `shasum -a 256 -c`
```

`scripts/postbuild.mjs`, in order; any failure exits non-zero:

1. Move `*.map` to `dist/sourcemaps/<version>/`. That directory is never installed. Fixtures are fictional, but
   `/local` is unauthenticated, so maps stay out anyway.
2. Copy the two OFL texts into `LICENSES/` and assert `THIRD_PARTY_LICENSES.md` exists.
3. Allowlist: only `agraharam.js`, `fonts/*.woff2` and `LICENSES/*.{md,txt}` may exist (before manifest and sums).
4. Privacy and safety scan of `agraharam.js`:
   - no `sourceMappingURL`;
   - no raw decorator syntax (`/^\s*@[A-Za-z_$][\w$]*\(/m`);
   - no regex lookbehind (`(?<=` or `(?<!`), which breaks parsing before Safari 16.4 (§1.2 item 11);
   - no `.toSorted(`, `.toReversed(` or `.toSpliced(` (ES2023 array-copy methods, below the floor; `lib: ES2022`
     catches our own code, this catches dependencies);
   - no `http(s)://` except `http://www.w3.org/`;
   - none of: `authSig`, `access_token=`, `Bearer `, `eyJ`, `10.0.0.`, `.dashboard-local`, `dev-ha-shell`,
     `FakeHass`, `__agrCalls`;
   - when any `../../.dashboard-local/**/*.json` exists locally, nothing in the forbidden set of
     `scripts/lib/public-scan.mjs` (built from every private JSON file: entity IDs, nested IDs, bare compound
     object IDs, denylist literals) may appear in any dist file, except the reviewed exemptions shared with
     `check-public.mjs` (§11.1).
5. Write `manifest.json`, then `SHA256SUMS`.

Excluded from the bundle by construction: `src/dev/**`, `tests/**`, `e2e/**`, `.dashboard-local/**`, screenshots,
sourcemaps, `index.html` and `harness.html`.

---

## 12. Test plan

### 12.1 Unit and component tests (Vitest + happy-dom)

Vitest runs two projects (§3): `dom` (happy-dom) and `node` (`tests/scripts/**`, `tests/install/**`).
`tests/setup.ts` (dom project only) installs controllable `IntersectionObserver` and `ResizeObserver` fakes, a
`setVisibility('hidden' | 'visible')` helper, `URL.createObjectURL`/`revokeObjectURL` spies, and fake timers per
test. `tests/helpers/mount.ts` mounts the card with `FakeHass` (from `src/dev/fake-hass.ts`) and exposes deep
query helpers across shadow roots.

ACCEPTANCE.md "Meaningful adapter/control checks" mapped to files and cases:

| # | Requirement | Test files → cases |
|---|---|---|
| 1 | No mutation on mount, render, route change, reconnect, demo | `tests/acceptance/a01-zero-mutation.test.ts`: (a) mount + 50 state pushes → `callService` 0; (b) remove + re-append (route change), the edit-mode toggle sequence and the hidden-5-min sequence (§10.3) → 0; (c) reconnect in HA's two-step order (`connected: true` with the old states reference, then the snapshot one macrotask later) → 0, and the same with both in one push → 0; (d) `preview` true/false toggle and `setConfig` change → 0; (e) `demo: true` with spy hass: click every enabled button in every section and drawer, confirm every confirm dialog → **all** FakeHass spies 0 (`callService`, `callApi`, `fetchWithAuth`, `callWS`, `connection.subscribeMessage`, `sendMessage`, `sendMessagePromise`). Live-mode cases (a)–(d) use the same runtime spies: `callService`, `callWS`, `sendMessage` and `sendMessagePromise` 0, and every `subscribeMessage` call has type `weather/subscribe_forecast` (a read); the static call-site rules of row 11 cannot see indirect paths. `tests/ha/hass-host.test.ts`: host lifecycle alone never calls `callService`. Every case also asserts that no unhandled error or rejection occurred (Vitest's default failure, §4.9), because HA's logging mixin would turn one into `system_log.write`. `e2e/fake-hass.spec.ts`: the same with the built bundle, plus `window.__agrPageErrors` and `pageerror` both 0 |
| 2 | Configured updates propagate; unrelated changes don't rebuild streams | `tests/ha/entity-store.test.ts`: bound change → one notify; unbound → none; identity-only hass → none; reconnect snapshot → one per subscriber. `tests/ha/entity-controller.test.ts`: `requestUpdate` counts. `tests/cameras/camera-dialog.test.ts`: `createCardElement` called once; 50 unrelated updates → same element, never removed or disposed; `el.hass` forwarded. `tests/acceptance/a02-propagation.test.ts`: weather temp change re-renders `agr-today`; a light change does not re-render `agr-cameras` (render spy) |
| 3 | Missing, unknown, unavailable and offline stay distinct; null ≠ 0 | `tests/ha/normalize.test.ts`: precedence table; `numericDisplay` for `null`, `undefined`, `''`, `'unknown'`, `NaN`, `Infinity` → absent "No data", never "0". `tests/cameras/camera-gate.test.ts`: privacy(on), privacy(unknown), offline, missing, disconnected. `tests/acceptance/a03-states.test.ts`: degraded scenario renders "Unavailable", "Not found", "Privacy on", "Privacy status unavailable", "Offline"; vehicle range shows absent; no "0%"/"0 mi" anywhere for null inputs |
| 4 | Offline/unauthorized disabled; no replay | `tests/actions/gateway.test.ts`: evaluate → disabled('disconnected'); `evaluate()` never returns `confirmation-required` (a confirm-required action evaluates to `{enabled: true, confirm: true}`; Silence Sound flips to `confirm: false` while `triggered`); request while disconnected → failed, `invoke` 0; reconnect → still 0; `request()` after `dispose()` → failed('not-sent'), `invoke` 0; stale `epoch` → failed('not-sent'), `invoke` 0. `Unauthorized` rejection → permission-denied and sticky disabled for that target; reset on user change. `tests/ha/hass-host.test.ts`: stale `hass.connected = true` with `connection.connected = false` → `port.invoke` rejects `PortNotSent`, `callService` 0, gateway shows failed('disconnected'); phase `resyncing` (both flags true, barrier armed) → `port.invoke` rejects `PortNotSent`, `callService` 0. `tests/actions/gateway.test.ts`: `controls: false` → every kind evaluates disabled('controls-off'), `request` → failed, `invoke` 0. `tests/acceptance/a04-offline.test.ts`: every action button `aria-disabled="true"`, still focusable, click and Enter guarded (0 calls), with its `aria-describedby` reason while disconnected; **during the resync barrier** (two-step reconnect, before the snapshot) every action button is still `aria-disabled` with the `disconnected` reason and the alarm pill still shows "Last known"; re-enabled only after the snapshot, with 0 calls; **a pending slider commit (draft timer running) across disconnect then reconnect → 0 calls**, control shows "Not sent" |
| 5 | One tap = one scoped call; repeats, rejection, delayed ack, timeout | `tests/actions/gateway.test.ts`: exact `ServiceCall` per kind (table-driven from §7.1); second request while pending → busy, `invoke` stays 1; in-flight registry: a second gateway (new instance, same target) → busy until the first ticket settles or expires; `service_validation_error` → failed('rejected') with escaped message; state confirmed before resolve → confirmed at resolve; confirmed after resolve → confirmed; no change → uncertain at the timeout (fake timers), `invoke` still 1 (no retry); `{error: {code: 3}}` → uncertain('connection-lost'); garage close observes `closing` then `opening` → failed('reversed') immediately. `tests/actions/action-controller.test.ts` (WP0, fake gateway): 3 taps → 1 call; **draft held behind a pending ticket + timeout → `invoke` stays 1**, draft `not-sent`; **draft + `{error: {code: 3}}` + reconnect → `invoke` stays 1**; draft held + ticket `confirmed` + value differs → exactly one follow-up; draft equal to observed after confirm → none; **tap then unmount within 800 ms → 0 calls**; preview on, config change and epoch change each cancel the timer → 0 calls. `tests/components/agr-button.test.ts`: double click while pending → one request; held Enter (`repeat: true` keydowns) → one `agr-activate`. `tests/components/agr-choice-group.test.ts`: renders only native `<button aria-pressed>` inside `role="group"` (no radio, `role="radio"`, `select` or `role="listbox"`); ArrowLeft/Right/Up/Down, Home, End, PageUp and PageDown on any option → 0 `agr-choose`; Enter, Space or click on an enabled option → exactly 1; held Enter → 1; activating the pressed (current) option → 0; every `aria-describedby` id resolves inside the same shadow root. `tests/comfort/climate-drawer.test.ts` and `tests/media/media-drawer.test.ts`: arrows across HVAC modes or sources → `invoke` 0; Enter on a non-current option → exactly one `climate.set_hvac_mode` / `media_player.select_source`; while that ticket is pending every option is disabled. `tests/components/agr-stepper.test.ts`: emits `agr-draft` per tap, owns no timers (`vi.getTimerCount() === 0`), renders "Not sent" with the observed value |
| 6 | Security routing; sound vs persistent disarm; state vs policy | `tests/security/security-drawer.test.ts`: table of label → role → `script.turn_on` target = configured script; "Disarm & Hold" text never equals or contains only "Silence"; Silence Sound → `silence_sound` script, no confirm while `triggered`/`pending`, confirm otherwise; all others require confirm; confirm dialog label equals the drawer button label for every role (including "Prepare garage departure"); alarm `armed_away` + policy "Auto" shows both rows independently; alarm `disarmed` + policy "Auto" never renders "Armed". `tests/config/validate.test.ts`: security action bound to an `alarm_control_panel`/`input_select` entity → wrong-domain; **the same script in `silence_sound` and `disarm_hold` → `duplicate-security-script`**. `tests/actions/gateway.test.ts`: a hand-built config with a duplicated script (bypassing validation) → `security.run` not-allowed, `invoke` 0. `tests/actions/catalog.test.ts`: no alarm/input/select/switch/automation domains; scripts only `turn_on`; no `variables`. `tests/architecture/fitness.test.ts`: `src` contains no `alarm_arm`, `alarm_disarm`, `select_option`, `input_boolean.turn`, `automation.` service strings |
| 7 | Garage confirmation; cancel; departure is not door movement | `tests/garage/garage.test.ts`: "Open garage" dispatches `agr-request-confirm` with 0 invokes; Cancel/Escape → 0; confirm → exactly one `cover.open_cover` on the configured cover; `request({kind: 'garage.open'})` without `confirmed` → failed('confirmation-required'); unknown position → disabled('state-unknown'); **alarm-aware Open copy**: alarm `armed_away` → the body contains "The alarm is Armed away. Opening the garage may set it off." and, with `prepare_departure` configured, the Prepare garage departure sentence (absent when not configured); `arming` → same line; `unknown`/`unavailable`/stale → the "isn't available" line; `disarmed`/`pending`/`triggered` → no extra line; the alarm changing while the dialog is open updates the copy; Close copy never has the line; confirming still produces exactly one `cover.open_cover` and no script call. `tests/components/agr-confirm-dialog.test.ts`: copy comes from the action (a `ConfirmDetail` has no copy fields); disconnect while open → closed, 0 calls; 60 s with no answer → cancelled, 0 calls; precondition stops holding → confirm button disabled. `tests/actions/gateway.test.ts`: **a cover with `device_class: garage` in the curtain role → `curtain.open` not-allowed, 0 invokes**. `tests/security/departure.test.ts`: "Prepare garage departure" → only the departure script, never `cover.*`; no follow-up door call. `tests/architecture/fitness.test.ts`: `confirmed: true` appears only in `agr-confirm-dialog.ts` |
| 8 | Features and units respected; no injection | `tests/actions/validate-args.test.ts`: out-of-range temperature, off-step value, mode/preset/source not in list, volume > 1, brightness on onoff-only light → unsupported, missing feature bit → unsupported, missing service → service-missing, unconfigured entity → not-allowed, fan ID with light kind → not-allowed/domain-mismatch, extra keys (`domain`, `service`, `data`, `entity_id`) → not-allowed. `tests/comfort/comfort.test.ts`: step = `target_temp_step`, else 1 °F / 0.5 °C; unit from `unit_system`. `tests/model/steps.test.ts`: observed 22.3, step 0.5 → `+` 22.5 and `−` 22.0; an off-grid converted `min_temp` (7.2) is reachable and accepted by `validate-args`; clamping at max; every `stepValue` output passes the gateway's argument check (property test over random grids); fan percentages are integers. `tests/media/media.test.ts`: transport buttons render only with their bits. `tests/ha/format.test.ts`: weather unit from attributes, no hardcoded °F |
| 9 | Camera privacy blocks fetch/stream; release on dismiss/unmount | `tests/cameras/camera-gate.test.ts`: privacy state `on` → privacy(on); `off` → continues; `unknown`, `unavailable`, `''`, `"On"`, `"true"`, `"enabled"` → privacy(unknown); `privacy_on_value: 'off'` inverts; missing privacy entity → privacy(unknown). `tests/config/validate.test.ts`: `privacy_on_value: "On"` → invalid-value. `tests/cameras/camera-tile.test.ts`: privacy on/unknown/unavailable/missing-entity **and an unexpected state string** → `fetchCameraSnapshot` never called and live not offered; privacy flips on mid-fetch → result discarded + object URL revoked; offscreen/hidden → no fetch; `thumbnails: false` → no fetch ever; `snapshot_interval` honored; a new state object with only a rotated `access_token` → no refetch or reset; disconnect → image revoked at once (with and without a privacy binding) and the disconnected tile shown; **resync barrier**: privacy switch off → on during an outage, then a two-step reconnect → `fetchWithAuth` count stays 0 and no live start before the snapshot; after the snapshot the gate is privacy(on) and the count is still 0; a privacy entity absent from the snapshot (old object kept) → privacy(unknown), 0 fetches; privacy still off in the snapshot → exactly one fetch after it; unmount → abort + revoke + observers disconnected; 401 → denied, no further fetches; **401 is session-level**: with two visible tiles, the first tile's 401 → the second tile and the live-view fallback reject without calling `fetchWithAuth` (spy count stays 1); reconnect or a `user` change → one new attempt allowed; 403 → only that tile denied. `tests/cameras/camera-tile.test.ts` also asserts every tile state renders a 4:3 box. `tests/cameras/camera-dialog.test.ts`: live not started under privacy (including an unexpected state string); privacy flips on while open → `dispose` called; close, Escape, unmount, card detach, hidden → `dispose` (the dialog's `close` event alone is enough); reopen → new handle; fallback stops fetching after close; **resume after hidden re-runs the full gate**: privacy turned on (or the connection dropped, or preview turned on) while hidden → on visible, `openLiveStream` is not called and the reason shows; the embedded card config includes `aspect_ratio: '16:9'` and `fit_mode: 'contain'`; during the resync barrier `openLiveStream` is not called; a contained `ll-rebuild` → `onFail('helpers-failed')`, handle disposed, snapshot fallback started after a fresh gate check, status "fallback (helpers-failed)"; the wrapper sets the letterbox background variables. `tests/cameras/live-containment.test.ts` (stubbed `loadCardHelpers`): `ll-upgrade`, `ll-rebuild`, `ll-custom`, `card-visibility-changed`, `hass-more-info` and `hass-action` dispatched from the embedded card never reach the card host; `ll-upgrade` re-assigns `hass`; config has every action `none`; **a `context-request` event dispatched from inside the embedded card propagates past the wrapper** to a listener on the card host (and an unrelated custom event does too). `tests/scripts/private-config.test.ts` (generator camera mapping, §13.4) on `tests/scripts/fixtures/candidates.fictional.json`: `privacy_entity`/`privacy_enabled_value` map exactly to `cameras[].privacy_entity`/`privacy_on_value`; a value other than exactly `on`/`off` (`"On"`, `"true"`, `true`), a privacy entity outside `DOMAINS_BY_ROLE.camera_privacy`, or only one of the two fields set → exit 1 with nothing written; excluding a privacy entity while keeping its camera → exit 1; a camera without a privacy binding → `thumbnails: false`, and `true` only when `camera_thumbnails` opts it in; an unknown `camera_thumbnails` key → exit 1; the generated config, validated and fed to `cameraGate` with the privacy entity `on`, yields `privacy(on)` (the gate actually runs on generated output) |
| 10 | Forecast unsupported/error/unsubscribe; teardown leaks nothing | `tests/today/forecast-controller.test.ts`: daily+hourly → 2 subscriptions with `{resubscribe: false}` and exact message shape; daily-only → 1 + 'daily-fallback'; none → 0 + 'unavailable'; `forecast_not_supported` → unavailable; teardown/disconnect/entity change → each unsub called exactly once; **stop before `subscribeMessage` resolves → unsub called as soon as it resolves**; **stale generation**: subscribe, then a socket close and reconnect without stop (simulated: FakeHass fires `disconnected` and `ready`, generation moves on), then stop → the old hajs unsub is **not** called, and a late-resolving subscribe from the old generation is dropped, not unsubscribed; a rejecting unsub is logged, never thrown (no unhandled rejection); a never-settling subscribe does not block teardown; late events ignored; first daily item dated tomorrow → "Tomorrow" label; **no subscribe while resyncing**, exactly one per type once the barrier clears; `invalid_entity_id` → error('entity'), then exactly one new attempt on `haState` → `RUNNING` and one on a `registry` meta change, none otherwise; `vi.getTimerCount() === 0` after teardown. `tests/upcoming/calendar-controller.test.ts`: abort + timer cleared on teardown; no calls without `calendars[]`; query built with `URLSearchParams` (an offset containing `+` survives); no refresh during the resync barrier, one after it |
| 11 | Runtime content escaped | `tests/acceptance/a11-escaping.test.ts`: payloads like `<img src=x onerror=…>` and `<script>` in friendly_name, room name, media_title, calendar summary, health_text and HA error message render as literal text; a recursive shadow-root query finds no `img[onerror]`/`script`. `tests/architecture/fitness.test.ts`: no `unsafeHTML`, `unsafeSVG`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval(`, `new Function` in `src`; no dispatch of `hass-more-info`, `hass-action` or `ll-custom` from `src` (HA's raw security more-info stays unreachable); `console.` only in `util/log.ts`; `callService` only in `hass-host.ts`; `components/` and `model/` never import `hass-host.ts`, `actions/gateway.ts` internals or `ServicePort`; no `color: var(--agr-olive)` or `color: var(--agr-brass)`; no regex lookbehind in `src`; the dev/harness import boundary of §10.3. Call-site rules, applied to `src/**` excluding `src/dev/**` (the fake implements these methods): `subscribeMessage` only in `src/ha/hass/forecast.ts` and only with the literal `'weather/subscribe_forecast'`; `callApi` only in `src/ha/hass/calendar.ts`; `fetchWithAuth` only in `src/ha/hass/camera.ts`; no `callWS`, `sendMessage`, `sendMessagePromise` anywhere; no `querySelector('home-assistant')` anywhere in `src` including `src/dev`; the root's only `hass` reads are `user.is_admin` and `themes.darkMode` (§4.4); no `toSorted`, `toReversed`, `toSpliced` or `.with(` on arrays; no `void` call without a `.catch` (§4.9); no `circle-help` or other Lucide alias names in `icons.ts`; no `localStorage`, `sessionStorage`, `indexedDB`, `caches.` or `document.cookie` anywhere in `src/**` including `src/dev/**` (the shell uses URL query state only); no native CSS nesting (`&`), `:has(`, `color-mix(`, `light-dark(` or `subgrid` in `src/**` `css` templates (§1.2 item 11); no `type="radio"`, `role="radio"`, `role="radiogroup"`, `role="listbox"` or `<select` in `src/components/**` (§7.2); `addEventListener` on a connection only in `src/ha/resync.ts` |

Lifecycle tests (`tests/root/lifecycle.test.ts`, WP0 with the null gateway, extended by WP14 with the real one):

- Remove and re-append the card, then click a control → exactly one `invoke`, through a gateway that is not
  disposed; a garage ticket in flight before the detach is still `busy` after re-attach.
- Open a drawer and a confirm dialog, remove and re-append → no dialog remains `open`; `closeAll()` ran;
  reopening works (no `InvalidStateError`, guarded by §5.4 rule 12).
- `setConfig` changing only `cameras` (new runtime key) → the Today section still re-renders on a weather change
  (it resubscribed to the new store).
- `setConfig` swapping two security roles with the same bound set → new gateway; old gateway disposed; requests
  resolve to the new mapping.
- `setConfig` flipping `demo` with identical bindings → host kind changes.
- Root renders with no changes → the same `DashboardServices` object (memoized); sections do not re-render.
- Derived vacuum battery ID → never actionable (`evaluate` → not-allowed).
- Health: `haState` STARTING with absent IDs → "Loading", never "Not found".
- `'clock'` meta at a minute boundary re-renders Header, Today and Upcoming with no entity change.
- Open a room drawer, a camera dialog (stubbed native handle) and a confirm dialog, then an accepted `setConfig`
  with the same runtime key, and again with a new runtime key → `closeAll()` ran each time, the live handle's
  `dispose` was called, nothing reopens; an identical (deep-equal) `setConfig` → no-op, the drawer stays open.
- A throw inside a section's selector during a `hass` update → caught and logged by code; no unhandled error;
  the card is not replaced (§4.9).
- Derived vacuum battery: the battery sensor's state arrives one ingest after the registry → derived once it
  appears; recomputed after `haState` becomes `RUNNING` and after the resync barrier clears.
- Orphan disposal: remove the card and advance 59 s, re-append → nothing disposed, same runtime; remove and
  advance 60 s → gateway and runtime disposed, the host's tracker subscription removed (the tracker's own
  connection listeners stay registered exactly once); re-append → a new runtime on the next `hass`, and a garage
  ticket in flight before the removal is still `busy` through the in-flight registry.
- Initial layout: a host already 1384 px wide renders `wide` on the first render, and sections are created
  once (no mode switch, one snapshot fetch per visible tile); a 0-width host renders no sections until the
  first ResizeObserver callback.
- Diagnostics: `services.warnings` carries `ignored-in-demo` warnings; `gateway.recent()` keeps the last 20
  tickets and the drawer opened afterwards shows them.

`tests/ha/resync.test.ts` (WP0): the barrier arms on hajs `ready`, on an observed `connected` false → true
and on a new connection object; a `connected: true` push with the same states reference, and registry,
config-only or identity-only updates, do not clear it; the first new states reference clears it; a runtime
created while the tracker is armed starts in `resyncing`; one tracker per connection registers each listener
once; `freshSinceResync` is false for an entity whose object the snapshot did not replace.

Further unit tests: `tests/config/validate.test.ts` (each issue code; demo warnings; `controls` defaults to
`false` and is `ignored-in-demo` in demo mode; frozen output; `demo: true`
returns empty bindings and imports nothing from `src/demo`; `isValidEntityId` matches HA's pattern on a shared
table of valid and invalid IDs), `tests/demo/scenarios.test.ts` (every scenario's demo input validates with no
warnings; merge conflicts and duplicate entity IDs fail; every §7.1 service has a simulator), selector tests in
each section's own `tests/<area>/` folder (one per selector, covering each normalization status and the §6.2.1
budget),
`tests/scripts/private-config.test.ts` (mapping rules on `tests/scripts/fixtures/candidates.fictional.json`;
label map; refuses unknown labels and non-`script.turn_on` invocations; the camera cases listed in row 9;
security helpers: zero or several matches for the alarm or for any of `policy`, `suggested`, `commissioning`,
`health` → exit 1 naming the token, nothing written; output always contains `controls: false`; vehicle
suffixes: several matches for any suffix → exit 1, zero matches for battery or range → vehicle omitted with a
header note; curtain candidates land in the default room, or are listed as unassigned in the header when
`overrides.rooms` does not place them; vacuum candidates are listed under "verify before enabling"),
`tests/install/install-sh.test.ts` (spawns `bash install/install.sh` against temp dirs: dry-run writes nothing and, when `<dest>` is absent, prints "destination
parent absent: will create"; `--apply` on a first install creates `<dest>` with one non-recursive `mkdir -m
0755` and then copies; `--apply` copies only allowlisted files; refuses an existing version; refuses a bad
checksum; refuses a dest whose basename is not `agraharam` under `www`; refuses a symlinked `--dest` or `www`;
never creates `www` itself), `tests/scripts/check-public.test.ts` (runs the script with `cwd` in a temp `git
init` repo containing `frontend/agraharam/` and fictional `.dashboard-local/bindings.candidates.json` and
`.dashboard-local/ha-context.saved.json` files (all planted IDs use `demo_` object IDs): an ID present **only in
the context-shaped file** and planted in a public file fails; an entity ID used as an object key in a private
file is collected; a `light.turn_off` service string in the context file forbids neither `light.turn_off` nor
bare `turn_off`; an unparsable private JSON file → exit 1; an ID planted in an **untracked, unstaged** file
fails; an ID in a tracked file fails; content staged and then removed
only from the working tree fails (index blob scanned); a nested `privacy_entity` ID and an
`invocation.data.entity_id` fail; a bare compound object ID (≥ 8 characters, no domain) fails; a single-word
object ID on its own passes; an ID embedded in `known_ambiguities` prose is collected; a denylist literal fails;
an exempted generic ID passes; a gitignored file (for example under `node_modules/`) is not scanned; the output
contains `path:line:column` and the rule but never the matched value; no private files → skipped, exit 0),
`tests/scripts/public-literals.test.ts` (runs `checkPublicLiterals()` over the real tree, needing no private
files: every entity-ID-shaped literal in `src/demo/**`, `src/dev/**`, `tests/**`, `e2e/**` and `install/**` is
`demo_*`, exempted, or a catalog `domain.service`; plus unit cases on temp files: a non-`demo_` light ID fails
(the test builds that string at runtime by concatenation, so its own source passes the check),
`light.demo_kitchen`, `sun.sun` and `light.turn_on` pass).

### 12.2 End-to-end (Playwright, built bundle via `harness.html` at 127.0.0.1:4173)

`playwright.config.ts`: the project `chromium` is the default. `e2e/keyboard.spec.ts` always runs in Chromium
**and** WebKit, because native dialog behavior is verified only there (§5.4 rule 14), so the default setup is
`npx playwright install chromium webkit` (§11.1); the cached 1.62 builds are not used by 1.63. Running every spec
in WebKit and Firefox is opt-in via `AGR_E2E_BROWSERS=all` (`npx playwright install firefox`); the full WebKit
run is recommended before deployment because wall tablets are often Safari. Keyboard navigation goes through
`e2e/helpers/keys.ts` `tabKey(browserName)`, which returns `'Alt+Tab'` (and `'Alt+Shift+Tab'`) for WebKit on
macOS, where Safari's default Tab reaches only text fields
([microsoft/playwright#32269](https://github.com/microsoft/playwright/issues/32269)); the trap treats Alt+Tab as
Tab (§5.4 rule 4). Every spec uses `e2e/helpers/errors.ts`, which registers `page.on('pageerror')` and asserts
it and `window.__agrPageErrors` are 0 at the end (§4.9). `layout`, `a11y` and `screenshots` specs first
`await document.fonts.ready` and assert both Agraharam faces report `loaded`, because the fallback-to-webfont
swap changes hero and clock metrics and with them the hard gate. `screenshots.spec` runs with
`reducedMotion: 'reduce'` and `animations: 'disabled'`, so the demo stream and sweeps are static.
`webServer` runs `vite preview --config vite.harness.config.ts`. A context-level route
**aborts and fails the test** on any request to an origin other than `127.0.0.1:4173`. The clock is pinned with
`page.clock.setFixedTime('2026-09-30T17:51:00-07:00')` (explicit offset, so the machine's own zone cannot shift
it) and `timezoneId: 'America/Los_Angeles'`. Do not use the Playwright MCP tool in this repo: it writes
`.playwright-mcp/` into the worktree.

| Spec | Checks |
|---|---|
| `e2e/bundle.spec.ts` | module served from `/local/agraharam/<v>/agraharam.js`; `customElements.get('agraharam-dashboard').version` equals `manifest.json.version` (the element came from the built bundle, not source); both fonts reach status `loaded` and `document.fonts.check` passes; served bytes match `SHA256SUMS`; no console errors |
| `e2e/layout.spec.ts` | matrix: 1440×900 and 1194×834 × sidebar expanded/collapsed, 1136×800 collapsed (card 1080), 720×900 and 640×900 (HA narrow, card 720 and 640), and 390×844, i.e. every row of both §6.1 tables, including the tightest content boxes at 1080, 720 and 640 and the 1138 collapsed case: `data-layout`, header variant, forecast cell count and hero size equal the §6.1 tables; `scrollWidth ≤ clientWidth` for document, frame and `agr-header` (no horizontal scroll, no header overflow) with `dense` (`armed_vacation`) and `offline` (stale pill); no panel overflows the frame; every open drawer's bounding box is inside the viewport at 390×844; columns in wide mode have aligned bottoms (±2 px). §6.2.1 gates, with `host=fake-hass`: `normal` at 1440×900 collapsed fits the viewport height (hard) and each panel's height versus its §6.2.1 target is written to `test-results/metrics/layout.json`; `dense` at 1440×900 has no horizontal overflow and aligned bottoms (hard) and its vertical overflow is written to the same file (reported); the compact header at 390 with "Alarm state unknown" wraps the pill instead of overflowing; quiet panels never stretch |
| `e2e/a11y.spec.ts` | axe (`wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`) on normal, degraded, offline, alert, restricted and dense × light/dark at 1440 and 390, and with the security drawer and a confirm dialog open: zero violations; custom check that every enabled `button`, `[role=button]` and `input` has a box ≥ 44×44; no nested interactive elements |
| `e2e/keyboard.spec.ts` (Chromium + WebKit) | All Tab presses via `tabKey(browserName)`. Tab to the security pill → Enter opens the drawer and focuses its heading; the rest of the page is inert; Tab and Shift+Tab wrap inside; the focus-visible ring is drawn; Escape closes and focus returns to the pill. Drawer + confirm stacked: Escape closes only the confirm dialog. Backdrop click closes a drawer but not a confirm dialog. Confirm dialog: initial focus on Cancel; Enter → closed with no action (fake-hass `__agrCalls` empty). Room drawer slider via arrow keys → one call after debounce. Climate drawer HVAC modes: Tab into the group, press ArrowLeft/Right/Up/Down, Home and End → `__agrCalls` has no `callService`; Enter on a non-current mode → exactly one `climate.set_hvac_mode`; the same for the media drawer's source list. An `aria-disabled` action button is reachable by Tab, announces its reason, and Enter does nothing. Open drawer, then "Edit-mode toggle" remount → no dialog left open; reopening is modal again. Camera dialog (fake-hass fallback): opens, then Escape → no further snapshot fetches |
| `e2e/motion.spec.ts` | `reducedMotion: 'reduce'` → drawer `transition-duration` computes to `0s`; no pending sweep animation; demo stream not animating |
| `e2e/fake-hass.spec.ts` | built bundle with FakeHass: mount, "Route change", "Edit-mode toggle" and "Hidden 5 min" remounts and reconnect → 0 `callService`; after each remount one click on a light toggle → exactly one call with the expected domain/service/target; garage Open → Cancel → 0; Open → Confirm → 1 `cover.open_cover`; Open → Confirm → "Edit-mode toggle" → Open is still busy; stepper tap → disconnect → reconnect → 0 calls; "Hidden 5 min" with the forecast subscribed → FakeHass records no `unsubscribe_events` for an old command ID after the reconnect (§9.2); "Outage change" turns a visible camera's privacy on during "Hidden 5 min" → no `fetchWithAuth` for that camera at any point (the reconnect uses the two-step order with a 400 ms snapshot delay), its tile shows "Privacy on" after the snapshot, and controls are `aria-disabled` until the snapshot lands |
| `e2e/screenshots.spec.ts` | captures `test-results/screenshots/<viewport>-<sidebar>-<scenario>-<theme>.png` (gitignored) for normal, degraded, offline, empty, loading, restricted, starting, alert and dense at all §6.1 viewports, light and dark, plus normal at 1440 with each drawer open, the dense cameras drawer, and alert's security drawer after tapping Silence Sound (sent, then uncertain after advancing the clock 10 s). Fictional data only. A curated subset may be committed under `frontend/agraharam/docs/screenshots/` after human review and `check:public` |

---

## 13. Installation bundle (`install/`)

### 13.1 Deployment model facts

- HA runs as a container on the NAS. `/config` is the bind mount of `${HA_CONFIG_PATH}`. `/config/www` is served at
  `/local` **only if it existed when HA started**, and files there need no authentication.
- Portainer deploys this repo's compose file from its own clone. **Pushing this branch installs nothing.** The
  compose stack needs no change, and no bind mount should be added for the dashboard.
- Assets reach `${HA_CONFIG_PATH}/www/agraharam/<version>/` only through an **authorized file channel**, such as
  the NAS file share mounted on the operator's machine. NAS SSH is not assumed. No REST upload exists, and
  HomeButler is not a file channel.
- `/local` responses are cached for 31 days, and HA's service worker serves non-API paths stale-while-revalidate
  on HTTPS origins. Versioned directories make each release a new URL. Clients must **reload** after a resource
  change, because resources load once per page load.

### 13.2 `install/install.sh`

```text
usage: install/install.sh --dest <HA config>/www/agraharam [--version X.Y.Z] [--src DIR] [--apply] [--allow-dirty]
  default: dry run (no writes). --src defaults to ../dist/agraharam/<version from package.json>.
```

Checks, run in both modes and in this order. Exit codes: 2 usage, 3 verification, 4 destination conflict.

1. `--dest` is given, its basename is `agraharam`, and its parent's basename is `www`. Otherwise exit 2 with
   "expected …/www/agraharam".
2. The parent `www` exists. Otherwise exit 3: "HA serves /local only if /config/www existed at startup. Create
   it through the file share, then schedule an HA restart separately. This script never restarts HA."
   2a. Neither `--dest` (if it exists) nor `www` is a symlink, and the physical path (`cd -P … && pwd -P`) equals
   the given path. Otherwise exit 3: "refusing a symlinked destination". This keeps a planted link from
   redirecting the copy outside the HA config share.
3. The source directory exists, and `manifest.json.version` equals the directory name and `--version`.
4. `SHA256SUMS` verifies (`shasum -a 256 -c` or `sha256sum -c`, whichever exists).
5. The file set equals the allowlist (`agraharam.js`, `fonts/*.woff2`, `LICENSES/*`, `manifest.json`,
   `SHA256SUMS`), with no extra files.
6. `manifest.git_dirty` is false, unless `--allow-dirty` is given (a warning is printed either way).
7. `<dest>/<version>` does **not** exist. Otherwise exit 4. Existing versions are never overwritten.
8. If `node` is on `PATH`, `node scripts/check-public.mjs --dist <src>` re-runs the privacy scan on the exact
   files to be copied (exit 3 on a hit). Without `node` it prints "privacy re-scan skipped: node not found" and
   relies on the build-time scan that the checksums bind to.

Dry-run output format (stable, line-oriented):

```text
agraharam install plan (dry run: nothing written)
source       dist/agraharam/0.1.0   manifest 0.1.0  git 1a2b3c4d5e6f  clean
destination  /Volumes/config/www/agraharam/0.1.0   (absent: ok)
destination parent absent: will create /Volumes/config/www/agraharam   (first install only)
checksums    7 files verified
copy         agraharam.js                                      183,204 B  sha256 3f2a…9c1d
copy         fonts/hanken-grotesk-latin-wght-normal-Ab12.woff2  34,704 B  sha256 …
…
resource     /local/agraharam/0.1.0/agraharam.js   (type: module; create or update, see install/README.md)
dashboard    url_path agraharam-next, view path home   (create once; see install/README.md)
restart      not performed; required only if www did not exist when HA last started
next         re-run with --apply to copy
```

With `--apply`, on a first install where `<dest>` (`…/www/agraharam`) does not exist yet, the script runs one
**non-recursive** `mkdir -m 0755 <dest>`, only after checks 1, 2 and 2a passed (so `www` exists, is not a
symlink and resolves to the given path). It never creates `www` and never uses `mkdir -p`. It then re-checks that
`<dest>` is a real directory (not a symlink) before writing. The dry run prints "destination parent absent: will
create <dest>" instead. The script then copies into `<dest>/.<version>.partial-<pid>` (files 0644, directories
0755), re-verifies `SHA256SUMS` there, then renames atomically to `<dest>/<version>`. On failure, a `trap` removes only
its own partial directory. It never deletes other paths, never touches `configuration.yaml` or `.storage`, never
restarts HA, and never edits other versions.

### 13.3 Other install files

- `resource.yaml`: `url: /local/agraharam/0.1.0/agraharam.js` with `type: module`. Comment: register once. To
  upgrade, **edit** this resource's URL; never add a second one.
- `dashboard.demo.yaml`: `title: Agraharam`, `views: [{title: Home, path: home, type: panel, cards: [{type:
  custom:agraharam-dashboard, demo: true}]}]`. This is the first safe render inside HA.
- `dashboard.example.yaml`: the full schema with fictional `*.demo_*` IDs and `controls: false`, for example
  `security.actions.disarm_hold: script.demo_disarm_hold` and `garage.cover: cover.demo_garage`. Comments state
  that controls stay off until the §13.5 read-only verification is done, that each security role needs its own
  script, that `privacy_on_value` is exactly `on` or `off`, and that
  cameras without a privacy binding default to `thumbnails: false` in the generated config and should stay that
  way for indoor cameras; cloud or battery cameras may raise `snapshot_interval`.
- `README.md` also states the browser floor (§1.2 item 11) and explains the camera thumbnail default: a camera
  with a privacy switch is gated by it (fail closed); a camera without one has nothing to gate on, so it shows
  "Live view on request" until the operator opts it in through `camera_thumbnails`.
- `overrides.example.json` (all keys optional; every map is keyed by entity ID):
  `{ "exclude": [], "names": {"camera.demo_front_gate": "Front gate"}, "camera_thumbnails":
  {"camera.demo_side_path": true}, "rooms": [{"name": "Courtyard", "lights": ["light.demo_courtyard"],
  "curtains": [], "purifier": "fan.demo_courtyard_purifier"}], "vehicle_name": "Demo sedan",
  "charge_limit_pct": 80 }`.

### 13.4 Private runtime config generator (`scripts/generate-private-config.mjs`)

- **Inputs** (repo root found with `git rev-parse --show-toplevel` via `execFileSync`):
  `.dashboard-local/bindings.candidates.json` (required) and `.dashboard-local/agraharam.overrides.json`
  (optional, private, same shape as the example).
- **Output**: `.dashboard-local/agraharam-next.dashboard.yaml` **only**. Guards: the resolved real path must be
  inside the real `.dashboard-local/`, the output must not be a symlink, `git check-ignore -q <out>` must
  succeed, and the file is written with mode 0600. Any guard failure exits 1 without writing.
- **Format**: `#` comment header (generated time, source file, "Candidates only. Verify every ID in live HA
  before enabling actions.", the candidates' `known_ambiguities` verbatim, the "verify before enabling" lists
  below, and how to set `controls: true` after §13.5), followed by a pretty-printed **JSON** body of the full
  dashboard config (`title`, one panel view `home`, one card with `demo: false` and **always `controls:
  false`**; the generator has no option to emit `true`). JSON
  is valid YAML 1.2, so the file pastes into HA's raw configuration editor. Stripping the comment lines gives a
  `lovelace/config/save` payload.
- **Mapping rules** are generic and contain no household data in code (`scripts/lib/private-config.mjs`):
  - Roles come from groups: people, today (weather/sun by domain), climate, air, bed_comfort_optional,
    vacuum_candidates, media_candidates, garage[0] and perimeter_read_only, minus `overrides.exclude`.
  - Vehicle fields are matched by suffix: `_battery_level`, `_battery_range`, `_status`, `_power`,
    `_session_energy`. Each suffix must match **exactly one** candidate: several matches exit 1 naming the
    suffix and count; zero matches omit an optional field, and zero for battery or range omit the vehicle with a
    header note.
  - Vacuum candidates may be renamed or replaced devices, so the header lists every emitted vacuum under
    "verify before enabling".
  - Appliances pair `<p>_current_status` with `<p>_remaining_time`.
  - Security helpers: the alarm is the `security_read_only` entry in the `alarm_control_panel` domain, and the
    helpers are matched by allowed domain (§4.1) plus object-ID token: `policy`, `suggested`,
    `(^|_)commissioning$`, `health`. Each of these five must match **exactly one** candidate. Zero or several
    matches exit 1, naming the token and the count, and nothing is written. A wrong helper bound as `policy` or
    `commissioning` would mislabel security state, so ambiguity is never resolved by order.
  - Security actions come from `guarded_actions` through an **exact label map**: "Disarm & Hold" → disarm_hold,
    "Silence Sound" → silence_sound, "Resume Auto Arming" → resume_auto, "Hold Night/Away/Vacation" → hold_*,
    "Prepare garage departure" → prepare_departure, "Monitors On/Off" → `studio_monitors_script`. An unknown label,
    or an invocation other than `{domain: 'script', service: 'turn_on', data: {entity_id: <same>}}`, exits 1.
  - Rooms come from `overrides.rooms`. Without overrides there is one room, "Lights", holding every light
    candidate and every curtain candidate, with a warning comment. With `overrides.rooms`, curtain candidates
    that no room lists are named in the header as "unassigned curtains", never silently dropped.
  - **Cameras** (`camera_candidates[]` → `cameras[]`, `mapCameras(candidates, overrides)`), in this order; every
    failure exits 1 and writes nothing:
    1. `entity` = `entity_id`. `name` = `overrides.names[entity_id]`, else the title-cased `role`.
    2. **Privacy fields are never dropped.** `privacy_entity` and `privacy_enabled_value` are treated as absent
       only when both are missing or `null`. If both are present: `privacy_entity` must pass `isValidEntityId`
       and its domain must be in `DOMAINS_BY_ROLE.camera_privacy`; `privacy_enabled_value` must be exactly the
       string `'on'` or `'off'` (no trimming, lowercasing or boolean coercion: `"On"`, `"true"`, `true` and
       `"enabled"` all exit 1). They map to `cameras[].privacy_entity` and `cameras[].privacy_on_value`. If only
       one of the two is present, exit 1 (half a privacy binding is a broken binding).
    3. `overrides.exclude` may remove a camera entirely (its privacy entity goes with it). Excluding a privacy
       entity while its camera stays → exit 1: the privacy gate can never be removed on its own.
    4. **Thumbnails default fail-closed.** A camera with a privacy binding is emitted with `thumbnails: true`
       (the §9.3 gate protects it). A camera **without** a privacy binding is emitted with `thumbnails: false`
       ("Live view on request"), because the generator cannot tell indoor from outdoor cameras, unless
       `overrides.camera_thumbnails[entity_id] === true` opts it in. `camera_thumbnails[id] === false` turns
       thumbnails off for any camera. A `camera_thumbnails` key that is not a candidate camera, or a value that
       is not a boolean, exits 1 (a typo must be loud, not silently ignored).
    5. `thumbnails` is always written explicitly, so the generated file shows the decision for every camera. The
       header comment lists the cameras emitted with `thumbnails: false` because they have no privacy binding.
    6. Post-condition, asserted before writing: every candidate camera that is not excluded and has a privacy
       binding appears in `cameras[]` with exactly that `privacy_entity` and `privacy_on_value`.
  - Calendars are emitted only if `upcoming_optional` is non-empty. The todo list is ignored.
- **Validation**: imports `../src/config/validate.ts`, `entity-id.ts` and `schema.ts` (Node 24 type stripping)
  and refuses to write if `validateConfig` reports issues. Each issue is printed with its path.
- **Tests** (`tests/scripts/private-config.test.ts`, fictional fixture `tests/scripts/fixtures/candidates.fictional.json`
  shaped like the private file, including cameras with `null` privacy fields and cameras with a `switch`
  privacy entity): every camera rule above, the security exactly-one rule, and a round trip in which the
  generated config is validated and a privacy entity in state `on` makes `cameraGate` return `privacy(on)`
  (§12.1 row 9).

### 13.5 Resource registration and dashboard creation (admin, after `install.sh --apply`)

Preflight checks, all read-only:

1. Open `https://<ha>/local/agraharam/<v>/manifest.json` in the browser. It must return the manifest. A 404 when
   `www` was newly created means a restart is required; report that separately.
2. Settings → Dashboards → ⋮ → Resources must be editable. `lovelace/info` must report `resource_mode` storage.
3. Settings → Dashboards must not already have `agraharam-next`. If it exists, inspect it and stop; never
   overwrite it.

Back up privately, before any write, into `.dashboard-local/backups/<ISO-time>-*.json`: the resource list, the
dashboard list, and the config of any dashboard you intend to touch. Only `agraharam-next` is touched.

UI path (primary):

1. Settings → Dashboards → ⋮ (top right) → Resources → Add resource → URL `/local/agraharam/<v>/agraharam.js`,
   type "JavaScript module". To upgrade, edit the existing Agraharam resource instead.
2. Settings → Dashboards → Add dashboard → "New dashboard from scratch" → title "Agraharam", icon
   `mdi:home-heart`, URL `agraharam-next` if the dialog offers a URL field (verify live, §15), "Admin only" off,
   "Show in sidebar" on.
3. Open the new dashboard → ⋮ → Edit dashboard → ⋮ → Raw configuration editor → paste `dashboard.demo.yaml` →
   Save. Confirm the demo renders. Then paste `.dashboard-local/agraharam-next.dashboard.yaml` → Save. It
   carries `controls: false`, so the real dashboard renders with every control disabled ("Controls are turned
   off in the dashboard configuration.").

Read-only verification, then enable controls (staged enablement; nothing here runs a script or a service):

1. With `controls: false`, compare the dashboard with HA's own views: alarm state, policy, garage position,
   each camera's privacy tile, presence. Any mismatch stops the rollout.
2. For every script bound in `security.actions` and `studio_monitors_script`, open it in Settings → Automations
   & Scenes → Scripts and read its sequence (do not run it, do not save). Confirm it does what its role says:
   `silence_sound` only silences, `disarm_hold` disarms and holds, each hold sets that hold, `resume_auto`
   resumes Auto, `prepare_departure` never moves the garage door. A mismatch is fixed in the private overrides
   and the config regenerated, never by editing the script.
3. Temporarily set `diagnostics: true`, open Diagnostics as an admin, and check that every binding resolves (no
   "Not found"), the features column matches the devices, and there are no config warnings.
4. Back up the dashboard config privately, then in the raw configuration editor set `controls: true` (and
   `diagnostics` back if wanted) → Save. Back up the saved config again.

WebSocket path (deterministic alternative): the admin runs these in the browser devtools console on an HA page,
using their own logged-in session. This is a manual operator step; dashboard code never does this.

The guards are code, not comments. Core does not deduplicate resources, and two Agraharam URLs would load two
bundle versions and trigger `defineOnce`'s version-conflict path.

```js
const hass = document.querySelector('home-assistant').hass;               // operator console only
const VERSION = '0.1.0';
const URL_PREFIX = '/local/agraharam/';
const url = `${URL_PREFIX}${VERSION}/agraharam.js`;
// Paste the JSON body of .dashboard-local/agraharam-next.dashboard.yaml (comment lines removed) in place of null.
const CONFIG = null;
if (!CONFIG || typeof CONFIG !== 'object' || !Array.isArray(CONFIG.views) || CONFIG.views.length === 0) {
  throw new Error('CONFIG is empty: paste the generated JSON body first. Nothing was written.');
}

const resources = await hass.callWS({ type: 'lovelace/resources' });      // back up this JSON privately
const ours = resources.filter((r) => typeof r.url === 'string' && r.url.startsWith(URL_PREFIX));
if (ours.length > 1) throw new Error(`Found ${ours.length} Agraharam resources. Fix by hand; stop.`);

const dashboards = await hass.callWS({ type: 'lovelace/dashboards/list' }); // back up this JSON privately
if (dashboards.some((d) => d.url_path === 'agraharam-next')) {
  throw new Error('Dashboard agraharam-next already exists. Inspect it; never overwrite. Stop.');
}

// First install: create exactly one resource. Upgrade: update the existing one, never add a second.
const resource = ours.length === 0
  ? await hass.callWS({ type: 'lovelace/resources/create', res_type: 'module', url })
  : await hass.callWS({ type: 'lovelace/resources/update', resource_id: ours[0].id, url });
console.log('resource id (save privately):', resource.id);
const undoResource = ours.length === 0
  ? `await hass.callWS({ type: 'lovelace/resources/delete', resource_id: '${resource.id}' })`
  : `await hass.callWS({ type: 'lovelace/resources/update', resource_id: '${resource.id}', url: '${ours[0].url}' })`;

let dashboard;
try {
  dashboard = await hass.callWS({ type: 'lovelace/dashboards/create', url_path: 'agraharam-next',
    title: 'Agraharam', icon: 'mdi:home-heart', show_in_sidebar: true, require_admin: false, mode: 'storage' });
} catch (err) {
  console.error(`Dashboard creation failed. To undo the resource change, run exactly:\n${undoResource}`);
  throw err;
}
console.log('dashboard id (save privately):', dashboard.id);

try {
  await hass.callWS({ type: 'lovelace/config/save', url_path: 'agraharam-next', config: CONFIG });
} catch (err) {
  console.error('Saving the config failed. To undo everything, run exactly:\n'
    + `await hass.callWS({ type: 'lovelace/dashboards/delete', dashboard_id: '${dashboard.id}' })\n${undoResource}`);
  throw err;
}
```

For an upgrade of an already-created dashboard, run only the resource part (the dashboard guard would stop the
script by design): the same `resources` read, the `ours.length > 1` guard, and then the `update` call. The
snippet never undoes anything itself; it prints the exact undo commands for the objects it created or changed.
After the WebSocket path, run the read-only verification above before setting `controls: true`.

Readback:

- `lovelace/resources` contains exactly one Agraharam URL.
- `lovelace/dashboards/list` contains `agraharam-next`, and the other entries are unchanged against the backup.
- `lovelace/config {url_path: 'agraharam-next'}` deep-equals the saved config.
- Load `/agraharam-next/home`: the card renders with no console errors.
- Repeat as a non-admin household account.
- Existing dashboards still load.
- Alarm, hold and commissioning state are unchanged. Compare by reading the entities; do not act.

### 13.6 Rollback (exact objects only)

- **Bad version**: edit the Agraharam resource URL back to the previous `/local/agraharam/<prev>/agraharam.js`,
  then reload clients. Keep the bad version's files until no client references them, then delete only
  `www/agraharam/<bad>/` through the file share.
- **Remove entirely**: read the dashboard `id` and the resource `id` from the create responses saved during
  install, or from a fresh `lovelace/dashboards/list` / `lovelace/resources` readback matched by `url_path`
  `agraharam-next` and by the Agraharam resource URL. Never assume them (the dashboard ID is normally the slugified
  url_path, `agraharam_next`, but the readback is authoritative). Then run `lovelace/dashboards/delete
  {dashboard_id: <id>}` and `lovelace/resources/delete {resource_id: <id>}`, or use the UI equivalents. Delete the
  `www/agraharam/` files last. No bulk restore, no stack reset, and other dashboards are never touched.

---

## 14. Implementation work packages

Ownership is exclusive: a parallel work package never edits a file it does not own. Files seeded by WP0 as
placeholders transfer to the listed owner when WP0 completes. Every other WP0 file that is not listed under a
section package (root card, `src/components/primitives/*`, `src/components/shell/*` except the alert banner,
`src/styles/*`, `src/util/*`, `src/icons/*`, README) passes to WP14 when WP0 completes, so `BREAKPOINTS` tuning
(§15 #4) and primitive fixes have an owner.

### WP0: Foundation (blocking; one developer). Milestones M0.1 "contracts" and M0.2 "foundation" land first

- **Owns**:
  - Tooling: `.nvmrc`, `.npmrc`, `package.json`, `package-lock.json`, `tsconfig.json`, `build-env.ts`, `vite.config.ts`,
    `vite.harness.config.ts`, `vitest.config.ts`, `playwright.config.ts` (skeleton), Prettier files, `index.html`,
    `harness.html`, `README.md` (skeleton), `scripts/stage-preview.mjs` (the harness and preview are WP0
    infrastructure, so `build:harness` works from day one).
  - Entry and root: `src/agraharam.ts`, `src/agraharam-dashboard.ts`, `src/version.ts`, `src/env.d.ts`.
  - Config and host core: `src/config/*`, and `src/ha/{types,host,hass-host,entity-store,resync,
    entity-controller,status-board,normalize,derive,features,format,errors}.ts`.
  - Gateway contract, controller and stubs: `src/ha/actions/{types,action-controller,null-gateway}.ts`.
  - Models: `src/model/{types,display,alarm-labels,perimeter,action-copy,budget,steps}.ts`.
  - UI foundation: `src/components/services.ts`, `src/components/primitives/*` (including
    `agr-confirm-dialog`, `agr-drawer`, `agr-dialog`),
    `src/components/shell/{agr-overlay-host,overlay-types,agr-config-error,agr-demo-ribbon}.ts`,
    `src/styles/*`, `src/icons/*`, `src/util/*`.
  - Demo and dev: `src/demo/{fixture-types,scenarios,configs,simulate,demo-host,demo-stream}.ts`,
    `src/demo/fixtures/index.ts`, `src/dev/*`.
  - Tests: `tests/setup.ts`, `tests/helpers/*`, `tests/config/*`, `tests/demo/*`, `tests/root/*`,
    `tests/ha/{entity-store,entity-controller,normalize,hass-host,resync,format}.test.ts`, `tests/model/steps.test.ts`,
    `tests/actions/action-controller.test.ts`, `tests/architecture/fitness.test.ts`, `tests/components/*`
    (primitives including `agr-choice-group`, and the confirm dialog).
- **Seeds placeholders** (render an `agr-panel` with the section label and a skeleton) for every section and drawer
  file in §3, every `src/model/<section>.ts`, `src/ha/hass/{forecast,camera,calendar}.ts` (the §4.4 seam
  signatures, reporting `unsupported`), `src/demo/fixtures/<section>.ts` (each a `SectionFixture` with the minimal
  normal scenario), `src/ha/actions/gateway.ts` (`createGateway` returning the null gateway; the root imports it
  from day one, so WP1 never edits the root), `src/model/air.ts` (`selectAirTile` with its M0.1 signature) and
  `src/components/shared/agr-fan-controls.ts` (both → WP4; WP5 imports them and never edits them),
  `scripts/check-public.mjs` (exits 0 with "not implemented"; the npm script is wired from day one) and
  `scripts/postbuild.mjs` (a pass-through that only asserts `agraharam.js` exists, so `npm run build` works in
  WP0; WP12 replaces it with §11.5).
- **M0.1 (contracts)**, landing first and matching §4, §5.1, §5.2, §5.5 and §10.2 exactly: `src/config/schema.ts`
  (including `controls`), `src/ha/types.ts` (including the optional `ConnectionLike` event methods),
  `src/ha/host.ts` (including the `resyncing` phase, `Formatter.hour`, `PortNotSent`, `connectionGeneration()`,
  `LiveStreamHandle.onFail` and `HostRuntime.status`/`tick`), `src/ha/resync.ts` (`ResyncTracker`), the
  `StoreView` type (including `isResyncing` and `freshSinceResync`), the seam signatures in
  `src/ha/hass/{forecast,camera,calendar}.ts` (forecast takes `generation`), `src/ha/actions/types.ts`
  (including `ActionGateway` with the one-argument `evaluate` and `recent()`, `Availability` with `confirm`, the
  `controls-off` code, `RequestOptions`, `InflightRegistry`), the `ActionController`/`DraftState` declarations,
  `src/model/types.ts` (including `SelectorInput` and `ChoiceOptionVM`), `src/model/steps.ts` (`stepValue`),
  the `selectAirTile` signature, `src/components/services.ts` (`DashboardServices` with `warnings`) and
  `src/ha/status-board.ts` (`StatusBoard`), `src/components/shell/overlay-types.ts` (`ConfirmDetail`,
  `DrawerRequest`, `DrawerElement`, `DRAWER_TAGS`, the `agr-drawer-closed` event), the public API of every
  primitive in §5.5 plus `agr-drawer`/`agr-dialog` (`heading`, `demo`, `theme`), `src/demo/fixture-types.ts`
  (including `FixtureClock`, `ScenarioSpec.user`, `missingServices`, `haVersion` and the 401/403 snapshot
  behaviors), and the full curated icon set in `src/icons/{icons,custom-icons}.ts` (§6.5). Contract changes
  after M0.1 require architect sign-off.
- **M0.2 (foundation)**, after which WP2–WP11 start: the primitives (`agr-panel`, `agr-button` with
  `aria-disabled` handling, `agr-choice-group`, `agr-drawer`, `agr-dialog`, `agr-confirm-dialog`, sliders,
  steppers, `agr-icon`), the overlay host with `DRAWER_TAGS` mounting, `EntityStore` with the resync barrier,
  `EntityController`/`ActionController`, the null gateway behind the seeded `createGateway`,
  tokens and typography, `assembleScenario` with `DemoHost`, the root rendering placeholder panels in all three
  layouts, and the demo shell with scenario and theme switchers. The remaining WP0 work (the remount modes,
  `FakeHass` details, the full `HassHost` test suite and the rest of the WP0 tests) continues in parallel with the
  section packages.
- **Acceptance**:
  - `npm ci`, `typecheck`, `test` (both Vitest projects), `build`, `build:harness` and `dev` all work; the demo
    shell renders the card with placeholder panels in all three layouts; the initial mode is measured
    synchronously and later changes follow §6.1 with hysteresis, measured on the card host and applied in
    `requestAnimationFrame`; the header variant follows `HEADER_CQ`; the host paints the canvas with
    `min-block-size: 100%` and safe-area inline padding (§6.5).
  - Fonts load from the module-relative URL.
  - `customCards` entry pushed (never reassigned, `preview: false`); `defineOnce` guard with version-conflict
    detection; `getCardSize()` 12; `getGridOptions()` `{columns: 'full'}`; `getStubConfig()` `{demo: true}`.
  - Config errors render in-card with the admin/non-admin split; demo isolation per §10.1; demo substitution done
    by the root (§4.2 rule 9).
  - EntityStore, HassHost (including the live-socket guard) and ActionController draft-rule tests pass.
  - The root lifecycle table (§9.1), including orphan disposal, is implemented and the
    `tests/root/lifecycle.test.ts` cases that do not need the real gateway pass; the dev shell offers all three
    remount modes and "Outage change".
  - Resync barrier (§4.4): `tests/ha/resync.test.ts` passes; FakeHass reconnects in HA's two-step order and
    records `callWS`, `sendMessage` and `sendMessagePromise`; `normalizeEntity` keeps values stale and
    `port.invoke` refuses while resyncing.
  - `agr-choice-group` passes its §12.1 row 5 cases (arrows never emit); every primitive's `aria-describedby`
    resolves in its own shadow root; `stepValue` tests pass; fixtures are clock-relative (`FixtureClock`).
  - Overlay host: the state-logic rules of §5.4 pass in unit tests (rule 14); the confirm dialog's integrity rules
    (§5.2) pass against a fake gateway.
  - Every scenario in §10.2 assembles and validates; `simulateServiceCall` covers every §7.1 service.
  - `HassHost` socket generation (§4.4) and camera session denial are unit-tested; the §4.9 error-containment
    rules and page-error counters are in place; every icon key resolves; the row 11 fitness rules (storage APIs,
    CSS floor, choice patterns, connection listeners only in `resync.ts`) are in place.

### Parallel work packages (start after WP0 M0.2, except WP1)

| WP | Scope | Owns (exclusive) | Depends on | Acceptance criteria |
|---|---|---|---|---|
| WP1 Action gateway | §4.7, §7 | `src/ha/actions/{catalog,validate-args,error-map,messages,gateway,inflight}.ts`, `tests/actions/*` except `action-controller.test.ts` | M0.1 (can start in parallel with the rest of WP0) | Every §7.1 row has a table-driven test for its exact `ServiceCall`, precondition, unknown-state rule, capability, arguments, observation and timeout; `evaluate()` never returns `confirmation-required` and reports `confirm`; monotonic `now`; epoch, dispose, in-flight registry, duplicate-script, garage-class curtain, `PortNotSent` and reversal tests pass; acceptance items 4, 5 and 8 (gateway parts) pass; catalog domain test passes; `controls: false` → every kind disabled('controls-off'), 0 invokes; `resyncing` → disabled('disconnected'); `recent()` ring buffer of 20; temperature validation accepts exactly the `stepValue` outputs (grid or min/max); replaces the body of the WP0-seeded `gateway.ts` without touching the root |
| WP2 Header and shell status | §6.4, §9.1 banner, household and diagnostics drawers | `src/components/header/*`, `src/components/shell/agr-alert-banner.ts`, `src/components/diagnostics/*`, `src/model/{header,diagnostics}.ts`, `src/demo/fixtures/people.ts`, `tests/header/*`, `tests/diagnostics/*` | WP0 | Presence shows only Home/Away/Unknown (zone-name fixture → Away); pill shows actual alarm state, with policy separate; connection, resyncing ("Reconnecting" indicator and banner), starting and demo states; clock minute-aligned (driven by `'clock'` meta) and locale/12-24h/time-zone aware; presence state never by color alone in the medium header; full alarm label in the compact pill; diagnostics admin-only, never renders `hass.config`, shows `version-conflict`, `controls` on/off, `services.warnings` and `gateway.recent()`, and reads forecast and live-view status from `services.status`; compact-header menu drawer; no header overflow at any §6.1 width (compact pill wraps, kolam hidden below 380 px); stale alarm shown as label plus a separate "Last known" line, including while resyncing |
| WP3 Today and weather | §9.2 | `src/components/today/*`, `src/model/today.ts`, `src/ha/hass/forecast.ts`, `src/ha/forecast-controller.ts`, `src/demo/fixtures/today.ts`, `tests/today/*` | WP0 | Acceptance item 10 including the §9.2 teardown details; hourly, daily-fallback and none VMs; high/low only from daily or twice_daily, with the "Tomorrow" label; sunset/sunrise; units from attributes; hero size and forecast cell count per the §6.1 content-width table; strip temperatures rounded to integers and labels from `formatter.hour()`; old-generation unsubscribes dropped (§9.2); no subscribe while resyncing; one retry after `invalid_entity_id` on RUNNING or a registry change; Today within its 360 px §6.2.1 target; writes `services.status`; refreshed on `'clock'` |
| WP4 Comfort | climate, air and bed tiles; climate drawer; shared fan controls | `src/components/comfort/*`, `src/model/comfort.ts`, `src/model/air.ts` and `src/components/shared/agr-fan-controls.ts` (both seeded by WP0), `src/demo/fixtures/comfort.ts`, `tests/comfort/*` | WP0 (WP1 for live actions; codes against the interface) | Bed tiles have no controls; stepper uses `ActionController.draft` and `stepValue` per §7.1/§7.2 (no own timers); HVAC modes and fan presets as `agr-choice-group` (arrows never send; one activation = one call); HVAC modes from `hvac_modes`; fan presets/speeds gated by bits; summary pill "Cooling"/"Heating" only from `hvac_action`; at most 2 tiles + "+N more"; Climate within its 140 px target; subscribes to `CONTROL_META`; `selectAirTile` and `agr-fan-controls` keep the M0.1 signatures WP5 imports |
| WP5 Home | rooms, lights, curtains, purifier-in-room, vacuums, appliances, studio monitors; room and home drawers | `src/components/home/*`, `src/model/home.ts`, `src/demo/fixtures/home.ts`, `tests/home/*` | WP0 (imports `selectAirTile` and `agr-fan-controls`, never edits them; until WP4 fills them the room purifier shows the WP0 placeholder) | Room quick toggle = one call scoped to the room's available lights; garage/gate/door covers in a room render read-only with the reason; vacuum actions by state and bits; battery derived or configured, absent rather than 0; appliance remaining formats, refreshed on `'clock'`; §6.2.1 budget with the home drawer; Home within its 352 px target; studio monitors "Requested" |
| WP6 Cameras | §9.3, §9.4 | `src/components/cameras/*`, `src/model/cameras.ts`, `src/ha/hass/camera.ts`, `src/ha/{camera-gate,snapshot-controller}.ts`, `src/demo/fixtures/cameras.ts`, `tests/cameras/*` (`demo-stream.ts` stays with WP0) | WP0 | Acceptance items 2 (camera part) and 9; the gate fails closed on any state other than the exact off value; `thumbnails` and `snapshot_interval` honored; image revoked at once on disconnect or resync for every camera; gate closed during the resync barrier and on a privacy entity not refreshed by the snapshot (row 9 barrier cases); at most 4 tiles plus an overflow drawer; Cameras within its 380 px target; privacy tiles look intentional; 4:3 tiles; native live via card helpers inside the event-containment wrapper (which lets `context-request` through), with `aspect_ratio`/`fit_mode`, near-black letterbox variables, and fallback (also after a contained `ll-rebuild`); live resume re-runs the full gate; 401 session denial respected and a 403 denies one tile; object URLs always revoked |
| WP7 Garage and vehicle | §8.5, vehicle telemetry | `src/components/garage/*`, `src/model/garage.ts`, `src/demo/fixtures/garage.ts`, `tests/garage/*` | WP0 | Acceptance item 7 (panel part); alarm-aware Open confirmation copy tested (§8.5); door state labels; vehicle bar with charge-limit tick, absent states, charger detail; generic sedan line art; vehicle hidden when not configured; Garage & car within its 304 px target |
| WP8 Media | compact player and media drawer | `src/components/media/*`, `src/model/media.ts`, `src/demo/fixtures/media.ts`, `tests/media/*` | WP0 | Active-player rule (overview shows only the active player); controls only for supported bits; plum volume slider through `ActionController.draft`; source list exact, as a vertical `agr-choice-group` (arrows never send); `off` state shows a compact "Off" row; Media within its 168 px target; no artwork |
| WP9 Upcoming | §9.5 | `src/components/upcoming/*`, `src/model/upcoming.ts`, `src/ha/hass/calendar.ts`, `src/ha/calendar-controller.ts`, `src/demo/fixtures/upcoming.ts`, `tests/upcoming/*` | WP0 | Hidden without `calendars[]`; Upcoming within its 180 px target with 2 events; summary/start/end only; escaped; `URLSearchParams` query; grouping rolls over on `'clock'`; no refresh during the resync barrier, one after it; teardown clean |
| WP10 Security drawer | §8.1–8.4 | `src/components/security/*`, `src/model/security.ts`, `src/demo/fixtures/security.ts`, `tests/security/*` | WP0 (WP1 for live routing) | Acceptance item 6 and the departure part of item 7; labels, consequences and confirm copy read from `model/action-copy.ts` (no local copy of them); only configured roles render; Silence Sound confirm rule; perimeter via `model/perimeter.ts` |
| WP11 House health | health panel and drawer | `src/components/health/*`, `src/model/health.ts`, `tests/health/*` | WP0 | Named inputs only; counts and lists by friendly name; never "All systems normal"; perimeter clause only when configured; perimeter via `model/perimeter.ts`; "Loading" rather than "Not found" while HA starts; House health within its 136 px target and never stretched (quiet surface) |
| WP12 Packaging and install | §11.1, §11.4–11.5, §13 | `scripts/*` except `stage-preview.mjs` (including `postbuild.mjs` from WP0's seed, `check-public.mjs`, `lib/public-scan.mjs`, `public-exemptions.json`), `install/*`, `tests/scripts/*`, `tests/install/*` | WP0 (build config) | `npm run build` produces the exact §11.5 tree; postbuild scan fails on a planted forbidden string, a planted lookbehind and a planted `toSorted`; `check:public` covers tracked, **untracked-not-ignored** and staged files plus staged blobs, builds the forbidden set from **every** `.dashboard-local/**/*.json` (keys and values, recursively: nested privacy and invocation IDs, bare compound object IDs, denylist), fails on an unparsable private file, drops service-registry strings (`service_names`) before deriving bare IDs, and passes exempted generic IDs, per every `tests/scripts/check-public.test.ts` case in §12.1 (including an ID found only in the context-shaped file); `tests/scripts/public-literals.test.ts` passes on the real tree; postbuild uses the same forbidden set; install.sh dry-run format, first-install `mkdir`, and every refusal (including symlinks) tested; generator writes only the private path, validates, always emits `controls: false`, refuses unknown labels, enforces exactly-one security helpers and vehicle suffixes, maps curtains (default room or listed as unassigned), flags vacuums "verify before enabling", and maps cameras per §13.4 (privacy fields exact, fail-closed thumbnails); the §13.5 operator snippet throws on an empty `CONFIG` before any write and prints exact undo commands; `tests/scripts/*` and `tests/install/*` run in the `node` Vitest project |

### Final work packages

| WP | Scope | Owns | Depends on | Acceptance criteria |
|---|---|---|---|---|
| WP13 Acceptance and e2e | §12 cross-cutting suites | `tests/acceptance/*`, `e2e/*`, `playwright.config.ts` (from WP0) | WP1–WP12 | Every §12.1 row and §12.2 spec green in chromium with zero page errors; a01 uses the runtime spies and the two-step reconnect; layout gate measured with `host=fake-hass` after `document.fonts.ready`; screenshots with reduced motion; `keyboard.spec.ts` green in WebKit (via `tabKey`); `layout.json` metrics reported; full WebKit run documented; screenshots captured to `test-results/screenshots/`; failures filed against the owning WP |
| WP14 Integration and polish | composition, visual refinement, docs | `src/agraharam-dashboard.ts`, `src/components/primitives/*`, `src/components/shell/*` except `agr-alert-banner.ts`, `src/styles/*`, `src/util/*`, `src/icons/*`, `README.md` (all from WP0) | WP1–WP12, iterating with WP13 | Every `tests/root/lifecycle.test.ts` case passes with the real gateway (WP1's `createGateway`, no root edit needed); focus restored by `data-focus-key` after layout changes and on drawer close; `normal` meets the §6.2.1 hard gate (tightening `budget.ts` if needed); visual review at the 3 viewports against the reference qualities (palette, editorial number, balanced columns, insets and radii); `npm run verify` and `test:e2e` pass; README documents `npm ci`, `npx playwright install chromium webkit`, `dev`, `build`, `typecheck`, `test`, `test:e2e`, `preview` and `config:private`, and the **commit procedure**: `npm run verify`, `git add`, then `npm run check:public` again on the staged tree before every commit (§11.1); `src/icons/*` owned from WP0 for later icon additions; handoff report separates demo validation, live rendering, physical tests and deployment |

Dependency graph: `WP0.M0.1 → WP1 ∥ (WP0.M0.2 → WP2…WP12 in parallel ∥ WP0 rest) → WP13 ∥ WP14`. Until WP1
lands, the seeded `createGateway` returns the null gateway (every action disabled with reason `unsupported`)
through the WP0 `ActionController`, so sections can build UI without waiting. WP5 consumes WP4's two shared
files only through their M0.1 signatures, so the two packages run in parallel. A section package adds demo
entities, scenario variants and device behaviors only through its own `SectionFixture` (§10.2); it never edits `configs.ts`, `scenarios.ts`, `simulate.ts`,
`demo-host.ts`, `fake-hass.ts` or `hass-host.ts`.

---

## 15. Risks and open questions (live verification needed)

| # | Item | Risk / unknown | Mitigation / verification |
|---|---|---|---|
| 1 | HA version today | 2026.9.2 was last observed 2026-09-17 | Read `hass.config.version` in diagnostics after the demo install; re-check the §4.3 contract if it is not 2026.9.x/2026.10.x |
| 2 | `/local` serving | `www` may not have existed at startup | Preflight manifest URL (§13.5); report a restart separately, never perform one |
| 3 | File channel | No authorized NAS transfer path is established | Ask the user for the share path; install.sh refuses unknown layouts |
| 4 | Sidebar and toolbar sizes | 256/56 px and 56 px are assumptions | Measure the card width live at 1194 and 1440; adjust `BREAKPOINTS` in one constant |
| 5 | Native live view | `ha-camera-stream` inside our shadow root and top-layer dialog: context timing and stream types per camera integration are untested | Verify each camera's live view in HA; the snapshot fallback is always available; never change camera privacy to test |
| 6 | Capabilities | Climate, fan, curtain and media `supported_features` are unknown for several entities | The UI reads features at runtime; review the diagnostics feature column after first live render |
| 7 | Guarded scripts | Script existence, modes and semantics must be re-read from live config before enabling buttons | Staged enablement: the generated config has `controls: false`, so real bindings render read-only; §13.5's read-only verification (script sequences, diagnostics) precedes `controls: true`; the first render can also use `demo: true` |
| 8 | Script confirmation | `last_triggered`/`context` behavior for guarded scripts is unverified | Ticket shows "Requested" only; the alarm row is the truth; an uncertain result never retries |
| 9 | Non-admin rendering | Resources and dashboards load for non-admins, but this is unverified here | Readback step as a household account |
| 10 | Vacuum battery | The derived battery sensor may not exist on the live registry | Shows absent; add `battery_sensor` in private overrides |
| 11 | Weather capability | Hourly support is assumed | Daily-fallback path is designed and tested |
| 12 | Dashboard URL in the UI dialog | The add-dashboard dialog may not expose `url_path` | Use the WS path in §13.5 |
| 13 | Resource mode | Must be storage | `lovelace/info` preflight |
| 14 | Error shapes and non-admin control | `Unauthorized` arrives as `home_assistant_error`, inferred from source. HA exposes no per-entity permissions to the client, so a restricted user sees **enabled** controls until the first call is rejected; a disabled-state check cannot verify the mapping | Accepted limitation: the first rejected tap shows the permission message and the control then stays disabled (sticky denial). The mapping is verified by unit tests and the `restricted` demo scenario only. No live call is made to test it, not even a rejected one |
| 15 | http.ban | Repeated camera 401s could count toward IP bans behind the tunnel | Stop on the first 401/403 (`denied`); backoff on other errors |
| 16 | Contexts vs `hass` | HA may later stop pushing `hass` to cards | Only `HassHost` changes; a context-based host would implement the same `HostRuntime` |
| 17 | Node type stripping | The generator imports TS directly | Fallback: a Vitest-based `config:check` that validates the generated file |
| 18 | Wall-tablet engine | Unknown browser engine and version | Stated floor Safari/iOS 16.4+, Chrome/Edge 108+, Firefox 110+ (§1.2 item 11); no lookbehind in the bundle (postbuild check); run the WebKit e2e project before deployment; fonts use document-level registration that works in all three engines |
| 19 | Bundle size and the 2 s define window | If the module takes over 2 s to load, HA's "custom element doesn't exist" card is visible until it does | Budget of 220 KB JS; fonts are not on the critical path (`display: swap`) |
| 20 | Content density | Real counts exceed the demo; the reference's balance may not survive them. The live configuration has more comfort entities than the 2-tile Climate budget, so "+N more" will show | §6.2.1 budget and per-panel height targets; `normal` must fit at 1440×900 (hard gate); `dense` overflow is reported in `layout.json`; tune `budget.ts` after the first live render |
| 21 | Misleading script names | A script's name may not describe what it does (a persistent disarm can carry a legacy name) | One script per role (validation + gateway), Silence Sound confirms unless the alarm is sounding, and the private generator's exact label map; the operator verifies each role against live script config before enabling real bindings (#7) |
| 22 | Camera thumbnail default | Cameras without a privacy binding start as "Live view on request" in the generated config, which is less glanceable than the reference | Deliberate fail-closed default (§13.4). The operator opts outdoor cameras in through `camera_thumbnails` after checking each one; indoor cameras stay off |
| 23 | hajs event API | `connection.addEventListener('ready' / 'disconnected')` is hajs public API in 9.6.0, but HA could swap the connection object | Feature-detected; the generation and the resync barrier also move on observed `connected` transitions and on a new `hass.connection` identity (§4.4) |
| 24 | Resync barrier signal | The barrier clears on the first new `hass.states` reference after a reconnect. This relies on 20260826.7 keeping the states reference for every non-state update; a future frontend that rebuilt `states` on a config push would clear it early | The per-entity `freshSinceResync` check still keeps cameras closed until their privacy entity object is replaced; re-check `connection-mixin.ts` on each HA upgrade (#1). A barrier with no state change holds (fail closed), which a live house never shows for long |

---

## 16. Review log

### 16.1 Round 1 blocking issues

| # | Issue | Resolution |
|---|---|---|
| B1 | Stepper draft auto-commits after an uncertain or failed ticket; debounce timers survive disconnect, preview and unmount | Drafts and debounce timers moved out of the leaves into the WP0 `ActionController` (§4.7). A held draft is sent only after a `confirmed` settle with the epoch, phase and host unchanged; `uncertain`/`failed` and every disconnect, preview, config change or unmount discard it as "Not sent" (§7.2). The gateway gained `epoch()`, `invalidate()`, `RequestOptions.epoch` and `not-sent` after `dispose()` (pipeline step 0). Tests in §12.1 rows 4 and 5, including the four the reviewer listed |
| B2 | One script in two security roles; garage cover configured as a curtain | `duplicate-security-script` validation (§4.2 rule 6) plus the gateway's request-time check (§4.7 step 4); gateway step 5a refuses `curtain.*` on `garage`/`gate`/`door` device classes and the room UI shows them read-only. Also: Silence Sound now confirms unless the alarm is `triggered` or `pending`, which narrows the damage of a mislabeled single binding that no validator can detect. Tests in §12.1 rows 6 and 7 |
| B3 | Camera privacy gate fails open on unexpected values | `privacy_on_value` validated as exactly `'on'`/`'off'` (§4.2 rule 7); the gate allows only the exact opposite value and maps everything else to `privacy(unknown)` (§9.3). Tests in §12.1 row 9 |
| B4 | Detach/re-attach breaks controls and dialogs; sections freeze after a live config change; services identity unspecified | Explicit lifecycle table (§9.1). The gateway survives detach and is rebuilt on every accepted config or when disposed; the overlay host closes every dialog on detach and guards `showModal()` (§5.4 rules 11–12); `EntityController` resubscribes on store identity (§4.5); `DashboardServices` is declared and memoized (§5.1). Lifecycle tests (§12.1) and three dev-shell remount modes used by `e2e/fake-hass.spec.ts` and `e2e/keyboard.spec.ts` (§10.3, §12.2) |
| B5 | No contracts between parallel packages for demo data and adapter seams; validate ↔ demo import cycle | `src/demo/fixture-types.ts` with `SectionFixture`, `DemoBehavior`, `ScenarioSpec` and generic assembly shared by `DemoHost` and `FakeHass`, plus one WP0 `simulateServiceCall` (§10.2); seam signatures for `src/ha/hass/*` (§4.4); `action-controller.ts` moved to WP0; `DashboardServices` in `src/components/services.ts`; demo substitution moved to the root with scenario validity as a test (§4.2 rule 9). All are in M0.1 (§14) |

### 16.2 Non-blocking suggestions adopted

- hajs queued-message gap: `ConnectionLike.connected`; `port.invoke` checks the live socket getter and rejects
  `PortNotSent` without calling (§4.3, §4.4); test in §12.1 row 4.
- Embedded `picture-entity` events contained (`ll-upgrade`, `ll-rebuild`, `ll-custom`, `card-visibility-changed`,
  `hass-more-info`, `hass-action`), `double_tap_action: none`, `ll-upgrade` re-assigns `hass` (D1, §9.4); test.
- Module-level in-flight registry keyed by target entity (§4.7).
- `CONTROL_META` for sections that render controls (§4.5).
- Forecast teardown: never await subscribe, unsubscribe a late-resolving subscription, swallow unsub rejections
  (§9.2); tests.
- Runtime key = host kind + demo scenario + bound set (§9.1).
- Derived IDs kept in a separate store set and never actionable; rule 8 contradiction removed (§4.2 rule 10).
- `check:public` in `verify`, scanning tracked and staged source plus dist with a shared exemption list (§11.1).
- Confirm copy looked up from one catalog by action; auto-cancel after 60 s; confirm disabled or closed when its
  preconditions or the connection change (§5.2).
- Garage reversal settles at once as `reversed` (§4.7, §7.1, §8.5).
- Camera hygiene: per-camera `thumbnails: false` and `snapshot_interval`; stale images dropped after 5 minutes
  disconnected (round 3: revoked at once, §16.8); the "no capability URL in the DOM" claim limited to stills
  (§2.3, §4.1, §9.3, §9.4).
- §15 #14 rewritten as an accepted limitation.
- Fitness test: no `hass-more-info`, `hass-action` or `ll-custom` dispatch from `src` (§12.1 row 11).
- Browser floor stated; entity-ID check rewritten without lookbehind; postbuild rejects lookbehind (§1.2, §4.2,
  §11.5).
- Calendar query via `encodeURIComponent` and `URLSearchParams` (§4.4, §9.5).
- Install hardening: symlink and real-path refusal; optional privacy re-scan; rollback IDs from create responses
  or readback (§13.2, §13.5, §13.6).
- Config errors: path and code for non-admins, full messages for admins (D4).
- `defineOnce` version-conflict detection (§11.3).
- Harness build fix (`String(...)` + `@vite-ignore`, plus `external`), import-boundary fitness test, built-module
  version marker asserted in e2e (§10.3, §11.3, §12.2).
- happy-dom limits: dialog unit tests restricted to state logic; native dialog behavior verified in Chromium and
  WebKit e2e (§5.4 rule 14, §12.2).
- Scenarios `loading`, `restricted`, `starting`, `dense`; a missing binding in `degraded` (§10.2).
- Content budget per panel and the `dense` 1440×900 fit goal (§6.2.1; revised in round 2, §16.5).
- `PANEL_CQ` recomputed from actual column widths; queries measure the content box (§6.1).
- Text colors restricted to the six text tokens; uncertain uses brass-ink; fitness test (§6.5, §7.2).
- Startup: absent IDs read "Loading" while HA is not running (§4.6). Snapshot "changed" means bound ID or gate,
  not a new state object (§9.3).
- `'clock'` meta from the minute ticker, realigned on visibility (§4.4, §4.5, §9.1).
- Focus restore by `data-focus-key`; the root routes overlay events; element-wise meta tuple comparison (§4.5,
  §5.1).
- Accessibility: presence glyphs in medium mode, sibling buttons in composite tiles, `aria-valuetext` with units,
  full alarm label in the narrow pill, demo stream stops under reduced motion, `customCards` `preview: false`
  (§5.1, §6.4, §6.5, §7.2, §11.3).
- `:host` style reset and HA-like dev-shell typography; `::backdrop` literal fallback (§5.4 rule 13, §6.5).
- Test details: `setFixedTime` with an explicit offset; `npx playwright install webkit firefox` documented
  (§11.1, §12.2).
- Tile values and forecast temperatures in Newsreader; camera tile name overlay specified (§2.3, §6.5).
- "Tomorrow" high/low label; `erasableSyntaxOnly`; `as const` feature tables; shared `model/perimeter.ts`
  (§4, §4.8, §9.2, §11.2).

### 16.3 Suggestions rejected or adopted differently

- **Dispose the gateway on detach and recreate it on attach** (frontend-quality B4 fix): adopted the ha-safety
  variant instead. The gateway survives detach, because recreating it would drop in-flight locks across an
  edit-mode toggle. The reviewer's test (exactly one invoke after re-attach) is kept.
- **Map a bare `3` to `failed` ("Not sent")**: kept as `uncertain`. "Nothing changed" copy should not rest on a
  library detail; the port's own live-socket check reports the known never-sent path truthfully (§4.7).
- **Plan a separately authorized, rejected live call to verify `Unauthorized`** (§15 #14): rejected. Verification
  makes no live service calls at all; unit tests and the `restricted` scenario cover the mapping.
- **CQ thresholds of 8 cells at 360 px and a 96 px hero at 380 px**: adopted with different values (8 cells at
  320, hero 96 at 360, 80 at 300). Forecast cells are not interactive, so 40 px cells are acceptable, and this
  shows 8 hours at 1440×900 in both sidebar states as the reference does.
- **Have the gateway publish a separate availability change signal**: not added. `CONTROL_META` plus the
  `ActionController`'s gateway subscription already re-render controls on every input to `Availability`; one
  mechanism is simpler.
- **Re-run the privacy scan in `install.sh`** ("optionally"): adopted only when `node` is available, because the
  operator's machine may lack it and the checksums already bind the copied files to the scanned build.

### 16.4 Round 2 blocking issues

| # | Issue | Resolution |
|---|---|---|
| R2-B1 | Private config generator drops camera privacy bindings, so cameras with privacy switches would be fetched with privacy ignored; no fail-closed default for cameras without a privacy binding | §13.4 camera mapping rules: `privacy_entity`/`privacy_enabled_value` map exactly to `privacy_entity`/`privacy_on_value`; a value other than exactly `on`/`off`, a privacy domain outside `DOMAINS_BY_ROLE.camera_privacy`, half a binding, or excluding a privacy entity while keeping its camera all exit 1 without writing; a post-condition asserts no privacy binding was lost. Cameras without a privacy binding are emitted with `thumbnails: false` unless `overrides.camera_thumbnails[entity_id] === true` (unknown keys exit 1); `thumbnails` is always explicit. `install/overrides.example.json` gains a fictional `camera_thumbnails` entry (§13.3). Tests in `tests/scripts/private-config.test.ts` on a fictional fixture, including a round trip through `validateConfig` and `cameraGate`, referenced from §12.1 row 9 and WP12 |
| R2-B2 | `check:public` never scans untracked files, so the first commit of the untracked tree goes out unscanned; matcher too narrow | §11.1: scans the union of tracked, untracked-not-ignored (`git ls-files --others --exclude-standard`) and staged files under `frontend/agraharam/`, plus each staged **index blob** and dist, via `execFileSync` with `-z`. The forbidden set is built by a recursive walk of the candidates file (nested `privacy_entity`, `guarded_actions[].entity_id`, `invocation.data.entity_id`), entity-ID-shaped substrings in prose with known domains, bare compound object IDs of 8 or more characters, and an optional private denylist, minus the exemptions. Output never prints the matched value. `tests/scripts/check-public.test.ts` plants an ID in an untracked, unstaged file in a temp repo, among other cases (§12.1). The commit procedure (verify, stage, re-run `check:public`, commit) is in §11.1, the README and WP14 |

### 16.5 Round 2 non-blocking suggestions adopted

- Forecast unsubscribe after reconnect: `HostReader.connectionGeneration()` from hajs `ready`/`disconnected`
  events and phase transitions; the forecast seam takes `generation` and drops, never calls, an unsub from an
  older generation; the misleading "can reject" rationale is replaced; test added (§4.3, §4.4, §9.2, §12.1 row 10;
  e2e check in `fake-hass.spec.ts`).
- `evaluate()` never returns `confirmation-required`; `Availability` carries `confirm` and sections route
  through the confirm dialog on it (§4.7, §5.2, §7.2, §7.3).
- Departure confirm button is now "Prepare garage departure", so the label-equality test holds (§8.2).
- Garage Open confirmation is alarm-aware (armed or arming, plus unknown/stale), information only, never
  chained (§5.2, §8.5, §12.1 row 7).
- "Unknown state" column in §7.1, referenced by gateway step 6 and the §7.2 toggle rule; generic `state-unknown`
  copy (§7.3).
- Containment wrapper stops exactly six event types; `context-request` must propagate; test (D1, §9.4, §12.1 row 9).
- Camera hygiene: 401 is a session-level denial shared by all tiles and the fallback; live-view resume re-runs
  the full gate; tests (§4.4, §9.3, §9.4).
- Fitness tests for `subscribeMessage`, `callApi`, `fetchWithAuth`, `callWS`, `sendMessage*` and
  `querySelector('home-assistant')` call sites (§12.1 row 11).
- WebSocket operator snippet: guards are code (existing dashboard throws; one existing resource is updated, two
  throw) (§13.5).
- `install.sh` creates `<dest>` with one non-recursive `mkdir -m 0755` on a first install; dry-run line; test
  (§13.2, §12.1).
- Health headline says "monitored entry points" (§4.8, §6.3).
- Generator security helpers require exactly one match each (§13.4).
- Drawer element contract in M0.1: `DrawerElement`, `DRAWER_TAGS`, `agr-drawer` owns the dialog, heading,
  close button, Demo pill and `agr-drawer-closed`; the camera dialog disposes on its `close` event (§5.2, §10.1).
- Full curated icon set listed in §6.5 and landed in M0.1; `IconName` is a literal union; names verified against
  lucide 1.51.0 (`circle-question-mark`, not the `circle-help` alias).
- Error containment for HA's logging mixin (§4.9): terminal catches, try/catch in the setter, `setConfig` and
  handlers, no URLs in errors, page-error counters asserted in every e2e spec.
- WebKit keyboard: `tabKey(browserName)` helper, Alt+Tab treated as Tab by the trap, `npx playwright install
  chromium webkit` as the default (§5.4 rule 4, §11.1, §12.2).
- Layout matrix includes card widths 1138, 1080, 720 and 640; the header has its own container query and
  compact variant; stale pill uses two lines (§6.1, §6.4, §12.2).
- Dense fit: the hard gate is `normal` at 1440×900 collapsed; `dense` asserts no horizontal overflow and aligned
  bottoms, and reports vertical overflow (§6.2.1).
- Camera tiles 4:3 with `object-fit: cover`; live view uses `aspect_ratio: '16:9'` and `fit_mode: 'contain'`
  (§6.5, §9.4).
- Accepted `setConfig` closes overlays (deep-equal configs are a no-op); lifecycle test (§9.1, §12.1).
- Dark variant: `color-scheme` and `accent-color` on `:host`; theme reflected onto every dialog for the
  `::backdrop` literal (§5.4 rule 13, §6.5).
- `lib: ES2022` plus a postbuild grep for ES2023 array-copy methods (§1.2, §11.2, §11.5).
- Fixture contract: `ScenarioSpec.user`, `missingServices`, `haVersion`; forecast error in `starting`, no forecast
  bits in `empty`, unknown garage position in `degraded` (§10.2).
- WP0 seeds a pass-through `postbuild.mjs` and owns `stage-preview.mjs` (§14).
- Diagnostics reads forecast and live-view status from a WP0 `StatusBoard` in `DashboardServices` (§5.1, §4.8).
- ResizeObserver on the card host, mode applied in `requestAnimationFrame` (D2).
- Monotonic `performance.now()` for in-flight expiry and ticket durations (§4.7).
- Accessibility: `<h2>` panel and drawer headings in labelled sections; `aria-disabled` with a click guard for
  action buttons; integer forecast-strip temperatures (§5.1, §7.2, §4.8).
- Derived vacuum battery recomputed on RUNNING, reconnect and late-arriving device states (§4.4).
- Hass access boundary: the two root reads are listed and fitness-tested; the root setter is wrapped;
  `StoreView` replaces `EntityStore` in UI-facing types, and `HostRuntime.tick()` is the root's only store
  mutation (§4.4, §4.5).
- M0.2 milestone so section packages start before all of WP0 is finished (§14).

### 16.6 Round 2 suggestions rejected or adopted differently

- **`camera_thumbnails` keyed by camera name**: keyed by entity ID instead (like every other overrides map).
  Names are display text and can collide or change; the overrides file is private, so IDs are fine there.
- **Throw when a resource under `/local/agraharam/` already exists** (§13.5): adopted as "update the single
  existing resource, throw on two or more". This is the documented upgrade path and still never creates a
  second URL.
- **Walk the working tree instead of git lists** (check-public): used git lists (tracked, untracked-not-ignored,
  staged) plus staged index blobs. This respects `.gitignore` without a hand-kept exclusion list and also catches
  content that is staged but already fixed in the working tree.
- **Bare object-ID matching for every object ID of 8 or more characters**: limited to compound object IDs (an
  underscore or digit). A single dictionary word such as an appliance name would fire on ordinary prose and
  wireframes; such IDs are still caught in full `domain.object` form.
- **Icon registry per section**: chose the other offered option, one curated list landed in M0.1, because one
  reviewed registry keeps the single stroke weight and avoids name collisions; later additions route through
  the WP14 owner.
- **Garage Open warning only for armed or arming**: extended to an unknown or stale alarm state too, because the
  private handoff asks for the actual state to be read before presenting a garage-open action.

### 16.7 Round 3 blocking issues

| # | Issue | Resolution |
|---|---|---|
| R3-B1 | After a reconnect, `connected` turns true before the state snapshot arrives, so pre-outage states count as live: the camera gate can fetch on a stale privacy "off", controls re-enable and "Last known" disappears | Post-reconnect snapshot barrier (§4.4): a module-level `ResyncTracker` per connection arms on hajs `ready`, an observed `connected` false → true and a new connection object, and clears on the first new `hass.states` reference. While armed the phase is `resyncing`, which every consumer treats as disconnected: `port.invoke` and gateway step 3 refuse, values stay stale, the camera gate returns `disconnected`, forecast and calendar restarts wait (§4.5, §4.6, §9.1–§9.5). Defense in depth: the gate also requires a privacy entity object replaced by the snapshot (`freshSinceResync`, §9.3). FakeHass and the dev shell model HA's two-step order, with "Outage change" (§10.3). Tests: `tests/ha/resync.test.ts`, §12.1 rows 1, 4, 9 and 10, and the `fake-hass.spec` privacy-during-outage case |
| R3-B2 | `check:public` builds its forbidden set from the candidates file only, which holds a small fraction of the real IDs in the private context file developers are told to read; nothing enforces "all IDs are `*.demo_*`" | The forbidden set is built from **every** `.dashboard-local/**/*.json` (keys and values, recursive; an unparsable file exits 1; HA service-registry strings dropped via `service_names`), shared with postbuild and the install re-scan (§11.1, §11.5). A positive public-literal check, needing no private files, requires every entity-ID-shaped literal in `src/demo`, `src/dev`, `tests`, `e2e` and `install` to be `demo_*`, exempted, or a catalog `domain.service` (`tests/scripts/public-literals.test.ts`). `check-public.test.ts` plants an ID that exists only in a context-shaped file (§12.1, WP12) |
| R3-B3 | Choice controls (HVAC mode, fan preset, media source) had no activation semantics; radio groups and selects change value, and so send actions, on arrow keys | One pattern, `agr-choice-group` (§7.2, §5.5): a labelled group of native `<button aria-pressed>`, each in the tab order; only click, Enter or Space emits, once; no navigation-key handlers, so arrows, Home and End never send; the current option is disabled `not-applicable`; key repeat ignored; radios, `role="radio"`, `<select>` and listbox are banned by a fitness test (listbox + explicit Apply is the only permitted alternative, unused in v1). Primitive public APIs are now M0.1, with reason text and headings rendered in each primitive's own shadow root so IDREFs resolve. Tests: `agr-choice-group.test.ts`, drawer tests and a `keyboard.spec` case (§12.1 row 5, §12.2) |

### 16.8 Round 3 non-blocking suggestions adopted

- Staged enablement: `controls` config key, default `false`; gateway step 2a returns `controls-off`; the generator
  always emits `false`; §13.5 adds a read-only verification before `controls: true` (§4.1, §4.7, §13.4, §13.5).
- Camera stills are revoked at once on disconnect or resync for every camera; no dimmed last image (§9.1, §9.3).
- Orphaned runtimes are disposed after 60 s detached; the in-flight registry keeps locks; only the module-level
  tracker listens on the connection (§9.1).
- A contained `ll-rebuild` fires `onFail('helpers-failed')` and switches to the snapshot fallback (§4.4, §9.4).
- `stepValue` snaps to the step grid and clamps before deltas; validation accepts exactly its outputs (§7.1).
- Fitness tests: no storage APIs anywhere in `src` (the dev shell uses URL query state); CSS floor patterns
  (`&` nesting, `:has(`, `color-mix(`, `light-dark(`, `subgrid`) rejected (§1.2, §12.1 row 11).
- Generator: curtains mapped or listed as unassigned; vehicle suffixes exactly one; vacuums flagged "verify
  before enabling" (§13.4).
- Forecast retries once after `invalid_entity_id` on RUNNING or a registry change (§9.2).
- Operator snippet: named `CONFIG` that throws when empty before any write; prints exact undo commands when a
  later step fails (§13.5).
- Live-mode zero-mutation tests use runtime spies for `callWS`, `sendMessage`, `sendMessagePromise` and
  `subscribeMessage` (§10.3, §12.1 row 1).
- Height budget: per-panel targets at 1440×900, Climate budget 2, `normal` composition specified, gate measured
  with `host=fake-hass`; medium template rebalanced to the narrow order; only raised panels stretch (§6.2,
  §6.2.1, §10.2).
- `Formatter.hour()` for forecast cells; strip without inner padding (§4.4, §4.8).
- `FixtureClock`: fixtures are relative to now (§10.2).
- Diagnostics data path: `DashboardServices.warnings` and `ActionGateway.recent()` (§4.7, §5.1).
- e2e waits for `document.fonts.ready`; screenshots with reduced motion and disabled animations (§12.2).
- Initial layout measured synchronously (D2); card height model, canvas painter and safe-area inline padding
  (§6.5); compact pill may wrap and the kolam hides below a 380 px header box (§6.4).
- WP seams: WP0 seeds `createGateway` (WP1 never edits the root); `selectAirTile` and `agr-fan-controls` seeded
  by WP0 and owned by WP4, imported by WP5; leftover WP0 files pass to WP14; `SelectorInput` declared; camera
  dialog is a `DrawerElement` that stacks and restores focus to its tile (§3, §4.8, §5.2, §14).
- Vitest `node` project for `tests/scripts` and `tests/install` (§3, §12.1).
- Live-view letterbox variables; `agr-panel` icon and right-aligned pill; confirm dialog `role="alertdialog"`;
  focus restore via `data-focus-key`; side sheet at ≥ 720 px viewport, `min(440px, 92vw)` (§5.2, §5.4, §5.5,
  §9.4).
- Demo coverage: weather unavailable (restricted), `uncertain('connection-lost')` and media off (degraded), 403
  single-tile denial (dense), never-confirm Silence Sound driven by `screenshots.spec` (alert) (§10.2, §12.2).

### 16.9 Round 3 suggestions rejected or adopted differently

- **Move connection listeners into `HostRuntime.attach()`/`detach()`**: replaced by the module-level
  `ResyncTracker` (the only connection listener, once per connection) plus orphan disposal after 60 s. The
  tracker must outlive runtimes so a runtime rebuilt during an outage still sees the barrier.
- **Harvest friendly names from the context file as denylist literals**: not automatic. Generic multi-word
  names would collide with fictional fixture names; household names belong in the private denylist.
- **Climate budget of 2 in wide mode only**: 2 in every mode, so selectors stay independent of width (§4.8).
- **Wide column 1 reordered with House health first**: not adopted; the raised-only stretch rule already lets
  Home, not the quiet House health box, absorb the column's slack.
- **Roving tabindex in choice groups**: not in v1. Every option is in the tab order and the group handles no
  navigation keys, which makes "arrows never act" true by construction.
- **Positive literal check inside `check:public`**: run as a Vitest test instead (it needs the TypeScript
  catalog); it still runs in `npm run verify` before every commit.
- **Gate order**: `!live → disconnected` now precedes the privacy check. Both outcomes are closed; while the
  state is uncertain the tile says so instead of showing a possibly stale "Privacy on".

### 16.10 Implementation addenda (team lead, from the round-4 confirmation warnings)

These bind the owning work packages without another design round.

- **Resync base (WP0).** The tracker records the first `states` reference observed after the latest
  `disconnected` event or after arming. If no host has observed anything since then, the first `observe()` after
  arming only sets the base and never clears the barrier. A tracker created while a reconnect may be in flight
  starts in that pending-base state (brief "Loading" until the next state change).
- **One definition of connected (WP0).** `StoreSnapshot.connected = hass.connected && hass.connection.connected
  === true`, evaluated at ingest; tracker events re-ingest. Test: `hass.connected` true with the live getter false
  gives camera gate `disconnected` and zero `fetchWithAuth` calls.
- **Not fresh after a barrier means stale (WP0).** After a barrier clears, any bound entity whose object was not
  replaced by the snapshot (for example one deleted during the outage) normalizes as stale for every role, not
  only camera privacy.
- **Realistic hidden-tab order (WP0, WP13).** FakeHass and `a01(b)` cover: panel removed, one state change, socket
  dropped, element re-appended before `ready`, then the two-step reconnect.
- **Runtime hygiene (WP0).** `ensureRuntime()` runs only while `this.isConnected`; the camera 401 session-denial
  flag lives at module level per connection and clears on a generation or user change.
- **Live view across a reconnect (WP6).** An open camera dialog shows "Paused while disconnected" and needs a
  "Resume live view" tap that re-runs the full open gate; it never auto-restarts.
- **check:public strictness (WP12).** Find private files via `AGR_PRIVATE_DIR`, else the worktree root. In
  `verify` and the commit procedure a missing private directory exits 2 unless `--allow-missing-private` is
  given. Add `check:public --range <rev-range>` to scan every blob reachable in the commits about to be pushed.
  Rule 2 and the positive literal check share one constant listing core's entity platforms plus helper domains
  (`input_*`, `counter`, `timer`, `group`, `schedule`, and so on).
- **Medium balance and padding (WP0 layout, tuned by WP14).** Assign medium column membership greedily from the
  `budget.ts` targets while keeping each column's internal narrow order (DOM order still equals visual order).
  Today uses 24 px padding in wide and the normal panel padding in medium and narrow; `forecast8` is 312 px so
  sidebar width jitter cannot drop the strip to 6 cells.
- **Shared comfort seam (WP0 seeds, WP4 owns).** `selectAirTile(input: SelectorInput, ref: Ref, role: 'air' |
  'room_purifier'): AirTileVM` and `agr-fan-controls` with `{ tile: AirTileVM; draft: DraftState; focusKeyPrefix:
  string }`; it re-dispatches its events composed to the drawer holding the `ActionController`.
- **Accessibility details (owning WPs).** The section live region is the only live region (button status text is
  static); steppers use `aria-disabled`, not native `disabled`; `agr-value` names its field with visually hidden
  text, not `aria-label` on a generic element; with `controls: false` one panel-level notice replaces per-control
  lines; the "Current …" copy for the disabled current option varies by kind (mode, preset, source).
- **Demo coverage (WP0).** `degraded` includes the alarm in `unknown`, so the wrapping compact pill is exercised.

