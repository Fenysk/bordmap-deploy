/**
 * L1 — Convex user management (plan §3 of FEN-341, Auth brique).
 *
 * Users are created/synced here via auth-gated mutations. The `authId` is the
 * JWT `sub` claim (Better Auth user UUID). `tokenIdentifier` = `iss|sub` and
 * is stored in `routes.createdBy` for the `by_creator` index.
 */
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'

/**
 * Sync the authenticated user into the `users` table (upsert by authId).
 * Called client-side right after sign-in/sign-up once Convex auth is live.
 */
export const sync = mutation({
  args: {
    email: v.string(),
    displayName: v.string(),
    /** RGPD consent timestamp (ms); pass Date.now() on first registration. */
    rgpdConsentAt: v.optional(v.number()),
  },
  handler: async (ctx, { email, displayName, rgpdConsentAt }) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('Authentification requise')

    const existing = await ctx.db
      .query('users')
      .withIndex('by_auth_id', (q) => q.eq('authId', identity.subject))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, { email, displayName })
      return existing._id
    }

    return ctx.db.insert('users', {
      authId: identity.subject,
      email,
      displayName: displayName || email.split('@')[0],
      createdAt: Date.now(),
      rgpdConsentAt,
    })
  },
})

/**
 * RGPD — Delete all data owned by the authenticated user: their routes then
 * their user record. Called before the Better Auth account deletion.
 */
export const deleteMyData = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('Authentification requise')

    const userRoutes = await ctx.db
      .query('routes')
      .withIndex('by_creator', (q) => q.eq('createdBy', identity.tokenIdentifier))
      .collect()

    for (const route of userRoutes) {
      await ctx.db.delete(route._id)
    }

    const user = await ctx.db
      .query('users')
      .withIndex('by_auth_id', (q) => q.eq('authId', identity.subject))
      .first()

    if (user) {
      await ctx.db.delete(user._id)
    }
  },
})

/**
 * Get the Convex user record for the currently authenticated user. Public
 * query (returns null when unauthenticated rather than throwing).
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return null

    return ctx.db
      .query('users')
      .withIndex('by_auth_id', (q) => q.eq('authId', identity.subject))
      .first()
  },
})
