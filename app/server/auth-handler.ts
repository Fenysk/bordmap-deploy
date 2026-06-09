/**
 * Nitro server handler for Better Auth — catches all /api/auth/** requests.
 *
 * Registered in vite.config.ts under the `/api/auth/**` route so every auth
 * endpoint (sign-up/email, sign-in/email, token, get-session, jwks, …) is
 * dispatched server-side by Better Auth before TanStack Router sees it.
 */
import { auth } from '#/lib/auth.server'

// Nitro 3's handler is invoked with an `H3Event`, NOT a web `Request` (even with
// `format: 'web'` configured). The spec-compliant web Request — with a working
// `.clone()` and the POST body intact — lives at `event.req`. The previous code
// forwarded the H3Event straight to Better Auth, which calls `request.clone()`
// internally on any body-reading POST → `TypeError: request.clone is not a
// function`, 500 on sign-up/sign-in/token (GET get-session never clones, so it
// slipped through). Unwrap to the real Request before handing off (FEN-476).
type H3EventLike = { req?: unknown; request?: unknown }

function toWebRequest(input: unknown): Request | undefined {
  if (input instanceof Request) return input
  const candidate =
    (input as H3EventLike)?.req ?? (input as H3EventLike)?.request
  return candidate instanceof Request ? candidate : undefined
}

export default async function authHandler(input: unknown): Promise<Response> {
  const request = toWebRequest(input)
  if (!request) {
    console.error(
      '[auth] handler received an unexpected request shape (no web Request at event.req)',
    )
    return new Response('Internal auth handler error', { status: 500 })
  }
  return auth.handler(request)
}
