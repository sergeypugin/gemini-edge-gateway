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
    return unavailable();
  });

  const keys = Array.from({ length: 25 }, (_, index) => key(`K${index}`));
  const response = await executeStratifiedRouting(
    request(), body, "user", { smart: ["model-a", "model-b"], lite: [] }, keys, null, null, 0,
  );

  assert.equal(response.status, 429);
  assert.equal(calls.length, MAX_TOTAL_SUBREQUESTS);
  assert.equal(calls.slice(0, 40).filter((model) => model === "model-a").length, 25);
  assert.equal(calls.slice(0, 40).filter((model) => model === "model-b").length, 15);
  assert.equal(calls.slice(40).every((model) => model === "model-a"), true);
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
  assert.deepEqual(attempts.slice(4), [
    "model-order-a:O0",
    "model-order-b:O0",
    "model-order-a:O1",
    "model-order-b:O1",
  ]);
});

test("discovery subrequests reduce the total routing budget", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return unavailable();
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
