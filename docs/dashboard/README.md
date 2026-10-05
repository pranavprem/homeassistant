# Agraharam — dashboard build handoff

Prepared 2026-10-03. This is a build brief, **not an installed dashboard**.

## Start here

Run Claude Code from this checkout and give it [PROMPT.md](PROMPT.md). Read:

1. Root `CLAUDE.md` — repository/deployment conventions.
2. [DESIGN.md](DESIGN.md) — visual direction and household-facing experience.
3. [IMPLEMENTATION.md](IMPLEMENTATION.md) — architecture, data, controls, installation.
4. [ACCEPTANCE.md](ACCEPTANCE.md) — what a finished implementation must prove.
5. `.dashboard-local/README.md` — private, machine-local household context.

The desired result is a bespoke cream/olive/brass dashboard **inside Home Assistant**,
not a generic grid of unstyled entity cards and not a screenshot-only mockup.

## Public and private boundary

This repository is public. Commit reusable UI code, fictional fixtures, design
tokens, the build pipeline and generic installation examples. Keep `.dashboard-local/`
ignored. It contains the user-provided visual reference and household-specific
entity bindings/context. Do not force-add it, inline its contents into public
fixtures, or publish browser captures containing real household data.

On another machine, the design brief remains usable without private files: build
with clearly labeled fictional demo data, then obtain the private context through
an approved private transfer or authenticated, read-only HA discovery. No personal
access token belongs in this repo or a browser build. Never read `.env`, `.mcp.json`
or credential stores just to make a visual prototype work.

The original `dashboard.yaml` is a historical reference, not a current entity
registry and not an automatically deployed dashboard. Do not make a new design
depend on stale entity IDs just because that YAML contains them.

## Scope

- Implement under `frontend/agraharam/`; keep installation examples in that subtree.
- Preserve existing dashboards as fallback; proposed new route: `/agraharam-next`.
- Existing automation/security policy remains authoritative. UI work does not
  authorize changing arming rules, sirens, camera privacy or device schedules.
- The local private security worktree must not be merged or pushed to this public repo.
- This handoff makes no live changes and does not grant NAS credentials/access.

## Launch

```text
Read docs/dashboard/PROMPT.md and implement it. First read the linked brief and
.dashboard-local/README.md, and inspect .dashboard-local/reference-dashboard.jpg
if present. Build and verify the dashboard; don't stop at a plan.
```

See [IMPLEMENTATION.md](IMPLEMENTATION.md#sources) for official HA references.
