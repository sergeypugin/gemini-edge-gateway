import { createGeminiStreamPipeline } from "./stream.js";
import { addMissingToolSignatures } from "./tool-signatures.js";
import { fetchWithStreamTimeout } from "./upstream.js";
import { recordSuccess } from "./analytics.js";
import { logSuccess, logWarn, logError, getPersistentLogs } from "./logger.js";
import {
  ONE_HOUR_MS,
  DAY_HOURS_MS,
  COOLDOWN_503_MS,
  DEFAULT_RPM_DELAY_MS,
  DEFAULT_TIMEOUT_DELAY_MS,
  getTodayMidnightUtc,
  getNextMidnightUtc,
  parseRetryDelayMs,
  classifyGoogleError
} from "./utils.js";

const DEFAULT_GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_SUBREQUESTS = 40;
const ATTEMPT_TIMEOUT_MS = 60 * 1000;

const modelCooldowns = {};
const pairCooldowns = {};
const deadKeys = new Set();
const deadModels = new Map();

const lastRpdUnblock = {};
let deadInitialized = false;

let lastSuccessfulKeyId = null;
let lastSuccessfulSmartModel = null;
let lastSuccessfulLiteModel = null;

export function saveMatrixStatus(model, keyId, status, env, ctx) {
  if (!env?.DB || !model || !keyId) return;
  const now = Date.now();
  const run = () => env.DB.prepare(`
    INSERT INTO matrix_state (model, key_id, status, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(model, key_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `).bind(model, keyId, status, now).run().catch((err) => {
    console.error("saveMatrixStatus error:", err);
  });

  if (ctx?.waitUntil) {
    ctx.waitUntil(run());
  } else {
    run();
  }
}

async function ensureDeadState(env) {
  if (deadInitialized) return;
  deadInitialized = true;
  if (!env?.DB) return;

  try {
    const todayMidnight = getTodayMidnightUtc();
    const { results } = await env.DB.prepare(`
      SELECT model, key_id, status, updated_at FROM matrix_state
    `).all();

    if (results && results.length > 0) {
      const now = Date.now();
      for (const row of results) {
        const { model, key_id, status, updated_at } = row;
        if (status === "404") {
          // Кэшируем 404 на 24 часа для автоперепроверки в новые сутки
          if (now - updated_at < DAY_HOURS_MS) {
            deadModels.set(model, "404");
          }
        } else if (status === "limit: 0") {
          // Кэшируем limit: 0 на 24 часа
          if (now - updated_at < DAY_HOURS_MS) {
            deadModels.set(model, "limit: 0");
          }
        } else if (status === "KEY_ERR") {
          deadKeys.add(key_id);
        } else if (status === "RPD") {
          // Если RPD зафиксирован до сегодняшних 00:00 UTC -- игнорируем (сброшен на новые сутки)
          if (updated_at >= todayMidnight) {
            const pairKey = `${model}:${key_id}`;
            pairCooldowns[pairKey] = getNextMidnightUtc();
          }
        }
      }
    }
  } catch (err) {
    console.error("ensureDeadState error:", err);
  }
}

// Two-Zone Split
function prepareSanitizedTemplate(rawText) {
  const firstImageIndex = rawText.indexOf('"image_url"');
  let cutoff = rawText.length;

  if (firstImageIndex !== -1) {
    const msgStart = rawText.lastIndexOf('{"role"', firstImageIndex);
    cutoff = msgStart !== -1 ? msgStart : firstImageIndex;
  }

  let metaZone = rawText.slice(0, cutoff);
  let dataZone = rawText.slice(cutoff);

  metaZone = metaZone
    .replaceAll('"content":null', '"content":""')
    .replaceAll('"content": null', '"content":""');

  const effortRegexMax = /(?<!\\)"reasoning_effort"\s*:\s*"(max|maximum|extrahigh)"/gi;
  const effortRegexMin = /(?<!\\)"reasoning_effort"\s*:\s*"(min|minimum|none)"/gi;
  metaZone = metaZone.replace(effortRegexMax, '"reasoning_effort":"high"').replace(effortRegexMin, '"reasoning_effort":"low"');

  if (dataZone.length > 0) {
    dataZone = dataZone.replace(/(?<!\\)"role"\s*:\s*"tool"/g, '"role":"user"');

    const tailLimit = Math.max(0, dataZone.length - 1000);
    const tail = dataZone.slice(tailLimit)
      .replace(effortRegexMax, '"reasoning_effort":"high"')
      .replace(effortRegexMin, '"reasoning_effort":"low"');
    dataZone = dataZone.slice(0, tailLimit) + tail;
  }

  let fullText = metaZone + dataZone;

  return addMissingToolSignatures(fullText);
}

export function getRouterLiveState() {
  return {
    modelCooldowns,
    pairCooldowns,
    deadKeys: Array.from(deadKeys),
    deadModels: Array.from(deadModels.keys()),
    deadModelsMap: Object.fromEntries(deadModels)
  };
}

export async function executeStratifiedRouting(request, rawText, currentUser, cascades, activeKeys, env = null, ctx = null) {
  await ensureDeadState(env);

  // Очистка устаревших блокировок в памяти
  const nowMs = Date.now();
  for (const k of Object.keys(pairCooldowns)) {
    if (pairCooldowns[k] <= nowMs) {
      delete pairCooldowns[k];
    }
  }

  const headSnippet = rawText.slice(0, 500);
  const isLite = /"model"\s*:\s*"[^"]*lite/i.test(headSnippet);
  let targetCascade = isLite ? cascades.lite : cascades.smart;
  const lastModel = isLite ? lastSuccessfulLiteModel : lastSuccessfulSmartModel;

  if (lastModel && targetCascade[0] !== lastModel && !deadModels.has(lastModel) && (!modelCooldowns[lastModel] || modelCooldowns[lastModel] <= Date.now())) {
    const idx = targetCascade.indexOf(lastModel);
    if (idx > 0) {
      targetCascade = [lastModel, ...targetCascade.toSpliced(idx, 1)];
    }
  }

  let candidateKeys = activeKeys;
  if (lastSuccessfulKeyId && candidateKeys.length > 0 && candidateKeys[0].id !== lastSuccessfulKeyId) {
    const idx = candidateKeys.findIndex((k) => k.id === lastSuccessfulKeyId);
    if (idx > 0) {
      candidateKeys = [candidateKeys[idx], ...candidateKeys.toSpliced(idx, 1)];
    }
  }

  let hadTpmError = false;
  let hadRpdError = false;
  let hadRpmError = false;
  let hadAuthError = false;
  let attemptsCount = 0;

  const basePayload = prepareSanitizedTemplate(rawText);

  // Каскадный перебор: от лучших моделей к базовым
  for (const model of targetCascade) {
    if (attemptsCount >= MAX_SUBREQUESTS) break;
    if (deadModels.has(model)) continue;

    if (modelCooldowns[model] && modelCooldowns[model] > Date.now()) {
      continue;
    }
    const headLimit = Math.min(basePayload.length, 500);
    const modelReplacedHead = basePayload.slice(0, headLimit).replace(/(?<!\\)"model"\s*:\s*"[^"]*"/, `"model":"${model}"`);
    const payload = modelReplacedHead + basePayload.slice(headLimit);
    for (const keyItem of candidateKeys) {
      if (attemptsCount >= MAX_SUBREQUESTS) break;
      if (deadKeys.has(keyItem.id)) continue;

      const pairKey = `${model}:${keyItem.id}`;
      if (pairCooldowns[pairKey] && pairCooldowns[pairKey] > Date.now()) continue;

      attemptsCount++;
      let ttfbMs = null;
      let responseCompletion = Promise.resolve(null);

      try {
        const upstream = await fetchWithStreamTimeout(DEFAULT_GOOGLE_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${keyItem.key}`,
          },
          body: payload,
          signal: request.signal,
        }, ATTEMPT_TIMEOUT_MS);
        const { response, ttfbMs: firstByteMs, responseCompletion: completion } = upstream;
        ttfbMs = firstByteMs;
        responseCompletion = completion;

        if (!response.ok) {
          let errorData = null;
          try {
            errorData = await response.json();
          } catch { }

          const rawError = Array.isArray(errorData) ? errorData[0] : errorData;
          const errorObj = rawError?.error || rawError || {};
          const statusCode = response.status;
          const responseMs = await responseCompletion;

          const errInfo = classifyGoogleError(statusCode, errorObj);
          if (errInfo.type === "NOT_FOUND") {
            deadModels.set(model, "404");
            saveMatrixStatus(model, keyItem.id, "404", env, ctx);
            logWarn(model, keyItem.id, statusCode, `Model Deprecated/Not Found (404)`, errorData, ttfbMs, env, ctx, responseMs);
            break;
          }

          if (errInfo.type === "ZERO_QUOTA") {
            deadModels.set(model, "limit: 0");
            saveMatrixStatus(model, keyItem.id, "limit: 0", env, ctx);
            logWarn(model, keyItem.id, statusCode, `Zero Free Quota (limit: 0)`, errorData, ttfbMs, env, ctx, responseMs);
            break;
          }

          if (errInfo.type === "AUTH") {
            hadAuthError = true;
            deadKeys.add(keyItem.id);
            saveMatrixStatus(model, keyItem.id, "KEY_ERR", env, ctx);
            logWarn(model, keyItem.id, statusCode, `Auth Error (Invalid Key)`, errorData, ttfbMs, env, ctx, responseMs);
            if (env?.DB && ctx?.waitUntil) {
              ctx.waitUntil(
                env.DB.prepare(`
                  INSERT INTO keys_cache (key_id, is_valid, status_code, checked_at)
                  VALUES (?, 0, ?, ?)
                  ON CONFLICT(key_id) DO UPDATE SET is_valid=0, status_code=excluded.status_code, checked_at=excluded.checked_at
                `).bind(keyItem.id, statusCode, Date.now()).run().catch(() => { })
              );
            }
            continue;
          }

          if (errInfo.type === "UNAVAILABLE") {
            modelCooldowns[model] = Date.now() + COOLDOWN_503_MS;
            saveMatrixStatus(model, keyItem.id, "503", env, ctx);
            logWarn(model, keyItem.id, statusCode, `Model Overloaded (503)`, errorData, ttfbMs, env, ctx, responseMs);
            break;
          }

          if (errInfo.type === "RPD") {
            hadRpdError = true;
            const now = new Date();
            const nowMs = now.getTime();

            // Если получили RPD в первую минуту новых суток (00:00 -- 00:01 UTC)
            // ставим таймаут до 01:01 UTC для защиты от рассинхрона серверов Google
            const isFirstMinuteOfDay = now.getUTCHours() === 0 && now.getUTCMinutes() === 0;
            let unlockTime = getNextMidnightUtc();

            if (isFirstMinuteOfDay) {
              const resetTarget = new Date(now);
              resetTarget.setUTCHours(1, 1, 0, 0);
              unlockTime = resetTarget.getTime();
            } else {
              const lastUnblock = lastRpdUnblock[pairKey] || 0;
              if (lastUnblock > 0 && Math.abs(nowMs - lastUnblock) < ONE_HOUR_MS) {
                unlockTime = nowMs + ONE_HOUR_MS;
              }
            }

            pairCooldowns[pairKey] = unlockTime;
            lastRpdUnblock[pairKey] = unlockTime;
            saveMatrixStatus(model, keyItem.id, "RPD", env, ctx);
            logWarn(model, keyItem.id, statusCode, `RPD Daily Limit`, errorData, ttfbMs, env, ctx, responseMs);
            continue;
          }

          if (errInfo.type === "TPM") {
            hadTpmError = true;
            saveMatrixStatus(model, keyItem.id, "TPM", env, ctx);
            logWarn(model, keyItem.id, statusCode, `TPM Token Limit`, errorData, ttfbMs, env, ctx, responseMs);
            continue;
          }

          if (errInfo.type === "RPM") {
            hadRpmError = true;
            const retryInfo = (errorObj?.details || []).find((d) => d["@type"]?.includes("RetryInfo"));
            const delayMs = parseRetryDelayMs(retryInfo?.retryDelay, DEFAULT_RPM_DELAY_MS);
            pairCooldowns[pairKey] = Date.now() + delayMs;
            saveMatrixStatus(model, keyItem.id, "RPM", env, ctx);
            logWarn(model, keyItem.id, statusCode, `RPM Minute Limit (${Math.round(delayMs / 1000)}s)`, errorData, ttfbMs, env, ctx, responseMs);
            continue;
          }

          const fallbackStatus = statusCode ? String(statusCode) : "UNDEFINED";
          saveMatrixStatus(model, keyItem.id, fallbackStatus, env, ctx);
          const errorMsg = errorObj?.message || errorObj?.status || "API Error";
          logWarn(model, keyItem.id, statusCode, errorMsg, errorData, ttfbMs, env, ctx, responseMs);
          continue;
        }

        const updateSuccessResponseTime = logSuccess(model, keyItem.id, ttfbMs, env, ctx);
        const responseTimeUpdate = responseCompletion.then(updateSuccessResponseTime);
        if (ctx?.waitUntil) ctx.waitUntil(responseTimeUpdate);
        else responseTimeUpdate.catch(() => { });
        recordSuccess(model, keyItem.id, currentUser, env, ctx);
        saveMatrixStatus(model, keyItem.id, "200", env, ctx);

        lastSuccessfulKeyId = keyItem.id;
        if (isLite) {
          lastSuccessfulLiteModel = model;
        } else {
          lastSuccessfulSmartModel = model;
        }

        const streamPipeline = createGeminiStreamPipeline();
        if (response.body) {
          response.body.pipeTo(streamPipeline.writable).catch((err) => {
            if (!request.signal.aborted) {
              logWarn(model, keyItem.id, 0, "Upstream stream interrupted", err, ttfbMs, env, ctx);
            }
          });
        }

        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");

        return new Response(streamPipeline.readable, {
          status: response.status,
          headers,
        });

      } catch (err) {
        if (request.signal.aborted) throw err;
        const isTimeout = err?.name == "TimeoutError";
        if (isTimeout) {
          modelCooldowns[model] = Date.now() + DEFAULT_TIMEOUT_DELAY_MS;
          for (const k of activeKeys) {
            saveMatrixStatus(model, k.id, "TIMEOUT", env, ctx);
          }
          logWarn(model, keyItem.id, 0, `Timeout (${ATTEMPT_TIMEOUT_MS / 1000}s) - Model Frozen`, null, null, env, ctx);
          break;
        }
        saveMatrixStatus(model, keyItem.id, "UNDEFINED", env, ctx);
        logWarn(model, keyItem.id, 0, err.message, null, ttfbMs, env, ctx);
        continue;
      }
    }
  }

  let advice = `исчерпаны все попытки (${attemptsCount} запросов).`;
  let errorReason = "Exhausted all attempts";

  if (hadTpmError) {
    advice = "контекст чата слишком велик (превышен минутный лимит токенов TPM). Выполните команду `/compact` в Zed или подождите 1 минуту.";
    errorReason = "TPM Limit (Tokens/Minute)";
  } else if (hadRpdError) {
    advice = "исчерпан суточный лимит запросов (RPD) на всех ключах для доступных моделей.";
    errorReason = "RPD Limit (Requests/Day)";
  } else if (hadRpmError) {
    advice = "слишком частые запросы (RPM). Подождите 30-60 секунд перед повтором.";
    errorReason = "RPM Limit (Requests/Minute)";
  } else if (hadAuthError) {
    advice = "все предоставленные ключи GEMINI_KEY отклонены Google API (ошибка 401/403). Проверьте актуальность ключей в переменных Cloudflare.";
    errorReason = "Auth Error (401/403 Invalid Key)";
  } else {
    advice = "произошла неизвестная ошибка API. Если вы используете VPN, попробуйте сменить страну/локацию в приложении VPN -- это переключит вас на другой датацентр Cloudflare с чистым пулом IP-адресов.";
    errorReason = "UNDEFINED";
  }

  logError(errorReason, 429, attemptsCount, env, ctx);

  return new Response(
    JSON.stringify({
      error: {
        message: `Gemini Edge Gateway: ${advice}`,
        type: "insufficient_quota",
        code: "gateway_exhausted",
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}
