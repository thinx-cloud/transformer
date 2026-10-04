/* jshint esversion: 8 */
// Quick 261004-seq: POST /do answers honestly and never logs what it transforms.
//
// isolated-vm is replaced by a controllable fake (the real module needs
// --no-node-snapshot, which jest does not pass). The fake records how the
// sandbox is configured, so the sandbox properties are pinned here too, and it
// runs a test-supplied `transform(status, device, globals)` in place of the
// compiled lambda, the way the real wrapper calls `rtn(transformer(...))`.

const mockSandbox = {
  isolates: [],
  instances: [],
  sources: [],
  runOptions: [],
  globals: [],
  released: 0,
  transform: (status) => status
};

jest.mock('isolated-vm', () => {
  class Isolate {
    constructor(options) {
      mockSandbox.isolates.push(options);
      mockSandbox.instances.push(this);
      this.isDisposed = false;
    }
    createContextSync() {
      // the real message, typo included (isolated-vm 6.2.0)
      if (this.isDisposed) throw new Error('Isolated is disposed');
      const globals = {};
      mockSandbox.globals.push(globals);
      return {
        global: {
          setSync: (name, value) => { globals[name] = value; },
          derefInto: () => ({})
        },
        release: () => { mockSandbox.released++; },
        _globals: globals
      };
    }
    compileScriptSync(source) {
      mockSandbox.sources.push(source);
      return {
        runSync: (context, options) => {
          mockSandbox.runOptions.push(options);
          const g = context._globals;
          g.rtn(mockSandbox.transform(g.__thinx_status, JSON.parse(g.__thinx_device_json), g));
        }
      };
    }
  }
  return { Isolate };
});

const http = require('http');
const util = require('util');
const base64 = require('base-64');
const Transformer = require('./transformer.js');

// Every value below must never reach a log line.
const SECRET_STATUS = 'Battery 3.71V SECRETSTATUS';
const SECRET_OWNER = 'ownerSECRET0123456789abcdef';
const SECRET_UDID = 'udid-marker-SECRETUDID'; // ggignore: planted log-leak marker, not a credential
const SECRET_CODE = 'function transformer(status, device) { return status + " SECRETCODE"; }';
const SECRET_LOG_ARG = 'SECRETLOGARG';
const SECRET_ERROR = 'SECRETERRORMESSAGE';
const SECRET_HEADER = 'SECRETHEADERVALUE';
const SECRETS = ['SECRETSTATUS', 'ownerSECRET', 'SECRET-udid', 'SECRETCODE', SECRET_LOG_ARG,
  SECRET_ERROR, SECRET_HEADER, base64.encode(SECRET_CODE).slice(0, 24), 'IncomingMessage'];

function job(code, status) {
  return {
    id: 'jsid:1',
    owner: SECRET_OWNER,
    codename: 'alias',
    code: code,
    params: {
      status: status,
      device: { udid: SECRET_UDID, owner: SECRET_OWNER }
    }
  };
}

function body(jobs) {
  return JSON.stringify({ jobs: jobs, device: SECRET_UDID });
}

let t;
let server;
let port;
let logged;
const spies = [];

function post(payload, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: '/do',
      method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Secret': SECRET_HEADER
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { json = null; }
        resolve({ status: res.statusCode, text: text, json: json, type: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function expectNoSecretsLogged() {
  const all = logged.join('\n');
  for (const secret of SECRETS) {
    expect(all).not.toContain(secret);
  }
}

beforeAll((done) => {
  t = new Transformer();
  server = http.createServer(t.app).listen(0, '127.0.0.1', () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

// the same rendering console.log uses, deep enough to reach request headers
function capture(...args) {
  logged.push(args.map((a) => (typeof a === 'string') ? a : util.inspect(a, { depth: 6 })).join(' '));
}

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    spies.push(jest.spyOn(console, level).mockImplementation(capture));
  }
  mockSandbox.sources.length = 0;
  mockSandbox.runOptions.length = 0;
  mockSandbox.globals.length = 0;
  mockSandbox.released = 0;
  mockSandbox.transform = (status) => status;
});

afterEach(() => {
  while (spies.length) spies.pop().mockRestore();
});

describe('POST /do response contract', () => {

  test('success answers {output: <string>} with no error and no success field', async () => {
    mockSandbox.transform = (status, device, g) => {
      g.log(SECRET_LOG_ARG, status, device);
      return 'transformed ' + device.udid.length;
    };
    const r = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ output: 'transformed ' + SECRET_UDID.length });
    expect(Object.keys(r.json)).toEqual(['output']);
    expect(r.type).toMatch(/application\/json/);
    expectNoSecretsLogged();
    expect(logged.join('\n')).toMatch(/\[transformer\] request [0-9a-f]{8} ok: 1 job\(s\)/);
  });

  test('base64-encoded code is accepted the same way', async () => {
    mockSandbox.transform = () => 'ok';
    const r = await post(body([job(base64.encode(SECRET_CODE), SECRET_STATUS)]));
    expect(r.json).toEqual({ output: 'ok' });
    expectNoSecretsLogged();
  });

  test('finite numbers and booleans are answered as strings', async () => {
    mockSandbox.transform = () => 42;
    let r = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(r.json).toEqual({ output: '42' });
    mockSandbox.transform = () => false;
    r = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(r.json).toEqual({ output: 'false' });
  });

  test('jobs chain: each job transforms the previous output', async () => {
    mockSandbox.transform = (status) => status + '+';
    const r = await post(body([job(SECRET_CODE, 'a'), job(SECRET_CODE, 'ignored')]));
    expect(r.json).toEqual({ output: 'a++' });
    expect(logged.join('\n')).toMatch(/\[transformer\] request [0-9a-f]{8} ok: 2 job\(s\)/);
  });

  test('sandbox timeout is a failure, never the input status', async () => {
    mockSandbox.transform = () => { throw new Error('Script execution timed out.'); };
    const r = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: false, error: 'sandbox_timeout' });
    expect(r.text).not.toContain('SECRETSTATUS');
    expectNoSecretsLogged();
    expect(logged.join('\n')).toMatch(/\[transformer\] request [0-9a-f]{8} failed: sandbox_timeout \(job 1 of 1\)/);
  });

  test('a lambda that throws answers sandbox_error and logs no exception text', async () => {
    mockSandbox.transform = () => {
      const e = new TypeError(SECRET_ERROR + ' ' + SECRET_STATUS);
      e.name = SECRET_ERROR;
      throw e;
    };
    const r = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(r.json).toEqual({ success: false, error: 'sandbox_error' });
    expectNoSecretsLogged();
    expect(logged.join('\n')).toMatch(/failed: sandbox_error \(job 1 of 1\)/);
  });

  test('isolate memory exhaustion answers sandbox_memory', async () => {
    mockSandbox.transform = () => { throw new Error('Isolate was disposed during execution due to memory limit'); };
    const r = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(r.json).toEqual({ success: false, error: 'sandbox_memory' });
  });

  test('after a memory-limit disposal the next request runs in a fresh isolate', async () => {
    mockSandbox.transform = () => {
      // isolated-vm disposes the isolate when a lambda exceeds memoryLimit
      mockSandbox.instances[mockSandbox.instances.length - 1].isDisposed = true;
      throw new Error('Isolate was disposed during execution due to memory limit');
    };
    const first = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(first.json).toEqual({ success: false, error: 'sandbox_memory' });

    mockSandbox.transform = (status) => status + ' ok';
    const second = await post(body([job(SECRET_CODE, 'next')]));
    expect(second.json).toEqual({ output: 'next ok' });
    expect(mockSandbox.isolates[mockSandbox.isolates.length - 1]).toEqual({ memoryLimit: 64 });
    expect(logged.join('\n')).toMatch(/\[transformer\] sandbox isolate recreated after disposal/);
    expectNoSecretsLogged();
  });

  test('a failure in a later job answers the failure, not the partial chain', async () => {
    let n = 0;
    mockSandbox.transform = (status) => {
      n++;
      if (n === 2) throw new Error('Script execution timed out.');
      return status + ' step1';
    };
    const r = await post(body([job(SECRET_CODE, SECRET_STATUS), job(SECRET_CODE, SECRET_STATUS)]));
    expect(r.json).toEqual({ success: false, error: 'sandbox_timeout' });
    expect(logged.join('\n')).toMatch(/failed: sandbox_timeout \(job 2 of 2\)/);
  });

  test('code referencing child_process is rejected before it is compiled', async () => {
    const code = 'function transformer(s) { require("child_process"); return "SECRETCODE"; }';
    const r = await post(body([job(code, SECRET_STATUS)]));
    expect(r.json).toEqual({ success: false, error: 'code_rejected' });
    expect(mockSandbox.sources).toHaveLength(0);
    expectNoSecretsLogged();
  });

  test('code without a transformer lambda answers lambda_missing and is not logged', async () => {
    const code = 'function SECRETCODE(s) { return s; }';
    const r = await post(body([job(code, SECRET_STATUS)]));
    expect(r.json).toEqual({ success: false, error: 'lambda_missing' });
    expect(mockSandbox.sources).toHaveLength(0);
    expectNoSecretsLogged();
    expect(logged.join('\n')).toMatch(/failed: lambda_missing \(job 1 of 1\)/);
  });

  test('a return value that is not a string, number or boolean answers output_invalid', async () => {
    for (const value of [undefined, null, { status: SECRET_STATUS }, NaN]) {
      mockSandbox.transform = () => value;
      const r = await post(body([job(SECRET_CODE, SECRET_STATUS)]));
      expect(r.json).toEqual({ success: false, error: 'output_invalid' });
    }
    expectNoSecretsLogged();
  });

  test('malformed jobs answer invalid_jobs instead of throwing', async () => {
    const shapes = [
      [],
      'not-an-array',
      [null],
      [{ code: SECRET_CODE }],
      [{ code: SECRET_CODE, params: null }],
      [{ params: { status: SECRET_STATUS, device: {} } }]
    ];
    for (const jobs of shapes) {
      const r = await post(JSON.stringify({ jobs: jobs, device: SECRET_UDID }));
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ success: false, error: 'invalid_jobs' });
    }
    expectNoSecretsLogged();
  });

  test('missing jobs or device keep their documented rejections', async () => {
    let r = await post(JSON.stringify({ device: SECRET_UDID }));
    expect(r.json).toEqual({ success: false, error: 'missing: body.jobs' });
    r = await post(JSON.stringify({ jobs: [job(SECRET_CODE, SECRET_STATUS)] }));
    expect(r.json).toEqual({ success: false, error: 'missing: device' });
    expectNoSecretsLogged();
  });

  test('an unparseable body answers 400 bad_request and logs no body fragment', async () => {
    const r = await post('{"jobs": [' + JSON.stringify(SECRET_CODE) + ' SECRETSTATUS');
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ success: false, error: 'bad_request' });
    expectNoSecretsLogged();
  });
});

describe('logging', () => {

  test('no request object, header, code, status or device data is logged on any path', async () => {
    mockSandbox.transform = (status, device, g) => {
      g.log(SECRET_LOG_ARG);
      g.log({ owner: device.owner });
      return status + ' SECRETSTATUS-out';
    };
    await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expectNoSecretsLogged();
    expect(logged.join('\n')).not.toContain('SECRETSTATUS-out');
    // the suppressed sandbox log() calls are counted, never forwarded
    expect(logged.join('\n')).toMatch(/sandbox log\(\) suppressed: 2 call\(s\)/);
  });

  test('sanitize() logs nothing about the code it fails to decode', () => {
    const bad = { toString: () => { throw new Error(SECRET_ERROR); } };
    t.sanitize(bad);
    expectNoSecretsLogged();
  });
});

describe('sandbox properties are unchanged', () => {

  test('64 MB isolate, 1000 ms run timeout, context released, data passed as values', async () => {
    mockSandbox.transform = (status) => status;
    const r = await post(body([job(SECRET_CODE, 'quote" \\ backslash')]));
    expect(r.json).toEqual({ output: 'quote" \\ backslash' });
    expect(mockSandbox.isolates.length).toBeGreaterThan(0);
    for (const options of mockSandbox.isolates) expect(options).toEqual({ memoryLimit: 64 });
    expect(mockSandbox.runOptions).toEqual([{ timeout: 1000 }]);
    expect(mockSandbox.released).toBe(1);
    expect(Object.keys(mockSandbox.globals[0]).sort())
      .toEqual(['__thinx_device_json', '__thinx_status', 'global', 'log', 'rtn']);
    expect(mockSandbox.sources[0]).not.toContain('quote"');
    expect(mockSandbox.sources[0]).toContain('rtn(transformer(__thinx_status, JSON.parse(__thinx_device_json)))');
  });

  test('the context is released when the lambda throws', async () => {
    mockSandbox.transform = () => { throw new Error('Script execution timed out.'); };
    await post(body([job(SECRET_CODE, SECRET_STATUS)]));
    expect(mockSandbox.released).toBe(1);
  });
});
