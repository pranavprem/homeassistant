# Agraharam dashboard

A composed household dashboard for Home Assistant, built as one custom Lovelace card
(`custom:agraharam-dashboard`) for a full-width panel view. TypeScript, Lit 3 and Vite 8; no backend,
no long-lived token, no runtime CDN. The approved design is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
§16.11 there records the integration decisions.

Nothing here is installed in Home Assistant by a git push. Installation is a separate, deliberate step
(see [Demo, live, physical and deployment](#demo-live-physical-and-deployment) below).

## Requirements

- Node 24 LTS (see `.nvmrc`; `engines` and `engine-strict` refuse other majors) and npm 11.
- Browser floor for the built card: Safari and iOS 16.4+, Chrome and Edge 108+, Firefox 110+.

## Setup

```sh
npm ci
npx playwright install chromium webkit   # default e2e browsers; add `firefox` for AGR_E2E_BROWSERS=all
```

Playwright 1.63 does not reuse browser builds cached by earlier versions, so run the install step on a new
machine and after every Playwright upgrade. WebKit is part of the default set because the keyboard and dialog
checks always run there.

## Commands

| Command                  | What it does                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`            | Fictional-data preview with HMR at http://127.0.0.1:5173/ (loopback only, no Home Assistant)                                   |
| `npm run build`          | Builds `dist/agraharam/<version>/` and runs `scripts/postbuild.mjs` (scans, manifest, checksums, size line)                    |
| `npm run build:harness`  | Builds `harness.html` into `dist/preview` and stages the built card beside it                                                  |
| `npm run preview`        | Builds both, then serves the built card at http://127.0.0.1:4173/harness.html                                                  |
| `npm run typecheck`      | `tsc` over every source, test, script and config file                                                                          |
| `npm test`               | Vitest once: the `dom` project (happy-dom) and the `node` project (scripts, install), fitness and unused-export rules included |
| `npm run test:watch`     | Vitest in watch mode                                                                                                           |
| `npm run test:e2e`       | Builds, then runs Playwright against the built bundle served by `vite preview`                                                 |
| `npm run format`         | Prettier, writing changes                                                                                                      |
| `npm run format:check`   | Prettier, reporting files that are not formatted                                                                               |
| `npm run check:public`   | Public-repo leak scan of tracked, untracked and staged files, staged blobs and `dist`                                          |
| `npm run config:private` | Generates the private dashboard config into `.dashboard-local/` (never into this tree)                                         |
| `npm run verify`         | `format:check`, `typecheck`, `test`, `build` and `check:public`, in that order                                                 |

Notes:

- `npm run test:e2e` runs Chromium, plus WebKit for the keyboard spec. `AGR_E2E_BROWSERS=all npm run test:e2e`
  runs every spec in Chromium, WebKit and Firefox (`npx playwright install firefox` first); run that before a
  deployment, because wall tablets are often Safari. Screenshots go to `test-results/` (gitignored).
- Do not drive this repository with the Playwright MCP tool: it writes `.playwright-mcp/` into the worktree.
- `check:public` finds the private files through `AGR_PRIVATE_DIR`, else `<worktree root>/.dashboard-local`. A
  missing private directory exits 2 unless `--allow-missing-private` is given, so on a fresh clone without
  `.dashboard-local/` both `npm run check:public` and `npm run verify` (whose last step it is) exit 2; there, run
  the earlier steps and `npm run check:public -- --allow-missing-private`. `--dist <dir>` scans one built
  directory; `--range <rev-range>` scans every blob in the commits about to be pushed. Hits print
  `path:line:column` and a rule, never the matched value.
- `config:private` reads `.dashboard-local/bindings.candidates.json` (and optional overrides) and writes only
  `.dashboard-local/agraharam-next.dashboard.yaml`, always with `controls: false`. It prints counts, never IDs.

### Bundle size

`postbuild.mjs` prints one size line for `agraharam.js` (raw and gzip bytes against the target) and warns when it
exceeds **480 KiB** (491,520 B) raw. Each build's exact raw byte size per file is in its
`dist/agraharam/<version>/manifest.json` (`files[]`, with SHA-256 sums); the gzip size is only in that size line. The card holds nine sections, the full action catalog with request validation, config
validation, the demo host with fictional fixtures, Lit and the curated Lucide icons; the build strips comments and
indentation from the Lit `css` templates (`vite-lit-css.ts`). That is well inside Home Assistant's 2 s window for
defining a custom element on a LAN or through the tunnel, the fonts load separately, and features are not cut for
size. The original 220 KB target (§11.5) predates the complete feature set; the rationale is recorded in §11.5 and
§16.11.

## Preview shell

`npm run dev` (source, HMR) and `npm run preview` (the built bundle through `harness.html`) both open a fake
Home Assistant shell: a 56 px toolbar and a sidebar that is 256 px expanded, 56 px collapsed and hidden below an
870 px viewport, so the card sees the widths it sees inside HA. The page uses HA-like body typography so any
style leaking into the card shows up.

| Control               | What it does                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Scenario              | One of the nine fictional scenarios (`normal`, `degraded`, `offline`, …)                           |
| Theme, Sidebar        | Light or dark; sidebar expanded or collapsed                                                       |
| Host                  | `demo` (the card's own DemoHost) or `fake-hass` (live mode against FakeHass)                       |
| Disconnect, Reconnect | fake-hass only; reconnect follows HA's two-step order (400 ms snapshot delay)                      |
| Deliver first update  | `loading` only; releases the held first state snapshot                                             |
| Route change          | Removes the card, waits 1 s, re-appends the same element                                           |
| Edit-mode toggle      | Moves the card into a wrapper with `preview = true`, then back with `preview = false`              |
| Hidden 5 min          | Hidden-tab order: panel removed, a state change, socket dropped, re-appended, reconnect            |
| Outage change         | fake-hass, while disconnected: a visible camera's privacy turns on, delivered only by the snapshot |

The shell keeps its state in the query string only (`scenario`, `theme`, `sidebar`, `host`), turns the
diagnostics drawer on for preview, records every FakeHass call on `window.__agrCalls`, and shows a red page-error
count when `window.__agrPageErrors` is not 0.

## Demo, live, physical and deployment

These are four different claims. Keep them apart in reviews and handoffs.

| Level      | What it means                                                                                   | How it is checked                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Demo       | The card behaves correctly on fictional data: layout, states, gateway rules, zero service calls | `npm test`, `npm run test:e2e` and the preview shell (DemoHost and FakeHass; no network, no HA)     |
| Live       | The card renders the household's real entities inside Home Assistant, read-only                 | Only after a deployment: `controls: false`, the Diagnostics drawer and the §13.5 readback           |
| Physical   | A control on the card moves a real device (lights, climate, garage, security scripts)           | Never by tooling; the household enables `controls: true` after the §13.5 read-only verification     |
| Deployment | The built bundle is copied to `/config/www/agraharam/<version>/` and registered as a resource   | `install/install.sh` through an authorized file channel to the NAS, then §13.5; a git push does not |

Demo validation never touches the household Home Assistant or any device. Live rendering, physical tests and the
deployment itself are operator steps described in [install/README.md](install/README.md) and §13 of the design.

## Public repository rules

This repository is public. Fixtures, tests, examples and screenshots use fictional data and `*.demo_*`
entity IDs only. Household context lives in the gitignored `.dashboard-local/` directory at the repo root
and must never be copied into this tree or into a build. Screenshots of real data are never taken.

## Commit procedure

1. `npm run verify` (it ends with `check:public`, which also scans untracked files).
2. `git add …` the intended files.
3. `npm run check:public` again, so the staged blobs are scanned.
4. Commit.
5. Before pushing, `npm run check:public -- --range <upstream>..HEAD`, so every commit about to leave the machine
   is scanned, not only the working tree.

No git hook is installed automatically, because hooks would affect the rest of the repository.
