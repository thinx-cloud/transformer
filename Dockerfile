FROM node:22.23.2-trixie-slim AS build

LABEL name="thinxcloud/transformer" version="2.1.159"

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
#   nodejs 22.23.2, libc6 2.41-12+deb13u4, libssl3t64 3.5.7-1~deb13u2
FROM gcr.io/distroless/nodejs22-debian13@sha256:412a5f8fce490bcff01fc2a73ec43bb62071e1b71dd847eeacaae7b8ecef1dc1

LABEL name="thinxcloud/transformer" version="2.1.159"

ARG ROLLBAR_ACCESS_TOKEN
ARG ROLLBAR_ENVIRONMENT
ARG REVISION

ENV ROLLBAR_ACCESS_TOKEN=${ROLLBAR_ACCESS_TOKEN}
ENV ROLLBAR_ENVIRONMENT=${ROLLBAR_ENVIRONMENT}
ENV REVISION=${REVISION}

WORKDIR /home/node/app

COPY --from=build /etc/passwd /etc/passwd
COPY --from=build /etc/group /etc/group
COPY --from=build --chown=transformer:thinx /home/node/app /home/node/app

USER transformer:thinx

EXPOSE 7474

CMD [ "--no-node-snapshot", "index.js" ]
