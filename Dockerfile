# The sandbox a plugin is installed into. Built once; every validation runs a
# throwaway container from it, so nothing a plugin does survives its own run.
#
# The harness and pnpm are baked in rather than installed per run — pulling
# them every time would make the network the thing under test.
#
# The full image, not `-slim`: `@deepseek-ai/dsh` depends on `node-pty`, which
# ships no arm64 prebuild, so npm falls through to node-gyp and needs python
# and a C++ toolchain. On slim the install dies at `gyp ERR! not ok`, which
# reads like a broken package and is really a missing compiler.
FROM node:22-bookworm

# COREPACK_HOME is not decoration. Corepack caches the pnpm it prepares under
# $HOME, `corepack prepare` runs here as root, and the container runs as `node`
# — so the pinned pnpm landed in /root/.cache where the only user who ever runs
# it cannot read it. Corepack then silently re-resolved to latest and pulled it
# over the network on every single run: the version pin below did nothing, and
# the network became part of the thing under test, which is the one outcome
# this image exists to prevent. Point it somewhere world-readable instead.
ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH \
    COREPACK_HOME=/usr/local/corepack \
    DSH_HOME=/work/home \
    npm_config_update_notifier=false

# Pinned, because the verdict has to be about the plugin. pnpm 11 exits
# non-zero on ERR_PNPM_IGNORED_BUILDS and `dsh` reads that as a failed install,
# so the same plugin is `needs-approval` on 11 and `passed` on 10.
RUN corepack enable \
 && corepack prepare pnpm@10 --activate \
 && chmod -R a+rX "$COREPACK_HOME" \
 && npm install -g @deepseek-ai/dsh --loglevel=error \
 && npm cache clean --force

# Nothing here runs as root. A plugin's install step is the untrusted part, and
# it should not be able to write outside the profile it is being installed into.
# The base image already ships an unprivileged `node` user; adding another one
# only moves the same uid around.
RUN mkdir -p /work && chown -R node:node /work

COPY --chown=node:node probe.mjs /usr/local/bin/probe.mjs
COPY --chown=node:node preset.mjs /usr/local/bin/preset.mjs

USER node
WORKDIR /work

ENTRYPOINT ["node", "/usr/local/bin/probe.mjs"]
