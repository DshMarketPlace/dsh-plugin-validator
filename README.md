<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-241f1a?style=flat-square"></a>
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-none-6b6055?style=flat-square">
  <img alt="Requires" src="https://img.shields.io/badge/requires-docker%20%2B%20node%2022-6b6055?style=flat-square">
  <a href="https://dshmarketplace.dev"><img alt="Used by" src="https://img.shields.io/badge/checked-2%2C426%20plugins-c0561d?style=flat-square"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

---

Installs a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin into a fresh profile inside a throwaway container, and reports **what the
harness recorded** — not what the CLI printed.

It is the check behind the install verdict on every listing at
[dshmarketplace.dev](https://dshmarketplace.dev).

## Why the exit code is not evidence

`dsh plugin add` exits `0` even when nothing was installed. It did so on a
machine with no pnpm: it printed the reason, and returned success.

So this tool ignores the exit code. After the install it reads the profile
manifest the harness writes for itself — `$DSH_HOME/profiles/web/package.json` —
and looks at `dsh.profile.bundles`. A plugin that is registered there is
installed. Nothing else counts.

The command is passed in **whole, exactly as the catalogue publishes it**,
because the thing under test is the command a person would copy, not our
reconstruction of it.

## Verdicts

Six outcomes, and **only two of them are defects**.

| Verdict | Meaning | A defect? |
| --- | --- | --- |
| `passed` | Installed and registered in the profile's `bundles` | — |
| `not-a-layer` | Installed fine as a plain dependency; it declares no `dsh.bundle`. Themes, agent bundles and libraries land here, and the harness promises a later version that gains one activates by itself | — |
| `needs-approval` | Resolved and landed, but a build script was refused. One `allowBuilds` entry away from working | — |
| `rejected` | The string is not a `dsh plugin add` command, or its target is neither an npm name nor a `github:` spec. Nothing ran | — |
| `failed` | Installed but never registered, no manifest was written, or `package.json` starts with a UTF-8 BOM | **yes** |
| `timeout` | Exceeded 180s | **yes** |

Two of those exist only because the first version got them wrong.
`not-a-layer` spent a day inside `failed`, marking working themes broken for
being a different kind of package. `needs-approval` covers a source install
whose `prepare` script pnpm declines to run — the one thing every source
install has to do.

**A 429 is never a verdict.** If a registry throttles the run, the probe emits
`error` and nothing downstream publishes it. That branch exists because 119
working plugins were once marked broken by npm throttling a batch, and 28 more
by `codeload.github.com`, which rate limits tarball downloads the same way.
Whose 429 it is does not matter — it always measures our traffic, not the
plugin.

## Use it

```console
$ docker build -t dsh-validator:latest .
```

One plugin, directly:

```console
$ docker run --rm dsh-validator:latest "dsh plugin --profile web add @liustack/modlens"
{"status":"passed","detail":"installed and registered in the web profile","bundles":["@liustack/modlens"],"dependencies":["@liustack/modlens"],"blockedBuildScripts":[]}
```

A batch — one JSON object per line, `fullName` and `install`:

```console
$ cat specs.jsonl
{"fullName":"liustack/modlens","install":"dsh plugin --profile web add @liustack/modlens"}
{"fullName":"someone/other","install":"dsh plugin --profile web add github:someone/other"}

$ node run.mjs specs.jsonl results.jsonl 3
2 specs, 0 already done, 2 to run
  2/2

{
  "passed": 1,
  "needs-approval": 1
}
```

**Resumable.** Results are appended as they finish and already-done entries are
skipped, so a run that dies at hour two costs hour two — not hours one and two.

| Environment variable | Default | |
| --- | --- | --- |
| `VALIDATOR_IMAGE` | `dsh-validator:latest` | Image to run |
| `VALIDATOR_MEMORY` | `1500m` | Per-container memory *and* swap ceiling |
| `VALIDATOR_CPUS` | `1.0` | Per-container CPU limit |
| `PROBE_TIMEOUT_MS` | `180000` | Install timeout inside the container |

Deliberately modest defaults: this is built to run on a box that has other
people's services on it, and a batch that starves them is a worse outcome than
a batch that takes all night.

## Isolation

A plugin's install step is arbitrary code from a stranger, so it gets a
container of its own that is destroyed afterwards.

- `--rm`, one container per plugin, nothing survives its own run
- `--cap-drop ALL` and `--security-opt no-new-privileges`
- Runs as the image's unprivileged `node` user, never root
- **No host mount** — there is no path out
- Memory, swap and `--pids-limit 512` capped
- A 300s wall-clock kill that outlives the probe's own timeout, so a wedged
  container cannot hold a slot forever

The runner is **deliberately file-in, file-out and holds no credentials.** A
`postinstall` that can reach a database token owns the database, so the process
running untrusted install scripts has nothing to reach. In the marketplace's
nightly job this is a separate CI job for exactly that reason: one job decides
what needs checking, this one runs it, a third reads the results back.

Network access is left on (`--network bridge`) because installing is the thing
being tested. That is the honest limit of the sandbox: it constrains what an
install can *reach on the host*, not what it can send.

## What it found

**Our own bug, before anyone else's.** The first full batch returned 410
failures. Almost none were broken plugins:

- **412 of 852 listings claiming an npm package were wrong** — 362 named a
  package that was never published, and 50 named somebody else's. Almost all of
  those were forks, which inherit the upstream's `package.json`, so the fork's
  card printed the upstream's install command. We installed a stranger's code
  and were about to publish its failure under the fork author's name.
- 119 more were npm throttling us, and 28 were GitHub doing the same.
- 18 were an artifact of editing the probe mid-run.

What survives is a low single-digit percentage, mostly monorepo and workspace
resolution errors — plus one worth naming: a `package.json` saved with a UTF-8
BOM, which `JSON.parse` rejects everywhere. Windows editors add it silently, so
the author has no way to see it. That is why the verdict says so by name
instead of calling it a generic failure.

**Reading the code had already failed to catch commands that cannot run, twice.
Installing them caught both.**

## Why pnpm 10, not 11

The image pins pnpm 10 on purpose. pnpm 11 exits non-zero on
`ERR_PNPM_IGNORED_BUILDS`, `dsh` reads that as a failed install and stops before
writing the bundle row — so the *same* plugin is `needs-approval` on 11 and
`passed` on 10. That is a fact about the package manager, not about the plugin,
and pinning is what keeps the verdict about the plugin.

The image is `node:22-bookworm` rather than `-slim` for a related reason:
`@deepseek-ai/dsh` depends on `node-pty`, which ships no arm64 prebuild, so npm
falls through to node-gyp and needs python and a C++ toolchain. On slim the
install dies at `gyp ERR! not ok`, which reads like a broken package and is
really a missing compiler.

## Elsewhere in the catalogue

- **Web** — [dshmarketplace.dev](https://dshmarketplace.dev)
- **npm** — `npx dshmarketplace-cli find memory`
- **PyPI** — `pip install dshmarketplace`
- **Inside DSH** — `dsh plugin --profile web add dshmarketplace-plugin`
- **Userscript** — [DSH Plugin Radar](https://greasyfork.org/scripts/591735-dsh-plugin-radar)

## Contributing

Issues and pull requests welcome — particularly a verdict you think is wrong.
If a *listing* is wrong, that belongs on the
[marketplace repo](https://github.com/DshMarketPlace/dshmarketplace); the data
lives there, not here.

## Licence

MIT. An independent project, not affiliated with DeepSeek.
