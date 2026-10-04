// file deepcode ignore UseCsurfForExpress: API cannot use CSRF

const { rollbarServerToken } = require("./secrets.js");

// ROLLBAR_SERVER_TOKEN, else ROLLBAR_ACCESS_TOKEN; a /run/secrets file first (D-03).
var rbconfig = rollbarServerToken();
let rollbar;
if (rbconfig) {
  const Rollbar = require("rollbar");
  // eslint-disable-next-line no-unused-vars
  rollbar = new Rollbar({
    accessToken: rbconfig,
    environment: process.env.ROLLBAR_ENVIRONMENT || null,
    handleUncaughtExceptions: true,
    handleUnhandledRejections: true,
    revision: process.env.REVISION || "transformer"
  });
} else {
  console.log(`${new Date().getTime()} [info] ROLLBAR_SERVER_TOKEN not set — Rollbar reporting disabled`);
}

var express = require('express');
const helmet = require('helmet');
var http = require('http');
var https = require('https');

require('ssl-root-cas').inject();
https.globalAgent.options.ca = require('ssl-root-cas');

const parser = require('body-parser');
const base64 = require('base-64');
const crypto = require('crypto');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length; // default number of forks

// One isolate per worker, limited to 64MB. isolated-vm disposes an isolate
// when a lambda exceeds its memory limit, and a disposed isolate refuses every
// later context ("Isolated is disposed"), so the worker would answer
// sandbox_error until restarted. sandboxIsolate() replaces it instead.
const ivm = require('isolated-vm');
const SANDBOX_MEMORY_MB = 64;
let isolate = new ivm.Isolate({ memoryLimit: SANDBOX_MEMORY_MB });

function sandboxIsolate() {
  if (isolate.isDisposed) {
    isolate = new ivm.Isolate({ memoryLimit: SANDBOX_MEMORY_MB });
    console.log(`[transformer] sandbox isolate recreated after disposal`);
  }
  return isolate;
}

// Wall-clock budget for a single transformer. Without a limit, `runSync` runs
// until the lambda returns, so `while(true){}` pins a worker forever and the
// cluster degrades one fork at a time. Transformers are meant to be primitive,
// so a second is generous.
const SANDBOX_TIMEOUT_MS = parseInt(process.env.TRANSFORMER_TIMEOUT_MS, 10) || 1000;

// Logging rule (quick 261004-seq): log lines carry a per-request id, counts and
// reason codes only. Transformer code, statuses (in or out), device objects,
// owner ids, the request object and exception text are never logged: the code
// and the statuses are customer data, and an exception thrown by the lambda can
// carry either of them in its message or name.
function requestId() {
  return crypto.randomBytes(4).toString('hex');
}

// Maps an exception from compiling or running the lambda to a reason code.
// The exception text is only matched, never logged or returned.
function sandboxReason(e) {
  const message = (e && typeof e.message === 'string') ? e.message : '';
  if (message.indexOf('timed out') !== -1) return 'sandbox_timeout';
  if (message.indexOf('memory limit') !== -1) return 'sandbox_memory';
  return 'sandbox_error';
}

// The lambda's return value as a status string, or null when it is not one.
function outputString(value) {
  if (typeof value === 'string') return value;
  if ((typeof value === 'number') && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function validJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  for (const job of jobs) {
    if ((typeof job !== 'object') || (job === null)) return false;
    if ((typeof job.params !== 'object') || (job.params === null)) return false;
    if ((typeof job.code !== 'string') || (job.code.length === 0)) return false;
  }
  return true;
}

function send(res, result, http_status) {
  // test.js drives process() with a plain function as `res`
  if (typeof res === 'function') return res(result);
  if (typeof res.status === 'function') res.status(http_status || 200);
  if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(result));
}

module.exports = class Transformer {

  constructor() {

    this.app = express();
    this.app.disable('x-powered-by');
    this.app.use(helmet.frameguard());

    if (cluster.isMaster) {
      console.log(`[transformer] Master Transformer ${process.pid} started`);
      // Fork workers.
      const forks = numCPUs;
      for (let i = 0; i < forks; i++) {
        if (process.env.ENVIRONMENT != "test")
          cluster.fork(); // causes open handles potentially keeping Jest from exiting
      }
      cluster.on('exit', (worker /*, code, signal */) => {
        console.log(`[transformer] worker ${worker.process.pid} died`);
      });
    } else {
      this.setupServer();
    }

    if (process.env.ENVIRONMENT == "test") {
      this.setupServer();
    }

    this.setupRoutes();
  }

  setupServer() {
    // Workers can share any TCP connection
    // In this case it is an HTTP server
    if (process.env.ENVIRONMENT != "test")
      // deepcode ignore HttpToHttps: <please specify a reason of ignoring this>
      http.createServer(this.app).listen(8000, "0.0.0.0"); // WTF? We have worker on port 8000? What is it doing here?

    this.app.use(parser.json({
      limit: "1mb"
    }));

    this.app.use(parser.urlencoded({
      extended: true,
      parameterLimit: 1000,
      limit: "1mb"
    }));

    const http_port = 7474;
    // Server should use self-signed certificate, generated by THiNX CA, which would be then trusted.
    // This would prevent eavesdropping inside cloud. Otherwise this should not be exposed to outside world at all.
    // Option 2: re-use thinx’ certificate by mapping same volume path

    if (process.env.ENVIRONMENT != "test")
      http.createServer(this.app).listen(http_port, "0.0.0.0");

    console.log(`[transformer] node ${process.pid} started on port: ${http_port}`);
  }

  setupRoutes() {

    this.app.use(function (req, res, next) {
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Origin", "api");
      res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-type,Accept,X-Access-Token,X-Key");
      if (req.method == "OPTIONS") {
        res.status(200).end();
      } else {
        // TODO: match referrer/origin using ACL. The request object is not
        // logged: it carries the body (code, status, device) and the headers.
        next();
      }
    });

    // Arrow function, not `function` — Express invokes the handler with its
    // own `this`, so a plain function expression left `this` undefined here and
    // every POST /do died with
    //   TypeError: Cannot read properties of undefined (reading 'process')
    // before reaching process(). The arrow captures the Transformer instance
    // lexically.
    this.app.post("/do", (req, res) => {
      try {
        this.process(req, res);
      } catch (_e) {
        console.log(`[transformer] request rejected: internal_error`);
        if (!res.headersSent) send(res, { success: false, error: "internal_error" }, 500);
      }
    });

    // Without this, Express's final handler logs the error stack, and a JSON
    // parse error message quotes the request body.
    // eslint-disable-next-line no-unused-vars
    this.app.use((err, req, res, next) => {
      const status = (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) ? err.status : 400;
      console.log(`[transformer] request rejected: bad_request (HTTP ${status})`);
      if (res.headersSent) return res.end();
      send(res, { success: false, error: "bad_request" }, status);
    });
  }

  execInSandbox(status, device, code_string, callback, on_log) {

    const sandbox = sandboxIsolate();
    const context = sandbox.createContextSync();
    const jail = context.global;
    jail.setSync('global', jail.derefInto());

    // `log` stays available to lambdas, but what they log is device data, so
    // the arguments are dropped; only the number of calls is reported.
    jail.setSync('log', () => {
      if (typeof on_log === 'function') on_log();
    });

    // Additional 'rtn' function for returning processed results from the jail upstream
    jail.setSync('rtn', (...args) => {
      callback(...args);
    });

    // Device status and the device object are passed in as isolate globals
    // rather than interpolated into the script source. Interpolating them
    // meant a status containing a double quote or backslash closed the string
    // literal early and the remainder was compiled as code — attacker-shaped
    // device status could rewrite the transform. Handing them over as values
    // means nothing from the request is ever parsed as source. Only
    // `code_string` is, which is the point of the service.
    jail.setSync('__thinx_status', typeof status === 'string' ? status : String(status));
    jail.setSync('__thinx_device_json', JSON.stringify(device === undefined ? null : device));

    // Run the untrusted code inside isolate instead of performing unsafe `eval`
    const untrusted = sandbox.compileScriptSync(`
          ${code_string}; // MUST include a lambda function named 'transformer'
          rtn(transformer(__thinx_status, JSON.parse(__thinx_device_json))); // runs the code and returns value through rtn and callback
        `);

    try {
      untrusted.runSync(context, { timeout: SANDBOX_TIMEOUT_MS });
    } finally {
      // Each call creates a context in the shared isolate; without releasing
      // it they accumulate against the 64MB limit until allocation fails.
      context.release();
    }

  }

  process(req, res) {

    // TODO: filter transformer origin only to the app instance.

    if (typeof (req.body) === "undefined") {
      console.log(`[transformer] request rejected: missing_body`);
      send(res, {
        success: false,
        error: "missing: body"
      });
      return;
    }

    var ingress = {};
    try {
      ingress = JSON.parse(req.body);
    } catch (e) {
      ingress = req.body;
    }

    if ((typeof (ingress) !== "object") || (ingress === null)) ingress = {};

    var jobs = ingress.jobs;
    if (typeof (ingress.jobs) === "undefined") {
      console.log(`[transformer] request rejected: missing_jobs`);
      send(res, {
        success: false,
        error: "missing: body.jobs"
      });
      return;
    }

    var device = ingress.device;

    if (typeof (device) === "undefined") {
      console.log(`[transformer] request rejected: missing_device`);
      send(res, {
        success: false,
        error: "missing: device"
      });
      return;
    }

    if (!validJobs(jobs)) {
      console.log(`[transformer] request rejected: invalid_jobs`);
      send(res, {
        success: false,
        error: "invalid_jobs"
      });
      return;
    }

    this.transform(jobs, res);
  }

  sanitize(code) {

    var cleancode;

    try {
      var decoded = false;

      // Try unwrapping as Base64
      try {
        cleancode = unescape(base64.decode(code));
        decoded = true;
      } catch (e) {
        decoded = false;
      }

      if (decoded === false) {
        try {
          cleancode = unescape(base64.decode(code.toString('utf8')));
          decoded = true;
        } catch (e) {
          decoded = false;
        }
      }

      if (decoded === false) {
        cleancode = unescape(code); // accept bare code for testing, will deprecate
      }

    } catch (_e) {
      // not logged: the exception can quote the code
      cleancode = undefined;
    }
    return cleancode;
  }

  // Runs one lambda; returns its output as a status string, or null when it
  // returned nothing usable. Sandbox exceptions propagate to the caller.
  runJob(status, device, code, on_log) {
    let returned = false;
    let value;
    this.execInSandbox(status, device, code, (job_status) => {
      returned = true;
      value = job_status;
    }, on_log);
    return returned ? outputString(value) : null;
  }

  /**
   * Runs the jobs as a chain: jobs[0].params.status seeds the first lambda and
   * each later lambda gets the previous output. Calls back exactly once with
   * {ok: true, output, jobs, log_calls} or {ok: false, reason, index, jobs}
   * (index is 1-based). Any failure ends the chain; no partial output is
   * reported.
   */
  process_jobs(jobs, callback) {

    const total = Array.isArray(jobs) ? jobs.length : 0;
    let log_calls = 0;
    const fail = (reason, index) => callback({ ok: false, reason: reason, index: index, jobs: total });
    const count_log = () => { log_calls++; };

    if (!validJobs(jobs)) return fail("invalid_jobs", 0);

    let status = jobs[0].params.status;
    for (let job_index = 0; job_index < total; job_index++) {
      const job = jobs[job_index];
      const device = job.params.device;

      // This is just a simple blacklist for dangerous functions.
      const code = this.sanitize(job.code);
      if (typeof code !== "string") return fail("code_invalid", job_index + 1);
      if (code.indexOf("child_process") !== -1) return fail("code_rejected", job_index + 1);
      if (code.indexOf("transformer") === -1) return fail("lambda_missing", job_index + 1);

      let output;
      try {
        output = this.runJob(status, device, code, count_log);
      } catch (e) {
        return fail(sandboxReason(e), job_index + 1);
      }
      if (output === null) return fail("output_invalid", job_index + 1);
      status = output;
    }
    callback({ ok: true, output: status, jobs: total, log_calls: log_calls });
  }

  /**
   * Answers POST /do (quick 261004-seq):
   * - success: {output: <string>} and nothing else;
   * - failure: {success: false, error: <reason code>} with no output, so a
   *   timeout or a rejected lambda can never be mistaken for a transform.
   * Reason codes: invalid_jobs, code_invalid, code_rejected, lambda_missing,
   * output_invalid, sandbox_timeout, sandbox_memory, sandbox_error.
   */
  transform(jobs, res) {
    const rid = requestId();
    const started = Date.now();
    this.process_jobs(jobs, (result) => {
      if (result.ok) {
        const suppressed = (result.log_calls > 0) ? `, sandbox log() suppressed: ${result.log_calls} call(s)` : "";
        console.log(`[transformer] request ${rid} ok: ${result.jobs} job(s), ${Date.now() - started} ms${suppressed}`);
        send(res, { output: result.output });
      } else {
        console.log(`[transformer] request ${rid} failed: ${result.reason} (job ${result.index} of ${result.jobs})`);
        send(res, { success: false, error: result.reason });
      }
    });
  }
};
