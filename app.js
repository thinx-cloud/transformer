let r = null; // Rollbar

function exists(x) {
    return ((typeof(x) === "undefined") || (x === null)) ? false : true;
}

function undef(x) {
    return !exists(x);
}

if (exists(process.env.ROLLBAR_ACCESS_TOKEN)) {
    var Rollbar = require('rollbar');
    r = new Rollbar({
        accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
        handleUncaughtExceptions: true,
        handleUnhandledRejections: true
    });
}

let Transformer = require("./trans.js");

// Init phase off-class

let srv = process.env.THINX_SERVER;

if (undef(srv)) {
    console.log(`${new Date().getTime()} [critical] THINX_SERVER environment variable must be defined in order to build firmware with proper backend binding.`);
    process.exit(1);
} 

console.log(`${new Date().getTime()} [info] » Starting transformer against ${srv}`);
const transformer = new Transformer(srv);

if (exists(r)) r.info("Transformer started", { context: "circle", environment: process.env.ENVIRONMENT, server: srv });
