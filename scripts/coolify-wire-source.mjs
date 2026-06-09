#!/usr/bin/env node
/**
 * scripts/coolify-wire-source.mjs — turn GITHUB_TOKEN into a git source Coolify
 * can clone (FEN-437, dispatch step 1).
 *
 * Coolify builds Bordmap by CLONING a repo and running the dockercompose build
 * pack, so we need a git host it can reach. This repo has NO remote, so this
 * script provisions one end to end, no human step:
 *
 *   1. resolve the token owner            (GET /user)
 *   2. create the deploy repo if missing  (POST /user/repos, public)  — idempotent
 *   3. build the secret-free bundle        (scripts/make-deploy-bundle.mjs)
 *   4. extract -> fresh git init -> commit (no history, no .env, no secrets)
 *   5. deploy-guard the target, then force-push to the DEDICATED deploy repo main
 *   6. write COOLIFY_GIT_REPOSITORY into infra/coolify/deploy.env
 *
 * Then `node scripts/coolify-deploy.mjs` finishes the job (needs Coolify egress).
 *
 * The token is NEVER printed and NEVER stored in the remote URL or argv: git gets
 * it through a one-shot GIT_ASKPASS helper reading it from the env.
 *
 * ZERO npm deps: Node >= 22 global fetch + git + tar.
 *
 * Env:
 *   GITHUB_TOKEN        (or GH_TOKEN)  — required, PAT with repo/contents:write
 *   GITHUB_REPO         repo name, default "bordmap-deploy"
 *   GITHUB_OWNER        override owner, default = the token's own login
 *   GITHUB_REPO_PRIVATE "1" => private repo (then Coolify needs a deploy key;
 *                       public is the documented simplest path)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertSafeDeployPush } from "./lib/deploy-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const BUNDLE = join(REPO_ROOT, "dist", "bordmap-deploy.tar.gz");
const DEPLOY_ENV = join(REPO_ROOT, "infra", "coolify", "deploy.env");

const log = (m) => console.log(m);
const die = (m) => {
  console.error(`❌ coolify-wire-source: ${m}`);
  process.exit(1);
};

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
if (!TOKEN) {
  die("no GITHUB_TOKEN (or GH_TOKEN) in the environment. Provision a GitHub PAT (repo / contents:write) and re-run.");
}
const REPO = process.env.GITHUB_REPO || "bordmap-deploy";
const PRIVATE = process.env.GITHUB_REPO_PRIVATE === "1";

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bordmap-coolify-wire",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  log("Bordmap → wire Coolify git source");

  // 1. Whoami (validates the token + read scope).
  const me = await gh("GET", "/user");
  if (!me.ok) die(`token rejected by GitHub (GET /user → ${me.status}). Check the PAT scopes.`);
  const owner = process.env.GITHUB_OWNER || me.json.login;
  log(`· authenticated as ${me.json.login}; target ${owner}/${REPO} (${PRIVATE ? "private" : "public"})`);

  // 2. Create the repo if it does not exist (idempotent).
  const existing = await gh("GET", `/repos/${owner}/${REPO}`);
  if (existing.ok) {
    log(`· repo ${owner}/${REPO} already exists — reusing`);
  } else if (existing.status === 404) {
    const path = owner === me.json.login ? "/user/repos" : `/orgs/${owner}/repos`;
    const created = await gh("POST", path, {
      name: REPO,
      private: PRIVATE,
      auto_init: false,
      description: "Bordmap deploy source (built by Coolify dockercompose build pack) — FEN-437",
    });
    if (!created.ok) die(`could not create ${owner}/${REPO} (POST ${path} → ${created.status}): ${JSON.stringify(created.json).slice(0, 300)}`);
    log(`· created ${owner}/${REPO}`);
  } else {
    die(`unexpected GitHub response checking ${owner}/${REPO}: ${existing.status}`);
  }
  const httpsUrl = `https://github.com/${owner}/${REPO}.git`;

  // 3. Build the secret-free bundle (git archive HEAD — no .env, no history).
  log("· building deploy bundle …");
  const bundleRun = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "make-deploy-bundle.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (bundleRun.status !== 0) die("make-deploy-bundle.mjs failed");
  if (!existsSync(BUNDLE)) die(`expected bundle missing: ${BUNDLE}`);

  // 4. Extract → fresh git repo (single commit, no history leakage).
  const work = mkdtempSync(join(tmpdir(), "bm-wire-"));
  const git = (args, opts = {}) => {
    const r = spawnSync("git", args, { cwd: work, encoding: "utf8", ...opts });
    if (r.status !== 0) die(`git ${args.join(" ")} → ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    return r.stdout;
  };
  execFileSync("tar", ["-xzf", BUNDLE, "-C", work]);
  // Coolify (dockercompose build pack) does NOT run GitHub Actions, so the CI
  // workflow is dead weight in the deploy snapshot — and pushing it needs the PAT
  // `workflow` scope (which the contents-scoped token lacks: "refusing to allow a
  // Personal Access Token to create or update workflow … without workflow scope").
  // Drop .github entirely so a contents:write PAT can push the bundle.
  execFileSync("rm", ["-rf", join(work, ".github")]);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "noreply@paperclip.ing"]);
  git(["config", "user.name", "Paperclip Deploy"]);
  git(["add", "-A"]);
  git(["commit", "-m", "Bordmap deploy source (FEN-437)"]);

  // 5. Push — token via GIT_ASKPASS so it never lands in argv or the remote URL.
  const askpass = join(work, ".askpass.sh");
  writeFileSync(askpass, '#!/bin/sh\nprintf "%s" "$GH_ASKPASS_TOKEN"\n');
  chmodSync(askpass, 0o700);
  const authUrl = `https://x-access-token@github.com/${owner}/${REPO}.git`;
  // Guard: a parentless deploy snapshot may ONLY land on the dedicated deploy repo.
  assertSafeDeployPush({ remoteUrl: httpsUrl, expectedRepo: REPO });
  git(["remote", "add", "origin", authUrl]);
  log(`· pushing bundle to ${httpsUrl} (main, force) …`);
  git(["push", "--force", "origin", "HEAD:main"], {
    env: { ...process.env, GIT_ASKPASS: askpass, GH_ASKPASS_TOKEN: TOKEN, GIT_TERMINAL_PROMPT: "0" },
  });

  // 6. Persist COOLIFY_GIT_REPOSITORY for the deploy step.
  upsertDeployEnv("COOLIFY_GIT_REPOSITORY", httpsUrl);
  log(`\n✅ source wired: ${httpsUrl}`);
  log(`   COOLIFY_GIT_REPOSITORY written to ${DEPLOY_ENV.replace(REPO_ROOT + "/", "")}`);
  log("   next: node scripts/coolify-deploy.mjs   → guardrail → push env → deploy → smoke");
}

/** Set KEY=value in deploy.env (create the file if absent), replacing any prior line. */
function upsertDeployEnv(key, value) {
  let lines = [];
  if (existsSync(DEPLOY_ENV)) lines = readFileSync(DEPLOY_ENV, "utf8").split("\n");
  const out = lines.filter((l) => !new RegExp(`^\\s*${key}\\s*=`).test(l));
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  out.push(`${key}=${value}`, "");
  writeFileSync(DEPLOY_ENV, out.join("\n"));
}

main().catch((err) => die(err.message ?? String(err)));
