let allLogs = [];
let renderedLogsCount = 0;
const LOGS_CHUNK_SIZE = 50;
const MAX_LOG_DISPLAY_LENGTH = 160;

function displayText(value, limit = MAX_LOG_DISPLAY_LENGTH) {
  const text = ["string", "number", "boolean"].includes(typeof value) ? String(value) : "";
  return text.length > limit ? text.slice(0, limit - 3) + "..." : text;
}

function escapeCell(value, limit = MAX_LOG_DISPLAY_LENGTH) {
  return displayText(value, limit).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}
let currentSortCol = "timestamp";
let currentSortDir = "desc";

const statusIndicator = document.getElementById("gateway-status");
const refreshBtn = document.getElementById("refresh-btn");
const logsTbody = document.getElementById("logs-tbody");
const logsContainer = document.getElementById("logs-scroll-viewport");

refreshBtn.onclick = () => loadDashboard();

const STATUS_MAP = {
  "200": "status-200",
  "RPM": "status-rpm",
  "TPM": "status-tpm",
  "503": "status-503",
  "RPD": "status-rpd",
  "limit: 0": "status-zero",
  "KEY_ERR": "status-keyerr",
  "400": "status-keyerr",
  "401": "status-keyerr",
  "403": "status-keyerr",
  "404": "status-404",
  "TIMEOUT": "status-timeout",
  "UNDEFINED": "status-undefined",
};

async function loadDashboard() {
  statusIndicator.textContent = "SYNCING...";
  try {
    const savedToken = localStorage.getItem("dashboard_auth") || "";
    const headers = savedToken ? { "Authorization": `Bearer ${savedToken}` } : {};

    const res = await fetch("/api/stats", { headers });

    if (res.status === 401) {
      localStorage.removeItem("dashboard_auth");
      const pass = prompt("Доступ ограничен. Введите DASHBOARD_PASSWORD:");
      if (pass) {
        localStorage.setItem("dashboard_auth", pass.trim());
        return loadDashboard();
      }
      throw new Error("Требуется пароль дашборда");
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    statusIndicator.textContent = "LIVE";

    renderOverview(data);
    renderKeys(data.discovery?.keysStatus || []);
    renderMatrix(data.matrix || {}, data.logs || []);
    renderModels(data.discovery);
    alignLayout();

    allLogs = Array.isArray(data.logs) ? data.logs.slice(0, 1000) : [];
    document.getElementById("logs-counter").textContent = `${allLogs.length} ENTRIES`;

    if (currentSortCol) {
      sortLogs(currentSortCol, false);
    } else {
      logsTbody.innerHTML = "";
      renderedLogsCount = 0;
      renderNextLogsChunk();
    }

    if (data.discovery?.hasMoreUnchecked) {
      statusIndicator.textContent = "VALIDATING NEXT BATCH...";
      setTimeout(async () => {
        try {
          await fetch("/api/stats?validate_next=true", { headers });
          loadDashboard();
        } catch { }
      }, 1000);
    }
  } catch (err) {
    statusIndicator.textContent = "OFFLINE: " + displayText(err?.message || "Dashboard unavailable");
  }
}

function updateRpdCountdown() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const diffMs = Math.max(0, nextMidnight.getTime() - now.getTime());
  const totalMins = Math.floor(diffMs / (1000 * 60));
  const hrs = String(Math.floor(totalMins / 60)).padStart(2, "0");
  const mins = String(totalMins % 60).padStart(2, "0");
  const el = document.getElementById("rpd-reset-countdown");
  if (el) el.textContent = `${hrs}:${mins} (00:00 UTC)`;
}

setInterval(updateRpdCountdown, 30000);

function renderOverview(data) {
  document.getElementById("success-rate").textContent = data.successRate || "100% (0/0)";
  updateRpdCountdown();

  const r = data.lastResponse;
  if (r) {
    const d = new Date(r.timestamp);
    const timeFormatted = isNaN(d.getTime())
      ? r.timestamp.split("T")[1]?.slice(0, 5) || r.timestamp
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    document.getElementById("last-resp").textContent = `${r.model} (${r.keyId}) by ${r.user} at ${timeFormatted}`;
  } else {
    document.getElementById("last-resp").textContent = "NO TRAFFIC YET";
  }

  const lastDisc = data.discovery?.lastUpdated;
  if (lastDisc) {
    const d = new Date(lastDisc);
    document.getElementById("last-disc").textContent = isNaN(d.getTime()) ? lastDisc : d.toLocaleString();
  } else {
    document.getElementById("last-disc").textContent = "NOT INITIALIZED";
  }
}

function formatKeyLabel(id) {
  if (!id) return "KEY";
  let s = displayText(id, 120).trim();
  s = s.replace(/^GEMINI[-_]/i, "").trim();
  return s;
}

function renderKeys(keys) {
  const container = document.getElementById("keys-status-container");
  if (!keys.length) {
    container.innerHTML = "<div>NO GEMINI_KEY VARIABLES FOUND</div>";
    return;
  }

  container.innerHTML = keys.map(k => {
    let statusClass = "key-status-ok";
    let statusText = "VALID (200)";

    if (k.unchecked) {
      statusClass = "key-status-unchecked";
      statusText = "UNCHECKED (?)";
    } else if (!k.isValid) {
      statusClass = "key-status-bad";
      statusText = `INVALID (HTTP ${k.status})`;
    }

    const cleanId = formatKeyLabel(k.id);
    return `<div class="key-row"><span>${escapeCell(cleanId)}</span><span class="${statusClass}">${escapeCell(statusText)}</span></div>`;
  }).join("");
}

function alignLayout() {
  const smart = document.getElementById("smart-list");
  const lite = document.getElementById("lite-list");
  const raw = document.getElementById("raw-list");
  if (smart && smart.clientHeight > 0) {
    const h = smart.clientHeight;
    if (lite) lite.style.maxHeight = `${h}px`;
    if (raw) raw.style.maxHeight = `${h}px`;
  }

  const leftPanel = document.querySelector(".panel-left");
  const keysContainer = document.getElementById("keys-status-container");
  if (leftPanel && keysContainer) {
    if (window.innerWidth <= 900) {
      keysContainer.style.height = "auto";
      keysContainer.style.maxHeight = "350px";
    } else {
      const leftHeight = leftPanel.offsetHeight;
      const h2 = document.querySelector(".panel-right .sub-title");
      const titleHeight = h2 ? h2.offsetHeight : 20;
      // h2 margin-bottom is 16px
      const targetHeight = leftHeight - titleHeight - 16;
      if (targetHeight > 0) {
        keysContainer.style.height = `${targetHeight}px`;
        keysContainer.style.maxHeight = `${targetHeight}px`;
      }
    }
  }
}

function parseStatusFromLog(found) {
  if (!found) return "-";
  if (found.status === 200) return "200";
  const msg = displayText(found.message).toUpperCase();
  if (msg.includes("RPD")) return "RPD";
  if (msg.includes("TPM")) return "TPM";
  if (msg.includes("RPM")) return "RPM";
  if (msg.includes("503") || found.status === 503) return "503";
  if (msg.includes("LIMIT: 0") || msg.includes("ZERO")) return "limit: 0";
  if (msg.includes("AUTH") || msg.includes("INVALID") || found.status === 401 || found.status === 403) return "KEY_ERR";
  if (msg.includes("404") || found.status === 404) return "404";
  return found.status ? String(found.status) : "UNDEFINED";
}

function renderMatrix(matrix, logs = []) {
  const table = document.getElementById("matrix-table");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  const models = Object.keys(matrix);
  if (!models.length) {
    thead.innerHTML = "";
    tbody.innerHTML = "<tr><td colspan=\"100\">NO DATA RECORDED</td></tr>";
    return;
  }

  const keys = Object.keys(matrix[models[0]] || {});
  thead.innerHTML = `<tr><th class="model-col-header">MODEL \\ KEY</th>${keys.map(k => {
    const compactKey = formatKeyLabel(k);
    return `<th class="key-col-header" title="${escapeCell(k, 120)}">${escapeCell(compactKey, 120)}</th>`;
  }).join("")}</tr>`;

  tbody.innerHTML = models.map(m => {
    // If the model is dead (404 or limit: 0), the entire row across all keys is banned
    let deadModelStatus = null;
    const modelDeadLog = logs.find(l => {
      if (l.model !== m) return false;
      const parsed = parseStatusFromLog(l);
      return parsed === "404" || parsed === "limit: 0";
    });
    if (modelDeadLog) {
      deadModelStatus = parseStatusFromLog(modelDeadLog);
    }

    const cells = keys.map(k => {
      const item = matrix[m][k] || { hits: 0, status: "-" };
      const statusText = item.status || "-";
      const badgeClass = STATUS_MAP[statusText] || (statusText === "-" ? "status-none" : "status-undefined");
      return `<td class="matrix-cell"><span class="status-badge ${badgeClass}">${escapeCell(statusText, 24)}</span></td>`;
    }).join("");
    return `<tr><td class="model-name-cell" title="${escapeCell(m, 120)}"><strong>${escapeCell(m, 120)}</strong></td>${cells}</tr>`;
  }).join("");
}

function renderModels(disc) {
  const renderList = (id, items) => {
    document.getElementById(id).innerHTML = items?.length
      ? items.map(m => `<li>${escapeCell(m, 120)}</li>`).join("")
      : "<li>None</li>";
  };
  renderList("smart-list", disc?.smart);
  renderList("lite-list", disc?.lite);
  renderList("raw-list", disc?.rawModels);
  setTimeout(alignLayout, 50);
}

function renderNextLogsChunk() {
  if (renderedLogsCount >= allLogs.length) return;

  const nextSlice = allLogs.slice(renderedLogsCount, renderedLogsCount + LOGS_CHUNK_SIZE);
  const rowsHtml = nextSlice.map(l => {
    let localTime = "--";
    if (l.timestamp) {
      const timestamp = displayText(l.timestamp, 40);
      const d = new Date(timestamp);
      localTime = isNaN(d.getTime()) ? timestamp : d.toLocaleTimeString();
    }
    const level = ["success", "warn", "error"].includes(l.level) ? l.level : "error";
    const ttfb = l.ttfbMs != null ? displayText(l.ttfbMs, 24) + "ms" : "-";
    const response = l.responseMs != null ? displayText(l.responseMs, 24) + "ms" : "-";

    return `<tr>
      <td>${escapeCell(localTime, 40)}</td>
      <td class="lvl-${level}">${escapeCell(level.toUpperCase(), 16)}</td>
      <td>${escapeCell(l.message)}</td>
      <td>${escapeCell(l.model || "--", 120)}</td>
      <td>${escapeCell(l.key || "--", 120)}</td>
      <td>${escapeCell(l.status ?? "--", 24)}</td>
      <td>${escapeCell(ttfb, 26)}</td>
      <td>${escapeCell(response, 26)}</td>
    </tr>`;
  }).join("");

  logsTbody.insertAdjacentHTML("beforeend", rowsHtml);
  renderedLogsCount += nextSlice.length;
}

function sortLogs(col, toggle = true) {
  if (toggle) {
    if (currentSortCol === col) {
      currentSortDir = currentSortDir === "asc" ? "desc" : "asc";
    } else {
      currentSortCol = col;
      currentSortDir = (col === "timestamp" || col === "ttfbMs" || col === "responseMs") ? "desc" : "asc";
    }
  }

  allLogs.sort((a, b) => {
    let valA = a[col];
    let valB = b[col];

    if (valA == null) valA = "";
    if (valB == null) valB = "";

    if (col === "timestamp") {
      const timeA = new Date(valA).getTime() || 0;
      const timeB = new Date(valB).getTime() || 0;
      return currentSortDir === "asc" ? timeA - timeB : timeB - timeA;
    }

    if (col === "status" || col === "ttfbMs" || col === "responseMs") {
      const numA = Number(valA) || 0;
      const numB = Number(valB) || 0;
      return currentSortDir === "asc" ? numA - numB : numB - numA;
    }

    const strA = String(valA).toLowerCase();
    const strB = String(valB).toLowerCase();
    if (strA < strB) return currentSortDir === "asc" ? -1 : 1;
    if (strA > strB) return currentSortDir === "asc" ? 1 : -1;
    return 0;
  });

  updateSortHeaders();
  logsTbody.innerHTML = "";
  renderedLogsCount = 0;
  renderNextLogsChunk();
}

function updateSortHeaders() {
  document.querySelectorAll("#logs-table th[data-col]").forEach(th => {
    const col = th.getAttribute("data-col");
    const baseText = th.textContent.replace(/[ ▲▼↑↓]/g, "").trim();
    if (col === currentSortCol) {
      th.textContent = `${baseText} ${currentSortDir === "asc" ? "▲" : "▼"}`;
    } else {
      th.textContent = baseText;
    }
  });
}

document.querySelectorAll("#logs-table th[data-col]").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.getAttribute("data-col");
    if (col) sortLogs(col, true);
  });
});

logsContainer.addEventListener("scroll", () => {
  if (logsContainer.scrollTop + logsContainer.clientHeight >= logsContainer.scrollHeight - 100) {
    renderNextLogsChunk();
  }
});

// Theme Logic
const themeToggle = document.getElementById("theme-toggle-box");
const root = document.documentElement;

function initTheme() {
  const savedTheme = localStorage.getItem("gateway_theme");
  const systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = savedTheme || (systemDark ? "dark" : "light");
  root.setAttribute("data-theme", theme);
  document.body.setAttribute("data-theme", theme);
}

themeToggle.onclick = () => {
  const currentTheme = root.getAttribute("data-theme") || "light";
  const newTheme = currentTheme === "light" ? "dark" : "light";
  root.setAttribute("data-theme", newTheme);
  document.body.setAttribute("data-theme", newTheme);
  localStorage.setItem("gateway_theme", newTheme);
};

initTheme();
loadDashboard();
window.addEventListener("resize", alignLayout);
