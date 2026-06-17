# Bordmap

Référence et découvre les meilleures routes Freebord sur une carte interactive.
Produit **autonome** (aucun couplage Freebord). Stack verrouillée board :
**TanStack Start + Convex, le tout dans un Docker**.

> Foundation lot **L0** (FEN-345). Governing plan: §1/§3/§4/§7/§8 of
> [FEN-341](/FEN/issues/FEN-341#document-plan). Briques produit B1 (auth),
> B2 (référencer), B3 (visualiser) arrivent dans les lots L1–L4.

## Stack

| Couche | Choix |
|---|---|
| Front / meta-framework | TanStack Start (React 19, SSR, file routing, Vite, Nitro) |
| Back / DB | Convex (self-host) |
| Carte (L3) | MapLibre GL + tuiles OSM |
| Auth (L1) | Better Auth (email/pwd) |
| Packaging | Image Docker unique (Convex backend + Start), repli compose 2 services |
| Package manager | pnpm |

## Arborescence

```
app/
  routes/        # routing fichier (pages publiques/protégées + routes serveur)
  components/    # RouteMap, RouteForm, RouteDetailCard (contrats §3)
  lib/shared/    # types Route, enums, helpers geo (haversine, geohash) — partagés front/back
  router.tsx     # entrée routeur
convex/          # schéma + fonctions backend (schéma vide en L0)
docs/adr/        # Architecture Decision Records (ADR 0001 = R6)
Dockerfile               # image unique (cible directive)
docker-compose.yml       # `docker compose up` -> image unique
docker-compose.fallback.yml + Dockerfile.app   # repli 2 services (R6)
```

## Dev loop — local

Prérequis : Node 24+, pnpm 11+.

```bash
pnpm install
cp .env.example .env.local        # remplir VITE_CONVEX_URL etc.
```

Deux terminaux (Convex backend + app) :

```bash
# 1) Backend Convex self-host (pousse schéma + fonctions, régénère convex/_generated)
npx convex dev

# 2) App TanStack Start (http://localhost:3000)
pnpm dev
```

`npx convex dev` régénère `convex/_generated/*` à partir de `convex/schema.ts`
et des fonctions — à relancer après modif du schéma (L2).

### Scripts

| Script | Rôle |
|---|---|
| `pnpm dev` | serveur de dev (port 3000) |
| `pnpm build` | build prod (Nitro node-server → `.output/`) |
| `pnpm start` *(= `node .output/server/index.mjs`)* | lance le build prod |
| `pnpm generate-routes` | (re)génère `app/routeTree.gen.ts` |
| `pnpm typecheck` / `pnpm typecheck:convex` | `tsc --noEmit` (app / convex) |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest (logique partagée) |

CI (`.github/workflows/ci.yml`) lance lint + typecheck + test + build à chaque push.

## Déploiement — NAS (image unique)

Le **reverse proxy + TLS du NAS** sont en frontal (Bordmap ne termine pas le
TLS). Le proxy route le domaine public vers le port **3000** (app) ; exposer
**3210/3211** (Convex) uniquement si le navigateur doit joindre Convex
directement — sinon les proxifier aussi.

```bash
# VITE_CONVEX_URL doit être l'URL PUBLIQUE de Convex (baked au build).
# CONVEX_CLOUD_ORIGIN/CONVEX_SITE_ORIGIN = origines publiques vues par le
# navigateur/CLI (derrière le reverse proxy NAS).
VITE_CONVEX_URL=https://bordmap.example/convex \
CONVEX_CLOUD_ORIGIN=https://bordmap.example/convex \
CONVEX_SITE_ORIGIN=https://bordmap.example/convex-site \
  docker compose up --build -d
```

- Volume `convex-data` = persistance (SQLite **+** identité d'instance sous
  `data/credentials`).
- `CONVEX_SELF_HOSTED_ADMIN_KEY` : la clé est **stable par défaut** — dérivée de
  l'`instance_secret` persisté dans le volume (même volume ⇒ même clé après
  restart). Fournir une clé explicite (Docker secret) reste recommandé en prod.
- `CONVEX_BACKEND_IMAGE` est **pinné** sur le sha complet de la release
  `precompiled-2026-06-01-aeb5f28` (correspond à `convex` npm 1.40.0, multi-arch
  amd64+arm64). Le bumper en lockstep avec le paquet `convex` (règle de sélection
  dans `.env.example` et [ADR 0001](docs/adr/0001-r6-single-image-vs-compose.md)).

### Valider R6 sur l'hôte docker — ✅ validé sur NAS le 2026-06-16 (FEN-353)

`docker/smoke.sh` construit + démarre l'image unique et exécute les 4 points de
smoke (backend `/version`, `convex deploy`, app `:3000` HTTP 200, persistance du
volume après restart). Reproductible sur NAS comme en CI :

```bash
VITE_CONVEX_URL=http://localhost:3210 \
AUTH_ISSUER=http://localhost:3000/api/auth \
  ./docker/smoke.sh
# ou contre le repli :  COMPOSE_FILE=docker-compose.fallback.yml ./docker/smoke.sh
```

Le job CI `r6-single-image-smoke` (`.github/workflows/ci.yml`) lance exactement
ce script sur un runner docker-capable.

**Prérequis confirmés en live (sinon l'image unique ne démarre pas / `convex
deploy` échoue) :**

- **Base runtime glibc ≥ 2.39** : le binaire `convex-local-backend` exige
  `GLIBC_2.38/2.39`. `NODE_IMAGE` est donc pinné sur `node:24-trixie-slim`
  (Debian 13, glibc 2.41) — **pas** `bookworm-slim` (2.36, le backend ne boote pas).
- **`AUTH_ISSUER`** doit être fourni au conteneur : l'entrypoint le pousse dans
  l'env Convex (`convex env set`) avant `convex deploy` ; sinon le push échoue
  (`auth.config.ts` référence `AUTH_ISSUER`). En prod = l'URL publique
  `https://<host>/api/auth`.
- L'image embarque `app/lib` (lib partagée importée par les fonctions Convex) en
  plus de `.output` + `convex/`, requis par le `convex deploy` au runtime.

### Repli R6 (2 services)

Si l'image unique est fragile sur le NAS (cf. [ADR 0001](docs/adr/0001-r6-single-image-vs-compose.md)),
bascule **après arbitrage board** :

```bash
docker compose -f docker-compose.fallback.yml up --build -d
```

## Sécurité

Pas de secrets dans le repo. `.env.local` est gitignored. Le secret client
Twitch n'a rien à faire ici (c'est LivePlace, pas Bordmap).
