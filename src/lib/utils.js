import { isThoughtSignatureError } from "./errors.js";

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const DAY_HOURS_MS = 24 * 60 * 60 * 1000;
export const COOLDOWN_503_MS = 10 * 1000;
export const DEFAULT_RPM_DELAY_MS = 60 * 1000;
export const DEFAULT_TIMEOUT_DELAY_MS = 5 * 60 * 1000;

export function getTodayMidnightUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export function getNextMidnightUtc() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

export function parseRetryDelayMs(retryDelayStr, defaultMs = DEFAULT_RPM_DELAY_MS) {
  if (!retryDelayStr) return defaultMs;
  const match = String(retryDelayStr).match(/([\d.]+)\s*s?/i);
  if (match) {
    const sec = parseFloat(match[1]);
    if (sec <= 60) {
      return Math.ceil(sec) * 1000;
    }
  }
  return defaultMs;
}

export function classifyGoogleError(statusCode, errorObj) {
  const status = typeof errorObj?.status == "string" ? errorObj.status : "";
  const message = typeof errorObj?.message == "string" ? errorObj.message : "";
  const lowerMessage = message.toLowerCase();

  if (isThoughtSignatureError(message)) {
    return { type: "THOUGHT_SIGNATURE" };
  }

  if (statusCode === 404 || status === "NOT_FOUND") {
    return { type: "NOT_FOUND" };
  }

  if (lowerMessage.includes("valid api key") || statusCode === 401 || statusCode === 403 || status === "PERMISSION_DENIED" || status === "UNAUTHENTICATED") {
    return { type: "AUTH" };
  }

  if (lowerMessage.includes("limit: 0")) {
    return { type: "ZERO_QUOTA" };
  }

  if (statusCode === 503 || statusCode === 500 || status === "UNAVAILABLE" || status === "INTERNAL") {
    return { type: "UNAVAILABLE" };
  }

  const details = Array.isArray(errorObj?.details) ? errorObj.details : [];
  const quotaFailures = details.filter((d) => typeof d?.["@type"] == "string" && d["@type"].includes("QuotaFailure"));
  const violations = quotaFailures.flatMap((q) => Array.isArray(q.violations) ? q.violations : []);

  const quotaIds = violations.map((v) => typeof v?.quotaId == "string" ? v.quotaId.toLowerCase() : "").join(" ");
  const quotaMetrics = violations.map((v) => typeof v?.quotaMetric == "string" ? v.quotaMetric.toLowerCase() : "").join(" ");

  if (statusCode === 429 || status === "RESOURCE_EXHAUSTED") {
    const isTpm = quotaIds.includes("tokenspermodelperminute") || quotaMetrics.includes("input_token_count");
    if (isTpm) { return { type: "TPM" }; }

    const isDaily = quotaIds.includes("requestsperday");
    if (isDaily) { return { type: "RPD" }; }

    return { type: "RPM" };
  }

  if (statusCode === 400 || status === "INVALID_ARGUMENT") {
    return { type: "INVALID_ARGUMENT", status, message };
  }

  return { type: "OTHER", status, message };
}
