#!/usr/bin/env node
/**
 * scripts/make-deploy-bundle.mjs — produce the self-contained source artifact
 * Coolify builds Bordmap from (FEN-437).
 *
 * Coolify deploys by CLONING a git repo and running the dockercompose build
 * pack, so the "bundle" is exactly the set of git-tracked files. `git archive`
 * honours .gitignore (no node_modules, no .env / .env.local, no secrets, no .git
 * history). The dedicated deploy repo is seeded from this (prefer
 * coolify-wire-source.mjs, which guards the target).
 *
 * ZERO npm deps: Node >= 22 + git.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const OUT_DIR = join(REPO_ROOT, "dist");
const OUT = join(OUT_DIR, "bordmap-deploy.tar.gz");

const git = (...a) => execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" });
const fail = (m) => {
  console.error(`❌ make-deploy-bundle: ${m}`);
  process.exit(1);
};

// Files Coolify MUST see to build the Bordmap compose stack.
const REQUIRED = [
  "docker-compose.coolify.yml",
  "Dockerfile.app",
  ".dockerignore",
  "infra/coolify/Caddyfile",
  "infra/coolify/Dockerfile.proxy",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
// A real secret must NEVER enter the bundle. (.env.example / *.example are fine.)
const SECRET_RE = /(^|\/)\.env$|(^|\/)\.env\.[^.]*$|(^|\/)deploy\.env$|\.pem$|id_rsa/;

const tracked = git("ls-files").split("\n").filter(Boolean);
console.log(`· ${tracked.length} git-tracked files in scope`);

const leaked = tracked.filter((f) => SECRET_RE.test(f) && !/\.example$/.test(f));
if (leaked.length) fail(`secret-looking files are tracked and would ship: ${leaked.join(", ")}`);
console.log("· no secret files in the tracked set ✓");

const trackedSet = new Set(tracked);
const missing = REQUIRED.filter((f) => !trackedSet.has(f));
if (missing.length) fail(`required build files not tracked (commit them first): ${missing.join(", ")}`);
console.log(`· all ${REQUIRED.length} required build files present ✓`);

mkdirSync(OUT_DIR, { recursive: true });
git("archive", "--format=tar.gz", "-o", OUT, "HEAD");
const bytes = statSync(OUT).size;
const head = git("rev-parse", "--short", "HEAD").trim();

console.log(`\n✅ bundle: ${OUT.replace(REPO_ROOT + "/", "")}  (${(bytes / 1024).toFixed(0)} KiB, HEAD ${head})`);
console.log("   This is exactly what Coolify clones + builds (build pack = dockercompose).");
console.log("   compose location for Coolify: /docker-compose.coolify.yml");
