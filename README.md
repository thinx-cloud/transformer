# thinx-node-transformer

[![pipeline status](https://gitlab.com/thinx/thinx-node-transformer/badges/master/pipeline.svg)](https://gitlab.com/thinx/thinx-node-transformer/commits/master) [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=thinx-cloud_transformer&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=thinx-cloud_transformer) [![Coverage Status](https://coveralls.io/repos/github/thinx-cloud/transformer/badge.svg?branch=main)](https://coveralls.io/github/thinx-cloud/transformer?branch=main) [![Codacy Badge](https://app.codacy.com/project/badge/Grade/cbf13627f23147179556112048af04a5)](https://www.codacy.com/gh/thinx-cloud/transformer/dashboard?utm_source=github.com&amp;utm_medium=referral&amp;utm_content=thinx-cloud/transformer&amp;utm_campaign=Badge_Grade)

Purpose of this service is to provide sandboxed execution environment for JavaScript lambda functions in THiNX (called Transformers, as they are used to transform and process proprietary device states).

Instance of NodeJS process [thinx-node-transformer](https://github.com/suculent/thinx-node-tranformer) safely enclosed inside a docker image. Takes jobs as HTTP posts and executes JavaScript code from job locally.

**Before first run**

1. Register at Rollbar.io and your Access Token as `POST_SERVER_ITEM_ACCESS_TOKEN` environment variable named `ROLLBAR_ACCESS_TOKEN` with optional `ROLLBAR_ENVIRONMENT` tag 	
See example expected code at [THiNX Wiki](https://suculent/thinx-device-api)

### Exceptionally dumb

This instance does not support anything more than bare node.js express server with https support. **Please, ask for required extensions or provide PR with usage example.**

### Security Note

In production, it's advised to track your Transformer using [Rollbar](https://rollbar.com/) as implemented in example.

First of all, generate your own Rollbar token, or remove the Rollbar implementation if you don't want to track what's going on inside your Transformer.

This instance must be firewalled. Must not be accessible except on localhost, where it is expected to execute primitive JavaScript in sandbox. Expected to run in Docker as a non-root user. Supports outgoing HTTPS.

**There's plan to implement outbound SSL sockets instead of incoming HTTP REST API (similar way to [thinxcloud/worker](https://github.com/thinxcloud/worker) project).

### Supported Modules (Public)

_Feel free to submit proposals for adding more modules. Intention is to keep it small and safe._

`base-64` : processed JavaScript must be safely encoded when transferred

`ssl-root-cas` : https support


### Notes

Instance should accept only local HTTP requests. Make sure neither port 7474 is exposed on host machine firewall.

```bash
docker run \
--user=transformer \
-e ROLLBAR_ACCESS_TOKEN=<your-rollbar-token> \
-d -p 7474 \
-v /var/logs:/logs \
-v /$(pwd):/app \
suculent/thinx-node-transformer
```

### Building the container

`docker build -t suculent/thinx-node-transformer .`


## Job Request Format

HTTP POST BODY:

```json
{
  jobs: [
    {
        id: "transaction-identifier",
        owner: "owner-id",
        codename: "status-transformer-alias",
        code: base64.encode("function transformer(status, device) { return status; };"),
        params: {
          status: "Battery 100.0V",
          device: {
            owner: "owner-id",
            id: "device-id"
          }
        }
    }
  ]
}
```
