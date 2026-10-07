# Portainer Stack Migration

Goal: let Portainer manage the Home Assistant stack from git, matching the mediaserver setup.

## Target Layout

- `portainer` stays as the standalone bootstrap stack from the mediaserver repo.
- `homeassistant` is a Git-backed Portainer stack from this repo's `docker-compose.yaml`.
- The compose project name is pinned with:

```yaml
name: homeassistant
```

That keeps Portainer aligned with containers named `homeassistant`, `grocy`, `homebutler`, `mosquitto`, `govee2mqtt`, and `ha-cloudflared` instead of creating a second project with a generated name.

## Can Portainer See This Repo?

Yes, if the NAS can reach GitHub. The current repo is public:

```text
https://github.com/pranavprem/homeassistant.git
```

Use:

- Stack name: `homeassistant`
- Build method: Git repository
- Repository URL: `https://github.com/pranavprem/homeassistant.git`
- Repository reference: `refs/heads/main`
- Compose path: `docker-compose.yaml`
- Environment: paste the existing values from the NAS-local `.env`

Portainer's Git clone will not automatically use `/volume1/docker/homeassistant/.env`, because it deploys from its own cloned copy. Keep secrets in Portainer environment variables or another Portainer-managed secret/env mechanism, not in git.

## Migration

Run these on the NAS before importing if the stack already exists outside Portainer.

1. Make sure the repo and local env exist:

```bash
cd /volume1/docker/homeassistant
git pull origin main
test -f .env
```

2. In Portainer, create a stack with the settings above and paste the existing `.env` values into the stack environment.

3. Deploy the stack.

Because the compose project name and container names are stable, Compose should converge on the existing containers and persistent bind mounts instead of creating a duplicate stack.

## Operating Rules

- Use Portainer for full-stack start, stop, restart, and Git redeploy of `homeassistant`.
- Keep Portainer outside this stack so a Home Assistant redeploy does not take down the UI driving it.
- Keep `.env`, Cloudflare tunnel tokens, MQTT credentials, Govee credentials, and Grocy API keys out of git.
- If you switch this repo back to private later, add Git credentials in Portainer or mirror it to NAS Gitea and use that repository URL instead.

## Keep the shared tunnel independent

`cloudflared` must not have a startup dependency on Home Assistant or Grocy health.
It is shared ingress: a failed Grocy healthcheck must not block remote access to
an otherwise healthy Home Assistant. The tunnel can start before either backend;
requests to an unavailable backend will fail independently until it recovers.
Do not weaken Grocy's healthcheck to make the tunnel start.

For a narrowly scoped recovery, start the existing `ha-cloudflared` container in
Portainer. To apply an approved tunnel-only Compose change from the correct NAS
checkout and environment, use:

```bash
docker compose up -d --no-deps --pull never cloudflared
```

This command targets only the tunnel and avoids pulling a new image. It is not
`make up`: that target can rebuild the stack and restart HA for proxy changes.
Starting an existing stopped/created container restores service only; the dependency
change must also reach the Git source used by Portainer to survive future recreations.

Verify separately:

- HA's local response and its unchanged container ID/start time.
- Tunnel container running and logs showing registered Cloudflare connections.
- The public HA URL loads successfully; a running container alone is not proof.
- Grocy's health independently, without describing its recovery as part of the tunnel fix.

The current tunnel healthcheck runs `cloudflared tunnel --version`; it only checks
that the executable works, not that the tunnel is connected. Do not use that
`healthy` label alone as proof of remote availability. Inspect Git polling settings
when redeployments recur, and avoid automatically pulling unrelated `latest`/`stable`
images as part of a narrow ingress repair.
