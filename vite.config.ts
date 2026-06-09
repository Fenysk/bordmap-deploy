import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

// Server-only auth deps kept external in every SSR/server build.
//
//   - `kysely` — rolldown (vite 8 beta) fails to resolve its re-exported
//     migration symbols (DEFAULT_MIGRATION_TABLE, …) statically when bundling
//     the SSR/server environment, breaking `vite build` (FEN-437). Worse, the
//     installed `kysely@0.29.2` does NOT even expose those constants as runtime
//     named exports — `@better-auth/kysely-adapter`'s *secondary* dialect files
//     (node-sqlite / bun-sqlite / d1) import them and only work because they are
//     lazily `import()`-ed and never instantiated under our better-sqlite3
//     driver. Bundling the adapter inlines those lazy files and hoists their
//     broken `import { DEFAULT_MIGRATION_TABLE } from 'kysely'` to the chunk top,
//     which throws at module-load (FEN-473). So keep kysely + the whole
//     `@better-auth/*` wrapper set EXTERNAL — loaded from node_modules at
//     runtime with their lazy dialects intact.
//   - `better-sqlite3` — native addon, can't be bundled.
//   - `@better-auth/*` — the better-auth scoped wrappers (see above + the
//     `betterAuthKyselyInterop` plugin below, which fixes the one interop snag
//     externalization otherwise causes).
//
// CONTRACT (FEN-471): because these are external, the bundled SSR code does a
// runtime `require()` of them from /app/node_modules. They MUST therefore be
// resolvable at the ROOT of node_modules and survive `pnpm prune --prod`. So
// every bare specifier here is declared a DIRECT dependency in package.json
// (@better-auth/core, @better-auth/kysely-adapter, @better-auth/telemetry,
// @better-auth/utils, kysely, better-sqlite3). If you add a new server-only
// external, add it as a direct dep too — otherwise auth routes 500 with
// "Cannot find package …".
const SERVER_ONLY_EXTERNAL = ['better-sqlite3', 'kysely', /^@better-auth\//]

// React MUST be external in the Nitro server bundle. When Rollup bundles
// react/react-dom into separate _libs chunks, each chunk gets its own copy of
// ReactCurrentDispatcher. better-auth/react (even when bundled) may end up in a
// different chunk than the SSR renderer, giving it a null dispatcher and causing
// "Cannot read properties of null (reading 'useRef')" on every page render
// (FEN-463). External = all code calls require('react') at runtime → Node.js
// module-cache hands back ONE shared instance → hooks work from every module.
const REACT_EXTERNAL = ['react', 'react-dom', /^react\//, /^react-dom\//]

// FEN-473 — better-auth's runtime adapter path is init() → getBaseAdapter() →
// `await import('../adapters/kysely-adapter/index.mjs')`, and that internal file
// is literally `export * from "@better-auth/kysely-adapter"`. Because we keep
// `@better-auth/kysely-adapter` EXTERNAL (above), Rollup cannot enumerate the
// external module's named exports, so it SILENTLY DROPS the `export *`
// re-export. `createKyselyAdapter` then resolves to `undefined` →
// `TypeError: createKyselyAdapter is not a function`, 500 on every auth call.
//
// Fix: intercept that one better-auth internal re-export module and replace the
// wildcard `export *` with an EXPLICIT named re-export. Rollup forwards named
// re-exports from an external just fine (the bug is specific to `export *`).
// The real adapter package + its lazy dialect files stay external and load from
// node_modules at runtime, exactly as before. Matched on the resolved absolute
// id so it fires regardless of pnpm's nesting; run in both the Vite graph and
// the Nitro server rollup (where the failing _libs chunk is emitted).
const betterAuthKyselyInterop = {
  name: 'better-auth-kysely-adapter-interop',
  enforce: 'pre' as const,
  load(id: string) {
    if (
      /better-auth[\\/]dist[\\/]adapters[\\/]kysely-adapter[\\/]index\.(mjs|js|cjs)$/.test(
        id,
      )
    ) {
      return `export { createKyselyAdapter, getKyselyDatabaseType, kyselyAdapter } from '@better-auth/kysely-adapter'\n`
    }
    return null
  },
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Externalise the server-only auth deps and React in every SSR/server build.
  // React is external to prevent duplicate ReactCurrentDispatcher (FEN-463).
  ssr: {
    external: [
      'better-sqlite3',
      'kysely',
      '@better-auth/kysely-adapter',
      'react',
      'react-dom',
    ],
  },
  plugins: [
    betterAuthKyselyInterop,
    devtools(),
    nitro({
      rollupConfig: {
        // Exclude native, SSR-only, and React modules from the Nitro bundle.
        external: [/^@sentry\//, ...SERVER_ONLY_EXTERNAL, ...REACT_EXTERNAL],
        // Fix the externalized-`export *` interop in the Nitro server bundle
        // too — this is where the /api/auth handler chunk is emitted (FEN-473).
        plugins: [betterAuthKyselyInterop],
      },
      // L1 — Better Auth catch-all handler. All /api/auth/* requests are
      // handled server-side by Better Auth before TanStack Router sees them.
      handlers: [
        // OIDC discovery for Convex JWT validation: Convex's `domain` auth
        // provider fetches /.well-known/openid-configuration before the JWKS.
        // Better Auth doesn't expose this endpoint by default → 404 →
        // "AuthProviderDiscoveryFailed" on every authed mutation. Register this
        // specific route BEFORE the catch-all so Nitro dispatches it first (FEN-451).
        {
          route: '/api/auth/.well-known/openid-configuration',
          handler: fileURLToPath(
            new URL(
              './app/server/oidc-discovery-handler.ts',
              import.meta.url,
            ),
          ),
          format: 'web',
          lazy: true,
        },
        {
          route: '/api/auth/**',
          // Absolute path — the project defines no `~` alias (tsconfig paths are
          // `#/*` and `@/*` → ./app/*), so the old `~/app/server/...` resolved
          // literally and broke `vite build` in #nitro/virtual/routing (FEN-437).
          handler: fileURLToPath(
            new URL('./app/server/auth-handler.ts', import.meta.url),
          ),
          format: 'web',
          lazy: true,
        },
      ],
    }),
    tailwindcss(),
    // Project lives under `app/` (plan §3), not the default `src/`.
    tanstackStart({ srcDirectory: 'app' }),
    viteReact(),
  ],
})

export default config
