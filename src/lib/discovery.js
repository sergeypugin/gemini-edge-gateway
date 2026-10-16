import { DAY_HOURS_MS } from "./utils.js";

let CACHED_DATA = null;
let LAST_DISCOVERY_TIME = 0;
const CACHE_TTL_MS = DAY_HOURS_MS;
const MAX_KEYS_PER_BATCH = 40;

export async function getDiscoveryData(keys, env = null, forceBatch = false) {
  const now = Date.now();
  if (!forceBatch && CACHED_DATA && (now - LAST_DISCOVERY_TIME < CACHE_TTL_MS)) {
    return { ...CACHED_DATA, subrequestsUsed: 0 };
  }

  if (!keys || keys.length === 0) {
    throw new Error("No Gemini keys provided");
  }

  const parseVer = (str) => {
    const match = str.match(/gemini[-_]?(\d+(?:\.\d+)?)/i);
    return match ? parseFloat(match[1]) : 0;
  };

  // Считываем кэш статусов ключей из D1
  const cachedStatusMap = new Map();
  if (env?.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT key_id, is_valid, status_code, checked_at FROM keys_cache"
      ).all();
      if (Array.isArray(results)) {
        for (const r of results) {
          if (now - r.checked_at < CACHE_TTL_MS) {
            cachedStatusMap.set(r.key_id, { isValid: r.is_valid === 1, status: r.status_code });
          }
        }
      }
    } catch (e) {
      console.error("D1 keys_cache read error:", e);
    }
  }

  const validatedResults = [];
  let subrequestsUsed = 0;
  const keysToValidate = [];
  const keysPending = [];

  for (const k of keys) {
    if (cachedStatusMap.has(k.id)) {
      const cached = cachedStatusMap.get(k.id);
      validatedResults.push({ id: k.id, key: k.key, isValid: cached.isValid, status: cached.status });
    } else if (keysToValidate.length < MAX_KEYS_PER_BATCH) {
      keysToValidate.push(k);
    } else {
      keysPending.push(k);
    }
  }

  // Проверяем текущую пачку ключей через Google API
  if (keysToValidate.length > 0) {
    const batchPromises = keysToValidate.map(async (k) => {
      try {
        const cleanKey = encodeURIComponent(k.key.trim());
        subrequestsUsed++;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`, {
          signal: AbortSignal.timeout(5000),
        });
        return { id: k.id, key: k.key, isValid: res.ok, status: res.status };
      } catch {
        return { id: k.id, key: k.key, isValid: false, status: 0 };
      }
    });

    const batchResults = await Promise.all(batchPromises);

    // Сохраняем проверенную пачку в D1
    if (env?.DB) {
      for (const r of batchResults) {
        env.DB.prepare(`
          INSERT INTO keys_cache (key_id, is_valid, status_code, checked_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(key_id) DO UPDATE SET is_valid=excluded.is_valid, status_code=excluded.status_code, checked_at=excluded.checked_at
        `).bind(r.id, r.isValid ? 1 : 0, r.status, now).run().catch(() => { });
      }
    }

    validatedResults.push(...batchResults);
  }

  // Для ключей свыше лимита ставим флаг unchecked
  for (const k of keysPending) {
    validatedResults.push({ id: k.id, key: k.key, isValid: true, status: 0, unchecked: true });
  }

  // Активные ключи для работы роутера (все валидные + пока непроверенные)
  const activeKeys = validatedResults.filter((k) => k.isValid !== false);

  if (activeKeys.length === 0) {
    if (CACHED_DATA) return { ...CACHED_DATA, subrequestsUsed: 0 };
    throw new Error("All provided GEMINI_KEY entries failed validation via Google API");
  }

  // Запрашиваем список моделей через первый живой ключ (1 сетевой запрос)
  let rawModels = CACHED_DATA?.rawModels || [];
  if (!CACHED_DATA && activeKeys.length > 0) {
    try {
      const cleanKey = encodeURIComponent(activeKeys[0].key.trim());
      subrequestsUsed++;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        rawModels = (data.models || []).map((m) => m.name.replace(/^models\//, ""));
      }
    } catch { }
  }

  const isChatModel = (name) => /^gemini-\d+(\.\d+)?-(flash|flash-lite)(-preview)?$/i.test(name.toLowerCase());
  const chatModels = rawModels.filter(isChatModel);
  const sorted = chatModels.sort((a, b) => parseVer(b) - parseVer(a));

  const smart = sorted.filter((m) => !m.toLowerCase().includes("lite"));
  const lite = sorted.filter((m) => m.toLowerCase().includes("lite"));

  CACHED_DATA = {
    rawModels,
    chatModels,
    smart,
    lite,
    validatedKeys: validatedResults,
    activeKeys,
    hasMoreUnchecked: keysPending.length > 0,
    subrequestsUsed,
    lastUpdated: now,
  };
  LAST_DISCOVERY_TIME = now;

  return CACHED_DATA;
}
