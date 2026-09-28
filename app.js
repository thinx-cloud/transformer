const { rollbarServerToken } = require("./secrets.js");

let r = null; // Rollbar

function exists(x) {
    return ((typeof(x) === "undefined") || (x === null)) ? false : true;
}

function undef(x) {
    return !exists(x);
}

// ROLLBAR_SERVER_TOKEN, else ROLLBAR_ACCESS_TOKEN; a /run/secrets file first (D-03).
const rollbar_token = rollbarServerToken();
if (rollbar_token) {
    var Rollbar = require('rollbar');
    r = new Rollbar({
        accessToken: rollbar_token,
        handleUncaughtExceptions: true,
        handleUnhandledRejections: true
    });
} else {
    console.log(`${new Date().getTime()} [info] ROLLBAR_SERVER_TOKEN not set — Rollbar reporting disabled`);
}

let Transformer = require("./trans.js");

// Init phase off-class

let srv = process.env.THINX_SERVER;

if (undef(srv)) {
    console.log(`${new Date().getTime()} [critical] THINX_SERVER environment variable must be defined in order to build firmware with proper backend binding.`);
    process.exit(1);
} 

console.log(`${new Date().getTime()} [info] » Starting transformer against ${srv}`);
new Transformer(srv);

if (exists(r)) r.info("Transformer started", { context: "circle", environment: process.env.ENVIRONMENT, server: srv });
