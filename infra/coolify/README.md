# Bordmap — Coolify deploy (FEN-437)

Agent-driven deploy of Bordmap onto Alexis's Coolify (`https://coolify.fenysk.fr`,
API `/api/v1`, Bearer), same pattern as LivePlace (FEN-79/80/93). Coolify talks to
Docker, so **no `docker.sock` access is needed from the agent** — it only needs
HTTPS egress to the Coolify API and to GitHub.

## Topology

`docker-compose.coolify.yml` runs **three services**: the **official** self-hosted
Convex backend image (`:3210`, binds 0.0.0.0 — the in-image single-image co-host
failed live on Coolify, R6), the Start app (`Dockerfile.app`, `:3000`), and a tiny
baked **Caddy** proxy (`Caddyfile` via `Dockerfile.proxy`) that fronts both on
**one public domain** by path-routing:

| public path        | upstream        | purpose                                  |
|--------------------|-----------------|------------------------------------------|
| `/convex/*`        | `convex-backend:3210` | Convex client API/sync (prefix stripped) |
| everything else    | `app:3000`            | SPA + Better Auth (`/api/auth/*`, JWKS)  |

`VITE_CONVEX_URL = https://<domain>/convex` is baked at build time. Coolify's edge
Traefik terminates TLS and routes the assigned domain → `proxy:80` (the proxy
`expose`s :80, never host-publishes — host-publishing 404s on Coolify, FEN-92).

## One-command deploy

```sh
# 1. Wire a git source Coolify can clone (creates GitHub repo + pushes a
#    secret-free, parentless bundle; needs GITHUB_TOKEN + GitHub egress).
node scripts/coolify-wire-source.mjs

# 2. Create the Coolify app, bake the public origins, deploy, and smoke
#    (needs COOLIFY_API_TOKEN + Coolify egress).
node scripts/coolify-deploy.mjs                 # add --check-persistence to also
                                                # restart + re-smoke (volume test)
```

`scripts/coolify-deploy.mjs --dry-run` (or no token) prints the exact env + API
calls without touching anything.

## Guardrails

`scripts/coolify-deploy.mjs` bakes the Bordmap project uuid
(`mbw8fq4xd475qc35hln9ryq0`) and **denylists** LivePlace + every other project. It
reads `GET /projects/<uuid>`, confirms the name matches `bordmap/boardmap`, and
refuses to write anywhere else. `scripts/lib/deploy-guard.mjs` keeps the deploy
snapshot off any non-dedicated repo.

## Inherited gotchas (already handled)

- **Bind-mount file → OCI bug**: the Caddyfile is **baked** into the proxy image.
- **Host-publish → 404**: the proxy `expose`s :80; Coolify routes the domain to it.
- **Thin Coolify logs**: compose fails fast (healthchecks); the backend's internal
  loopback origins are left at defaults so boot never deadlocks on the proxy.
- **Token rotation**: `resolveToken()` picks the highest `COOLIFY_API_TOKEN_N`.

## Token-free smoke

`BASE_URL=https://<domain> node scripts/smoke.mjs` — checks `/` → 200 + Bordmap
page, and `/convex/version` → 200. Volume persistence is covered by the named
`convex-data` volume + `--check-persistence` (restart + re-smoke) and by
`docker/smoke.sh` locally.
