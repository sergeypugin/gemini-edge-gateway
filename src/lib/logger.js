import { MAX_LOG_FIELD_LENGTH, normalizeErrorMessage, redactText, sanitizeErrorDetails } from "./errors.js";

const MAX_MEMORY_LOGS = 1000;
const MAX_PERSISTED_LOGS = 200;
let memoryLogs = [];

function normalizeDuration(value) {
  return typeof value == "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function publicLogEntry(entry) {
  const level = ["success", "warn", "error"].includes(entry.level) ? entry.level : "error";
  return {
    timestamp: redactText(entry.timestamp, 40),
    level,
    message: level == "success" ? "Success" : normalizeErrorMessage(entry.message, entry.status),
    model: redactText(entry.model, MAX_LOG_FIELD_LENGTH),
    key: redactText(entry.key, MAX_LOG_FIELD_LENGTH),
    status: typeof entry.status == "number" && Number.isFinite(entry.status) ? entry.status : redactText(entry.status, 24),
    ttfbMs: normalizeDuration(entry.ttfbMs),
    responseMs: normalizeDuration(entry.responseMs),
  };
}

// Сохранение лога в SQLite базу D1
async function persistLogEntry(entry, env) {
  if (!env?.DB) return;
  try {
    return await env.DB.prepare(`
      INSERT INTO logs (timestamp, level, message, model, key_id, status, ttfb_ms, response_ms, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.timestamp,
      entry.level,
      entry.message,
      entry.model || null,
      entry.key || null,
      entry.status ?? null,
      normalizeDuration(entry.ttfbMs),
      normalizeDuration(entry.responseMs),
      entry.details ? JSON.stringify(entry.details) : null
    ).run();
  } catch (err) {
    console.error("D1 log persistence failed");
  }
}

function pushMemoryLog(entry) {
  const publicEntry = publicLogEntry(entry);
  memoryLogs.unshift(publicEntry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.pop();
  }
  return publicEntry;
}

// Успешный запрос
export function logSuccess(model, keyId, ttfbMs, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "success",
    message: "Success",
    model: redactText(model, MAX_LOG_FIELD_LENGTH),
    key: redactText(keyId, MAX_LOG_FIELD_LENGTH),
    status: 200,
    ttfbMs: normalizeDuration(ttfbMs),
    responseMs: null,
  };
  const publicEntry = pushMemoryLog(entry);

  let persistence = null;
  if (env?.DB) {
    persistence = persistLogEntry(entry, env);
    if (ctx?.waitUntil) ctx.waitUntil(persistence);
  }

  return async (responseMs) => {
    entry.responseMs = normalizeDuration(responseMs);
    publicEntry.responseMs = entry.responseMs;
    if (!persistence) return;

    try {
      const result = await persistence;
      const rowId = result?.meta?.last_row_id ?? result?.last_row_id;
      if (rowId == null || entry.responseMs == null) return;
      await env.DB.prepare("UPDATE logs SET response_ms = ? WHERE id = ?")
        .bind(entry.responseMs, rowId).run();
    } catch {
      console.error("D1 response timing update failed");
    }
  };
}

export function logWarn(model, keyId, status, message, rawDetails = null, ttfbMs = null, env = null, ctx = null, responseMs = null) {
  const entry = {
    ...publicLogEntry({ level: "warn", message, model, key: keyId, status, ttfbMs, responseMs }),
    timestamp: new Date().toISOString(),
    details: sanitizeErrorDetails(message, rawDetails),
  };

  pushMemoryLog(entry);
  console.warn(`[${entry.timestamp}] [WARN] ${entry.model} (${entry.key}) -> ${entry.status} ${entry.message}`);

  if (env?.DB && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

// Критический отказ шлюза
export function logError(message, status = 429, rawDetails = null, env = null, ctx = null, ttfbMs = null, responseMs = null) {
  const entry = {
    ...publicLogEntry({ level: "error", message, status, ttfbMs, responseMs }),
    timestamp: new Date().toISOString(),
    details: sanitizeErrorDetails(message, rawDetails),
  };

  pushMemoryLog(entry);
  console.error(`[${entry.timestamp}] [ERROR] ${entry.message} (${entry.status})`);

  if (env?.DB && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

export async function getPersistentLogs(env) {
  if (env?.DB) {
    try {
      const { results } = await env.DB.prepare(`
        SELECT timestamp, level, message, model, key_id AS key, status, ttfb_ms AS ttfbMs, response_ms AS responseMs
        FROM logs
        ORDER BY timestamp DESC
        LIMIT ?
      `).bind(MAX_PERSISTED_LOGS).all();

      if (Array.isArray(results) && results.length > 0) {
        return results.slice(0, MAX_PERSISTED_LOGS).map(publicLogEntry);
      }
    } catch (err) {
      console.error("D1 log retrieval failed");
    }
  }
  return getRecentLogs();
}

export function getRecentLogs() {
  return memoryLogs.map(publicLogEntry);
}
