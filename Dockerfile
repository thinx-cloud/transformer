FROM node:17-alpine

LABEL name="thinxcloud/transformer" version="1.8.76"

ARG ROLLBAR_ACCESS_TOKEN
ARG ROLLBAR_ENVIRONMENT
ARG REVISION

ENV ROLLBAR_ACCESS_TOKEN=${ROLLBAR_ACCESS_TOKEN}
ENV ROLLBAR_ENVIRONMENT=${ROLLBAR_ENVIRONMENT}
ENV REVISION=${REVISION}

RUN apk --no-cache add g++ gcc libgcc libstdc++ linux-headers make python3 curl git jq

# remove offending node_modules from development environment (may not be compatible with alpine)
RUN rm -rf ./node_modules

# https://stackoverflow.com/questions/52196518/could-not-get-uid-gid-when-building-node-docker
RUN npm config set unsafe-perm true

# allow building native extensions with alpine: https://github.com/nodejs/docker-node/issues/384
RUN npm install -g node-gyp

RUN mkdir -p /home/node/app

COPY . /home/node/app/

WORKDIR /home/node/app

RUN npm install -g npm@8.6.0 && \
    npm install . --only-prod && \
    addgroup -S thinx && \
    adduser -S -D -h /home/node/app transformer thinx && \
    chown -R transformer:thinx /home/node/app

RUN apk del gcc g++ make python3 curl git jq

# Switch to 'transformer' or 'node' user
USER transformer

# Open the mapped port
EXPOSE 7474

CMD [ "node", "index.js" ]
