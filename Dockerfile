FROM node:22-trixie-slim AS build

LABEL name="thinxcloud/transformer" version="2.0.147"

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

FROM gcr.io/distroless/nodejs22-debian13

LABEL name="thinxcloud/transformer" version="2.0.147"

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
