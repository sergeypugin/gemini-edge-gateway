import { MAX_LOG_FIELD_LENGTH, normalizeErrorMessage, redactText, sanitizeErrorDetails } from "./errors.js";

const MAX_MEMORY_LOGS = 1000;
const MAX_PERSISTED_LOGS = 200;
let memoryLogs = [];

function publicLogEntry(entry) {
  const level = ["success", "warn", "error"].includes(entry.level) ? entry.level : "error";
  return {
    timestamp: redactText(entry.timestamp, 40),
    level,
    message: level == "success" ? "Success" : normalizeErrorMessage(entry.message, entry.status),
    model: redactText(entry.model, MAX_LOG_FIELD_LENGTH),
    key: redactText(entry.key, MAX_LOG_FIELD_LENGTH),
    status: typeof entry.status == "number" && Number.isFinite(entry.status) ? entry.status : redactText(entry.status, 24),
    durationMs: typeof entry.durationMs == "number" && Number.isFinite(entry.durationMs) ? entry.durationMs : null,
  };
}

// Сохранение лога в SQLite базу D1
async function persistLogEntry(entry, env) {
  if (!env?.DB) return;
  try {
    await env.DB.prepare(`
      INSERT INTO logs (timestamp, level, message, model, key_id, status, duration_ms, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.timestamp,
      entry.level,
      entry.message,
      entry.model || null,
      entry.key || null,
      entry.status ?? null,
      entry.durationMs ?? null,
      entry.details ? JSON.stringify(entry.details) : null
    ).run();
  } catch (err) {
    console.error("D1 log persistence failed");
  }
}

function pushMemoryLog(entry) {
  memoryLogs.unshift(publicLogEntry(entry));
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.pop();
  }
}

// Успешный запрос
export function logSuccess(model, keyId, durationMs, env = null, ctx = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "success",
    message: "Success",
    model: redactText(model, MAX_LOG_FIELD_LENGTH),
    key: redactText(keyId, MAX_LOG_FIELD_LENGTH),
    status: 200,
    durationMs: typeof durationMs == "number" && Number.isFinite(durationMs) ? durationMs : null,
  };

  pushMemoryLog(entry);
  console.log(`[${entry.timestamp}] [SUCCESS] ${entry.model} (${entry.key}) in ${entry.durationMs}ms`);

  if (env?.DB && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

export function logWarn(model, keyId, status, message, rawDetails = null, durationMs = null, env = null, ctx = null) {
  const entry = {
    ...publicLogEntry({ level: "warn", message, model, key: keyId, status, durationMs }),
    timestamp: new Date().toISOString(),
    details: sanitizeErrorDetails(message, rawDetails),
  };

  pushMemoryLog(entry);
  console.warn(`[${entry.timestamp}] [WARN] ${entry.model} (${entry.key}) -> ${entry.status} ${entry.message} in ${entry.durationMs != null ? entry.durationMs + 'ms' : 'N/A'}`);

  if (env?.DB && ctx?.waitUntil) {
    ctx.waitUntil(persistLogEntry(entry, env));
  }
}

// Критический отказ шлюза
export function logError(message, status = 429, rawDetails = null, env = null, ctx = null) {
  const entry = {
    ...publicLogEntry({ level: "error", message, status }),
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
        SELECT timestamp, level, message, model, key_id AS key, status, duration_ms AS durationMs
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
