import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithStreamTimeout } from "../src/lib/upstream.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = () => ({ signal: new AbortController().signal });

test("active generation may exceed the initial deadline", async (t) => {
  let interval;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      let count = 0;
      controller.enqueue(new Uint8Array([65]));
      interval = setInterval(() => {
        controller.enqueue(new Uint8Array([65]));
        if (++count == 8) {
          clearInterval(interval);
          controller.close();
        }
      }, 15);
    },
    cancel() { clearInterval(interval); },
  })));
  t.after(() => clearInterval(interval));
  const response = await fetchWithStreamTimeout("https://example.test", options(), 80);
  assert.equal(await response.text(), "AAAAAAAAA");
});

test("headers without the first body byte still time out", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })));
  await assert.rejects(fetchWithStreamTimeout("https://example.test", options(), 20), { name: "TimeoutError" });
  assert.equal(cancelled, true);
});

test("a stalled stream reports an idle timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([65])); },
  })));
  const response = await fetchWithStreamTimeout("https://example.test", options(), 20);
  await assert.rejects(response.text(), { name: "TimeoutError" });
});

test("consumer backpressure is not an upstream timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("ready"));
  const response = await fetchWithStreamTimeout("https://example.test", options(), 20);
  await sleep(60);
  assert.equal(await response.text(), "ready");
});

test("client cancellation is not a model timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream()));
  const controller = new AbortController();
  const pending = fetchWithStreamTimeout("https://example.test", { signal: controller.signal }, 200);
  controller.abort(new DOMException("Client disconnected", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
});

test("preserves upstream status, headers and error body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('{"error":"bad request"}', {
    status: 400, headers: { "Content-Type": "application/json" },
  }));
  const response = await fetchWithStreamTimeout("https://example.test", options(), 20);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await response.json(), { error: "bad request" });
});
