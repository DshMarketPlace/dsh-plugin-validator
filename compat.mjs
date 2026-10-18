/**
 * Which version of a plugin the local DeepSeek Harness will accept.
 *
 * From 0.2 the harness refuses, before installing anything, a plugin whose
 * `engines.dsh` — or, when it has none, any `@deepseek-ai/dsh*` peer range —
 * does not admit the running dsh. A multi-target `dsh plugin add a b c` is
 * refused whole, so one stale member takes a preset down with it. Picking a
 * version the harness accepts is therefore part of resolving the install, not
 * a nicety.
 *
 * Shared with dshmarketplace-cli (src/compat.js), where it is tested against
 * node-semver; keep the two identical.
 *
 * The rule mirrors packages/boot/app-boot/src/plugin-compatibility.ts in
 * deepseek-ai/deepseek-harness: `semver.satisfies(runtime, range,
 * { includePrerelease: true })`, `engines.dsh` deciding alone when declared.
 * The range parser is hand-rolled because this package carries no
 * dependencies; test/compat.test.js holds it to node-semver's answers over
 * every dsh range the catalogue's plugins actually declare.
 */

const VERSION_RE =
  /^\s*[v=]*\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?\s*$/;
const PARTIAL_RE =
  /^[v=]*([0-9]+|[xX*])(?:\.([0-9]+|[xX*])(?:\.([0-9]+|[xX*])(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?)?)?$/;

export function parseVersion(text) {
  const m = VERSION_RE.exec(text ?? "");
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

function compareIds(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compare(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return Math.sign(a[k] - b[k]);
  }
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const d = compareIds(a.pre[i], b.pre[i]);
    if (d) return d;
  }
  return 0;
}

const isX = (part) => part === undefined || /^[xX*]$/.test(part);

/** One `[op][partial]` token desugared to plain comparators, node-semver style. */
function desugar(op, M, m, p, pr) {
  if (op === "^") {
    if (isX(M)) return [];
    if (isX(m)) return [`>=${M}.0.0-0`, `<${+M + 1}.0.0-0`];
    if (isX(p)) {
      return M === "0"
        ? [`>=${M}.${m}.0-0`, `<${M}.${+m + 1}.0-0`]
        : [`>=${M}.${m}.0-0`, `<${+M + 1}.0.0-0`];
    }
    // A full version keeps its exact lower bound even under includePrerelease:
    // `^0.1.0` does not admit 0.1.0-rc.6. The harness leans on this.
    const low = `>=${M}.${m}.${p}${pr ? `-${pr}` : ""}`;
    if (M !== "0") return [low, `<${+M + 1}.0.0-0`];
    if (m !== "0") return [low, `<${M}.${+m + 1}.0-0`];
    return [low, `<${M}.${m}.${+p + 1}-0`];
  }
  if (op === "~" || op === "~>") {
    if (isX(M)) return [];
    if (isX(m)) return [`>=${M}.0.0-0`, `<${+M + 1}.0.0-0`];
    if (isX(p)) return [`>=${M}.${m}.0-0`, `<${M}.${+m + 1}.0-0`];
    return [`>=${M}.${m}.${p}${pr ? `-${pr}` : ""}`, `<${M}.${+m + 1}.0-0`];
  }
  const anyX = isX(M) || isX(m) || isX(p);
  let gtlt = op === "=" && anyX ? "" : op;
  if (isX(M)) return gtlt === ">" || gtlt === "<" ? ["<0.0.0-0"] : [];
  if (gtlt && anyX) {
    let [mj, mn] = [+M, isX(m) ? 0 : +m];
    if (gtlt === ">") {
      gtlt = ">=";
      if (isX(m)) [mj, mn] = [mj + 1, 0];
      else mn += 1;
    } else if (gtlt === "<=") {
      gtlt = "<";
      if (isX(m)) mj += 1;
      else mn += 1;
    }
    return [`${gtlt}${mj}.${mn}.0-0`];
  }
  if (isX(m)) return [`>=${M}.0.0-0`, `<${+M + 1}.0.0-0`];
  if (isX(p)) return [`>=${M}.${m}.0-0`, `<${M}.${+m + 1}.0-0`];
  // node-semver widens a bare `>=0.0.0` so that it admits prereleases too.
  if (gtlt === ">=" && `${M}.${m}.${p}` === "0.0.0" && !pr) return [">=0.0.0-0"];
  return [`${gtlt || "="}${M}.${m}.${p}${pr ? `-${pr}` : ""}`];
}

function hyphen(from, to) {
  const f = PARTIAL_RE.exec(from);
  const t = PARTIAL_RE.exec(to);
  if (!f || !t) return null;
  const out = [];
  const [, fM, fm, fp, fpr] = f;
  if (!isX(fM)) {
    if (isX(fm)) out.push(`>=${fM}.0.0-0`);
    else if (isX(fp)) out.push(`>=${fM}.${fm}.0-0`);
    else out.push(`>=${fM}.${fm}.${fp}${fpr ? `-${fpr}` : "-0"}`);
  }
  const [, tM, tm, tp, tpr] = t;
  if (!isX(tM)) {
    if (isX(tm)) out.push(`<${+tM + 1}.0.0-0`);
    else if (isX(tp)) out.push(`<${tM}.${+tm + 1}.0-0`);
    else if (tpr) out.push(`<=${tM}.${tm}.${tp}-${tpr}`);
    else out.push(`<${tM}.${tm}.${+tp + 1}-0`);
  }
  return out;
}

/** A comparator set as `[op, version]` pairs, or null when it does not parse. */
function parseSet(text) {
  const trimmed = text.trim();
  const h = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  const raw = h
    ? hyphen(h[1], h[2])
    : trimmed
        .replace(/(<=|>=|~>|[<>=~^])\s+/g, "$1")
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((token) => {
          const op = /^(<=|>=|~>|[<>=~^])?/.exec(token)[1] ?? "";
          const m = PARTIAL_RE.exec(token.slice(op.length));
          return m ? desugar(op, m[1], m[2], m[3], m[4]) : [null];
        });
  if (!raw || raw.includes(null)) return null;
  const set = [];
  for (const c of raw) {
    const [, op, v] = /^(<=|>=|<|>|=)?(.*)$/.exec(c);
    const parsed = parseVersion(v);
    if (!parsed) return null;
    set.push([op || "=", parsed]);
  }
  return set;
}

const TESTS = {
  "=": (d) => d === 0,
  ">": (d) => d > 0,
  ">=": (d) => d >= 0,
  "<": (d) => d < 0,
  "<=": (d) => d <= 0,
};

/** `semver.satisfies(version, range, { includePrerelease: true })`. */
export function satisfies(version, range) {
  const v = typeof version === "string" ? parseVersion(version) : version;
  if (!v || typeof range !== "string") return false;
  const sets = range.split("||").map(parseSet);
  if (sets.includes(null)) return false;
  return sets.some((set) => set.every(([op, bound]) => TESTS[op](compare(v, bound))));
}

/**
 * The requirements a manifest places on dsh that `runtime` does not meet, in
 * the harness's own terms. Empty means the harness will accept it.
 */
export function unmetRequirements(manifest, runtime) {
  const ok = (range) => range.trim() !== "" && satisfies(runtime, range);
  const dsh = manifest.engines?.dsh;
  if (typeof dsh === "string") return ok(dsh) ? {} : { "engines.dsh": dsh };
  const unmet = {};
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
    if (["workspace:^", "workspace:~", "workspace:*"].includes(range)) continue;
    if (typeof range !== "string" || !ok(range)) unmet[name] = range;
  }
  return unmet;
}

/**
 * The version to install on `runtime`, from an npm packument. Leaves the
 * target unpinned when `latest` is accepted — that is what the bare name
 * resolves to anyway. Otherwise the highest accepted release no newer than
 * `latest`, a prerelease only when no release qualifies, as the harness's own
 * Discover tab chooses.
 */
export function pickVersion(packument, runtime) {
  const latest = packument["dist-tags"]?.latest;
  const all = Object.values(packument.versions ?? {});
  const latestManifest = latest ? packument.versions?.[latest] : undefined;
  if (latestManifest) {
    const unmet = unmetRequirements(latestManifest, runtime);
    if (!Object.keys(unmet).length) return { pin: null, latest };
  }
  const ceiling = latest ? parseVersion(latest) : null;
  const accepted = all
    .filter((m) => !m.deprecated)
    .map((m) => ({ m, v: parseVersion(m.version) }))
    .filter(({ m, v }) => v && (!ceiling || compare(v, ceiling) <= 0))
    .filter(({ m }) => !Object.keys(unmetRequirements(m, runtime)).length)
    .sort((a, b) => compare(b.v, a.v));
  const best = accepted.find(({ v }) => !v.pre.length) ?? accepted[0];
  const unmet = latestManifest ? unmetRequirements(latestManifest, runtime) : {};
  return best
    ? { pin: best.m.version, latest, unmet }
    : { pin: null, latest, unmet, incompatible: true };
}

/** An npm target split into name and an explicit version, if one was given. */
export function splitSpec(target) {
  const m = /^(@[^/@\s]+\/[^@\s]+|[^@\s][^@\s]*)@(\S+)$/.exec(target);
  return m ? { name: m[1], version: m[2] } : { name: target, version: null };
}
