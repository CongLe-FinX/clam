# syntax=docker/dockerfile:1
#
# CL Agent Mesh node image (linux, native arch — arm64 on Apple Silicon).
# Build from the repo root:   docker build -f deploy/docker/Dockerfile -t clam-node:dev .
# (deploy/docker/clam-nodes.sh build does exactly that.)
#
# Credentials are NEVER part of this image: OMP and gh logins are streamed into the running container's HOME volume.

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.20.0
ARG BUN_VERSION=1.4.4
ARG OMP_VERSION=18.14.0
ARG GH_VERSION=2.95.0
ARG CLOUDFLARED_VERSION=2026.10.5

# ---------------------------------------------------------------- builder
FROM node:${NODE_VERSION}-bookworm-slim AS builder
ARG PNPM_VERSION
# python3 + make + g++ build native addons with node-gyp: node-pty (the Terminal's PTY) ships no linux prebuilds, so it is ALWAYS compiled here;
# better-sqlite3 only needs them when it has no prebuilt binary for the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /src
# The whole (ignore-filtered) repo: pnpm needs every workspace package manifest to resolve the lockfile.
COPY . .
# `--frozen-lockfile` fails the build when pnpm-lock.yaml is out of sync with the manifests.
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Self-contained production tree for the server: package.json + dist + production node_modules
# (incl. the compiled better-sqlite3 addon). Workspace packages are bundled into dist/main.js by tsup.
# (`deploy` also copies the package sources; replace them with the built bundle.)
# The last check fails the build when the compiled node-pty addon did not make it into the production tree (no Terminal otherwise).
RUN pnpm --filter @clam/server deploy --prod --legacy /out/server \
 && rm -rf /out/server/dist /out/server/src /out/server/test /out/server/*.ts \
 && cp -r apps/server/dist /out/server/dist \
 && cp -r apps/web/dist /out/web \
 && cd /out/server && node -e "const pty=require('node-pty'); const p=pty.spawn('/bin/sh',['-c','exit 0'],{}); p.onExit(()=>process.exit(0)); setTimeout(()=>{console.error('node-pty smoke test timed out'); process.exit(1)},5000)"

# ---------------------------------------------------------------- tools (bun + omp, gh, cloudflared)
FROM debian:bookworm-slim AS tools
ARG BUN_VERSION
ARG OMP_VERSION
ARG GH_VERSION
ARG CLOUDFLARED_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in arm64) bun_arch=aarch64 ;; amd64) bun_arch=x64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac; \
    mkdir -p /opt/bun/bin; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip"; \
    unzip -q -j /tmp/bun.zip "bun-linux-${bun_arch}/bun" -d /opt/bun/bin; \
    chmod +x /opt/bun/bin/bun; \
    curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}"; \
    chmod 0755 /usr/local/bin/cloudflared; \
    rm -rf /tmp/*
# OMP is the npm package of the same name as the host's `omp` binary; its native addon ships as
# @oh-my-pi/pi-natives-linux-<arch> (optional dependency, picked by bun for this platform).
# The download cache (~850 MB) lives outside /opt/bun: this stage's /tmp is never copied into the runtime image.
ENV BUN_INSTALL=/opt/bun BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
RUN /opt/bun/bin/bun install -g "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" \
 && /opt/bun/bin/bun --version \
 # OMP's OPTIONAL local speech/embedding dependencies (onnxruntime, sherpa-onnx, transformers: ~500 MB) are not
 # used by a CLAM node (agents call hosted models); drop them to keep the image small.
 && cd /opt/bun/install/global/node_modules \
 && rm -rf onnxruntime-node onnxruntime-web onnxruntime-common sherpa-onnx-node sherpa-onnx-linux-* @huggingface

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq tini openssh-client procps less nano iproute2 lsof chromium fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
# Chromium is the machine's own Browser (headless, controlled over a private pipe; see docs/security.md). Its dedicated profile lives in
# the data dir; the container has no user namespaces for Chromium's sandbox, so it runs with --no-sandbox (CLAM_BROWSER_NO_SANDBOX).
COPY --from=tools /usr/local/bin/gh /usr/local/bin/cloudflared /usr/local/bin/
COPY --from=tools /opt/bun /opt/bun
COPY --from=builder /out/server /opt/clam/server
COPY --from=builder /out/web /opt/clam/web

# Non-root user. HOME is a volume (compose mounts one per node): OMP profile (~/.omp), gh config (~/.config/gh),
# CLAM data (~/.clam: database, node identity, encrypted secrets) and project clones all persist there.
# The node image already owns uid 1000 as `node`; rename it rather than adding a second user.
RUN usermod -l clam -d /home/clam -m node && groupmod -n clam node \
 && mkdir -p /home/clam/.clam && chown -R clam:clam /home/clam
ENV HOME=/home/clam \
    BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/opt/clam/server/node_modules/.bin:$PATH \
    NODE_ENV=production \
    CLAM_HOST=127.0.0.1 \
    CLAM_PORT=4317 \
    CLAM_NETWORK_PORT=4318 \
    CLAM_DATA_DIR=/home/clam/.clam \
    CLAM_WEB_DIST=/opt/clam/web \
    CLAM_OMP_BIN=/opt/bun/bin/omp \
    CLAM_BROWSER_PATH=/usr/bin/chromium \
    CLAM_BROWSER_NO_SANDBOX=1 \
    CLAM_CLOUDFLARED_BIN=/usr/local/bin/cloudflared \
    CLAM_SECRET_BACKEND=encrypted-file \
    CLAM_LOG_LEVEL=info
USER clam
WORKDIR /home/clam
VOLUME ["/home/clam"]
# The server binds loopback only; the tunnel (cloudflared in this container) is the only way in. No EXPOSE.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${CLAM_PORT}/api/local/health" || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["node", "/opt/clam/server/dist/main.js"]
