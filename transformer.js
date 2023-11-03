// file deepcode ignore UseCsurfForExpress: API cannot use CSRF

var rbconfig = process.env.ROLLBAR_ACCESS_TOKEN || null;
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
}

var express = require('express');
const helmet = require('helmet');
var http = require('http');
var https = require('https');

require('ssl-root-cas').inject();
https.globalAgent.options.ca = require('ssl-root-cas');

const parser = require('body-parser');
const base64 = require('base-64');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length; // default number of forks

// Create a new isolate limited to 128MB
const ivm = require('isolated-vm');
const isolate = new ivm.Isolate({ memoryLimit: 128 });

// Create a new context within this isolate. Each context has its own copy of all the builtin
// Objects. So for instance if one context does Object.prototype.foo = 1 this would not affect any
// other contexts.
const context = isolate.createContextSync();

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

    this.app.all("/*", function (req, res, next) {
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Origin", "api");
      res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-type,Accept,X-Access-Token,X-Key");
      if (req.method == "OPTIONS") {
        res.status(200).end();
      } else {
        console.log("TODO: match referrer/origin using ACL", { req });
        next();
      }
    });

    this.app.post("/do", function (req, res) {
      this.process(req, res);
    });
  }

  execInSandbox(status, device, code_string, callback) {
    // new async sandbox
    let sandbox_code = `
    module.exports = function(status, device, callback) { 
        ${code_string};
        callback(transformer(status, device));
    }
    `;
    console.log("Sandbox code:", sandbox_code);
    let functionWithCallbackInSandbox = context.evalSync(sandbox_code);
    functionWithCallbackInSandbox(status, device, (result) => {
        console.log("transformer result:", { result });
        callback(result);
    });
}

  process(req, res) {

    if (typeof (req.origin) === "undefined") {
      console.log("Request origin", req.origin, "(TODO: filter transformer origin only to the app instance, will that be possible?)");
    }

    if (typeof (req.body) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        error: "missing: body"
      }));
      return;
    }

    var ingress = {};
    try {
      ingress = JSON.parse(req.body);
    } catch (e) {
      ingress = req.body;
    }

    var jobs = ingress.jobs;
    if (typeof (ingress.jobs) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        error: "missing: body.jobs"
      }));
      return;
    }

    var device = ingress.device;

    if (typeof (device) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        error: "missing: device"
      }));
      return;
    }

    console.log(new Date().toString() + "Incoming job.");
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

    } catch (e) {
      console.log("[transformer] Docker Transformer Exception: ", e);
    }
    return cleancode;
  }

  process_jobs(jobs, callback) {
    
    var input_raw = jobs[0].params.status;
    var status = input_raw; // should be rather an array
    var error = null;
    for (var job_index in jobs) {
      const job = jobs[job_index];
      const device = jobs[job_index].params.device;
      
      // This is just a simple blacklist for dangerous functions.
      // -> extract from here as validateJob
      let code = this.sanitize(job.code);
      if (code.indexOf("child_process") !== -1) {
        callback("child process not allowed", true);
        return;
      }
      if (code.indexOf("transformer") === -1) {
        console.log("Invalid code:", job.code);
        callback("lambda function missing", true);
        return;
      }
      // <- extract to here as validateJob
      try {
        console.log("Evaluating code:'", code, "'");
        this.execInSandbox(status, device, code, (job_status) => {
            console.log("[transformer] Docker Transformer will return status (currently dropped): '", job_status, "'");
            status = job_status; // should merge results to an array; this is a problem in async exec where all jobs should be promises
          });
      } catch (e) {
        console.log("[transformer] Docker Transformer Exception: " + e);
        error = JSON.stringify(e);
      }
    }
    callback(status, error);
  }

  transform(jobs, res) {
    this.process_jobs(jobs, (status, error) => {
      if (process.env.ENVIRONMENT != "test") {
        console.log("[transformer] error", error);
        res.end(JSON.stringify({
          output: status,
          error: "transformer_error"
        }));
      } else {
        res({
          output: status,
          error: error
        });
      }
    });
  }
};