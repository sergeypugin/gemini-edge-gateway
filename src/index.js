import { parseConfig } from "./lib/config.js";
import { authenticate } from "./lib/auth.js";
import { getDiscoveryData } from "./lib/discovery.js";
import { executeStratifiedRouting } from "./lib/router.js";
import { getAnalyticsSnapshot } from "./lib/analytics.js";
import { logError } from "./lib/logger.js";
import { INTERNAL_ERROR_MESSAGE } from "./lib/errors.js";

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      logError(INTERNAL_ERROR_MESSAGE, 500, err, env, ctx);
      return new Response(JSON.stringify({ error: { message: INTERNAL_ERROR_MESSAGE, type: "internal_server_error", code: 500 } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const { keys, authorizedUsers } = parseConfig(env);

  // Публичный эндпоинт аналитики (защищен паролем, если задан DASHBOARD_PASSWORD)
  if (url.pathname === "/api/stats") {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Проверка пароля дашборда (только если переменная задана)
    const { dashboardPasswords } = parseConfig(env);
    if (dashboardPasswords.length > 0) {
      const clientToken = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim()
        || url.searchParams.get("auth");

      if (!clientToken || !dashboardPasswords.includes(clientToken)) {
        return new Response(JSON.stringify({ error: "Unauthorized: Dashboard Password Required" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    try {
      const forceBatch = url.searchParams.get("validate_next") === "true";
      const discovery = await getDiscoveryData(keys, env, forceBatch);
      const stats = await getAnalyticsSnapshot(discovery, keys, env);
      return new Response(JSON.stringify(stats), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          ...corsHeaders,
        },
      });
    } catch (e) {
      logError(INTERNAL_ERROR_MESSAGE, 500, e, env, ctx);
      return new Response(JSON.stringify({ error: INTERNAL_ERROR_MESSAGE }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }

  // Список моделей для Zed (/v1/models)
  if (url.pathname.endsWith("/models")) {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "Gemini Smart", object: "model" },
          { id: "Gemini Lite", object: "model" },
        ],
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // Обработка промптов (/v1/chat/completions)
  if (url.pathname.endsWith("/chat/completions")) {
    const authResult = authenticate(request, authorizedUsers);
    if (!authResult.ok) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Unauthorized: Invalid Access Token",
            type: "auth_error",
            code: 401,
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    if (keys.length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: "No GEMINI_KEY variables configured in Cloudflare",
            type: "configuration_error",
            code: 500,
          },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            message: "Invalid request body",
            type: "invalid_request_error",
            code: 400,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const discovery = await getDiscoveryData(keys, env);
      return await executeStratifiedRouting(request, rawBody, authResult.user, discovery, discovery.activeKeys, env, ctx);
    } catch (err) {
      logError(INTERNAL_ERROR_MESSAGE, 500, err, env, ctx);
      return new Response(
        JSON.stringify({
          error: {
            message: INTERNAL_ERROR_MESSAGE,
            type: "internal_server_error",
            code: 500,
          },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  return new Response("Not Found", { status: 404 });
}
