// Mock isolated-vm before requiring transformer.js
jest.mock('isolated-vm');

const Transformer = require('./transformer.js');

/* example job:
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
*/

const base64 = require('base-64');
const safe_code = 'transformer = function(status, device) { console.log("transformer", device); return status; }';
const safe_code_64 = base64.encode(safe_code);
const mock_jobs = [{
  params: {
    status: "test-job-1",
    device: "test-device-id-1"
  },
  code: safe_code_64
},
{
  params: {
    status: "test-job-2",
    device: "test-device-id-2"
  },
  code: safe_code_64
}
];

let t = new Transformer();

// process(req, res)

// sanitize(code)
// does unescape and base64 decode; should actually do more than that or be called properly (e.g. unescape_code)
test('sanitize(code): decode base64-wrapped code', () => {
  let A = t.sanitize(safe_code);
  let B = t.sanitize(safe_code_64);
  expect(A.toString().match(B.toString()));
});

test('sanitize(code): decode bare code', () => {
  let A = t.sanitize(safe_code);
  expect(A.toString().match(safe_code));
});

test('process_jobs(jobs, callback)', (done) => {
  t.process_jobs(mock_jobs, (status) => {
    console.log("test result", status);
    done();
  });
});

test('process(req, res)', (done) => {
  let mock_req = {
    origin: "api",
    body: JSON.stringify({
      jobs: mock_jobs,
      device: "test-device-udid"
    })
  };
  let res = function (result) {
    console.log("end", result);
    done();
  };
  t.process(mock_req, res, (status) => {
    console.log("test result", status);
    done();
  });
});