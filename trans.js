// New implementation of Transformer v2 (socket-based)
// TODO/WARNING: This is a copy-paste for refactoring the THiNX Transformer from HTTP to Socket (secure; but not yet)

let rollbar = null;

if (typeof(process.env.ROLLBAR_TOKEN) !== "undefined") {
    let Rollbar = require('rollbar');
    rollbar = new Rollbar({
        accessToken: process.env.ROLLBAR_TOKEN,
        handleUncaughtExceptions: true,
        handleUnhandledRejections: true
    });
}

if (rollbar == null) {
    console.log("Rollbar not initialized. Maybe missing ROLLBAR_TOKEN?");
}

const version = require('./package.json').version;
const io = require('socket.io-client');
const sha256 = require('sha256');
const base64 = require('base-64');

// Create a new isolate limited to 128MB
const ivm = require('isolated-vm');
const isolate = new ivm.Isolate({ memoryLimit: 128 });

// Create a new context within this isolate. Each context has its own copy of all the builtin
// Objects. So for instance if one context does Object.prototype.foo = 1 this would not affect any
// other contexts.
const context = isolate.createContextSync();

class Transformer {

    constructor(build_server) {

        this.client_id = null;

        // deepcode ignore MissingClose: The client will close with the app, constructor is called only once.
        this.socket = io(build_server);
        console.log(`${new Date().getTime()} -= THiNX Cloud Transformer ${version} =-`);
        this.setupSocket(this.socket);
        this.socket_id = null;
    }

    //
    // Main Logic
    //

    runJob(socket, body) {

        // todo: run the job as in Transformer and return a response...
        // socket.emit('result', result);

        let ingress = {};
        try {
          ingress = JSON.parse(body);
        } catch (e) {
          ingress = body;
          console.log("Request should be a JSON.");
        }
    
        let jobs = ingress.jobs;
        if (typeof (ingress.jobs) === "undefined") {
          console.log("Missing jobs.");
          return;
        }
    
        let device = ingress.device;
    
        if (typeof (device) === "undefined") {
            console.log("Missing device.");
          return;
        }
    
        console.log(new Date().toString() + "Incoming job.");
        
        this.transform(socket, jobs);
    }

    setupSocket(socket) {
        
        // Connectivity Events

        socket.on('connect', () => { 
            socket.emit('register', { status: "Hello from Transformer.", id: this.socket_id, running: this.running });
        });

        socket.on('disconnect', () => { 
            console.log(`${new Date().getTime()} » Transformer socket disconnected.`);
        });

        // either by directly modifying the `auth` attribute
        socket.on("connect_error", () => {
            if ((typeof(process.env.WORKER_SECRET) !== "undefined")) {
                if (typeof(socket.auth) !== "undefined") {
                    socket.auth.token = process.env.WORKER_SECRET;
                    console.log(`${new Date().getTime()} connect_error attempt to resolve using WORKER_SECRET`);
                }
                setTimeout(function(){
                    socket.connect();
                }, 10000);
            }
        });

        // Business Logic Events

        socket.on('job', (data) => { 
            console.log(new Date().getTime(), `» Transformer has new job:`, data);
            this.runJob(socket, data);
            console.log(`${new Date().getTime()} [info] » Job synchronously completed.`);
        });
    }

    // Transformer Logic

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
    
      sanitize(code) {
    
        let cleancode;
    
        try {
          let decoded = false;
    
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

        let jobs_string = JSON.stringify(jobs);
        let identifier = sha256(jobs_string); // can be validated on the other side
        
        let input_raw = jobs[0].params.status;
        let status = input_raw; // should be rather an array
        let error = null;
        for (let job_index in jobs) {
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
        callback(identifier, status, error);
      }
    
      transform(socket, jobs) {
        this.process_jobs(jobs, (identifier, status, error) => {
            socket.emit({
                identifier: identifier, // sha256 of the request processed... must be validated on the server side to fetch correct result from queue
                output: status,
                error: error
              });
        });
      };
}

// Init phase off-class

let srv = process.env.THINX_SERVER;
let transformer = null;

if (typeof(srv) === "undefined" || srv === null) {
    console.log(`${new Date().getTime()} [critical] THINX_SERVER environment variable must be defined in order to build firmware with proper backend binding.`);
    process.exit(1);
} else {
    // fix missing http if defined in env file just like api:3100
    if (srv.indexOf("http") == -1) {
        srv = "http://" + srv;
    }
    console.log(`${new Date().getTime()} [info] » Starting build worker against ${srv}`);

    try {
        transformer = new Transformer(srv);
    } catch (e) {
        // in test environment there is a test worker running on additional port 3101 as well...
        console.log(`Caught exception ${e}`);
        let srv2 = srv1.replace(":3100", ":3101");
        // eslint-disable-next-line no-unused-vars
        transformer = new Transformer(srv2);
    }
}
