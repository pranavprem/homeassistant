# Definition of done

This checklist is for the eventual dashboard implementation. None of these checks
are claimed complete by the documentation handoff.

## Reproducibility

- Clean checkout: documented Node version, `npm ci`, build and typecheck pass.
- `npm run dev` launches a loopback-only fictional-data preview without HA access.
- All asset/module/font URLs resolve at the deployed versioned `/local` base path,
  not just Vite's root. No runtime dependency on an external CDN.
- Build excludes `.dashboard-local`, credentials, household fixtures and real screenshots.

## Visual/browser review

- Inspect 1440×900 desktop, 1194×834 landscape tablet and 390×844 phone viewports.
- Test with an HA-like sidebar/header reducing available width, not only standalone.
- No clipped text, horizontal scrolling, overlapping controls or off-screen dialogs.
- Reference quality is recognizable: warm palette, editorial number, balanced panels,
  consistent insets/radii, useful hierarchy, calm information density.
- 44 px touch targets; keyboard-operable buttons/drawers, focus trapping/restoration,
  accessible names and contrast. Reduced-motion and dark variant are usable.
- Camera privacy/unavailable cards and missing integrations have designed fallbacks.
- Save screenshots using **fictional data**, and report actual browser tools used.
  Browser-unavailable is a verification gap, not a passed visual check.

## Meaningful adapter/control checks

Use spies/mocked host methods, not live devices. At minimum prove:

1. Mount, render, route change, reconnect and demo interactions never mutate real HA.
2. Configured entity updates propagate; unrelated changes don't rebuild camera streams.
3. Missing/unknown/unavailable/offline states stay distinct; null numeric data is not 0.
4. Offline and unauthorized controls are disabled; no queued action replays on reconnect.
5. One deliberate tap produces one correctly scoped service action; repeated taps,
   service rejection, delayed acknowledgement and timeout behave visibly and safely.
6. Security labels route to the correct guarded scripts, never raw arm/disarm or helper
   writes; sound-only and persistent disarm are different actions. Actual state and
   requested policy are displayed independently.
7. Garage open/close requires explicit confirmation; cancel sends no action; preparing
   departure is not confused with physically moving the garage door.
8. Climate/lighting/media controls respect supported features and units; no arbitrary
   target/service injection from displayed strings.
9. Camera privacy on/unknown prevents stream startup; dismiss/unmount releases streams.
10. Forecast unsupported/error/unsubscribe and component teardown leave no leaked work.
11. Runtime content is escaped (no unsafe HTML for entity names, media or calendar text).

Keep tests focused on these behaviors, not screenshots of every trivial element or
assertions that merely mirror implementation details. Don't run unrelated Python
service tests unless that service is changed; it should not need to change.

## Installation/readback (separate from local build)

- Dry-run lists exact destination and files, resource change and new dashboard URL.
- Installed-version HA compatibility checked; entity bindings resolved read-only.
- Latest dashboard/resource configs backed up privately before additive changes.
- Only versioned public-safe build assets installed; no private data in `/local`.
- New route loads inside authenticated HA, including a non-admin household account
  where permitted. Existing dashboards, defaults and resource registrations work.
- Current alarm/hold/commissioning state is unchanged. No live device/siren/garage
  action was performed as a test without separate authorization.
- Report actual live UI readback separately from simulated adapter/e2e tests.
- Rollback steps refer to the exact new route/resource/version, not a whole-stack reset.

## Handoff report

List implementation files, preview commands, build/test results, demo screenshots,
deployment artifacts, and remaining limitations. Explicitly distinguish:

- local demo verified;
- live HA rendering verified or not;
- physical controls tested or deliberately not tested;
- deployed vs merely ready to install.
