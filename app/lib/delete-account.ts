/**
 * Server function: delete the current user's Better Auth records from SQLite.
 * Call this AFTER deleting Convex data (the Convex JWT must still be valid
 * when the Convex mutation runs; the auth deletion comes last).
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { auth, deleteAuthUser } from './auth.server'

export const deleteAuthAccount = createServerFn().handler(async () => {
  const request = getRequest()
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return
  deleteAuthUser(session.user.id)
})
