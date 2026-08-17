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

function verdict(status, detail, extra = {}) {
  process.stdout.write(JSON.stringify({ status, detail, ...extra }) + "\n");
  process.exit(0);
}

const command = process.argv[2]?.trim() ?? "";
const match = COMMAND.exec(command);
if (!match) verdict("rejected", "not a dsh plugin install command");

const target = match[1];
if (target.includes("..")) verdict("rejected", "path traversal in target");
if (!NPM.test(target) && !GITHUB.test(target)) {
  verdict("rejected", "target is neither an npm name nor a github spec");
}

const home = await mkdtemp(join(tmpdir(), "dsh-"));
const profile = join(home, "profiles", "web");

const install = await run(
  "dsh",
  ["plugin", "--profile", "web", "add", target],
  { env: { ...process.env, DSH_HOME: home } },
);

if (install.killed) {
  verdict("timeout", `install exceeded ${TIMEOUT_MS / 1000}s`);
}

// `dsh plugin add` exits 0 even when nothing installed — it did so on a machine
// with no pnpm, printing the reason and returning success. The exit code is
// therefore not evidence, and the only thing that is, is the profile manifest
// the harness writes for itself.
let manifest = null;
try {
  manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
} catch {
  verdict("failed", "no profile manifest was written", { log: tail(install.out) });
}

const bundles = manifest?.dsh?.profile?.bundles ?? [];
const deps = Object.keys(manifest?.dependencies ?? {});

// Observed, not guessed: pnpm names the packages whose build scripts it
// refused to run. The catalogue infers this from README keywords today, which
// is a guess about the same fact.
const blocked = [...install.out.matchAll(/Ignored build scripts:\s*([^\n]+)/g)]
  .flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/\.$/, "")))
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
  });
}

// The package resolved and pnpm wrote it into the profile, but the harness did
// not register it. When a build script was refused, that is the whole reason
// and it is recoverable: pnpm 11 exits non-zero on `ERR_PNPM_IGNORED_BUILDS`,
// `dsh` reads that as a failed install and stops before writing the bundle
// row. On pnpm 10 the same install is a warning and succeeds — which is why
// this cannot be reported as "broken". It is one `allowBuilds` entry away.
const landed = name ? deps.includes(name) : deps.length > 0;

if (landed && blocked.length) {
  verdict("needs-approval", "installs, but a blocked build script stops registration", {
    bundles,
    dependencies: deps,
    blockedBuildScripts: blocked,
    log: tail(install.out),
  });
}

verdict("failed", "installed but not registered as a profile bundle", {
  bundles,
  dependencies: deps,
  blockedBuildScripts: blocked,
  log: tail(install.out),
});

function tail(text, lines = 24) {
  return text.split("\n").slice(-lines).join("\n").slice(-4000);
}
