/**
 * Better Auth server instance — server-only, never imported by client code.
 *
 * Architecture (plan §3):
 *   - Email + password provider (required).
 *   - JWT plugin: issues EdDSA-signed access tokens for Convex auth.
 *   - JWKS at /api/auth/.well-known/jwks.json (matched in convex/auth.config.ts).
 *   - Sessions persisted in SQLite alongside the Convex data volume.
 *   - httpOnly session cookie (plan §3 contract).
 *
 * JWT issuer = AUTH_ISSUER env var (defaults to http://localhost:3000/api/auth).
 * Must match `domain` in convex/auth.config.ts and the `iss` claim of every JWT.
 */
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins/jwt'
import { getMigrations } from 'better-auth/db/migration'
import path from 'node:path'

const DATA_DIR =
  process.env.DATA_DIR ??
  process.env.CONVEX_DATA_DIR ??
  (process.env.NODE_ENV === 'production' ? '/convex/data' : './.data')

const DB_PATH =
  process.env.AUTH_DB_PATH ?? path.join(DATA_DIR, 'auth.db')

// Shared SQLite connection used by betterAuth and the account-deletion helper.
const authDb = Database(DB_PATH)

const SITE_URL =
  process.env.SITE_URL ?? 'http://localhost:3000'

const AUTH_ISSUER =
  process.env.AUTH_ISSUER ?? `${SITE_URL}/api/auth`

const AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ?? 'changeme-set-BETTER_AUTH_SECRET-in-production'

// Single source of truth for the Better Auth config. Reused below by
// ensureAuthSchema() so the migrator derives EXACTLY the schema this instance
// expects (core tables + jwt plugin's `jwks` + user.additionalFields) — no
// drift between the runtime adapter and the migration.
const authOptions = {
  secret: AUTH_SECRET,
  baseURL: SITE_URL,
  basePath: '/api/auth',

  database: authDb,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },

  plugins: [
    jwt({
      jwt: {
        issuer: AUTH_ISSUER,
        audience: 'bordmap',
        expirationTime: '1h',
      },
      jwks: {
        // Path relative to basePath → full URL: /api/auth/.well-known/jwks.json
        jwksPath: '/.well-known/jwks.json',
        keyPairConfig: { alg: 'EdDSA' },
      },
    }),
  ],

  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  user: {
    additionalFields: {
      displayName: {
        type: 'string',
        required: false,
        defaultValue: '',
      },
    },
  },

  trustedOrigins: [SITE_URL],
} satisfies Parameters<typeof betterAuth>[0]

export const auth = betterAuth(authOptions)

export type AuthSession = typeof auth.$Infer.Session

/**
 * FEN-476 (Layer B) — create the Better Auth schema if missing.
 *
 * The kysely/better-sqlite3 adapter does NOT auto-create tables, and there is no
 * external migration step (the container entrypoints deploy Convex but never run
 * `better-auth migrate`). So a fresh `auth.db` boots with zero tables and every
 * table-reading route 500s (`no such table: jwks` / `user` / `session`).
 *
 * Run the migrator in-process at module init via getMigrations(authOptions):
 *   - Idempotent — better-auth diffs the live schema and only creates/alters
 *     what's missing (no-op once the tables exist), safe on every boot.
 *   - Topology-independent — runs in dev, the single-image, and the fallback
 *     compose alike, since all of them simply `node .output/server/index.mjs`.
 *     No entrypoint change and no `@better-auth/cli` in the runtime image.
 *   - Drift-free — uses the same `authOptions` the live adapter does.
 *
 * Best-effort: a failure here leaves auth routes 500ing (the pre-fix state) but
 * must NOT crash module load, or every SSR page that merely reads the session
 * would 500 too. The error is logged loudly for the /diag server.log.
 */
let schemaReady: Promise<void> | undefined
export function ensureAuthSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        const { toBeCreated, toBeAdded, runMigrations } =
          await getMigrations(authOptions)
        if (toBeCreated.length === 0 && toBeAdded.length === 0) return
        const created = toBeCreated.map((t) => t.table).join(', ') || 'none'
        const altered = toBeAdded.map((t) => t.table).join(', ') || 'none'
        // eslint-disable-next-line no-console
        console.log(
          `[auth] applying Better Auth migrations — create: [${created}] alter: [${altered}]`,
        )
        await runMigrations()
        // eslint-disable-next-line no-console
        console.log('[auth] Better Auth schema is up to date')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          '[auth] Better Auth migration failed — auth routes will 500 until resolved:',
          err,
        )
      }
    })()
  }
  return schemaReady
}

// Ensure the schema exists before this module's `auth` is used by ANY importer
// (the /api/auth handler, SSR session reads, the account-deletion helper).
await ensureAuthSchema()

/**
 * RGPD — Hard-delete a user from the Better Auth SQLite database.
 * Must be called after Convex data is deleted (routes + user record).
 * Table names follow Better Auth's default SQLite schema.
 */
export function deleteAuthUser(userId: string): void {
  authDb.prepare('DELETE FROM verification WHERE identifier = ?').run(userId)
  authDb.prepare('DELETE FROM session WHERE "userId" = ?').run(userId)
  authDb.prepare('DELETE FROM account WHERE "userId" = ?').run(userId)
  authDb.prepare('DELETE FROM "user" WHERE id = ?').run(userId)
}
