/**
 * Better Auth React client.
 *
 * Exposes React-hook-compatible methods:
 *   authClient.useSession()             — React hook for session state
 *   authClient.signIn.email(...)        — sign in with email/password
 *   authClient.signUp.email(...)        — register
 *   authClient.signOut()               — sign out
 *
 * The `jwtClient` plugin adds `authClient.jwks()` — used by the Convex
 * provider to fetch the JWT for auth-gated mutations.
 */
import { createAuthClient } from 'better-auth/react'
import { jwtClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  baseURL:
    typeof window !== 'undefined'
      ? window.location.origin
      : 'http://localhost:3000',
  plugins: [jwtClient()],
})

export type Session = typeof authClient.$Infer.Session
