/**
 * scripts/lib/deploy-guard.mjs — refuse to push the deploy snapshot anywhere but
 * the dedicated Bordmap deploy repo (FEN-437).
 *
 * The deploy bundle is a PARENTLESS, secret-free snapshot (no history). It must
 * land ONLY on the dedicated public deploy repo Coolify clones — never on a repo
 * that looks like LivePlace or anything else. This guard fails LOUD before git
 * runs if the resolved target looks wrong.
 */
const FORBIDDEN_RE = /liveplace/i;

/**
 * @param {object} o
 * @param {string} o.remoteUrl     the https remote we are about to push to
 * @param {string} o.expectedRepo  the dedicated deploy repo name (e.g. "bordmap-deploy")
 */
export function assertSafeDeployPush({ remoteUrl, expectedRepo }) {
  const url = String(remoteUrl || "");
  if (!url) throw new Error("deploy-guard: empty remote URL");
  if (FORBIDDEN_RE.test(url)) {
    throw new Error(`deploy-guard: refusing to push the Bordmap deploy snapshot to a forbidden remote (${url}).`);
  }
  // The repo path component must be exactly the dedicated deploy repo.
  const m = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i.exec(url);
  if (!m) throw new Error(`deploy-guard: cannot parse owner/repo from ${url}`);
  const repo = m[2];
  if (expectedRepo && repo !== expectedRepo) {
    throw new Error(
      `deploy-guard: target repo "${repo}" != dedicated deploy repo "${expectedRepo}". ` +
        `Refusing to force-push a parentless snapshot onto a different repo.`,
    );
  }
  return { owner: m[1], repo };
}
