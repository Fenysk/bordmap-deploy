import { defineConfig } from 'vitest/config'
import viteReact from '@vitejs/plugin-react'

/**
 * Dedicated Vitest config — intentionally does NOT load the TanStack Start /
 * Nitro plugins (those boot a dev server and hang on close). L0 tests are pure
 * logic (`app/lib/shared`); component/integration tests added later can opt
 * into jsdom via the `environment` comment in their file.
 */
export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: {
      '#': new URL('./app', import.meta.url).pathname,
      '@': new URL('./app', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['app/**/*.{test,spec}.{ts,tsx}'],
  },
})
