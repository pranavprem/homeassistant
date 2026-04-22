# HomeButler Control-Plane Design (Phases 1–3)

Status: draft for review
Scope: Phase 1 (stack registry), Phase 2 (action registry + runner), Phase 3 (initial action set)
Author: architect (control-plane team)
Target code location: `services/homebutler/`

---

## 1. Goals & Non-Goals

### Goals
- Give Neo/HA a **typed, introspectable** API to observe and control multiple Docker stacks on the NAS (`homeassistant`, `mediaserver`, `morpheus`, `tor`) through a single localhost service.
- Replace the flat container-name list with a **stack → service → container** registry, so callers reason about "the paperless-webserver service in the mediaserver stack" rather than raw container names.
- Allow a **strictly-allowlisted** set of higher-level actions (e.g., `make update-gluetun`, `make redeploy`) to be invoked, with no user-provided shell input, targets, or argv.
- Surface **capability/availability metadata** so callers (and humans) can see which actions are currently runnable and why, without trying to run them.
- Degrade gracefully: when a repo path or executable is not mounted inside HomeButler, the action appears in the registry but is marked `available: false` with a reason — it is never silently swallowed and never attempted.

### Non-goals
- No arbitrary shell / `make <target>` / `docker compose <cmd>` pass-through. Ever.
- No dynamic registration of stacks, services, or actions from requests, config files, or external systems. Registry is source code, reviewed in git.
- No long-running / streaming job subsystem in this phase. All actions are synchronous `subprocess.run` with a mandatory timeout. Background jobs, queues, and progress streams are out of scope (future phase).
- No auth/authz added in this phase. HomeButler remains bound to `127.0.0.1:8000` and is reached from HA/Neo over the internal docker network. Authz is layered later if HomeButler moves off localhost.
- No secrets management / vault integration. Actions that need secrets read them from env vars already present inside the container; we do not forward request-supplied env.
- No GUI. Pure JSON API.

---

## 2. Stack Registry (Phase 1)

### 2.1 Data shapes

The registry is a typed Python module of **frozen dataclasses** (not JSON, not YAML, not DB). This keeps the allowlist diffable in git and verified by type checking.

Module: `services/homebutler/app/registry/stacks.py`

```
StackId        = str   # regex: ^[a-z0-9_]+$
ServiceId      = str   # regex: ^[a-z0-9_]+$

@dataclass(frozen=True)
class ServiceDef:
    service_id: ServiceId
    container_name: str          # the actual Docker container name
    description: str
    tags: tuple[str, ...] = ()   # free-form labels (e.g., "database", "media", "tunnel")

@dataclass(frozen=True)
class StackDef:
    stack_id: StackId
    display_name: str
    description: str
    repo_path_env: str | None    # name of env var that points at the host repo path, e.g. "HOMEBUTLER_MEDIASERVER_REPO"
    compose_project: str | None  # optional docker-compose project label (used for diagnostics only in v1)
    services: tuple[ServiceDef, ...]
```

`repo_path_env` is the name of an env var — not the value — so rotating mount points does not require a code change. The registry resolves the path at request time.

### 2.2 Registry content (initial)

| stack_id        | repo_path_env                   | services (service_id → container_name)                                                                                                                                                                                                                                                                                                                                   |
|-----------------|---------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `homeassistant` | `HOMEBUTLER_HOMEASSISTANT_REPO` | `homeassistant→homeassistant`, `grocy→grocy`, `homebutler→homebutler`, `mosquitto→mosquitto`, `govee2mqtt→govee2mqtt`, `cloudflared→ha-cloudflared`                                                                                                                                                                                                                       |
| `mediaserver`   | `HOMEBUTLER_MEDIASERVER_REPO`   | `gluetun→gluetun`, `cloudflared→cloudflared`, `qbittorrent→qbittorrent`, `sabnzbd→sabnzbd`, `prowlarr→prowlarr`, `radarr→radarr`, `sonarr→sonarr`, `recyclarr→recyclarr`, `jellyfin→jellyfin`, `jellyseerr→jellyseerr`, `plex→plex`, `vaultwarden→vaultwarden`, `immich_server→immich-server`, `immich_ml→immich-machine-learning`, `immich_redis→immich-redis`, `immich_postgres→immich-postgres`, `paperless_webserver→paperless-webserver`, `paperless_postgres→paperless-postgres`, `paperless_redis→paperless-redis`, `paperless_gotenberg→paperless-gotenberg`, `paperless_tika→paperless-tika`, `portainer→portainer`, `gitea→gitea`, `watchtower→watchtower`, `dozzle→dozzle`, `prometheus→prometheus`, `cadvisor→cadvisor`, `node_exporter→node-exporter`, `grafana→grafana` |
| `morpheus`      | `HOMEBUTLER_MORPHEUS_REPO`      | `morpheus→morpheus`                                                                                                                                                                                                                                                                                                                                                      |
| `tor`           | `HOMEBUTLER_TOR_REPO`           | `proxy→tor-proxy`, `firefox→tor-firefox`                                                                                                                                                                                                                                                                                                                                 |

Service IDs use underscores (`immich_server`) while container names use the real dashed/naming scheme (`immich-server`). This avoids making callers memorize container naming quirks.

### 2.3 Registry API (Python)

```
def get_stack(stack_id: str) -> StackDef          # raises StackNotFound
def list_stacks() -> tuple[StackDef, ...]
def get_service(stack_id: str, service_id: str) -> tuple[StackDef, ServiceDef]  # raises StackNotFound/ServiceNotFound
def all_controlled_container_names() -> frozenset[str]   # union over registry
```

`all_controlled_container_names()` becomes the authoritative source for the Docker container allowlist. `DockerOpsClient` is constructed with this set.

### 2.4 Integration with `DockerOpsClient`

- `DockerOpsClient` is not changed structurally. It keeps `allowed_containers` as a flat set.
- The stack/service routes resolve `(stack_id, service_id) → container_name` via the registry, then delegate to `DockerOpsClient` with the resolved name.
- `DockerOpsClient.allowed_containers` is initialized from `all_controlled_container_names()` **unioned** with legacy `HOMEBUTLER_CONTROLLED_CONTAINERS` if set (see §6 on backwards compat; the recommended outcome is that the env var becomes advisory and the registry wins).

### 2.5 Legacy routes

`GET /ops/containers`, `GET /ops/containers/{name}`, `GET /ops/containers/{name}/logs`, `POST /ops/containers/{name}/restart` **remain unchanged** and keep working against the flat allowlist. They are documented in the OpenAPI schema with a `deprecated: false` but described as "legacy flat container view; prefer `/ops/stacks/...`".

---

## 3. Action Registry (Phase 2)

### 3.1 Action metadata

Module: `services/homebutler/app/registry/actions.py`

```
ActionId = str   # regex: ^[a-z0-9_]+(\.[a-z0-9_]+)+$ (namespaced, at least one dot)

class ActionKind(str, Enum):
    MAKE_TARGET      = "make_target"
    COMPOSE_COMMAND  = "compose_command"
    SCRIPT           = "script"     # reserved; no entries in v1

@dataclass(frozen=True)
class ActionDef:
    action_id: ActionId                    # e.g. "mediaserver.update_gluetun"
    stack_id: StackId                      # must exist in stack registry
    description: str
    kind: ActionKind
    argv: tuple[str, ...]                  # fixed at registry-definition time; NEVER merged with request input
    repo_path_env: str | None              # usually inherited from stack, but explicit for clarity
    timeout_seconds: int                   # mandatory; per-action hard cap (see §4)
    mutating: bool                         # true for anything that changes state
    required_executables: tuple[str, ...]  # e.g. ("make",) or ("docker",)
    extra_env_allowlist: tuple[str, ...] = ()  # names of env vars from HomeButler's own env that may be forwarded
```

### 3.2 Validation rules enforced at module-import time

- `action_id` matches the regex; no duplicates.
- `stack_id` resolves in the stack registry.
- `argv` is non-empty, contains no `;`, `&&`, `|`, `<`, `>`, or empty strings.
- `argv[0]` is in `required_executables`.
- `timeout_seconds` in `[1, 1800]` (30 min hard cap).
- `kind` matches the shape of `argv` (e.g., `MAKE_TARGET` ⇒ `argv[0] == "make"` and exactly one additional token).
- `extra_env_allowlist` names are all-uppercase identifiers; no wildcards.

Failing any check raises at import so HomeButler fails to start with a clear error rather than misbehaving at request time.

### 3.3 Availability

Computed at request time, not cached, via:

```
@dataclass(frozen=True)
class ActionAvailability:
    available: bool
    repo_path_resolved: str | None
    missing_executables: tuple[str, ...]
    reason: str | None   # human-readable, only set when available=False
```

Checks:
1. If `repo_path_env` is set: `os.environ.get(repo_path_env)` must be non-empty and the path must exist and be a directory.
2. Every `required_executables` entry must resolve via `shutil.which`.
3. If both pass ⇒ `available=True`.

The registry's introspection endpoints (§5.3) still return the action definition even when unavailable — they just flag it. This is intentional: Neo/HA can tell a user "this action exists but is not wired up yet" rather than getting a 404.

### 3.4 Registry content (Phase 3 initial actions)

| action_id                        | stack_id        | kind              | argv                                     | timeout | mutating | required_executables |
|----------------------------------|-----------------|-------------------|------------------------------------------|---------|----------|----------------------|
| `mediaserver.update_gluetun`     | `mediaserver`   | `make_target`     | `("make", "update-gluetun")`             | 600     | true     | `("make",)`          |
| `mediaserver.sync_configs`       | `mediaserver`   | `make_target`     | `("make", "sync-configs")`               | 300     | true     | `("make",)`          |
| `morpheus.redeploy`              | `morpheus`      | `make_target`     | `("make", "redeploy")`                   | 900     | true     | `("make",)`          |
| `morpheus.health`                | `morpheus`      | `make_target`     | `("make", "health")`                     | 60      | false    | `("make",)`          |
| `tor.restart`                    | `tor`           | `compose_command` | `("docker", "compose", "restart")`       | 180     | true     | `("docker",)`        |
| `tor.status`                     | `tor`           | `compose_command` | `("docker", "compose", "ps")`            | 30      | false    | `("docker",)`        |

### 3.5 Why no homeassistant action in the initial set

HomeButler runs **inside** the homeassistant stack. A `make redeploy` equivalent would kill its own container mid-request, which is better modeled as "ask the host to restart us" and is not needed right now — HA and Grocy are already restartable individually via `/ops/stacks/homeassistant/services/{service}/restart`. Omitting avoids foot-guns. Revisit in a future phase with an out-of-band mechanism (e.g., a systemd-triggered runner).

### 3.6 No user input in argv / targets / env

v1 actions accept **no parameters**. The `POST .../run` request body is a fixed empty-object schema (`RunActionRequest`) reserved for future structured fields. It is rejected if it contains any keys not declared by the action registry (none currently declared). This makes "argv injection via parameter" structurally impossible in v1 and keeps the door open for strictly-typed parameters later (e.g., a paperless action that takes `retention_days: int` drawn from an enum).

---

## 4. Command Runner

Module: `services/homebutler/app/services/command_runner.py`

### 4.1 Signature

```
@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    truncated: bool
    timed_out: bool

class CommandRunner:
    def __init__(self, *,
                 stdout_cap_bytes: int = 64 * 1024,
                 stderr_cap_bytes: int = 64 * 1024,
                 global_env_allowlist: tuple[str, ...] = ("PATH", "HOME", "TZ", "LANG", "LC_ALL")): ...

    def run(self, *,
            argv: tuple[str, ...],
            cwd: str,
            timeout_seconds: int,
            extra_env_allowlist: tuple[str, ...] = ()) -> CommandResult: ...
```

### 4.2 Rules

- `subprocess.run(argv, cwd=cwd, env=env, shell=False, timeout=timeout_seconds, capture_output=True, check=False)`.
- `argv` is always a tuple/list, never a string. `shell=False` is hard-coded; there is no codepath that sets `shell=True`.
- `env` is constructed from scratch, not inherited: `{k: os.environ[k] for k in (global_env_allowlist + extra_env_allowlist) if k in os.environ}`. No request-provided env. No wildcards.
- `cwd` must be an absolute path that exists and is a directory. The runner re-validates this at call time (defense in depth against a repo getting unmounted between the availability check and the run).
- On `TimeoutExpired`: process is killed (`process.kill()` via the internal `Popen`-based path), partial stdout/stderr is captured up to the cap, and `timed_out=True` is returned with `exit_code=-1`.
- stdout/stderr are read as bytes, decoded `utf-8` with `errors="replace"`, truncated to their caps with a trailing `\n… [truncated N bytes]` marker, and `truncated=True` is set when a cap was hit.
- Secrets redaction: any captured output containing substrings matching known-sensitive env var values (`GROCY_API_KEY`, `CLOUDFLARED_TOKEN`, `GOVEE_API_KEY`, `GOVEE_PASSWORD`, `MQTT_PASSWORD`) is replaced with `***`. The list lives next to the runner and is exhaustive rather than heuristic.
- Structured logging: every invocation logs `{action_id, argv_hash, cwd, exit_code, duration_ms, timed_out, truncated}` at `INFO`. Never logs raw stdout/stderr; callers fetch those via the API response. `argv_hash` is `sha256(argv).hexdigest()[:12]` to keep logs grep-able without leaking what the target was (argv is fixed-from-registry, so the hash is useful for correlation only).

### 4.3 Where env passthrough is allowed

- **Always**: `PATH`, `HOME`, `TZ`, `LANG`, `LC_ALL`.
- **Per-action**: via `extra_env_allowlist` on the `ActionDef`. v1 actions declare none. This is the only mechanism to forward env.
- **Never**: anything from the HTTP request, query string, headers, or body.

---

## 5. API Surface

All under prefix `/ops`, tag `ops`. All responses are Pydantic models (schemas defined in `services/homebutler/app/schemas.py`, new additions below). Unknown stack / service / action IDs return `404` with a uniform error shape.

### 5.1 Error shape

```
class OpsError(BaseModel):
    error: str           # machine-readable code, e.g. "stack_not_found"
    message: str         # human-readable detail
    detail: dict | None  # optional structured context
```

FastAPI returns it with the appropriate status (`404` for not found, `403` for allowlist denial, `409` for unavailable action, `422` for validation, `502` for Docker/subprocess failure, `504` for timeout).

### 5.2 Stack routes

```
GET  /ops/stacks
GET  /ops/stacks/{stack}
GET  /ops/stacks/{stack}/services/{service}
GET  /ops/stacks/{stack}/services/{service}/logs?tail=200
POST /ops/stacks/{stack}/services/{service}/restart
```

Schemas:

```
class ServiceInfo(BaseModel):
    stack: str
    service: str
    container_name: str
    description: str
    tags: list[str] = []
    container: ContainerSummary | None   # null if container not present on host

class StackInfo(BaseModel):
    stack: str
    display_name: str
    description: str
    repo_path_env: str | None
    repo_path_resolved: str | None       # null if env unset or path missing
    services: list[ServiceInfo]

class StackListResponse(BaseModel):
    count: int
    stacks: list[StackInfo]

class ServiceDetailResponse(BaseModel):
    service: ServiceInfo

class ServiceLogsResponse(BaseModel):
    stack: str
    service: str
    container_name: str
    tail: int
    logs: str

class ServiceMutationResponse(BaseModel):
    status: str            # "restarted"
    message: str
    service: ServiceInfo
```

Semantics:
- `list_containers` is called once per list-stacks request and merged against the registry to populate `ServiceInfo.container`. Containers that are **in** the registry but **not running on the host** are returned with `container=null` rather than omitted.
- `logs` and `restart` delegate to the existing `DockerOpsClient.get_logs(...)` / `DockerOpsClient.restart(...)` after resolving `service → container_name`.

### 5.3 Stack-level restart — decision: **defer, do not ship in v1**

Recommendation: **do not expose `POST /ops/stacks/{stack}/restart` in v1.** Reasoning:
- A fan-out restart is rarely what the caller wants (order matters for dependencies like mosquitto → govee2mqtt; restarting `cloudflared` before its upstream is healthy causes user-visible tunnel flaps).
- A `docker compose restart` invocation is the correct primitive, but expressing it as a free route invites "well, what if we add `stop`, `down`, `up --build`?" creep.
- The right expression is an **explicit Action**: e.g., `mediaserver.restart_all` → `("docker", "compose", "restart")`. That keeps fan-out behavior allowlisted and auditable. We explicitly defer adding such an action to a later phase where we can decide per-stack whether bulk restart is safe.

If Neo needs "restart this whole stack" in v1, callers loop over services and call the per-service restart endpoint. Cheap, explicit, and debuggable.

### 5.4 Action routes

```
GET  /ops/actions
GET  /ops/actions/{action}
POST /ops/actions/{action}/run
```

Schemas:

```
class ActionAvailabilityInfo(BaseModel):
    available: bool
    repo_path_resolved: str | None
    missing_executables: list[str] = []
    reason: str | None = None

class ActionInfo(BaseModel):
    action: str
    stack: str
    description: str
    kind: str                  # value of ActionKind
    argv: list[str]            # echoed for transparency; read-only
    timeout_seconds: int
    mutating: bool
    required_executables: list[str]
    availability: ActionAvailabilityInfo

class ActionListResponse(BaseModel):
    count: int
    actions: list[ActionInfo]

class ActionDetailResponse(BaseModel):
    action: ActionInfo

class RunActionRequest(BaseModel):
    model_config = {"extra": "forbid"}   # reject any unknown field
    # (empty in v1; typed, validated fields added per-action in the future)

class ActionRunResponse(BaseModel):
    action: str
    status: str                # "ok" | "failed" | "timed_out"
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    truncated: bool
    timed_out: bool
    started_at: str            # ISO-8601
    finished_at: str
```

Semantics:
- `GET /ops/actions` always returns the full registry; `availability` is computed per-entry.
- `POST /ops/actions/{action}/run` returns `409 unavailable` when `availability.available == False` (before spawning anything). Otherwise it runs synchronously and returns the structured result. Non-zero `exit_code` is a *successful API call* with `status="failed"` — it is not a 5xx, because "the command ran and exited 1" is normal for health checks and must be introspectable by the caller.
- `timed_out=true` maps to HTTP `504` (the operation itself didn't complete in time).
- The `Retry-After` header is not set; callers decide retry policy. Mutating actions should not be retried blindly and the response `mutating` flag is the caller's cue.

---

## 6. Configuration & Env Vars

### 6.1 New env vars

| Var                               | Default                    | Purpose                                                              |
|-----------------------------------|----------------------------|----------------------------------------------------------------------|
| `HOMEBUTLER_REPO_ROOT`            | `/opt/repos`               | Base path inside the container where host repos are bind-mounted.    |
| `HOMEBUTLER_HOMEASSISTANT_REPO`   | `${HOMEBUTLER_REPO_ROOT}/homeassistant` | Repo path for the homeassistant stack.                    |
| `HOMEBUTLER_MEDIASERVER_REPO`     | `${HOMEBUTLER_REPO_ROOT}/mediaserver`   | Repo path for the mediaserver stack.                      |
| `HOMEBUTLER_MORPHEUS_REPO`        | `${HOMEBUTLER_REPO_ROOT}/morpheus`      | Repo path for the morpheus stack.                         |
| `HOMEBUTLER_TOR_REPO`             | `${HOMEBUTLER_REPO_ROOT}/tor`           | Repo path for the tor stack.                              |
| `HOMEBUTLER_ACTIONS_ENABLED`      | `true`                     | Global kill-switch for action routes. When false, `/ops/actions*` returns `503 disabled`; stack routes still work. |

Defaults are resolved in `app/config.py` with the existing `@lru_cache Settings` pattern. Unset per-stack env ⇒ fall back to `${HOMEBUTLER_REPO_ROOT}/{stack_id}`. The registry records the env var *name* (so it can display `repo_path_env="HOMEBUTLER_MEDIASERVER_REPO"` in responses) while resolution flows through `Settings`.

### 6.2 Relationship with `HOMEBUTLER_CONTROLLED_CONTAINERS`

Recommendation: **the stack registry is the source of truth; the env var is honored but becomes additive.** Rationale:
- The allowlist is security-critical and should live in code-reviewed source, not in `.env`.
- Hot-swapping via env risks shipping a production `.env` that allowlists more than intended.

Resolution order:
1. Start with `allowlist = all_controlled_container_names()` from the registry.
2. If `HOMEBUTLER_CONTROLLED_CONTAINERS` is set: `allowlist = allowlist | set(env_list)` — it can **only add**, never remove. A warning is logged listing the additions so drift is visible.
3. `Settings.controlled_containers` returns the effective merged list (for `GET /config` and for `DockerOpsClient`).

This preserves existing behavior for anyone who has customized the env var while making the registry authoritative going forward. If we later want to drop the env var entirely, step 2 becomes a no-op and a single commit removes it.

### 6.3 Doc updates

- `example.env`: add the six new vars under a `# HomeButler repo mounts` block, all commented-in with defaults. Note that actions are unavailable until the repos are bind-mounted (§7).
- `README.md`: add a "Control plane (HomeButler)" subsection under Architecture with a one-paragraph summary and pointer to this design doc.
- `CLAUDE.md` (project): one-line note that HomeButler now exposes `/ops/stacks` and `/ops/actions` with an allowlisted registry.

---

## 7. Execution Model & Deployment

### 7.1 What's needed for actions to actually run

Today HomeButler's container has `docker.sock` mounted but lacks `make`, `docker` CLI, `docker compose` plugin, and **the host repo paths**. Three things must change to make actions functional:

1. **Install `make` and the `docker` CLI (with compose plugin) inside the HomeButler image.** Update the Dockerfile to add a lightweight install step. Recommendation: use the official Docker static binaries + compose plugin to avoid pulling a full docker-ce, and `apt-get install --no-install-recommends make`. This keeps the image < 200 MB.
2. **Bind-mount the four host repos into the container**, read-only where possible. Proposed mount target: `/opt/repos/{homeassistant,mediaserver,morpheus,tor}`. `mediaserver` and `morpheus` Makefiles invoke `docker`/`docker compose`, which write to temp files inside the repo (`.env`, compose state) — those two mounts are **read-write**. `tor` can be read-only since actions are limited to `docker compose restart/ps`, and `homeassistant` is read-only (no actions target it in v1).
3. **Compose service edits** in `docker-compose.yaml` for the `homebutler` service: add the four `volumes:` entries (host path → container path) and leave `/var/run/docker.sock` mount intact.

**Recommendation:** do (1) and (3) as part of the Phase 3 implementation PR. Actions register as `available: false` with a clear reason (`"repo path /opt/repos/mediaserver not found"` or `"executable 'make' not found"`) until the deployment side is complete. This decouples code-merge from the NAS deployment step.

### 7.2 Security tradeoff of the Docker CLI + repo mounts

- Giving the container the Docker CLI is **no incremental privilege escalation** over the existing `docker.sock` mount — full control is already possible via the SDK. The CLI is convenience for Makefile targets.
- Mounting repos read-write for `mediaserver`/`morpheus` means a HomeButler compromise could overwrite those repos. HomeButler is already localhost-only and behind two containers' worth of networking isolation; the practical blast radius is the same as "attacker got on the NAS." This is acceptable for a home lab. Revisit if HomeButler is ever exposed.

### 7.3 Rollback

If the new Dockerfile breaks on the NAS: the old image keeps running (no layer change on the running container), and `docker compose down homebutler && docker compose up -d homebutler` on the previous commit reverts. No data migrations; registry changes are code-only.

---

## 8. Security Boundaries

1. **Allowlist is the only path.** Stack/service/action IDs that don't appear in the registry return `404 not_found`. Container names resolved from the registry are re-validated against `DockerOpsClient.allowed_containers` (defense in depth — a registry typo cannot reach Docker).
2. **ID shape is enforced.** `^[a-z0-9_]+$` for stack/service IDs; `^[a-z0-9_]+(\.[a-z0-9_]+)+$` for action IDs. Enforced at the route level via FastAPI path converters and at registry-import time. Rejection is `404`, not `422`, to not leak "this shape was close."
3. **No shell, no concatenation, no templating.** `subprocess.run` with `argv=tuple(...)`, `shell=False`, registry-fixed `argv`. There is no codepath anywhere in HomeButler that builds a shell string.
4. **No user-controlled env.** `extra_env_allowlist` is declared per-action in code, applied against HomeButler's own process env. Request bodies/headers/query are never forwarded.
5. **Mandatory timeouts with a hard cap.** Every action has a timeout ≤ 1800s. On timeout, the process is killed and the response is `504`.
6. **Logs sanitized.** Output is capped, decoded with `errors="replace"`, and known secret values are redacted before being returned or logged.
7. **Mutating actions are flagged.** `mutating=true` is visible in `GET /ops/actions` and in the run response; callers/operators can filter or require an explicit confirmation UI.
8. **Action routes kill-switched.** `HOMEBUTLER_ACTIONS_ENABLED=false` disables `/ops/actions*` at the router level. Useful for emergency rollback without redeploying.
9. **Localhost-only.** HomeButler keeps its `127.0.0.1:8000` host binding. The `automation` docker network is how HA reaches it; external exposure is explicitly not added here.
10. **Not exposed, explicitly.** No endpoint accepts user-provided make targets, compose commands, service names for compose, container names for docker CLI, shell strings, env pairs, or file paths. Any future action that needs a parameter must declare it as a typed, enum-constrained field in its request schema.

---

## 9. Testing Strategy

### 9.1 Layout

```
services/homebutler/tests/
    test_stack_registry.py        # unit
    test_action_registry.py       # unit
    test_availability.py          # unit (with monkeypatched shutil.which and tmp_path)
    test_command_runner.py        # unit (subprocess in real Python — safe since argv is fixed)
    test_ops_stack_routes.py      # FastAPI TestClient + fake DockerOpsClient
    test_ops_action_routes.py     # FastAPI TestClient + fake CommandRunner
    conftest.py                   # fakes / fixtures
```

### 9.2 Fakes

- `FakeDockerOpsClient`: in-memory container map keyed by name, same public methods as `DockerOpsClient`, deterministic behavior for `list/get/logs/restart`. Used in route tests via FastAPI `dependency_overrides`.
- `FakeCommandRunner`: records the `argv/cwd/timeout` it was called with and returns a scripted `CommandResult`. No real subprocess in route tests.
- For `test_command_runner.py`: run a **real** subprocess using short, portable invocations (`python -c "..."`, `/bin/sleep`) — argv is fixed in tests too, so there is no injection risk. Guard Linux/macOS differences with `sys.platform` skips.

### 9.3 Minimum test matrix

Stack registry:
- Unknown `stack_id` / `service_id` → raises typed exceptions.
- Service → container resolution returns the correct name for each service in every stack.
- `all_controlled_container_names()` equals the union of every `container_name` in the registry with no duplicates.

Service routes:
- `GET /ops/stacks` lists every stack; each service's `container` field is populated from `FakeDockerOpsClient` or null when absent.
- `GET /ops/stacks/unknown` → 404.
- `GET /ops/stacks/mediaserver/services/unknown` → 404.
- `GET .../logs?tail=9999` → 422 (existing `Query(le=1000)` constraint upheld).
- `POST .../restart` on a known service calls `DockerOpsClient.restart` with the resolved container name exactly once.
- Legacy `GET /ops/containers/{name}` still works.

Action registry:
- Every `ActionDef` passes import-time validation (fixtures deliberately construct invalid ones — missing stack, bad argv, shell metacharacters — and assert they raise).
- `availability.available` transitions correctly as `shutil.which` returns and `tmp_path` exists/absent.
- Action IDs that aren't registered → 404.

Command runner:
- Successful command: exit_code/stdout/stderr/duration populated; `truncated=False`, `timed_out=False`.
- Timeout: process killed; `timed_out=True`; `exit_code=-1`; partial output captured.
- Stdout > cap: `truncated=True` with marker appended.
- `shell=False` is the only path (asserted via the code, not a runtime test).
- `cwd` that is not a directory → raises before spawning.
- Env passthrough: unallowlisted vars are stripped; allowlisted vars flow through; request-supplied env is never accepted (structurally impossible in the signature, asserted via type check + a test that passes `{"FOO": "bar"}` as a kwarg and expects `TypeError`).

Action routes:
- `GET /ops/actions` returns every registered action with availability.
- `POST /ops/actions/unknown/run` → 404.
- `POST /ops/actions/morpheus.health/run` with `available=false` → 409.
- `POST /ops/actions/morpheus.health/run` with `available=true` → 200 and `FakeCommandRunner` was called with exactly the registry's argv/cwd/timeout.
- `HOMEBUTLER_ACTIONS_ENABLED=false` → 503 on `/ops/actions*` and `/ops/stacks*` still works.

---

## 10. Phase 3 Action List (restated, as the source of truth)

Already covered in §3.4. To keep the registry literal:

```
ActionDef(
    action_id="mediaserver.update_gluetun",
    stack_id="mediaserver", kind=MAKE_TARGET,
    argv=("make", "update-gluetun"),
    repo_path_env="HOMEBUTLER_MEDIASERVER_REPO",
    timeout_seconds=600, mutating=True,
    required_executables=("make",),
),
ActionDef(
    action_id="mediaserver.sync_configs",
    stack_id="mediaserver", kind=MAKE_TARGET,
    argv=("make", "sync-configs"),
    repo_path_env="HOMEBUTLER_MEDIASERVER_REPO",
    timeout_seconds=300, mutating=True,
    required_executables=("make",),
),
ActionDef(
    action_id="morpheus.redeploy",
    stack_id="morpheus", kind=MAKE_TARGET,
    argv=("make", "redeploy"),
    repo_path_env="HOMEBUTLER_MORPHEUS_REPO",
    timeout_seconds=900, mutating=True,
    required_executables=("make",),
),
ActionDef(
    action_id="morpheus.health",
    stack_id="morpheus", kind=MAKE_TARGET,
    argv=("make", "health"),
    repo_path_env="HOMEBUTLER_MORPHEUS_REPO",
    timeout_seconds=60, mutating=False,
    required_executables=("make",),
),
ActionDef(
    action_id="tor.restart",
    stack_id="tor", kind=COMPOSE_COMMAND,
    argv=("docker", "compose", "restart"),
    repo_path_env="HOMEBUTLER_TOR_REPO",
    timeout_seconds=180, mutating=True,
    required_executables=("docker",),
),
ActionDef(
    action_id="tor.status",
    stack_id="tor", kind=COMPOSE_COMMAND,
    argv=("docker", "compose", "ps"),
    repo_path_env="HOMEBUTLER_TOR_REPO",
    timeout_seconds=30, mutating=False,
    required_executables=("docker",),
),
```

No homeassistant-stack action in v1 (justification in §3.5).

---

## 11. Backward Compatibility & Migration

- `GET /ops/containers*` and `POST /ops/containers/{name}/restart` — unchanged. No schema, status code, or behavior changes. Flagged in OpenAPI description as "legacy flat view; prefer `/ops/stacks/...`".
- `HOMEBUTLER_CONTROLLED_CONTAINERS` — still honored, **additive only** relative to the registry (§6.2). A startup log line announces the effective set.
- `GET /config` — continues to return `controlled_containers` as the flat effective set. A new top-level `stacks` summary field is **not** added in v1 (keep `/config` stable; introspect via `/ops/stacks` instead).
- Clients that already hit `/ops/containers/grocy/restart` keep working during and after the rollout; they can migrate to `/ops/stacks/homeassistant/services/grocy/restart` at their own pace.

---

## 12. Open Questions (with recommended answers)

1. **Should `HOMEBUTLER_CONTROLLED_CONTAINERS` be additive or replace the registry?**
   *Recommendation: additive only (§6.2).* Registry wins as source of truth; env var can add but not remove. Allows trivial removal of the env var in a later phase.

2. **Ship stack-level `POST /ops/stacks/{stack}/restart` in v1?**
   *Recommendation: no (§5.3).* Risk of implicit dependency-order breakage. Express bulk operations as explicit allowlisted Actions when needed.

3. **Include a homeassistant-stack action?**
   *Recommendation: no in v1 (§3.5).* HomeButler is in-stack; bulk ops risk killing itself. Per-service restart is already available.

4. **Add the Docker CLI + make to the HomeButler image now, or ship registry-only first?**
   *Recommendation: add now in the Phase 3 PR (§7.1).* Otherwise every action ships as `available: false` and the first real test is in prod. Image grows by ~100 MB; acceptable.

5. **Mount repos read-only or read-write?**
   *Recommendation: RW for `mediaserver` and `morpheus` (Makefiles write state), RO for `tor` and `homeassistant`.* Narrowest viable permission per stack (§7.1).

6. **Registry as Python or YAML?**
   *Recommendation: Python (§2.1, §3.1).* Type checker catches bad references at import; YAML would need a schema + loader + tests that duplicate what `mypy`/Pydantic already give us for free.

7. **Introduce an async job / streaming-logs subsystem in v1?**
   *Recommendation: no.* Synchronous `subprocess.run` with a 1800s cap covers every v1 action. Defer to a future phase if/when an action legitimately needs minutes of streaming output (e.g., a large `redeploy`).

---

## 13. Directory Layout After This Phase

```
services/homebutler/
  app/
    api/routes/
      ops.py                 # extended: legacy + stack + action routes
    clients/
      docker_ops.py          # unchanged
    registry/
      __init__.py
      stacks.py              # StackDef, ServiceDef, registry, lookup helpers
      actions.py             # ActionDef, ActionKind, registry, lookup helpers
      availability.py        # ActionAvailability + compute_availability(...)
    services/
      command_runner.py      # CommandRunner, CommandResult
      grocy_migration.py     # unchanged
    schemas.py               # extended with Stack/Service/Action schemas (§5)
    config.py                # extended with repo paths + ACTIONS_ENABLED
  docs/
    control-plane-design.md  # this file
  tests/
    ...                      # as in §9.1
  Dockerfile                 # + make, + docker CLI, + compose plugin
  requirements.txt           # unchanged (stdlib subprocess, no new deps)
```

No new runtime dependencies (stdlib `subprocess` + `shutil.which` cover everything). `docker-compose.yaml` grows four `volumes:` entries and six new env-var lines on the `homebutler` service.

---

## 14. Implementation Order (for the developer agent)

1. Add `app/registry/stacks.py` with the four stacks and their services. Wire `all_controlled_container_names()` into `Settings.controlled_containers` (additive with env var).
2. Extend schemas and add `/ops/stacks*` routes delegating to existing `DockerOpsClient`. Legacy routes untouched.
3. Add `app/services/command_runner.py`.
4. Add `app/registry/actions.py` + `app/registry/availability.py`.
5. Add `/ops/actions*` routes behind `HOMEBUTLER_ACTIONS_ENABLED`.
6. Update `Dockerfile` (make + docker CLI + compose plugin) and `docker-compose.yaml` (four repo bind-mounts + new env vars).
7. Update `example.env` and `README.md`.
8. Tests per §9 landed alongside each of 1–5.
