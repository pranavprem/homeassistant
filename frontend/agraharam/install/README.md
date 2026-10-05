# Installing Agraharam in Home Assistant

This folder holds everything needed to install the card on the household Home Assistant (HA), update it and undo
it. The design behind every step is in [`docs/ARCHITECTURE.md` §13 and §17](../docs/ARCHITECTURE.md). Nothing here
runs by itself: each step is a deliberate operator action.

There are two delivery channels, and they are **mutually exclusive** (never both at once):

- **HACS releases (primary).** Every merge to `main` that changes the bundle publishes a GitHub release `vX.Y.N`
  through `.github/workflows/agraharam.yml`. HACS sees it, and HA installs it only when an admin presses Update.
  Nothing is pushed into the house.
- **`/local` (fallback).** `install/install.sh` copies a verified build (or a downloaded release) through an
  authorized file channel, and an admin registers the resource by hand.

## How deployment really works

- HA runs as a container on the NAS. Its `/config` is the bind mount of `${HA_CONFIG_PATH}`.
- The stack is a **Portainer Git stack** that deploys this repository's compose file from Portainer's own clone.
  The compose stack needs no change, and no bind mount should be added for the dashboard.
- **HACS:** a merge to `main` publishes a release, but **installs nothing by itself**. HACS polls GitHub, offers the
  update under Settings → Updates, and on Update downloads `agraharam.js` into `www/community/homeassistant/` and
  re-tags its resource (`/hacsfiles/homeassistant/agraharam.js?hacstag=…`). Clients pick it up on their next page
  load.
- **`/local`:** the built files reach `${HA_CONFIG_PATH}/www/agraharam/<version>/` only through an **authorized file
  channel**, such as the NAS file share mounted on the operator's machine. NAS SSH is not assumed. HA has no REST
  upload for frontend files, and HomeButler is not a file channel. `/config/www` is served at `/local` **only if it
  existed when HA started**. If `www` is new, HA needs a restart before `/local` works. Schedule that restart
  separately; no step here restarts HA.
- Files under `/local` and `/hacsfiles` need **no authentication**. Only the generic release goes there (one
  JavaScript module with both fonts embedded, licenses, manifest and checksums). Household bindings live in the
  authenticated dashboard config, never in `www`.
- `/local` responses are cached for 31 days and HA's service worker serves them stale-while-revalidate. Each
  release is a new URL (a new versioned directory, or a new `hacstag`). Clients must **reload** after a resource
  change, because resources load once per page load.

## Files

| File                     | Purpose                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `install.sh`             | `/local` channel: dry-run-by-default copier of one flat release to `<HA config>/www/agraharam/` |
| `resource.yaml`          | `/local` channel: the single module resource (`/local/agraharam/<version>/agraharam.js`)        |
| `dashboard.demo.yaml`    | Panel view with `demo: true`: the first safe render inside HA                                   |
| `dashboard.example.yaml` | The full config shape with fictional `*.demo_*` bindings and `controls: false`                  |
| `overrides.example.json` | Shape of the private generator overrides (fictional)                                            |

At the repository root, `hacs.json` tells HACS the file name, and `.github/workflows/agraharam.yml` runs CI and
publishes releases.

## Requirements

- Node 24 LTS and npm (see `../.nvmrc`), only on the machine that generates the private config (and, for
  `/local`, builds).
- HACS 2.x in HA, for the primary channel.
- For `/local`: `bash`, `shasum` or `sha256sum`, and a GNU or BSD `mv` (Linux and macOS both qualify) on the machine
  that copies the files. `node` there is optional; with it, the copy is re-scanned for private values.
- An HA admin account for the resource and dashboard steps; resources must be in storage mode.
- Browser floor for the card: Safari and iOS 16.4+, Chrome and Edge 108+, Firefox 110+. CI runs the WebKit layout
  and accessibility suites on every change; run `AGR_E2E_BROWSERS=all npm run test:e2e` locally before relying on a
  wall tablet.

## HACS channel (primary)

### GitHub settings (one time, repository owner)

- [ ] A ruleset on `main` that requires the `agraharam-ci` status check from the GitHub Actions app, with an owner
      or admin bypass so direct pushes of stack changes keep working. The release jobs are self-gating either way,
      because they need that check's job.
- [ ] Immutable releases on (assets locked, tags cannot move, attestations generated; verify an asset with
      `gh release verify-asset`). It applies to releases published after it is turned on.
- [ ] A tag ruleset on the release tags, pattern `v[0-9]*.[0-9]*.[0-9]*`, that blocks update and delete. Only
      `vMAJOR.MINOR.PATCH` tags are releases; never create another tag starting with `v` followed by a digit.
- [ ] Settings → Actions: default workflow permissions read-only; require approval for workflow runs from outside
      contributors; allow GitHub-authored actions only, with SHA pinning required if offered.
- [ ] Two-factor authentication or a hardware key on every account with write access, and a periodic audit of
      write-scoped tokens (personal access tokens, apps, deploy keys, including any agent's).

Every non-draft, non-prerelease release in this repository must be an Agraharam release carrying `agraharam.js`:
HACS installs the first one in GitHub's list order, whoever created it, and ignores the "latest" flag. Never publish
another kind of release here.

### First install

1. **The first release exists.** The repository's Releases page lists `vX.Y.N` with `agraharam.js`. Without a
   release, HACS reports the repository as not compliant; add it only after the first release.
2. **Read-only preflight.** List the resources (Settings → Dashboards → ⋮ → Resources, or the snippet below).
   **Stop** if any URL starts with `/hacsfiles/homeassistant` but not with `/hacsfiles/homeassistant/`: HACS 2.0.5
   matches its own resource by that prefix without the slash and would rewrite or delete it. If a
   `/local/agraharam/` resource exists, follow [Switching channels](#switching-channels) first: the channels are
   exclusive.
3. **Add and download.** HACS → ⋮ → Custom repositories → this repository's GitHub URL
   (`https://github.com/<owner>/homeassistant`), type **Dashboard** → Add. Open Agraharam in HACS → Download. HACS
   registers `/hacsfiles/homeassistant/agraharam.js?hacstag=…` itself; never add or edit that resource by hand.
4. **Create the dashboard and verify it read-only** before `controls: true`: generate the private config
   ([section 2](#2-generate-the-private-dashboard-config)), create the dashboard with steps 2 and 3 of the
   [UI path](#ui-path-primary) (skip step 1: HACS registered the resource), then do the
   [read-only verification](#6-read-only-verification-then-enable-controls), unchanged.

Preflight snippet (browser devtools console on an HA page, as an admin; it only reads):

<!-- agraharam:hacs-preflight-snippet:start -->

```js
const hass = document.querySelector('home-assistant').hass; // operator console only
const HACS_PREFIX = '/hacsfiles/homeassistant';
const LOCAL_PREFIX = '/local/agraharam/';
const resources = await hass.callWS({ type: 'lovelace/resources' }); // read-only; back up this JSON privately
const urls = resources.map((r) => r.url).filter((url) => typeof url === 'string');
const clashing = urls.filter((url) => url.startsWith(HACS_PREFIX) && !url.startsWith(`${HACS_PREFIX}/`));
if (clashing.length > 0) {
  throw new Error(
    `Stop: ${clashing.length} resource(s) start with ${HACS_PREFIX} but not ${HACS_PREFIX}/. ` +
      'HACS 2.0.5 would rewrite or delete them. Nothing was written.',
  );
}
if (urls.some((url) => url.startsWith(LOCAL_PREFIX))) {
  throw new Error('A /local/agraharam/ resource exists. Follow "Switching channels" first. Nothing was written.');
}
console.log('Preflight passed: no resource conflicts with the HACS channel.');
```

<!-- agraharam:hacs-preflight-snippet:end -->

### Update

Settings → Updates → Agraharam → Update, then reload every client (wall tablets included). Updates are never
installed automatically: an HA automation could do it, but it is deliberately not set up, so a person always
presses Update. Merging to `main` only publishes the release; see the repository's Releases page for what each one
contains.

### Rollback

Under HACS, roll back through HACS only: HACS → Agraharam → ⋮ → Redownload → pick the previous version, then reload
every client. Never edit the HACS resource URL by hand.

### Switching channels

- **HACS → `/local`:** remove the repository in HACS first (this deletes its resource), then follow sections 1
  to 5 below.
- **`/local` → HACS:** delete the `/local/agraharam/` resource first (Settings → Dashboards → Resources), then do
  the HACS first install.

HACS re-creates its resource after every install or update whenever no resource starts with
`/hacsfiles/homeassistant`, so editing a resource URL by hand from one channel to the other would end with two
registrations. The `/local` snippets below count both prefixes and stop if they find a HACS resource, and the card's
version-conflict notice remains the safety net.

## /local channel (fallback)

Sections 1, 3, 4 and the resource step of section 5 are for this channel only; sections 2, 5 (dashboard steps)
and 6 apply to both.

## 1. Build and verify

From `frontend/agraharam/`:

```sh
npm ci
npm run verify            # format, typecheck, tests, build and the public-repo scan
```

`npm run build` writes the flat release directory `dist/agraharam/<version>/`: `agraharam.js` (both fonts
embedded), `THIRD_PARTY_LICENSES.md`, `OFL-1.1-Newsreader.txt`, `OFL-1.1-Hanken-Grotesk.txt`, `manifest.json` and
`SHA256SUMS`. Source maps go to `dist/sourcemaps/<version>/` and are never installed. `install.sh` refuses a build
made from uncommitted changes unless you pass `--allow-dirty`, so build from a committed tree.

Instead of building, you can install a published release: `gh release download vX.Y.Z --dir X.Y.Z` (the directory
must be named after the version), then pass `--src X.Y.Z --version X.Y.Z` to `install.sh`. Its assets are exactly
the flat release directory, so the same checks apply.

## 2. Generate the private dashboard config

```sh
npm run config:private
```

The generator reads `.dashboard-local/bindings.candidates.json` (required) and
`.dashboard-local/agraharam.overrides.json` (optional) at the worktree root and writes **only**
`.dashboard-local/agraharam-next.dashboard.yaml` (mode 0600, gitignored). It prints counts, never entity IDs.
The output always has `controls: false`; the generator has no option to emit `true`.

Read the file's comment header before using it. It lists the candidates' known ambiguities, every vacuum and every
ID missing from the saved inventory under "verify before enabling", cameras without a privacy binding, every camera
written with `live: false` and why, and any lights or curtains no room lists. If two candidates match one security
helper or one vehicle field, the generator stops without writing and names the token and the count; resolve it with
`exclude` in the overrides file.

**Camera thumbnails default to fail-closed.** A camera with a privacy switch is gated by it: any state other than
the exact "privacy off" value hides the camera. A camera without a privacy binding has nothing to gate on, so the
generator emits `thumbnails: false` and the tile shows "Live view on request". Opt an outdoor camera in through
`camera_thumbnails` only after checking it; keep indoor cameras off.

**Live view defaults to fail-closed too.** `live: false` on a camera removes live view from this dashboard: its
tile offers no live view (it shows the still, or "Live view off" with `thumbnails: false`), and the live-view dialog
refuses to start for it even if asked. The card's own default is `live: true`, but the generator writes `live`
explicitly for every camera and keeps it `true` only with positive outdoor evidence: an outdoor word (front door,
doorbell, porch, garage, driveway, yard, deck, patio, garden, gate and so on) in the camera's role, name or entity
ID, no indoor word (living, bedroom, kitchen, loft, hall, entry, office, studio, any "…room" and so on) in any of
them, and no privacy binding (a camera someone wanted a privacy switch for is treated as indoor). Every other camera
gets `live: false`, listed in the header with its reason. Opt a camera in or out through `camera_live` only after
checking what it shows.

Overrides (`overrides.example.json` shows the shape; every map is keyed by entity ID, unknown keys are errors):

| Key                                | Effect                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `exclude`                          | Candidate IDs to leave out. Excluding a camera's privacy entity while keeping the camera fails |
| `names`                            | Display names for emitted entities                                                             |
| `camera_thumbnails`                | `true` opts a camera without a privacy binding into thumbnails; `false` turns any camera off   |
| `camera_live`                      | `true` keeps live view for a checked camera the rule turned off; `false` turns it off for any  |
| `rooms`                            | Rooms with their lights, curtains and purifier (default: one "Lights" room with everything)    |
|                                    | Each ID must be a light, curtain or air candidate that is not excluded                         |
| `vacuum_battery_sensors`           | A battery sensor per vacuum, when the derived one does not exist                               |
| `vehicle_name`, `charge_limit_pct` | Vehicle display name and the charge-limit tick (50 to 100)                                     |

## 3. Copy the files to HA

Mount the NAS share that holds HA's config on this machine, then dry-run with an absolute destination:

```sh
install/install.sh --dest /Volumes/<share>/<HA config>/www/agraharam
```

For a downloaded release (or any build whose version is not `package.json`'s, such as a release build stamped with
its run number), add `--src <directory named X.Y.Z> --version X.Y.Z`. The dry run writes nothing and prints the plan: source, manifest version and git SHA, destination, every file with
its size and checksum, the resource URL and the dashboard to create. Then copy:

```sh
install/install.sh --dest /Volumes/<share>/<HA config>/www/agraharam --apply
```

What it checks, in order, in both modes:

1. `--dest` ends in `www/agraharam` and is absolute (else exit 2).
2. `www` exists. It never creates `www` (exit 3 with the restart note).
3. Neither `www` nor the destination is a symbolic link, and the physical path equals the given path (exit 3).
4. The source directory, `--version` and `manifest.json` agree (exit 3).
5. `SHA256SUMS` verifies, and the file set is exactly the flat allowlist (exit 3): `agraharam.js`,
   `THIRD_PARTY_LICENSES.md`, the two `OFL-1.1-*.txt` texts, `manifest.json` and `SHA256SUMS`, with no directory
   and nothing else (not even a `notes.md`), because `/local` serves everything unauthenticated on the HA origin.
6. The build is from a clean tree, unless `--allow-dirty` (exit 3).
7. `<dest>/<version>` does not exist: versions are never overwritten (exit 4).
8. With `node` available, `check-public --dist` re-scans exactly the files to copy (exit 3 on a hit). It needs
   the private files (`AGR_PRIVATE_DIR`, else `.dashboard-local/` at the worktree root) and exits 3 without
   them. On a machine that has none, pass `--allow-missing-private`; the plan then reads
   `privacy re-scan skipped: no private files (--allow-missing-private given)`, and the checksums still bind
   the files to the build-time scan.

With `--apply` it creates `<dest>` with one non-recursive `mkdir` on a first install, copies into a private
`.<version>.partial-<pid>` directory, re-verifies the checksums there and renames it into place. The rename never
follows a symbolic link: if one appears at `<dest>/<version>` in the meantime, the install stops with exit 4.
On failure it removes only the partial directory it created; a stale partial directory left by an earlier run
makes it stop (exit 4) and is left for you to remove. It never restarts HA, never touches `configuration.yaml` or
`.storage`, and never edits other versions.

## 4. Preflight (read-only)

1. Open `https://<ha>/local/agraharam/<version>/manifest.json` in a browser. It must return the manifest. A 404
   right after `www` was created means HA needs a restart; report that and schedule it separately.
2. Settings → Dashboards → ⋮ → Resources must be editable. `lovelace/info` must report `resource_mode` storage.
3. Settings → Dashboards must not already list `agraharam-next`. If it exists, inspect it and stop; never overwrite.

Before any write, back up privately into `.dashboard-local/backups/<ISO-time>-*.json`: the resource list, the
dashboard list, and the config of any dashboard you intend to touch. Only `agraharam-next` is touched.

## 5. Register the resource and create the dashboard

### UI path (primary)

Under HACS, skip step 1: HACS registered the resource.

1. `/local` only. Settings → Dashboards → ⋮ (top right) → Resources → Add resource → URL
   `/local/agraharam/<version>/agraharam.js`, type "JavaScript module". To upgrade, edit the existing Agraharam
   resource instead of adding one.
2. Settings → Dashboards → Add dashboard → "New dashboard from scratch": title "Agraharam", icon `mdi:home-heart`,
   URL `agraharam-next` if the dialog offers a URL field, "Admin only" off, "Show in sidebar" on. If the dialog has
   no URL field, use the WebSocket path below.
3. Open the new dashboard → ⋮ → Edit dashboard → ⋮ → Raw configuration editor → paste `dashboard.demo.yaml` → Save.
   Confirm the demo renders. Then paste `.dashboard-local/agraharam-next.dashboard.yaml` → Save. It carries
   `controls: false`, so the real dashboard renders with every control disabled ("Controls are turned off in the
   dashboard configuration.").

### WebSocket path (deterministic alternative)

`/local` channel only. Run in the browser devtools console on an HA page, logged in as an admin. This is a manual
operator step; the dashboard code never does this. The guards are code: it writes nothing until `CONFIG` holds the
generated JSON body, stops if a HACS resource (`/hacsfiles/homeassistant…`) exists because the channels are
exclusive, stops if `agraharam-next` exists, never adds a second Agraharam resource, and prints the exact undo
commands for anything it created or changed if a later step fails.

<!-- agraharam:first-install-snippet:start -->

```js
const hass = document.querySelector('home-assistant').hass; // operator console only
const VERSION = '0.1.0';
const URL_PREFIX = '/local/agraharam/';
const HACS_PREFIX = '/hacsfiles/homeassistant'; // the HACS channel's resources, matched as HACS 2.0.5 matches them
const url = `${URL_PREFIX}${VERSION}/agraharam.js`;
// Paste the JSON body of .dashboard-local/agraharam-next.dashboard.yaml (comment lines removed) in place of null.
const CONFIG = null;
if (!CONFIG || typeof CONFIG !== 'object' || !Array.isArray(CONFIG.views) || CONFIG.views.length === 0) {
  throw new Error('CONFIG is empty: paste the generated JSON body first. Nothing was written.');
}

const resources = await hass.callWS({ type: 'lovelace/resources' }); // back up this JSON privately
const ours = resources.filter(
  (r) => typeof r.url === 'string' && (r.url.startsWith(URL_PREFIX) || r.url.startsWith(HACS_PREFIX)),
);
if (ours.some((r) => r.url.startsWith(HACS_PREFIX))) {
  throw new Error(`A ${HACS_PREFIX} resource exists: HACS manages Agraharam. Channels are exclusive. Stop.`);
}
if (ours.length > 1) throw new Error(`Found ${ours.length} Agraharam resources. Fix by hand; stop.`);

const dashboards = await hass.callWS({ type: 'lovelace/dashboards/list' }); // back up this JSON privately
if (dashboards.some((d) => d.url_path === 'agraharam-next')) {
  throw new Error('Dashboard agraharam-next already exists. Inspect it; never overwrite. Stop.');
}

// First install: create exactly one resource. Upgrade: update the existing one, never add a second.
const resource =
  ours.length === 0
    ? await hass.callWS({ type: 'lovelace/resources/create', res_type: 'module', url })
    : await hass.callWS({ type: 'lovelace/resources/update', resource_id: ours[0].id, url });
console.log('resource id (save privately):', resource.id);
const undoResource =
  ours.length === 0
    ? `await hass.callWS({ type: 'lovelace/resources/delete', resource_id: '${resource.id}' })`
    : `await hass.callWS({ type: 'lovelace/resources/update', resource_id: '${resource.id}', url: '${ours[0].url}' })`;

let dashboard;
try {
  dashboard = await hass.callWS({
    type: 'lovelace/dashboards/create',
    url_path: 'agraharam-next',
    title: 'Agraharam',
    icon: 'mdi:home-heart',
    show_in_sidebar: true,
    require_admin: false,
    mode: 'storage',
  });
} catch (err) {
  console.error(`Dashboard creation failed. To undo the resource change, run exactly:\n${undoResource}`);
  throw err;
}
console.log('dashboard id (save privately):', dashboard.id);

try {
  await hass.callWS({ type: 'lovelace/config/save', url_path: 'agraharam-next', config: CONFIG });
} catch (err) {
  console.error(
    'Saving the config failed. To undo everything, run exactly:\n' +
      `await hass.callWS({ type: 'lovelace/dashboards/delete', dashboard_id: '${dashboard.id}' })\n${undoResource}`,
  );
  throw err;
}
```

<!-- agraharam:first-install-snippet:end -->

After the WebSocket path, run the read-only verification below before setting `controls: true`.

## 6. Read-only verification, then enable controls

Nothing here runs a script or calls a service.

1. With `controls: false`, compare the dashboard with HA's own views: alarm state, policy, garage position, each
   camera's privacy tile, presence. Any mismatch stops the rollout.
2. Check each camera's `live` flag in the raw configuration editor against what that camera actually shows: an
   indoor camera must read `live: false`. Fix one through `camera_live` in the private overrides and regenerate.
3. For every script bound in `security.actions` and `studio_monitors_script`, open it in Settings → Automations &
   Scenes → Scripts and read its sequence (do not run it, do not save). Confirm it does what its role says:
   `silence_sound` only silences, `disarm_hold` disarms and holds, each hold sets that hold, `resume_auto` resumes
   Auto, `prepare_departure` never moves the garage door. Fix a mismatch in the private overrides and regenerate;
   never edit the script.
4. Temporarily set `diagnostics: true`, open Diagnostics as an admin, and check that every binding resolves (no
   "Not found"), the features column matches the devices, and there are no config warnings. Read "Home
   Assistant version" there too: this release was built against 2026.9.x and 2026.10.x. On any other version,
   re-check the host contract in [`docs/ARCHITECTURE.md` §4.3](../docs/ARCHITECTURE.md) against that release
   before enabling controls, and stop if anything differs.
5. Back up the dashboard config privately, then in the raw configuration editor set `controls: true` (and
   `diagnostics` back if wanted) → Save. Back up the saved config again.

### Readback

- `lovelace/resources` contains exactly one Agraharam URL, counting both `/local/agraharam/` and
  `/hacsfiles/homeassistant`.
- `lovelace/dashboards/list` contains `agraharam-next`, and the other entries are unchanged against the backup.
- `lovelace/config {url_path: 'agraharam-next'}` deep-equals the saved config.
- `/agraharam-next/home` renders the card with no console errors, also as a non-admin household account.
- Existing dashboards still load.
- Alarm, hold and commissioning state are unchanged. Compare by reading the entities; do not act.

## Upgrade (/local channel)

Under HACS, see [Update](#update) instead.

1. Install the new version with `install/install.sh … --apply`: a newer release downloaded as in section 1, or a
   local build of a committed tree. Older version directories stay in place.
2. Point the existing resource at the new URL: edit it in Settings → Dashboards → Resources, or run the snippet
   below. Never add a second Agraharam resource.
3. Reload every client (wall tablets included), then repeat the readback.

<!-- agraharam:upgrade-snippet:start -->

```js
const hass = document.querySelector('home-assistant').hass; // operator console only
const VERSION = '0.1.0';
const URL_PREFIX = '/local/agraharam/';
const HACS_PREFIX = '/hacsfiles/homeassistant'; // the HACS channel's resources, matched as HACS 2.0.5 matches them
const url = `${URL_PREFIX}${VERSION}/agraharam.js`;

const resources = await hass.callWS({ type: 'lovelace/resources' }); // back up this JSON privately
const ours = resources.filter(
  (r) => typeof r.url === 'string' && (r.url.startsWith(URL_PREFIX) || r.url.startsWith(HACS_PREFIX)),
);
if (ours.some((r) => r.url.startsWith(HACS_PREFIX))) {
  throw new Error(`A ${HACS_PREFIX} resource exists: HACS manages Agraharam. Update it in HACS. Stop.`);
}
if (ours.length !== 1) throw new Error(`Found ${ours.length} Agraharam resources, expected exactly one. Stop.`);
if (ours[0].url === url) throw new Error('The resource already points at this version. Nothing was written.');

await hass.callWS({ type: 'lovelace/resources/update', resource_id: ours[0].id, url });
console.log(
  'Updated. To undo, run exactly:\n' +
    `await hass.callWS({ type: 'lovelace/resources/update', resource_id: '${ours[0].id}', url: '${ours[0].url}' })`,
);
```

<!-- agraharam:upgrade-snippet:end -->

## Rollback (exact objects only)

- **Under HACS**: HACS → Agraharam → ⋮ → Redownload → pick the previous version, then reload clients (see
  [Rollback](#rollback) above). To remove Agraharam entirely under HACS, remove the dashboard as below, then remove
  the repository in HACS, which deletes its resource and files.
- **Bad version** (`/local`): edit the Agraharam resource URL back to the previous `/local/agraharam/<prev>/agraharam.js`,
  then reload clients. Keep the bad version's files until no client references them, then delete only
  `www/agraharam/<bad>/` through the file share.
- **Remove entirely**: take the dashboard `id` and the resource `id` from the create responses saved during the
  install, or from a fresh `lovelace/dashboards/list` / `lovelace/resources` readback matched by `url_path`
  `agraharam-next` and by the Agraharam resource URL. Never assume them (the dashboard ID is normally
  `agraharam_next`, but the readback is authoritative). Then run `lovelace/dashboards/delete {dashboard_id: <id>}`
  and `lovelace/resources/delete {resource_id: <id>}`, or use the UI equivalents. Delete the `www/agraharam/`
  files last. No bulk restore, no stack reset, and other dashboards are never touched.

## Troubleshooting

| Symptom                                                   | Cause and fix                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json` returns 404                               | `www` did not exist when HA started: schedule a restart separately                                                                  |
| "Custom element doesn't exist: agraharam-dashboard"       | Resource missing or wrong URL; check Resources, then reload the page                                                                |
| Diagnostics or an admin notice reports a version conflict | Two Agraharam resources, perhaps one per channel: keep one, remove the other, reload clients                                        |
| HACS reports the repository as not compliant              | No release with `agraharam.js` exists yet: wait for the first release, then add it                                                  |
| HACS offers no update after a merge                       | The merge did not change the bundle, or release-publish failed: see the workflow run; a re-run or the next push to `main` publishes |
| Old version still shows after an upgrade                  | The page loaded resources before the change: reload every client                                                                    |
| Every control disabled with "Controls are turned off"     | Expected until step 6 sets `controls: true`                                                                                         |
