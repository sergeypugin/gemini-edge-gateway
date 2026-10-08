import { getPersistentLogs } from "./logger.js";
import { getRouterLiveState } from "./router.js";
import { getTodayMidnightUtc, DEFAULT_TIMEOUT_DELAY_MS, DAY_HOURS_MS } from "./utils.js";

let matrix = {};
let lastResponse = null;
let totalRequests = 0;

export function recordSuccess(model, keyId, user, env = null, ctx = null) {
  totalRequests += 1;
  lastResponse = {
    model,
    keyId,
    user,
    timestamp: new Date().toISOString(),
  };

  if (!matrix[model]) {
    matrix[model] = {};
  }
  matrix[model][keyId] = (matrix[model][keyId] || 0) + 1;

  if (env?.DB && ctx?.waitUntil) {
    const payload = JSON.stringify({ matrix, lastResponse, totalRequests });
    ctx.waitUntil(
      env.DB.prepare(`
        INSERT INTO stats_kv (key, value, updated_at)
        VALUES ('gateway_stats', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(payload, Date.now()).run().catch((err) => {
        console.error("D1 stats persist error:", err);
      })
    );
  }
}

export async function getAnalyticsSnapshot(discoveryData, allKeys, env) {
  if (totalRequests === 0 && env?.DB) {
    try {
      const row = await env.DB.prepare(
        "SELECT value FROM stats_kv WHERE key = 'gateway_stats'"
      ).first();

      if (row?.value) {
        const saved = JSON.parse(row.value);
        matrix = saved.matrix || {};
        lastResponse = saved.lastResponse || null;
        totalRequests = saved.totalRequests || 0;
      }
    } catch (err) {
      console.error("D1 stats read error:", err);
    }
  }

  const logs = await getPersistentLogs(env);
  const liveState = getRouterLiveState();
  const now = Date.now();
  const todayMidnightMs = getTodayMidnightUtc();

  // Загружаем актуальные состояния из matrix_state
  const dbStates = {};
  if (env?.DB) {
    try {
      const { results } = await env.DB.prepare("SELECT model, key_id, status, updated_at FROM matrix_state").all();
      for (const row of results) {
        dbStates[`${row.model}:${row.key_id}`] = row;
      }
    } catch (e) {
      console.error("D1 matrix_state read error:", e);
    }
  }

  const formattedMatrix = {};
  const allModels = discoveryData ? [...discoveryData.smart, ...discoveryData.lite] : Object.keys(matrix);
  const uniqueModels = [...new Set(allModels)];

  // Определяем невалидные ключи и модели на основе БД и Discovery
  const deadKeysFromDb = new Set();
  if (discoveryData?.validatedKeys) {
    for (const k of discoveryData.validatedKeys) {
      if (k.isValid === false) {
        deadKeysFromDb.add(k.id);
      }
    }
  }

  const deadModelsFromDb = {};
  for (const pairKey in dbStates) {
    const row = dbStates[pairKey];
    if (row.status === "KEY_ERR") deadKeysFromDb.add(row.key_id);
    if (row.status === "404" && (now - row.updated_at < DAY_HOURS_MS)) {
      deadModelsFromDb[row.model] = "404";
    }
    if (row.status === "limit: 0" && (now - row.updated_at < DAY_HOURS_MS)) {
      deadModelsFromDb[row.model] = "limit: 0";
    }
  }

  for (const model of uniqueModels) {
    formattedMatrix[model] = {};
    const isModel503 = (liveState.modelCooldowns[model] && liveState.modelCooldowns[model] > now) ||
      Object.values(dbStates).some(r => r.model === model && r.status === "503" && (now - r.updated_at < 60000));
    const isModelTimeout = (liveState.modelCooldowns[model] && liveState.modelCooldowns[model] > now) ||
      Object.values(dbStates).some(r => r.model === model && r.status === "TIMEOUT" && (now - r.updated_at < DEFAULT_TIMEOUT_DELAY_MS));

    for (const key of allKeys) {
      const pairKey = `${model}:${key.id}`;
      const hits = (matrix[model] && matrix[model][key.id]) || 0;
      const dbRow = dbStates[pairKey];

      let status = "-";
      const unlockTime = liveState.pairCooldowns[pairKey];
      const isDeadKey = liveState.deadKeys.includes(key.id) || deadKeysFromDb.has(key.id);
      const isDeadModel = liveState.deadModels.includes(model) || !!deadModelsFromDb[model];
      const deadReason = (liveState.deadModelsMap && liveState.deadModelsMap[model]) || deadModelsFromDb[model] || "404";
      const isRpdActive = (unlockTime && unlockTime > now) || (dbRow?.status === "RPD" && dbRow.updated_at >= todayMidnightMs);

      // Иерархия приоритетов статусов ячейки:
      // 1. Мертвая модель (404, limit: 0) -- красит всю строку
      // 2. Мертвый ключ (KEY_ERR) -- красит всю колонку
      // 3. Исчерпанный суточный лимит (RPD) -- статус ячейки до 00:00 UTC
      // 4. Перегрузка модели (503) -- красит всю строку, кроме ячеек с RPD и KEY_ERR
      // 5. Таймаут модели (TIMEOUT) -- красит всю строку, кроме ячеек с RPD и KEY_ERR
      // 6. Локальные временные статусы (RPM, TPM) -- до 60 секунд
      // 7. Последний подтвержденный статус (200) или прочерк (-)
      if (isDeadModel) {
        status = (dbRow?.status === "limit: 0" || dbRow?.status === "404") ? dbRow.status : deadReason;
      } else if (isDeadKey) {
        status = "KEY_ERR";
      } else if (isRpdActive) {
        status = "RPD";
      } else if (isModel503) {
        status = "503";
      } else if (isModelTimeout) {
        status = "TIMEOUT";
      } else if (dbRow) {
        const effectiveDbStatus = dbRow.status === "429" ? "RPM" : dbRow.status;
        const ttlMs = effectiveDbStatus === "TIMEOUT" ? DEFAULT_TIMEOUT_DELAY_MS : 60000;
        if (effectiveDbStatus === "RPD") {
          status = (dbRow.updated_at >= todayMidnightMs) ? "RPD" : "-";
        } else if (["503", "RPM", "TPM", "TIMEOUT"].includes(effectiveDbStatus)) {
          status = (now - dbRow.updated_at < ttlMs) ? effectiveDbStatus : "-";
        } else {
          status = effectiveDbStatus;
        }
      }

      formattedMatrix[model][key.id] = { hits, status };
    }
  }

  let successCount = 0;
  let errorCount = 0;

  if (env?.DB) {
    try {
      const statsRow = await env.DB.prepare(`
        SELECT
          COUNT(CASE WHEN level = 'success' THEN 1 END) as success_count,
          COUNT(CASE WHEN level = 'error' THEN 1 END) as error_count
        FROM logs
      `).first();

      if (statsRow) {
        successCount = statsRow.success_count || 0;
        errorCount = statsRow.error_count || 0;
      }
    } catch (e) {
      console.error("D1 stats counts error:", e);
    }
  }

  // Если в D1 записей нет, считаем по memoryLogs
  if (successCount === 0 && errorCount === 0 && logs.length > 0) {
    successCount = logs.filter(l => l.level === "success").length;
    errorCount = logs.filter(l => l.level === "error").length;
  }

  const totalEvaluated = successCount + errorCount;
  const successRate = totalEvaluated > 0
    ? `${((successCount / totalEvaluated) * 100).toFixed(1)}% (${successCount}/${totalEvaluated})`
    : "100% (0/0)";

  return {
    totalRequests,
    successRate,
    successCount,
    errorCount,
    lastResponse,
    matrix: formattedMatrix,
    logs,
    discovery: discoveryData ? {
      lastUpdated: new Date(discoveryData.lastUpdated).toISOString(),
      rawCount: discoveryData.rawModels.length,
      rawModels: discoveryData.rawModels,
      smart: discoveryData.smart,
      lite: discoveryData.lite,
      keysStatus: discoveryData.validatedKeys.map((k) => {
        const isDead = liveState.deadKeys.includes(k.id) || deadKeysFromDb.has(k.id) || !k.isValid;
        return {
          id: k.id,
          isValid: !isDead,
          status: isDead ? (k.status && k.status !== 200 ? k.status : 400) : k.status,
          unchecked: k.unchecked || false,
        };
      }),
    } : null,
  };
}
