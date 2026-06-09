/**
 * Convex JWT auth config — L1 Better Auth integration.
 *
 * Better Auth (with the `jwt` plugin) acts as the JWT issuer.
 * Its JWKS endpoint lives at `/api/auth/.well-known/jwks.json`.
 *
 * The `domain` here must match:
 *   (a) the `iss` claim in the JWTs Better Auth issues, and
 *   (b) the URL prefix from which Convex fetches JWKS
 *       (`{domain}/.well-known/jwks.json`).
 *
 * In the single-Docker setup both services share localhost, so the default
 * http://localhost:3000/api/auth works out of the box. Set AUTH_ISSUER in
 * Convex environment (via CONVEX_SELF_HOSTED_ADMIN_KEY + `convex env set`)
 * when the NAS reverse proxy uses a different public origin.
 */
export default {
  providers: [
    {
      domain:
        process.env.AUTH_ISSUER ?? 'http://localhost:3000/api/auth',
      applicationID: 'bordmap',
    },
  ],
}
