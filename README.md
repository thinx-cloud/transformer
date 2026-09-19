# thinx-node-transformer

[![pipeline status](https://gitlab.com/thinx/thinx-node-transformer/badges/master/pipeline.svg)](https://gitlab.com/thinx/thinx-node-transformer/commits/master) [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=thinx-cloud_transformer&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=thinx-cloud_transformer) [![Coverage Status](https://coveralls.io/repos/github/thinx-cloud/transformer/badge.svg?branch=main)](https://coveralls.io/github/thinx-cloud/transformer?branch=main) [![Codacy Badge](https://app.codacy.com/project/badge/Grade/cbf13627f23147179556112048af04a5)](https://www.codacy.com/gh/thinx-cloud/transformer/dashboard?utm_source=github.com&amp;utm_medium=referral&amp;utm_content=thinx-cloud/transformer&amp;utm_campaign=Badge_Grade)

Purpose of this service is to provide sandboxed execution environment for JavaScript lambda functions in THiNX (called Transformers, as they are used to transform and process proprietary device states).

Instance of NodeJS process [thinx-node-transformer](https://github.com/suculent/thinx-node-tranformer) safely enclosed inside a docker image. Takes jobs as HTTP posts and executes JavaScript code from job locally.

**Before first run**

1. Register at Rollbar.io and your Access Token as `POST_SERVER_ITEM_ACCESS_TOKEN` environment variable named `ROLLBAR_ACCESS_TOKEN` with optional `ROLLBAR_ENVIRONMENT` tag 	
See [API contract](#api-contract) below for the request/response shape and an
example lambda.

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


## API contract

One endpoint. The service is stateless: it compiles and runs the supplied
lambda, returns the result, and persists nothing.

```
POST /do
Content-Type: application/json
```

### Request

```json
{
  "device": { "owner": "owner-id", "id": "device-id" },
  "jobs": [
    {
      "id": "transaction-identifier",
      "owner": "owner-id",
      "codename": "status-transformer-alias",
      "code": "ZnVuY3Rpb24gdHJhbnNmb3JtZXIoc3RhdHVzLCBkZXZpY2UpIHsgcmV0dXJuIHN0YXR1czsgfQ==",
      "params": {
        "status": "Battery 100.0V",
        "device": { "owner": "owner-id", "id": "device-id" }
      }
    }
  ]
}
```

**Both `device` and `jobs` are required at the top level.** A missing one is
rejected before any code runs:

| missing | response |
|---|---|
| `jobs` | `{"success": false, "error": "missing: body.jobs"}` |
| `device` | `{"success": false, "error": "missing: device"}` |

Note that top-level `device` is only checked for presence. The object actually
handed to the lambda is `jobs[i].params.device`, so both must be supplied even
though they usually carry the same value.

### Per-job fields

- **`code`** — base64-encoded JavaScript defining a function named
  `transformer`. It is decoded, then screened twice before compiling:
  it must contain the substring `transformer` (otherwise
  `lambda function missing`) and must not contain `child_process`
  (otherwise `child process not allowed`).
- **`params.status`** — the value passed as the lambda's first argument.
  Only `jobs[0].params.status` seeds the run; each subsequent job receives the
  previous job's return value, so a multi-job request is a chain, not a
  parallel batch.
- **`params.device`** — passed as the second argument, serialised with
  `JSON.stringify`.

`id`, `owner` and `codename` are carried for traceability and are not
interpreted by the service.

### The lambda

Invoked inside an `isolated-vm` isolate as:

```js
rtn(transformer("<params.status>", <params.device as JSON>));
```

Two globals are injected into the isolate, and nothing else — no `require`,
no filesystem, no network:

- `log(...)` — writes to the service's stdout
- `rtn(value)` — returns `value` to the caller (called for you, around the
  `transformer(...)` result)

`status` and `device` are handed to the isolate as values, not spliced into
the script source, so any string is safe to submit — quotes, backslashes and
newlines included. They are always seen by the lambda as data and can never be
parsed as code.

### Response

```json
{ "output": "<value returned by the last transformer>", "error": "transformer_error" }
```

> **`error` is not a failure signal.** Outside `ENVIRONMENT=test` the field is
> currently populated with the literal string `transformer_error` on every
> response, successful or not. Judge success by `output`, not by the presence
> of `error`.

### Execution limits

A transformer is killed if it exceeds its wall-clock budget, so a lambda that
never returns cannot pin a worker. The default is 1000 ms, overridable with the
`TRANSFORMER_TIMEOUT_MS` environment variable. A run that hits the limit is
reported through the usual `error` path, leaving `output` at the previous job's
value. The isolate itself is capped at 64 MB.

### Known limitations

- Results are not merged across jobs; only the final job's return value is
  reported in `output`.
