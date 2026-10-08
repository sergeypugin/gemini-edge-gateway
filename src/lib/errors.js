export const MAX_LOG_MESSAGE_LENGTH = 160;
export const MAX_LOG_FIELD_LENGTH = 120;
export const MAX_LOG_DETAILS_LENGTH = 4096;
export const INTERNAL_ERROR_MESSAGE = "Internal gateway error";

export function redactText(value, limit = MAX_LOG_MESSAGE_LENGTH) {
  if (typeof value != "string") return "";
  const text = value.slice(0, 8192)
    .replace(/AIza[\w-]+/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, "$1 [REDACTED]")
    .replace(/((?:[?&]|\b)(?:key|api[_-]?key|x-goog-api-key|access[_-]?token|refresh[_-]?token|token|auth|password|secret|authorization)["']?\s*[=:]\s*)(["'])([\s\S]*?)\2/gi, "$1\"[REDACTED]\"")
    .replace(/((?:[?&]|\b)(?:key|api[_-]?key|x-goog-api-key|access[_-]?token|refresh[_-]?token|token|auth|password|secret|authorization)\s*[=:]\s*)[^\s&;,"'<>]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  if (limit < 3) return text.slice(0, Math.max(0, limit));
  return text.length > limit ? text.slice(0, limit - 3) + "..." : text;
}

export function isThoughtSignatureError(message) {
  return typeof message == "string" && /thought[\s_-]*signature/i.test(message);
}

export function normalizeErrorMessage(message, status = null) {
  const text = typeof message == "string" ? message.slice(0, 8192) : "";
  if (text == INTERNAL_ERROR_MESSAGE) return INTERNAL_ERROR_MESSAGE;
  if (isThoughtSignatureError(text)) return "Missing or invalid thought signature";
  if (/\bTPM\b|tokenspermodelperminute/i.test(text)) return "TPM Token Limit";
  if (/\bRPD\b|requestsperday/i.test(text)) return "RPD Daily Limit";
  if (/\bRPM\b/i.test(text)) return "RPM Minute Limit";
  if (/limit:\s*0|zero free quota/i.test(text)) return "Zero Free Quota (limit: 0)";
  if (/timeout|timed out|aborted/i.test(text)) return "Upstream request timed out";
  if (/auth error|invalid (?:api )?key|valid api key|permission_denied|unauthenticated/i.test(text) || [401, 403].includes(Number(status))) return "Auth Error (Invalid Key)";
  if (/deprecated|not[ _]found/i.test(text) || Number(status) == 404) return "Model Deprecated/Not Found (404)";
  if (/overloaded|unavailable/i.test(text) || [500, 502, 503, 504].includes(Number(status))) return "Upstream service unavailable";
  if (/invalid[ _]argument/i.test(text) || Number(status) == 400) return "Invalid upstream request";
  if (/exhausted all attempts/i.test(text)) return "Exhausted all attempts";
  if (Number(status) == 429) return "Upstream rate limit exceeded";
  return "Upstream request failed";
}

export function sanitizeErrorDetails(message, details = null) {
  let nodes = 64;
  let textBudget = 2048;
  const seen = new WeakSet();
  const sensitive = /authorization|apikey|token|password|secret|credential|thoughtsignature|^key$|^geminikey/i;
  const visit = (value, depth = 0) => {
    if (nodes-- <= 0 || depth > 4) return "[TRUNCATED]";
    if (value == null || typeof value == "boolean") return value;
    if (typeof value == "number") return Number.isFinite(value) ? value : null;
    if (typeof value == "string") {
      if (textBudget <= 0) return "[TRUNCATED]";
      const text = redactText(value, Math.min(512, textBudget));
      textBudget -= text.length;
      return text;
    }
    if (typeof value != "object") return `[${typeof value}]`;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (value instanceof Error) {
      return visit({ name: value.name, message: value.message, stack: value.stack, cause: value.cause }, depth + 1);
    }
    if (Array.isArray(value)) return value.slice(0, 16).map(item => visit(item, depth + 1));
    const result = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count++ >= 16 || nodes <= 0) break;
      const safeKey = redactText(key, 64);
      result[safeKey] = sensitive.test(key.replace(/[^a-z0-9]/gi, "")) ? "[REDACTED]" : visit(value[key], depth + 1);
    }
    return result;
  };

  try {
    const result = visit({ message, details });
    const serialized = JSON.stringify(result);
    return new TextEncoder().encode(serialized).length > MAX_LOG_DETAILS_LENGTH
      ? { summary: redactText(serialized, 512) }
      : result;
  } catch {
    return { message: "Error details unavailable" };
  }
}
