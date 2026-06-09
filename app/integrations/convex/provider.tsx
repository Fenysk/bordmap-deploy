/**
 * Convex React provider with Better Auth JWT bridge.
 *
 * Better Auth issues short-lived EdDSA JWTs (1 h) via GET /api/auth/token
 * (requires valid session cookie). Convex validates them using the JWKS it
 * fetched from /api/auth/.well-known/jwks.json, configured in auth.config.ts.
 *
 * `ConvexProviderWithAuth` drives Convex re-auth whenever the session changes.
 */
import {
  ConvexProviderWithAuth,
  ConvexReactClient,
  useConvexAuth,
} from 'convex/react'
import { authClient } from '#/lib/auth-client'

const CONVEX_URL = (import.meta as any).env.VITE_CONVEX_URL as string
if (!CONVEX_URL) {
  console.error('[Convex] missing env VITE_CONVEX_URL')
}

const convexClient = new ConvexReactClient(CONVEX_URL)

function useAuth() {
  const { data: session, isPending } = authClient.useSession()

  return {
    isLoading: isPending,
    isAuthenticated: !!session?.user,
    fetchAccessToken: async (_opts: {
      forceRefreshToken: boolean
    }): Promise<string | null> => {
      if (!session?.user) return null
      try {
        const res = await fetch('/api/auth/token', { credentials: 'include' })
        if (!res.ok) return null
        const data = (await res.json()) as { token?: string }
        return data.token ?? null
      } catch {
        return null
      }
    },
  }
}

export default function AppConvexProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ConvexProviderWithAuth client={convexClient} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuth>
  )
}

export { useConvexAuth }
