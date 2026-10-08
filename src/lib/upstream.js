export async function fetchWithStreamTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeoutError = () => new DOMException("Upstream response timed out", "TimeoutError");
  let timer;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  };
  const abort = () => controller.abort(options.signal.reason);
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  resetTimer();

  let reader;
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.body) {
      cleanup();
      return response;
    }
    reader = response.body.getReader();
    const read = async () => {
      controller.signal.throwIfAborted();
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([reader.read(), aborted]);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
      }
    };
    let first = await read();
    clearTimeout(timer);
    const body = new ReadableStream({
      async pull(streamController) {
        try {
          let chunk;
          if (first) {
            chunk = first;
            first = null;
          } else {
            resetTimer();
            chunk = await read();
            clearTimeout(timer);
          }
          if (chunk.done) {
            cleanup();
            streamController.close();
          } else {
            streamController.enqueue(chunk.value);
          }
        } catch (err) {
          cleanup();
          controller.abort(err);
          await reader.cancel(err).catch(() => { });
          streamController.error(err);
        }
      },
      async cancel(reason) {
        cleanup();
        controller.abort(reason);
        await reader.cancel(reason).catch(() => { });
      },
    });
    return new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (err) {
    cleanup();
    if (reader) await reader.cancel(err).catch(() => { });
    throw controller.signal.aborted ? controller.signal.reason : err;
  }
}
