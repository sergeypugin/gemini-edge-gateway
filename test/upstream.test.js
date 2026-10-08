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
  const { response } = await fetchWithStreamTimeout("https://example.test", options(), 80);
  assert.equal(await response.text(), "AAAAAAAAA");
});

test("TTFB includes header wait and the wait for the first nonempty body chunk", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    await sleep(15);
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array());
        await sleep(15);
        controller.enqueue(new Uint8Array([65]));
        await sleep(15);
        controller.close();
      },
    }));
  });
  const result = await fetchWithStreamTimeout("https://example.test", options(), 100);
  assert.ok(result.ttfbMs >= 20, `TTFB was ${result.ttfbMs}ms`);
  assert.equal(await result.response.text(), "A");
  assert.ok((await result.responseCompletion) >= 0);
});

test("response duration measures from the first byte until upstream EOF", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([65]));
      await sleep(20);
      controller.enqueue(new Uint8Array([66]));
      await sleep(20);
      controller.close();
    },
  })));
  const result = await fetchWithStreamTimeout("https://example.test", options(), 100);
  assert.equal(result.ttfbMs >= 0, true);
  assert.equal(await result.response.text(), "AB");
  assert.ok((await result.responseCompletion) >= 30);
});

test("headers without the first body byte still time out", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })));
  await assert.rejects(fetchWithStreamTimeout("https://example.test", options(), 20), { name: "TimeoutError" });
  assert.equal(cancelled, true);
});

test("a stalled stream reports an idle timeout and unknown response duration", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([65])); },
  })));
  const result = await fetchWithStreamTimeout("https://example.test", options(), 20);
  await assert.rejects(result.response.text(), { name: "TimeoutError" });
  assert.equal(await result.responseCompletion, null);
});

test("consumer backpressure is not an upstream timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("ready"));
  const result = await fetchWithStreamTimeout("https://example.test", options(), 20);
  await sleep(60);
  assert.equal(await result.response.text(), "ready");
  assert.ok((await result.responseCompletion) >= 0);
});

test("client cancellation is not a model timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream()));
  const controller = new AbortController();
  const pending = fetchWithStreamTimeout("https://example.test", { signal: controller.signal }, 200);
  controller.abort(new DOMException("Client disconnected", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
});

test("consumer cancellation leaves response duration unknown", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([65])); },
  })));
  const result = await fetchWithStreamTimeout("https://example.test", options(), 100);
  await result.response.body.cancel();
  assert.equal(await result.responseCompletion, null);
});

test("preserves upstream status, headers and error body", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('{"error":"bad request"}', {
    status: 400, headers: { "Content-Type": "application/json" },
  }));
  const result = await fetchWithStreamTimeout("https://example.test", options(), 20);
  assert.equal(result.response.status, 400);
  assert.equal(result.response.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await result.response.json(), { error: "bad request" });
  assert.ok((await result.responseCompletion) >= 0);
});
