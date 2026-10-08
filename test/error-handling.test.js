import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import gateway from "../src/index.js";
import { classifyGoogleError } from "../src/lib/utils.js";
import { getPersistentLogs, getRecentLogs, logError, logSuccess, logWarn } from "../src/lib/logger.js";
import {
  INTERNAL_ERROR_MESSAGE,
  MAX_LOG_DETAILS_LENGTH,
  MAX_LOG_FIELD_LENGTH,
  MAX_LOG_MESSAGE_LENGTH,
  normalizeErrorMessage,
  redactText,
  sanitizeErrorDetails,
} from "../src/lib/errors.js";

function captureConsole(t) {
  const output = [];
  for (const method of ["log", "warn", "error"]) {
    t.mock.method(console, method, (...args) => output.push(args.join(" ")));
  }
  return output
    ;
}

function fakeDatabase(results = []) {
  const writes = [];
  const queries = [];
  const pending = [];
  return {
    writes,
    queries,
    env: {
      DB: {
        prepare(sql) {
          queries.push(sql);
          return {
            bind(...values) {
              return {
                async run() { writes.push(values); },
                async all() { return { results }; },
              };
            },
          };
        },
      },
    },
    ctx: { waitUntil(promise) { pending.push(promise); } },
    async flush() { await Promise.all(pending); },
  };
}

function assertPublicLog(entry) {
  assert.ok(!Object.hasOwn(entry, "details"));
  assert.ok(entry.message.length <= MAX_LOG_MESSAGE_LENGTH);
  assert.ok(entry.model.length <= MAX_LOG_FIELD_LENGTH);
  assert.ok(entry.key.length <= MAX_LOG_FIELD_LENGTH);
  assert.ok(entry.timestamp.length <= 40);
}

const signatureMessage = "Function call is missing a thought_signature in functionCall parts. " + "private prompt ".repeat(10000);

test("normalization uses short meaningful categories rather than upstream text", () => {
  const cases = [
    [signatureMessage, 400, "Missing or invalid thought signature"],
    ["Model Overloaded (503)", 503, "Upstream service unavailable"],
    ["RPD Limit (Requests/Day)", 429, "RPD Daily Limit"],
    ["TPM Token Limit", 429, "TPM Token Limit"],
    ["RPM Minute Limit (60s)", 429, "RPM Minute Limit"],
    ["Zero Free Quota (limit: 0)", 429, "Zero Free Quota (limit: 0)"],
    ["Timeout (30s) -- Model Frozen", 0, "Upstream request timed out"],
    ["API key not valid", 403, "Auth Error (Invalid Key)"],
    ["NOT_FOUND", 404, "Model Deprecated/Not Found (404)"],
    ["INVALID_ARGUMENT", 400, "Invalid upstream request"],
    ["unknown failure " + "sensitive ".repeat(10000), 418, "Upstream request failed"],
    [null, 429, "Upstream rate limit exceeded"],
    [{ message: "sensitive" }, 0, "Upstream request failed"],
    [INTERNAL_ERROR_MESSAGE, 500, INTERNAL_ERROR_MESSAGE],
  ];
  for (const [message, status, expected] of cases) {
    assert.equal(normalizeErrorMessage(message, status), expected);
    assert.equal(normalizeErrorMessage(expected, status), expected);
    assert.ok(expected.length <= MAX_LOG_MESSAGE_LENGTH);
  }
});

test("Google classification distinguishes thought signatures and tolerates malformed details", () => {
  for (const message of [signatureMessage, "Missing thought signature", "Invalid thoughtSignature"]) {
    assert.equal(classifyGoogleError(400, { message }).type, "THOUGHT_SIGNATURE");
  }
  for (const details of [null, {}, "invalid", [null, 1, { "@type": 42 }, { "@type": "QuotaFailure", violations: {} }]]) {
    assert.equal(classifyGoogleError(429, { message: { text: "error" }, details }).type, "RPM");
  }
  const quota = { details: [{ "@type": "google.rpc.QuotaFailure", violations: [null, { quotaId: 42, quotaMetric: {} }, { quotaId: "RequestsPerDay" }] }] };
  assert.equal(classifyGoogleError(429, quota).type, "RPD");
  quota.details[0].violations.push({ quotaMetric: "input_token_count" });
  assert.equal(classifyGoogleError(429, quota).type, "TPM");
  assert.equal(classifyGoogleError(400, { message: 42, status: {} }).type, "INVALID_ARGUMENT");
  assert.equal(classifyGoogleError(400, { message: "Please pass a valid API key" }).type, "AUTH");
  assert.equal(classifyGoogleError(418, null).type, "OTHER");
});

test("diagnostics redact credentials and remain bounded for hostile values", () => {
  const secret = "sensitive-credential";
  const googleKey = "AIza" + "x".repeat(35);
  const details = {
    Authorization: `Bearer ${secret}`,
    api_key: secret,
    accessToken: secret,
    password: secret,
    GEMINI_KEY_1: secret,
    thought_signature: secret,
    nested: { url: `https://example.test/?key=${secret}&auth=${secret}`, note: `Bearer ${secret} ${googleKey}` },
    json: JSON.stringify({ api_key: secret, password: "private password with spaces" }),
    quotaId: "RequestsPerDay",
    huge: "x".repeat(100000),
    bigint: 1n,
    error: new Error(`network failed: token=${secret}`),
  };
  details.self = details;
  const serialized = JSON.stringify(sanitizeErrorDetails(`failed: key=${secret}`, details));
  assert.ok(Buffer.byteLength(serialized, "utf8") <= MAX_LOG_DETAILS_LENGTH);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes(googleKey));
  assert.ok(!serialized.includes("private password"));
  assert.ok(serialized.includes("RequestsPerDay"));
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(serialized.includes("[CIRCULAR]"));
  assert.equal(redactText("abcdef", 1), "a");
  assert.equal(redactText("abcdef", 2), "ab");
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ["\\\"".repeat(32) + index, "\\\"".repeat(1000)]));
  assert.ok(Buffer.byteLength(JSON.stringify(sanitizeErrorDetails("x".repeat(511), wide)), "utf8") <= MAX_LOG_DETAILS_LENGTH);
  const unicode = Array.from({ length: 16 }, () => "\u4e2d".repeat(1000));
  assert.ok(Buffer.byteLength(JSON.stringify(sanitizeErrorDetails("failure", unicode)), "utf8") <= MAX_LOG_DETAILS_LENGTH);
  const throwing = { get message() { throw new Error(secret); } };
  assert.deepEqual(sanitizeErrorDetails(null, throwing), { message: "Error details unavailable" });
});

test("logger bounds console, memory and D1 entries without exposing diagnostics", async t => {
  const output = captureConsole(t);
  const db = fakeDatabase();
  const details = { apiKey: "sensitive-credential", error: { message: signatureMessage, status: "INVALID_ARGUMENT" } };
  logWarn("model".repeat(10000), "GEMINI_KEY_1", 400, signatureMessage, details, 25, db.env, db.ctx);
  logError("sensitive-credential " + "x".repeat(100000), 0, details, db.env, db.ctx);
  logSuccess("model".repeat(10000), "GEMINI_KEY_1", 15, db.env, db.ctx);
  await db.flush();
  assert.equal(db.writes.length, 3);
  assert.equal(db.writes[0][2], "Missing or invalid thought signature");
  assert.ok(db.writes[0][7].length <= MAX_LOG_DETAILS_LENGTH);
  assert.ok(db.writes[0][7].includes("INVALID_ARGUMENT"));
  assert.ok(!db.writes[0][7].includes("sensitive-credential"));
  for (const line of output) {
    assert.ok(line.length < 600);
    assert.ok(!line.includes("private prompt"));
    assert.ok(!line.includes("sensitive-credential"));
  }
  const logs = getRecentLogs();
  for (const log of logs) assertPublicLog(log);
  logs[0].message = "mutated";
  logs.pop();
  assert.equal(getRecentLogs()[0].message, "Success");
  const fallback = await getPersistentLogs(null);
  for (const log of fallback) assertPublicLog(log);
  fallback[0].message = "mutated";
  assert.equal(getRecentLogs()[0].message, "Success");
});

test("persistent public logs sanitize legacy rows and ignore malformed raw details", async () => {
  const row = {
    timestamp: "invalid " + "x".repeat(10000), level: "warn", message: signatureMessage,
    model: "model".repeat(10000), key: "key=private-credential", status: 400,
    durationMs: 25, details: "not JSON: private raw diagnostics", extra: "private extra field",
  };
  const db = fakeDatabase(Array.from({ length: 250 }, () => row));
  const logs = await getPersistentLogs(db.env);
  assert.equal(logs.length, 200);
  assert.ok(!db.queries[0].includes("details"));
  assert.equal(logs[0].message, "Missing or invalid thought signature");
  for (const entry of logs) assertPublicLog(entry);
  assert.ok(!JSON.stringify(logs).includes("private"));
  assert.ok(!Object.hasOwn(logs[0], "extra"));
});

test("D1 failures use safe console diagnostics and public memory fallback", async t => {
  const output = captureConsole(t);
  const pending = [];
  const env = { DB: { prepare() { throw new Error("Bearer private-credential " + "x".repeat(10000)); } } };
  logError("unknown failure", 0, null, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  const logs = await getPersistentLogs(env);
  assert.ok(logs.length > 0);
  for (const entry of logs) assertPublicLog(entry);
  assert.ok(output.includes("D1 log persistence failed"));
  assert.ok(output.includes("D1 log retrieval failed"));
  assert.ok(!output.join(" ").includes("private-credential"));
});

test("in-memory log count remains bounded", t => {
  captureConsole(t);
  for (let index = 0; index < 1010; index++) logError("failure", 0);
  assert.equal(getRecentLogs().length, 1000);
});

test("stats exceptions return generic errors with CORS", async t => {
  captureConsole(t);
  const response = await gateway.fetch(new Request("https://gateway.test/api/stats"), {}, {});
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(await response.json(), { error: INTERNAL_ERROR_MESSAGE });
});

test("chat discovery exceptions do not return upstream diagnostics", async t => {
  const output = captureConsole(t);
  const secret = "private-credential";
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }));
  const env = {
    AUTH_SECRET: "test-auth", GEMINI_KEY_1: "test-key",
    DB: {
      prepare(sql) {
        if (sql.includes("SELECT")) return { async all() { return { results: [] }; } };
        throw new Error(`Bearer ${secret} ` + "x".repeat(10000));
      },
    },
  };
  const response = await gateway.fetch(new Request("https://gateway.test/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer test-auth" }, body: "{}",
  }), env, {});
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { message: INTERNAL_ERROR_MESSAGE, type: "internal_server_error", code: 500 } });
  assert.ok(!output.join(" ").includes(secret));
});

test("request setup exceptions, including non-Error throws, are handled safely", async t => {
  const output = captureConsole(t);
  for (const thrown of [null, "private diagnostic", new Error("Bearer private-credential")]) {
    const request = { get url() { throw thrown; } };
    const response = await gateway.fetch(request, {}, {});
    assert.equal(response.status
      , 500);
    assert.deepEqual(await response.json(), { error: { message: INTERNAL_ERROR_MESSAGE, type: "internal_server_error", code: 500 } });
  }
  assert.ok(!output.join(" ").includes("private"));
});

test("dashboard escapes and bounds all log cells and whitelists level classes", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const rows = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", innerHTML: "", style: {},
      addEventListener() { }, setAttribute() { },
      insertAdjacentHTML(position, html) { rows.push(html); },
      querySelector() { return element(id + "-child"); },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], documentElement: element("root"), body: element("body") },
    window: { addEventListener() { }, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    setInterval() { }, setTimeout() { }, fetch: () => new Promise(() => { }),
  });
  vm.runInContext(source, context);
  const attack = '<img src=x onerror="alert(1)"> & \'quoted\'';
  const log = {
    timestamp: attack, level: 'warn" onclick="alert(1)', message: attack + "x".repeat(10000),
    model: attack, key: attack, status: attack, durationMs: attack,
  };
  vm.runInContext(`allLogs = ${JSON.stringify([log, { message: {}, level: {}, durationMs: {} }])}; renderNextLogsChunk();`, context);
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].includes("<img"));
  assert.ok(!rows[0].includes('class="lvl-warn"'));
  assert.ok(rows[0].includes('class="lvl-error"'));
  assert.ok(rows[0].includes("&lt;img"));
  assert.ok(rows[0].includes("&quot;"));
  assert.ok(rows[0].includes("&amp;"));
  assert.ok(rows[0].includes("&#39;"));
  assert.ok(rows[0].length < 2000);
  assert.ok(!rows[0].includes("x".repeat(161)));
  vm.runInContext(`renderKeys([{ id: ${JSON.stringify(attack)}, status: ${JSON.stringify(attack)}, isValid: false }]); renderModels({ smart: [${JSON.stringify(attack)}] }); renderMatrix(${JSON.stringify({ [attack]: { [attack]: { status: attack } } })});`, context);
  for (const id of ["keys-status-container", "smart-list", "matrix-table-child"]) {
    assert.ok(!element(id).innerHTML.includes("<img"));
    assert.ok(element(id).innerHTML.includes("&lt;img"));
  }
});
