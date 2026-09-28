// SEC-CFG-02 / D-03: the transformer's copy of the API's readSecret, and the
// Rollbar server token read built on it. Fake values only; fs is wrapped so
// that only the /run/secrets paths these cases own are answered, and every
// other path is delegated to the real functions.

const fs = require("fs");

const NAMES = ["ROLLBAR_SERVER_TOKEN", "ROLLBAR_ACCESS_TOKEN", "SPEC_SECRET_NAME"];
const secretPath = (name) => "/run/secrets/" + name;
const ownedPath = (p) => NAMES.some((name) => p === secretPath(name));

let secrets, savedEnv, files, realExistsSync, realReadFileSync;

beforeEach(() => {
    savedEnv = {};
    NAMES.forEach((name) => { savedEnv[name] = process.env[name]; delete process.env[name]; });
    files = {};
    realExistsSync = fs.existsSync;
    realReadFileSync = fs.readFileSync;
    fs.existsSync = function (p) {
        if (ownedPath(p)) return Object.prototype.hasOwnProperty.call(files, p);
        return realExistsSync.apply(this, arguments);
    };
    fs.readFileSync = function (p) {
        if (ownedPath(p)) {
            if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error("ENOENT: " + p);
            return files[p] + "\n";
        }
        return realReadFileSync.apply(this, arguments);
    };
    secrets = require("./secrets.js");
    secrets._resetCacheForTests();
});

afterEach(() => {
    fs.existsSync = realExistsSync;
    fs.readFileSync = realReadFileSync;
    NAMES.forEach((name) => {
        if (typeof savedEnv[name] === "undefined") delete process.env[name];
        else process.env[name] = savedEnv[name];
    });
    if (secrets) secrets._resetCacheForTests();
});

describe("readSecret", () => {

    test("a /run/secrets file wins over env, trimmed", () => {
        process.env.SPEC_SECRET_NAME = "spec-env-value";
        files[secretPath("SPEC_SECRET_NAME")] = "spec-file-value";
        expect(secrets.readSecret("SPEC_SECRET_NAME")).toBe("spec-file-value");
    });

    test("env is used when there is no file", () => {
        process.env.SPEC_SECRET_NAME = "spec-env-value";
        expect(secrets.readSecret("SPEC_SECRET_NAME")).toBe("spec-env-value");
    });

    test("null (or the given default) when neither exists", () => {
        expect(secrets.readSecret("SPEC_SECRET_NAME")).toBeNull();
        secrets._resetCacheForTests();
        expect(secrets.readSecret("SPEC_SECRET_NAME", "d")).toBe("d");
    });

    test("a ../ name never reads a file", () => {
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const readSpy = jest.spyOn(fs, "readFileSync");
        try {
            expect(secrets.readSecret("../etc/passwd", "d")).toBe("d");
            expect(readSpy.mock.calls.some((call) => String(call[0]).includes("passwd"))).toBe(false);
        } finally {
            existsSpy.mockRestore();
            readSpy.mockRestore();
        }
    });

    test("the value is cached per name until _resetCacheForTests()", () => {
        process.env.SPEC_SECRET_NAME = "first";
        expect(secrets.readSecret("SPEC_SECRET_NAME")).toBe("first");
        process.env.SPEC_SECRET_NAME = "second";
        expect(secrets.readSecret("SPEC_SECRET_NAME")).toBe("first");
        secrets._resetCacheForTests();
        expect(secrets.readSecret("SPEC_SECRET_NAME")).toBe("second");
    });
});

describe("rollbarServerToken", () => {

    test("null when neither name resolves", () => {
        expect(secrets.rollbarServerToken()).toBeNull();
    });

    test("the access token when only it is set", () => {
        process.env.ROLLBAR_ACCESS_TOKEN = "spec-access-env-token";
        expect(secrets.rollbarServerToken()).toBe("spec-access-env-token");
    });

    test("the server token when both names are set", () => {
        process.env.ROLLBAR_ACCESS_TOKEN = "spec-access-env-token";
        process.env.ROLLBAR_SERVER_TOKEN = "spec-server-env-token";
        expect(secrets.rollbarServerToken()).toBe("spec-server-env-token");
    });

    test("the server token file wins over its env value", () => {
        process.env.ROLLBAR_ACCESS_TOKEN = "spec-access-env-token";
        process.env.ROLLBAR_SERVER_TOKEN = "spec-server-env-token";
        files[secretPath("ROLLBAR_SERVER_TOKEN")] = "spec-server-file-token";
        expect(secrets.rollbarServerToken()).toBe("spec-server-file-token");
    });
});
