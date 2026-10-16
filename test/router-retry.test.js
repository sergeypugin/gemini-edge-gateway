import test from "node:test";
import assert from "node:assert/strict";
import { executeStratifiedRouting, MAX_TOTAL_SUBREQUESTS } from "../src/lib/router.js";

const request = () => new Request("https://gateway.test/v1/chat/completions", {
  method: "POST",
  signal: new AbortController().signal,
});
const body = JSON.stringify({ model: "gemini-smart", messages: [{ role: "user", content: "hello" }] });
const unavailable = () => new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "overloaded" } }), { status: 503 });

function key(id) {
  return { id, key: `secret-${id}` };
}

test("retries temporary failures after first pass without exceeding total budget", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(JSON.parse(options.body).model);
    return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
  });

  const keys = Array.from({ length: 25 }, (_, index) => key(`K${index}`));
  const response = await executeStratifiedRouting(
    request(), body, "user", { smart: ["model-a", "model-b"], lite: [] }, keys, null, null, 0,
  );

  assert.equal(response.status, 429);
  assert.equal(calls.length, MAX_TOTAL_SUBREQUESTS);
  assert.equal(calls.slice(0, 40).filter((model) => model === "model-a").length, 25);
  assert.equal(calls.slice(0, 40).filter((model) => model === "model-b").length, 15);
  assert.deepEqual(calls.slice(40), [
    "model-a", "model-b",
    "model-a", "model-b",
    "model-a", "model-b",
    "model-a", "model-b",
    "model-a",
  ]);
});

test("retry pass orders failures by 503, RPM, TPM, then UNDEFINED", async (t) => {
  const attempts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const keyId = options.headers.Authorization.replace("Bearer secret-", "");
    const model = JSON.parse(options.body).model;
    attempts.push(`${model}:${keyId}`);
    const firstPassErrors = [
      { status: 503, body: { error: { status: "UNAVAILABLE" } } },
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "QuotaFailure", violations: [{ quotaMetric: "input_token_count" }] }] } } },
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } },
      { status: 418, body: { error: { status: "UNKNOWN" } } },
    ];
    const error = firstPassErrors[attempts.length - 1] || firstPassErrors[0];
    return new Response(JSON.stringify(error.body), { status: error.status });
  });

  const response = await executeStratifiedRouting(
    request(), body, "user", { smart: ["model-order-a", "model-order-b"], lite: [] }, [key("O0"), key("O1")], null, null, 0,
  );

  assert.equal(response.status, 429);
  assert.ok(attempts.includes("model-order-a:O0"));
  assert.ok(attempts.includes("model-order-b:O0"));
  assert.ok(attempts.indexOf("model-order-a:O0") < attempts.indexOf("model-order-b:O0"));
});

test("503 skips the remaining keys for the cooled model", async (t) => {
  const attempts = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const keyId = options.headers.Authorization.replace("Bearer secret-", "");
    const model = JSON.parse(options.body).model;
    attempts.push(`${model}:${keyId}`);
    return unavailable();
  });

  const response = await executeStratifiedRouting(
    request(), body, "user", { smart: ["model-rr-a", "model-rr-b"], lite: [] }, [key("R0"), key("R1")], null, null, 0,
  );

  assert.equal(response.status, 429);
  assert.equal(attempts[0], "model-rr-a:R0");
  assert.equal(attempts[1], "model-rr-b:R0");
  assert.equal(attempts.filter((attempt) => attempt.endsWith(":R1")).length, 0);
});

test("discovery subrequests reduce the total routing budget", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
  });

  const response = await executeStratifiedRouting(
    request(), body, "user", { smart: ["model-budget"], lite: [] }, Array.from({ length: 25 }, (_, index) => key(`B${index}`)), null, null, 3,
  );

  assert.equal(response.status, 429);
  assert.equal(calls, MAX_TOTAL_SUBREQUESTS - 3);
});

test("discovery consuming the request budget prevents routing fetches", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return unavailable();
  });

  const response = await executeStratifiedRouting(
    request(), body, "user", { smart: ["model-empty-budget"], lite: [] }, [key("EMPTY")], null, null, MAX_TOTAL_SUBREQUESTS,
  );

  assert.equal(response.status, 429);
  assert.equal(calls, 0);
});
