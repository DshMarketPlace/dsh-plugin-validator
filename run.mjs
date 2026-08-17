/**
 * Runs a batch of install commands through the sandbox, one container each.
 *
 *   node run.mjs specs.jsonl results.jsonl [concurrency]
 *
 * Deliberately takes a file in and writes a file out, with no database
 * credentials anywhere near it. The machine that executes untrusted install
 * scripts should not also hold write access to the catalogue.
 *
 * Resumable: results are appended as they finish and already-done specs are
 * skipped, so a run that dies at hour two costs hour two, not hours one and
 * two.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [specPath, outPath, concurrencyArg] = process.argv.slice(2);
const CONCURRENCY = Number(concurrencyArg) || 3;
const IMAGE = process.env.VALIDATOR_IMAGE ?? "dsh-validator:latest";

if (!specPath || !outPath) {
  console.error("usage: node run.mjs specs.jsonl results.jsonl [concurrency]");
  process.exit(2);
}

const specs = readFileSync(specPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const done = new Set(
  existsSync(outPath)
    ? readFileSync(outPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).fullName)
    : [],
);

const pending = specs.filter((s) => !done.has(s.fullName));
console.log(`${specs.length} specs, ${done.size} already done, ${pending.length} to run`);

/**
 * One container per plugin, torn down after. Everything a plugin's install
 * step can reach is inside it: no host mount, no capabilities, no privilege
 * escalation, a memory and process ceiling, and a hard wall-clock limit that
 * outlives the probe's own timeout so a wedged container cannot hold a slot.
 */
function validate(spec) {
  return new Promise((resolve) => {
    // Deliberately modest. This runs on a host with other people's services on
    // it, and a validation batch that starves them is a worse outcome than a
    // validation batch that takes all night.
    const args = [
      "run", "--rm", "--network", "bridge",
      "--memory", process.env.VALIDATOR_MEMORY ?? "1500m",
      "--memory-swap", process.env.VALIDATOR_MEMORY ?? "1500m",
      "--cpus", process.env.VALIDATOR_CPUS ?? "1.0",
      "--pids-limit", "512",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--stop-timeout", "10",
      IMAGE, spec.install,
    ];

    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));

    const wall = setTimeout(() => child.kill("SIGKILL"), 300_000);

    child.on("close", () => {
      clearTimeout(wall);
      let verdict;
      try {
        verdict = JSON.parse(out.trim().split("\n").pop());
      } catch {
        verdict = { status: "error", detail: "probe produced no verdict" };
      }
      resolve({ fullName: spec.fullName, install: spec.install, ...verdict });
    });
  });
}

let cursor = 0;
let finished = 0;

async function worker() {
  while (cursor < pending.length) {
    const spec = pending[cursor++];
    const result = await validate(spec);
    appendFileSync(outPath, JSON.stringify(result) + "\n");
    finished++;
    if (finished % 10 === 0 || finished === pending.length) {
      console.log(`  ${finished}/${pending.length}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const tally = {};
for (const line of readFileSync(outPath, "utf8").split("\n").filter(Boolean)) {
  const s = JSON.parse(line).status;
  tally[s] = (tally[s] ?? 0) + 1;
}
console.log("\n" + JSON.stringify(tally, null, 2));
