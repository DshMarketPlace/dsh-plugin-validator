/**
 * Installs one plugin into a fresh profile and reports what actually happened.
 * Runs inside the sandbox container; prints a single JSON object on stdout.
 *
 *   node probe.mjs "dsh plugin --profile web add some-plugin"
 *
 * The command is passed whole, exactly as the catalogue publishes it, because
 * the thing being tested is the command a person would copy — not our
 * reconstruction of it.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pickVersion } from "./compat.mjs";

/**
 * The same guard the in-DSH plugin uses, for the same reason: this process
 * receives a string from a catalogue and runs it. Everything after the shape
 * check is a fixed argv — no shell, so nothing here is a quoting bug away from
 * being an injection.
 */
const COMMAND = /^dsh plugin(?: --profile [\w.-]+)? add (\S+)$/;
const NPM = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~><=|\-+*]+)?$/i;
const GITHUB = /^github:[\w.-]+\/[\w.-]+(?:#[\w./-]+)?$/;

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 180_000);

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 8 << 20, ...opts },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          killed: Boolean(error?.killed),
          out: `${stdout}${stderr}`,
        });
      },
    );
  });
}

// Stamped on every verdict once known. From dsh 0.2 the harness refuses
// plugins built for another version of it, so a verdict that does not say
// which dsh produced it cannot be read — and for two months none of ours did.
let stamp = {};

function verdict(status, detail, extra = {}) {
  process.stdout.write(JSON.stringify({ status, detail, ...stamp, ...extra }) + "\n");
  process.exit(0);
}

const SEMVER = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;
// Declared up here: the verdict branches run at top level, so a constant
// further down is still uninitialised when they call into it.
const CURRENT_DSH = new Set(["workspace:*", "workspace:^", "workspace:~"]);

const command = process.argv[2]?.trim() ?? "";
const match = COMMAND.exec(command);
if (!match) verdict("rejected", "not a dsh plugin install command");

const target = match[1];
if (target.includes("..")) verdict("rejected", "path traversal in target");
if (!NPM.test(target) && !GITHUB.test(target)) {
  verdict("rejected", "target is neither an npm name nor a github spec");
}

const [dshV, pnpmV] = await Promise.all([run("dsh", ["--version"]), run("pnpm", ["--version"])]);
stamp = {
  dshVersion: SEMVER.exec(dshV.out)?.[0] ?? null,
  pnpmVersion: SEMVER.exec(pnpmV.out)?.[0] ?? null,
};

/** One install into a fresh DSH_HOME, with everything pnpm said attached. */
async function attempt(spec) {
  const home = await mkdtemp(join(tmpdir(), "dsh-"));
  const result = await run("dsh", ["plugin", "--profile", "web", "add", spec], {
    env: { ...process.env, DSH_HOME: home },
  });
  // On failure dsh 0.2 keeps pnpm's own output in a diagnostics file and
  // prints only its path. Every pnpm error code tested below lives in there,
  // so without it each of those branches goes blind on exactly the runs that
  // need it.
  const diagnostics = /diagnostics: (\S+?\.log)\b/.exec(result.out)?.[1];
  const extra = diagnostics ? await readFile(diagnostics, "utf8").catch(() => "") : "";
  return { ...result, home, text: `${result.out}\n${extra}` };
}

const install = await attempt(target);
const profile = join(install.home, "profiles", "web");

if (install.killed) {
  verdict("timeout", `install exceeded ${TIMEOUT_MS / 1000}s`);
}

// A host that refused to serve us measured our traffic, not the plugin. This
// has to be checked before anything else: the install genuinely failed, so
// every test below would agree it failed, and 119 working plugins were marked
// broken because npm was throttling a batch that ran alongside an audit making
// a thousand requests of its own. `error` is the runner's word for "no
// verdict", and nothing downstream publishes it.
//
// Not only npm: 28 more were marked broken by a 429 from codeload.github.com,
// because a source install downloads a tarball from GitHub and GitHub rate
// limits that too. Whose 429 it is does not matter — it is always ours.
if (/ERR_PNPM_FETCH_(429|5\d\d)\b/.test(install.text)) {
  verdict("error", "a registry throttled or failed this run", {
    log: tail(install.text),
  });
}

// From dsh 0.2 the harness checks a plugin's dsh range before installing it
// and, when the range does not cover the running version, refuses and rolls
// the profile back. The plugin is not broken; it was built for another dsh,
// and usually an older release of it fits this one. For three weeks this fell
// through to "installed but not registered", the nightly retracted it as our
// own fault, and the next night queued the same plugins again.
const refusal =
  /installation rejected: Plugin (\S+)@(\S+) is incompatible with dsh (\S+?): (.*?)\. Running it/.exec(
    install.text,
  );
if (refusal) {
  const [, pkg, refusedVersion, runtime, said] = refusal;
  let requires = {};
  try {
    requires = JSON.parse(said.slice(said.indexOf("{")));
  } catch {
    requires = { raw: said };
  }
  const fallback = await fitOlderRelease(pkg, runtime);
  const ranges = [...new Set(Object.values(requires))].join(", ");
  verdict(
    "incompatible",
    `dsh ${runtime} refuses ${pkg}@${refusedVersion}, which requires dsh ${ranges}` +
      (fallback?.version
        ? `; ${pkg}@${fallback.version} ${fallback.status === "passed" ? "installs" : `was tried and ${fallback.status}`}`
        : fallback
          ? "; no release of it accepts this dsh"
          : ""),
    { requires, refusedVersion, fallback, log: tail(install.text) },
  );
}

// dsh kills pnpm when it outgrows the container — a large monorepo cloned and
// built from source inside 1.5 GB. That measures our sandbox, not the plugin,
// so like a 429 it is no verdict at all.
if (/Command was killed with SIGKILL/.test(install.text)) {
  verdict("error", "pnpm was killed mid-install — the sandbox's memory or time ceiling", {
    log: tail(install.text),
  });
}

// Named so that each reads as what it is rather than as the catch-all. The
// first is our data (the listing points at a package that no longer exists);
// the other two are defects in the package.
if (/ERR_PNPM_NO_VERSIONS/.test(install.text)) {
  verdict("failed", "the npm package has no published versions — it was unpublished", {
    log: tail(install.text),
  });
}
if (/ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER[\s\S]*?catalog:/.test(install.text)) {
  verdict("failed", "a dependency uses pnpm's catalog: protocol, which only resolves inside the author's workspace", {
    log: tail(install.text),
  });
}
const rejected = /installation rejected: (Cannot validate installed package[^\n]*)/.exec(install.text);
if (rejected) {
  // The throwaway profile's path means nothing on a listing page.
  const why = rejected[1].replace(/\/tmp\/dsh-\w+\/profiles\/web\/node_modules\//g, "").slice(0, 240);
  verdict("failed", `dsh rejected the installed package: ${why}`, {
    log: tail(install.text),
  });
}

// `dsh plugin add` exits 0 even when nothing installed — it did so on a machine
// with no pnpm, printing the reason and returning success. The exit code is
// therefore not evidence, and the only thing that is, is the profile manifest
// the harness writes for itself.
let manifest = null;
try {
  manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
} catch {
  verdict("failed", "no profile manifest was written", { log: tail(install.text) });
}

const bundles = manifest?.dsh?.profile?.bundles ?? [];
const deps = Object.keys(manifest?.dependencies ?? {});

// Observed, not guessed: pnpm names the packages whose build scripts it
// refused to run. The catalogue infers this from README keywords today, which
// is a guess about the same fact.
// pnpm draws this warning inside a box when it thinks it has a terminal, so
// the line ends with padding and a `\u2502`. Captured verbatim, that border
// ends up in `blockedBuilds`, which the public API now serves — so strip the
// frame before the name, not after someone reads it.
const blocked = [...install.text.matchAll(/Ignored build scripts:\s*([^\n]+)/g)]
  .flatMap((m) => m[1].split(","))
  .map((s) => s.replace(/[\s\u2502|]+$/, "").trim().replace(/\.$/, ""))
  .filter(Boolean);

// npm targets can carry a version range; the bundle list records the bare name.
const name = target.startsWith("github:")
  ? null
  : target.replace(/^(@[^/]+\/[^@]+|[^@][^@]*)@.+$/, "$1");

const registered = name
  ? bundles.includes(name)
  : bundles.length > 2 || deps.length > 0;

if (registered) {
  verdict("passed", "installed and registered in the web profile", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    installed: name ? await release(install.home, name) : null,
  });
}

// The package resolved and pnpm wrote it into the profile, but the harness did
// not register it. When a build script was refused, that is the whole reason
// and it is recoverable: pnpm 11 exits non-zero on `ERR_PNPM_IGNORED_BUILDS`,
// `dsh` reads that as a failed install and stops before writing the bundle
// row. On pnpm 10 the same install is a warning and succeeds — which is why
// this cannot be reported as "broken". It is one `allowBuilds` entry away.
const landed = name ? deps.includes(name) : deps.length > 0;

// Installing from a git spec makes pnpm run the package's own prepare script
// to build it, and pnpm refuses until the package is allowlisted. Same shape
// as a blocked build script and the same fix — an `allowBuilds` entry — so it
// belongs in the same bucket. Calling it a failure would mark a working plugin
// broken for doing the one thing a source install has to do.
if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/.test(install.text)) {
  verdict("needs-approval", "source install needs its build approved before it can register", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked.length ? blocked : [target],
    log: tail(install.text),
  });
}

if (landed && blocked.length) {
  verdict("needs-approval", "installs, but a blocked build script stops registration", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    log: tail(install.text),
  });
}

// The harness says this one itself, so there is nothing to infer: a package
// with no `dsh.bundle` in its manifest installs as an ordinary dependency
// instead of a profile layer, and the harness's own warning promises that a
// later version which gains one activates automatically. The install worked.
// Reporting it as a failure marks a working package broken for being a
// different kind of package — themes, agent bundles and libraries all land
// here — so it gets its own verdict rather than the catch-all.
if (landed && /declares no dsh\.bundle/.test(install.text)) {
  verdict("not-a-layer", "installs as a plain dependency; it declares no dsh.bundle", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    log: tail(install.text),
  });
}

// A real defect, and one worth naming rather than leaving in the catch-all: a
// package.json saved with a UTF-8 BOM parses nowhere. pnpm refuses to prepare
// the package, or the harness itself throws out of `readProfileManifest` and
// takes the whole command down. Windows editors add the BOM silently, so the
// author has no way to see it — which is the whole argument for saying so.
if (/Unexpected token '﻿'/.test(install.text)) {
  verdict("failed", "its package.json starts with a UTF-8 BOM, which JSON.parse rejects", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    log: tail(install.text),
  });
}

verdict("failed", "installed but not registered as a profile bundle", {
  bundles,
  dependencies: deps,
  blockedBuildScripts: blocked,
  log: tail(install.text),
});

/**
 * The newest release dsh would accept, installed into a second fresh profile.
 * Only for npm targets — a git source has one version, the one on the branch.
 * Null when there is nothing to try or the registry cannot be read.
 */
async function fitOlderRelease(pkg, runtime) {
  if (target.startsWith("github:")) return null;
  let doc;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    doc = await res.json();
  } catch {
    return null;
  }
  const pick = pickVersion(doc, runtime);
  if (!pick.pin) return { version: null, status: "none" };

  const second = await attempt(`${pkg}@${pick.pin}`);
  if (second.killed) return { version: pick.pin, status: "timeout" };
  let m = null;
  try {
    m = JSON.parse(await readFile(join(second.home, "profiles", "web", "package.json"), "utf8"));
  } catch {
    return { version: pick.pin, status: "failed" };
  }
  if ((m?.dsh?.profile?.bundles ?? []).includes(pkg)) {
    return { version: pick.pin, status: "passed", installed: await release(second.home, pkg) };
  }
  const landedToo = Object.keys(m?.dependencies ?? {}).includes(pkg);
  const blockedToo = /Ignored build scripts:|ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/.test(second.text);
  return { version: pick.pin, status: landedToo && blockedToo ? "needs-approval" : "failed" };
}

/**
 * The dsh range a plugin index should list for a manifest, as the harness's
 * own generator (apps/plugin-market-generator) derives it: `engines.dsh` when
 * declared, else the conjunction of its dsh peer ranges. Null means any dsh;
 * false means it cannot be written down, and the release is left unlisted.
 */
function enginesRange(manifest) {
  const declared = manifest.engines?.dsh;
  const ranges =
    typeof declared === "string"
      ? [declared]
      : Object.entries(manifest.peerDependencies ?? {})
          .filter(([k, r]) => /^@deepseek-ai\/dsh(?:-|$)/.test(k) && typeof r === "string" && !CURRENT_DSH.has(r))
          .map(([, r]) => r);
  const used = [...new Set(ranges.map((r) => r.trim()))].filter((r) => r !== "*");
  if (!used.length) return null;
  if (used.some((r) => r === "" || r.startsWith("workspace:"))) return false;
  if (used.length === 1) return used[0];
  let combos = [""];
  for (const r of used) {
    combos = combos.flatMap((c) => r.split("||").map((alt) => `${c} ${alt.trim()}`.trim()));
    if (combos.length > 64) return false;
  }
  return combos.join(" || ");
}

/**
 * What a plugin index needs to list the release that just installed: its
 * exact version, when npm published it, and the dsh range the harness checks
 * it against. Read off the package pnpm put in the profile, and the registry's
 * own clock. Null when the package cannot be read.
 */
async function release(home, pkg) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(home, "profiles", "web", "node_modules", pkg, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
  let publishedAt = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const at = res.ok ? (await res.json()).time?.[manifest.version] : null;
    publishedAt = at ? Math.floor(Date.parse(at) / 1000) : null;
  } catch {
    // The index skips a release without a publish time; the verdict stands.
  }
  return { name: pkg, version: manifest.version, publishedAt, engines: enginesRange(manifest) };
}

function tail(text, lines = 24) {
  return text.split("\n").slice(-lines).join("\n").slice(-4000);
}
