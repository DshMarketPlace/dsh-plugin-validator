/**
 * Installs a whole preset into ONE profile and reports whether every plugin in
 * it survived the company of the others.
 *
 *   node preset.mjs "coding" pkg-a pkg-b pkg-c
 *
 * Why this is not just probe.mjs in a loop. `probe.mjs` answers "does this
 * plugin install into a clean profile", which is the right question for a
 * catalogue listing and the wrong one for a preset. A preset is a claim about
 * a *combination*, and combinations fail in ways the parts do not:
 *
 *   - two plugins that want incompatible versions of the same peer
 *   - a build script blocked only when another plugin drags in the dependency
 *     that owns it
 *   - a plugin that installs but is silently not registered once another one
 *     has claimed the same loader id — cordis rejects duplicate entry ids
 *   - install order mattering at all, which it should not, and which is worth
 *     knowing before a stranger finds out
 *
 * Publishing a preset is putting our name on other people's work, so the bar
 * is every plugin registered, together, in one profile, with the exact command
 * the preset publishes.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = Number(process.env.PRESET_TIMEOUT_MS ?? 600_000);
const PROFILE = process.env.PRESET_PROFILE ?? "web";

const [presetName, ...targets] = process.argv.slice(2);

if (!presetName || !targets.length) {
  console.error('usage: node preset.mjs "<preset-name>" <target> [target...]');
  process.exit(2);
}

// The same guard the probe and the in-DSH plugin use. These strings arrive
// from a catalogue; everything past the shape check is a fixed argv.
const NPM = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~><=|\-+*]+)?$/i;
const GITHUB = /^github:[\w.-]+\/[\w.-]+(?:#[\w./-]+)?$/;

for (const t of targets) {
  if (t.includes("..") || (!NPM.test(t) && !GITHUB.test(t))) {
    report("rejected", `not an installable target: ${t}`);
  }
}

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 16 << 20, ...opts }, (error, stdout, stderr) => {
      resolve({ killed: Boolean(error?.killed), out: `${stdout}${stderr}` });
    });
  });
}

function report(status, detail, extra = {}) {
  process.stdout.write(
    JSON.stringify({ preset: presetName, targets, status, detail, ...extra }) + "\n",
  );
  process.exit(0);
}

function tail(text, lines = 40) {
  return text.split("\n").slice(-lines).join("\n").slice(-6000);
}

/** The bare package name, as the bundle list records it — no version range. */
function bareName(target) {
  if (target.startsWith("github:")) return null;
  return target.replace(/^(@[^/]+\/[^@]+|[^@][^@]*)@.+$/, "$1");
}

const home = await mkdtemp(join(tmpdir(), "dsh-preset-"));
const profile = join(home, "profiles", PROFILE);

// One command, exactly as the preset would publish it. Installing them one at
// a time would resolve each against a different tree and hide precisely the
// conflicts this script exists to find.
const install = await run("dsh", ["plugin", "--profile", PROFILE, "add", ...targets], {
  env: { ...process.env, DSH_HOME: home },
});

if (install.killed) {
  report("timeout", `preset install exceeded ${TIMEOUT_MS / 1000}s`, { log: tail(install.out) });
}

// A throttled registry measures our traffic, not the preset. Checked first,
// because every test below would agree the install failed.
if (/ERR_PNPM_FETCH_(429|5\d\d)\b/.test(install.out)) {
  report("error", "a registry throttled or failed this run", { log: tail(install.out) });
}

let manifest = null;
try {
  manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
} catch {
  report("failed", "no profile manifest was written", { log: tail(install.out) });
}

const bundles = manifest?.dsh?.profile?.bundles ?? [];
const deps = Object.keys(manifest?.dependencies ?? {});

const blocked = [
  ...new Set(
    [...install.out.matchAll(/Ignored build scripts:\s*([^\n]+)/g)]
      .flatMap((m) => m[1].split(","))
      // pnpm boxes this warning when it thinks it has a terminal; the trailing
      // padding and `│` are frame, not part of the package name.
      .map((s) => s.replace(/[\s│|]+$/, "").trim().replace(/\.$/, ""))
      .filter(Boolean),
  ),
];

// Per plugin, because "the preset installed" is not the claim. The claim is
// that every plugin in it is live, and a preset that quietly drops one is
// worse than no preset — the reader believes they have a capability they do
// not have.
const perPlugin = targets.map((target) => {
  const name = bareName(target);
  const registered = name ? bundles.includes(name) : deps.length > 0;
  const landed = name ? deps.includes(name) : deps.length > 0;
  return {
    target,
    registered,
    landed,
    // The harness says this one itself rather than us inferring it.
    notALayer: Boolean(name) && landed && !registered && /declares no dsh\.bundle/.test(install.out),
  };
});

const missing = perPlugin.filter((p) => !p.registered);

if (!missing.length) {
  report("passed", `all ${targets.length} registered together in one profile`, {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    perPlugin,
  });
}

// A blocked build script is recoverable — one `onlyBuiltDependencies` entry —
// and the CLI writes it automatically. It is still not publishable as-is: a
// preset has to state that it needs the approval, or do it.
if (missing.every((p) => p.notALayer)) {
  report("not-a-layer", "every missing plugin declares no dsh.bundle; the install worked", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    perPlugin,
  });
}

if (blocked.length && missing.every((p) => p.landed)) {
  report("needs-approval", "installed, but blocked build scripts stopped registration", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    perPlugin,
  });
}

report("failed", `${missing.length} of ${targets.length} did not register: ${missing.map((p) => p.target).join(", ")}`, {
  bundles,
  dependencies: deps,
  blockedBuildScripts: blocked,
  perPlugin,
  log: tail(install.out),
});
