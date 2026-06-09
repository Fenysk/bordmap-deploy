/**
 * Minimal OpenID Connect discovery document for Convex JWT auth validation.
 *
 * Convex's `domain`-based auth provider fetches OIDC metadata at
 * `{domain}/.well-known/openid-configuration` before fetching the JWKS.
 * Better Auth does not expose this endpoint by default, so Convex returns
 * "Auth provider discovery failed: 404" and rejects every authed mutation.
 *
 * This handler serves the minimum fields Convex needs to proceed to JWKS
 * fetch and validate the EdDSA JWT: `issuer` (must match the JWT `iss` claim)
 * and `jwks_uri` (where Convex fetches the public keys) (FEN-451).
 */
type H3EventLike = { req?: unknown; request?: unknown }

function toWebRequest(input: unknown): Request | undefined {
  if (input instanceof Request) return input
  const candidate =
    (input as H3EventLike)?.req ?? (input as H3EventLike)?.request
  return candidate instanceof Request ? candidate : undefined
}

export default async function oidcDiscoveryHandler(
  input: unknown,
): Promise<Response> {
  const request = toWebRequest(input)
  if (!request) return new Response('Bad Request', { status: 400 })

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const issuer =
    process.env.AUTH_ISSUER ??
    `${process.env.SITE_URL ?? 'http://localhost:3000'}/api/auth`

  const doc = {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: ['EdDSA'],
  }

  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
