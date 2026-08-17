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

ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH \
    DSH_HOME=/work/home \
    npm_config_update_notifier=false

RUN corepack enable \
 && corepack prepare pnpm@10 --activate \
 && npm install -g @deepseek-ai/dsh --loglevel=error \
 && npm cache clean --force

# Nothing here runs as root. A plugin's install step is the untrusted part, and
# it should not be able to write outside the profile it is being installed into.
# The base image already ships an unprivileged `node` user; adding another one
# only moves the same uid around.
RUN mkdir -p /work && chown -R node:node /work

COPY --chown=node:node probe.mjs /usr/local/bin/probe.mjs

USER node
WORKDIR /work

ENTRYPOINT ["node", "/usr/local/bin/probe.mjs"]
