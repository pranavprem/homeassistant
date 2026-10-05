# Prompt for Claude Code

Build **Agraharam**, a polished, custom-designed dashboard for my Home Assistant,
in this repository. I want the visual quality of the reference image: warm cream
surfaces, olive/brass accents, editorial typography, calm density and a deliberately
composed three-column landscape layout. It should feel like a beautiful household
control surface, not an admin console or a wall of stock cards.

## Read before implementing

Read the root `CLAUDE.md`, `docs/dashboard/README.md`, `DESIGN.md`,
`IMPLEMENTATION.md`, and `ACCEPTANCE.md`. Read `.dashboard-local/README.md`, the
private binding/context files it names, and visually inspect
`.dashboard-local/reference-dashboard.jpg` if available. Check `git status` and
preserve all unrelated edits. Existing YAML is reference material, not proof of
live deployment. Private context must stay out of git and build artifacts.

## What to build

Use `frontend/agraharam/` as the source root. Prefer TypeScript + Lit + Vite,
compiled into a custom Lovelace card in a full-width **panel view**. This gives
custom HTML/CSS inside HA with its existing authenticated session and navigation,
without adding a separate backend, token-pasting login, or HA restart just for a
custom sidebar panel. Keep a clean HA adapter boundary so the components can be
previewed using fictional data. Explain a material architecture deviation before
committing to it, but do not block on routine implementation choices.

Build the responsive home overview and useful detail drawers:

- Header: household presence, actual security state, connection health, date/time.
- Today: large weather/temperature treatment and a supported hourly forecast.
- Climate and air: real available thermostats, cooling/fans, purifiers.
- Home: lighting/room shortcuts, robot vacuum status, useful appliance summaries.
- Cameras: authenticated thumbnails with explicit privacy/offline states; open
  one stream on demand rather than autoplaying every indoor camera.
- Garage/vehicle: garage status/action and supported vehicle charge/range data.
- Media: compact now-playing/control surface for supported players.
- Upcoming: only when a real configured calendar/task source is available.

Adapt the reference to my devices, not the other person's cars, watches, flights,
family, Sonos system or networking gear. Favor a curated overview; put deep
controls behind accessible drawers. Missing integrations should not be invented.
Use the private binding manifest to separate real entities from demo fixtures.

## Non-negotiables

- No long-lived credentials in frontend code, URLs, source maps, localStorage or
  git. Use the HA session passed to the component; keep any HA-issued transient
  camera capability URL ephemeral. Bundle dependencies locally, no runtime CDN imports.
- Keep current dashboards and defaults intact. Build for a separate new route.
- Do not edit or redeploy automations, security policy, camera profiles or the
  household's current armed/held state. Do not test physical controls on the house.
- Security buttons call only the verified existing guarded scripts. Actual alarm
  state, selected policy, health and detection coverage are different concepts.
- Initial render, preview, reconnect and navigation send **zero service calls**.
- Device actions need deliberate user gestures, capability checks, pending/error
  handling, and observed state acknowledgement. Do not silently queue actions offline.
- Never store private camera images under `/local` or in screenshots committed to git.
- Show disconnected, missing, unavailable, privacy-enabled and error states honestly.
  Demo mode is conspicuously labeled and cannot issue real device commands.

## Delivery

1. Briefly summarize the implementation approach, then build it.
2. Deliver a working fictional-data preview, real HA adapter and configurable
   entity bindings; `npm ci`, `npm run dev`, `npm run build`, `npm run typecheck`,
   `npm test`, and `npm run test:e2e` should be documented and repeatable.
3. Visually inspect at 1440×900, 1194×834 and 390×844. Capture fictional-data
   screenshots; refine typography, spacing, composition, focus behavior and overflow.
4. Run the meaningful adapter/control/accessibility checks in ACCEPTANCE.md.
5. Provide an additive installation bundle: versioned static assets, one resource
   registration, example panel-view dashboard, deployment/dry-run/rollback steps.
   Account for this repo's Portainer Git deployment model. A local build is not
   automatically installed on the NAS.
6. Build and verify locally; prepare the exact installation diff before asking
   about live deployment. Do not restart HA, change the active dashboard or write
   live configuration as an incidental build/test action.
7. End with changed files, commands run, preview instructions, verification results,
   and the exact remaining deployment step/blocker. Separate demo validation from
   real HA rendering and physical device tests. Do not claim a mock is live.

Make reasonable design decisions and keep going. If private/live access is missing,
finish the demo implementation and installation package, label the missing live
verification, and ask only for the concrete information needed to connect it.
