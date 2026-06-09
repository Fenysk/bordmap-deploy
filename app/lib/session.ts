/**
 * Server-side session helper for TanStack Start route guards.
 *
 * `getSession()` is a server function that reads the Better Auth session
 * from the incoming request cookies. Use it in `beforeLoad` to protect routes:
 *
 *   beforeLoad: async ({ location }) => {
 *     const session = await getSession()
 *     if (!session) throw redirect({ to: '/login' })
 *   }
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { auth } from './auth.server'

export const getSession = createServerFn().handler(async () => {
  const request = getRequest()
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return null
  return {
    userId: session.user.id,
    email: session.user.email,
    displayName:
      (session.user as Record<string, unknown>).displayName as string ??
      session.user.name ??
      '',
  }
})

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSession>>>
