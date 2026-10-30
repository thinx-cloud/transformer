FROM node:22.23.4-trixie-slim AS build

LABEL name="thinxcloud/transformer" version="2.2.1"

WORKDIR /home/node/app

RUN apt-get update && \
    apt-get install -y --no-install-recommends g++ make python3 && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm install -g npm@10.9.2 && \
    npm ci --omit=dev

COPY . .

RUN groupadd --gid 10001 thinx && \
    useradd --uid 10001 --gid thinx --home-dir /home/node/app --shell /usr/sbin/nologin --no-create-home transformer && \
    chown -R transformer:thinx /home/node/app

# Pinned by digest to guarantee the patched runtime contents:
#   nodejs 22.23.4 (CVE-2026-111497, Brotli decoder RCE), libc6 2.41-12+deb13u4, libssl3t64 3.5.7-1~deb13u3
FROM gcr.io/distroless/nodejs22-debian13@sha256:f643bc05bdcf5a8d98442e8a2a5c7a3a4c3a0e3bc4cdc5f10557d47f1ddd5812

LABEL name="thinxcloud/transformer" version="2.2.1"

ARG ROLLBAR_ENVIRONMENT
ARG REVISION

ENV ROLLBAR_ENVIRONMENT=${ROLLBAR_ENVIRONMENT}
ENV REVISION=${REVISION}

# ROLLBAR_ACCESS_TOKEN is deliberately not declared here. This is the final
# stage, so an ENV would be baked into the published (public)
# thinxcloud/transformer image. It is supplied at runtime by docker-compose
# `environment:` instead.

WORKDIR /home/node/app

COPY --from=build /etc/passwd /etc/passwd
COPY --from=build /etc/group /etc/group
COPY --from=build --chown=transformer:thinx /home/node/app /home/node/app

USER transformer:thinx

EXPOSE 7474

CMD [ "--no-node-snapshot", "index.js" ]
