/**
 * stock-line-bot — Step 5-4
 *
 * LINE private-group commands:
 *   /測試      Existing connectivity reply
 *   /群組ID    Existing one-time setup command (disabled after whitelist is set)
 *   /資料測試  Read-only Google Sheets diagnostic
 *   /選股      Latest committed screening batch, with freshness gate
 *   /個股 2330 Most recent committed screening for one stock
 *   /績效      Historical T+20 tracking summary
 *   /觀察      Enabled Watchlist stocks
 *
 * No public Sheet endpoints. No writes to Sheets. No added npm dependency.
 * Before production deployment, compare this file with the deployed source.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const DIAGNOSTIC_RANGES = [
  "'Watchlist'!A1:E101",
  "'Signals'!A1:P101",
  "'Performance'!A1:Q101",
  "'Reports'!A1:I", // latest commit marker may be beyond row 200
];

// Full columns: do not silently truncate results after the first 100 rows.
const QUERY_RANGES = {
  watchlist: "'Watchlist'!A1:E",
  signals: "'Signals'!A1:P",
  performance: "'Performance'!A1:Q",
  reports: "'Reports'!A1:I",
};
const MAX_STOCKS_IN_REPLY = 25;

let cachedToken = null;
let cachedTokenExpiry = 0;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function objectToBase64Url(obj) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToBytes(pem) {
  const raw = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  if (!raw) throw new Error("Missing private key");
  return Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
}

async function getGoogleAccessToken(env) {
  const nowMs = Date.now();
  if (cachedToken && cachedTokenExpiry > nowMs + 60_000) return cachedToken;

  if (!env.GOOGLE_CREDS_JSON) throw new Error("Missing Google credential");
  let creds;
  try {
    creds = JSON.parse(env.GOOGLE_CREDS_JSON);
  } catch {
    throw new Error("Invalid Google credential JSON");
  }
  if (
    creds.type !== "service_account" ||
    typeof creds.client_email !== "string" ||
    typeof creds.private_key !== "string"
  ) {
    throw new Error("Invalid service account");
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(creds.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const now = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: creds.client_email,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now - 30,
    exp: now + 3300,
  };
  const signingInput = objectToBase64Url(header) + "." + objectToBase64Url(payload);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const assertion = signingInput + "." + bytesToBase64Url(new Uint8Array(signature));

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!tokenResponse.ok) throw new Error("Google OAuth authorization failed");
  const tokenData = await tokenResponse.json();
  if (typeof tokenData.access_token !== "string") {
    throw new Error("Invalid Google OAuth response");
  }
  cachedToken = tokenData.access_token;
  cachedTokenExpiry = nowMs + Math.max(0, Number(tokenData.expires_in || 3600)) * 1000;
  return cachedToken;
}

async function readSheets(env, ranges = DIAGNOSTIC_RANGES) {
  if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_CREDS_JSON) {
    throw new Error("Google Sheets bindings missing");
  }
  const spreadsheetId = env.GOOGLE_SHEET_ID.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) {
    throw new Error("Invalid spreadsheet ID");
  }

  const token = await getGoogleAccessToken(env);
  const url = new URL(
    "https://sheets.googleapis.com/v4/spreadsheets/" +
      spreadsheetId +
      "/values:batchGet"
  );
  for (const range of ranges) url.searchParams.append("ranges", range);
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Google Sheets read failed");
  const data = await response.json();
  if (!Array.isArray(data.valueRanges) || data.valueRanges.length !== ranges.length) {
    throw new Error("Unexpected Sheets response");
  }
  return data.valueRanges.map((entry) => entry.values || []);
}

function countEnabledWatchlist(rows) {
  if (!rows.length) throw new Error("Watchlist is empty");
  const headers = rows[0].map((x) => String(x).trim().toLowerCase());
  const stockCol = headers.indexOf("stock_id");
  const enabledCol = headers.indexOf("enabled");
  if (stockCol < 0 || enabledCol < 0) throw new Error("Watchlist headers missing");
  return rows.slice(1).filter((row) => {
    const enabled = String(row[enabledCol] || "").trim().toUpperCase();
    return String(row[stockCol] || "").trim() && ["TRUE", "YES", "1"].includes(enabled);
  }).length;
}

function countRows(rows, requiredColumn) {
  if (!rows.length || !rows[0].includes(requiredColumn)) {
    throw new Error("Result sheet headers missing");
  }
  const idCol = rows[0].indexOf(requiredColumn);
  return rows.slice(1).filter((row) => String(row[idCol] || "").trim()).length;
}

function latestDailyReport(rows) {
  if (!rows.length) throw new Error("Reports empty");
  const h = rows[0];
  const indices = ["kind", "part", "status", "data_date", "generated_at_utc"];
  if (!indices.every((name) => h.includes(name))) {
    throw new Error("Report headers missing");
  }

  const index = Object.fromEntries(indices.map((name) => [name, h.indexOf(name)]));
  const committed = rows
    .slice(1)
    .filter((r) => r[index.kind] === "daily" && String(r[index.part]) === "0")
    .sort((a, b) =>
      String(b[index.generated_at_utc] || "").localeCompare(
        String(a[index.generated_at_utc] || "")
      )
    );
  if (!committed.length) return null;
  return {
    status: String(committed[0][index.status] || "unknown"),
    date: String(committed[0][index.data_date] || "unknown"),
  };
}

function taiwanDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function sheetsDiagnosticMessage(env) {
  const [watchlist, signals, performance, reports] = await readSheets(env);
  const enabled = countEnabledWatchlist(watchlist);
  const signalCount = countRows(signals, "stock_id");
  const performanceCount = countRows(performance, "stock_id");
  const latest = latestDailyReport(reports);

  const summary = [
    "✅ Google Sheets 唯讀連線成功",
    "觀察清單：" + enabled + " 檔啟用（本次最多讀取 100 列）",
    "Signals：" + signalCount + " 筆（本次最多讀取 100 列）",
    "Performance：" + performanceCount + " 筆（本次最多讀取 100 列）",
  ];
  if (latest) {
    summary.push("最近日報：" + latest.date + "／" + latest.status);
    if (latest.status !== "complete" || latest.date !== taiwanDate()) {
      summary.push("⚠️ 以上是歷史或尚未完整驗證的資料，非今日即時交易訊號。");
    }
  } else {
    summary.push("最近日報：尚無已提交的日報");
  }
  return summary.join("\n");
}


function safeCell(value, limit = 70) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function recordsFromSheet(values, required) {
  if (!values.length || !Array.isArray(values[0])) {
    throw new Error("Required spreadsheet is empty");
  }
  const headers = values[0].map((header) => String(header).trim());
  if (required.some((name) => !headers.includes(name))) {
    throw new Error("Unexpected spreadsheet columns");
  }
  return values.slice(1)
    .filter((row) => Array.isArray(row) && row.some((value) => String(value).trim()))
    .map((row) => Object.fromEntries(
      headers.filter(Boolean).map((name) => [name, String(row[headers.indexOf(name)] ?? "")])
    ));
}

function enabledWatchlistRows(values) {
  return recordsFromSheet(values, ["stock_id", "enabled"])
    .filter((row) =>
      row.stock_id.trim() &&
      ["TRUE", "YES", "1"].includes(row.enabled.trim().toUpperCase())
    );
}

function committedDailyBatches(signalValues, reportValues) {
  const signals = recordsFromSheet(signalValues, ["stock_id", "action", "run_id", "price_date"]);
  const reports = recordsFromSheet(reportValues, [
    "run_id", "kind", "part", "content", "status",
    "signal_count", "error_count", "data_date", "generated_at_utc",
  ]);
  const markers = reports
    .filter((row) => row.kind === "daily" && row.part.trim() === "0")
    .sort((a, b) => b.generated_at_utc.localeCompare(a.generated_at_utc));
  return markers.map((marker) => {
    const id = marker.run_id;
    if (!id || !["complete", "partial", "stale", "unavailable"].includes(marker.status)) {
      throw new Error("Daily report is not committed");
    }
    const partsExpected = Number(marker.content);
    if (!Number.isSafeInteger(partsExpected) || partsExpected < 1 || partsExpected > 100) {
      throw new Error("Invalid report segment count");
    }
    const parts = reports.filter((row) =>
      row.run_id === id && row.kind === "daily" && row.part.trim() !== "0"
    );
    const partsActual = parts.map((row) => Number(row.part));
    if (
      parts.length !== partsExpected ||
      new Set(partsActual).size !== partsExpected ||
      parts.some((row) => row.status !== marker.status || !row.content) ||
      partsActual.some((part) => !Number.isInteger(part) || part < 1 || part > partsExpected)
    ) {
      throw new Error("Incomplete report segments");
    }
    const currentSignals = signals.filter((row) => row.run_id === id);
    const expectedSignals = Number(marker.signal_count);
    if (
      !Number.isSafeInteger(expectedSignals) || expectedSignals < 0 ||
      currentSignals.length !== expectedSignals ||
      new Set(currentSignals.map((row) => row.stock_id)).size !== expectedSignals ||
      currentSignals.some((row) => !row.stock_id.trim() ||
        !["BUY", "WATCH", "SKIP", "ERROR"].includes(row.action))
    ) {
      throw new Error("Report / Signals batch mismatch");
    }
    const errors = currentSignals.filter((row) => row.action === "ERROR").length;
    if (Number(marker.error_count) !== errors) {
      throw new Error("Signal error count mismatch");
    }
    return { marker, signals: currentSignals };
  });
}

function batchIsCurrent(batch) {
  return batch.marker.status === "complete" &&
    batch.marker.data_date === taiwanDate() &&
    batch.signals.length > 0 &&
    batch.signals.every((row) => row.price_date === batch.marker.data_date);
}

function batchHeader(batch) {
  const current = batchIsCurrent(batch);
  return [
    "行情日期：" + safeCell(batch.marker.data_date || "未知"),
    "報告狀態：" + safeCell(batch.marker.status),
    current
      ? "✅ 當日資料已完成驗證；仍非即時報價，進場前請確認市場資訊。"
      : "⚠️ 歷史或未完整驗證的分析，不是今日即時行情或買進建議。",
  ];
}

function actionCounts(signals) {
  return Object.fromEntries(
    ["BUY", "WATCH", "SKIP", "ERROR"].map(
      (action) => [action, signals.filter((row) => row.action === action).length]
    )
  );
}

function stockTitle(stock) {
  return safeCell(stock.stock_id, 12) + " " + safeCell(stock.name || "", 30);
}

async function latestBatchForQuery(env, stockId = null) {
  const [signals, reports] = await readSheets(env, [QUERY_RANGES.signals, QUERY_RANGES.reports]);
  const batches = committedDailyBatches(signals, reports);
  if (!batches.length) return null;
  if (stockId == null) return batches[0];
  return batches.find((batch) => batch.signals.some((row) => row.stock_id === stockId)) || null;
}

async function screeningMessage(env) {
  const batch = await latestBatchForQuery(env);
  if (!batch) return "📭 目前沒有已提交的每日選股報告。";
  const counts = actionCounts(batch.signals);
  const lines = [
    "📊 最近一期選股分析（唯讀紀錄）",
    ...batchHeader(batch),
    "BUY " + counts.BUY + "｜WATCH " + counts.WATCH +
      "｜SKIP " + counts.SKIP + "｜ERROR " + counts.ERROR,
  ];
  let shown = 0;
  for (const action of ["BUY", "WATCH", "SKIP", "ERROR"]) {
    const stocks = batch.signals.filter((row) => row.action === action);
    if (!stocks.length || shown >= MAX_STOCKS_IN_REPLY) continue;
    lines.push("");
    lines.push(action + (batchIsCurrent(batch) ? "" : "（歷史標籤）") + "：" );
    for (const stock of stocks) {
      if (shown >= MAX_STOCKS_IN_REPLY) break;
      lines.push("• " + stockTitle(stock) + "｜" +
        safeCell(stock.signal_score || "未評分", 12) + " 分");
      shown++;
    }
  }
  if (batch.signals.length > shown) {
    lines.push("另外 " + (batch.signals.length - shown) + " 檔未顯示，請使用 /個股 股票代號查詢。");
  }
  return lines.join("\n");
}

function numericPercent(value) {
  const raw = String(value ?? "").replace(/,/g, "").replace(/%/g, "").trim();
  if (!raw) return null;
  const result = Number(raw);
  return Number.isFinite(result) ? result : null;
}

function signedPercent(num) {
  return (num > 0 ? "+" : "") + num.toFixed(2) + "%";
}

function backtestWinratePercent(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = numericPercent(raw);
  if (parsed === null) return null;
  const percent = raw.includes("%") || parsed > 1 ? parsed : parsed * 100;
  return percent >= 0 && percent <= 100 ? percent : null;
}

async function individualStockMessage(env, stockId) {
  const batch = await latestBatchForQuery(env, stockId);
  if (!batch) {
    return "📭 找不到 " + stockId + " 的已提交分析紀錄。請先確認是否曾列入選股名單。";
  }
  const s = batch.signals.find((row) => row.stock_id === stockId);
  const lines = [
    "🔎 " + stockTitle(s) + "｜最近一次已保存分析",
    ...batchHeader(batch),
    "訊號：" + safeCell(s.action) + "｜綜合分數：" + safeCell(s.signal_score || "未評分", 15),
    "個股行情日：" + safeCell(s.price_date || "未知"),
  ];
  if (s.entry_price) {
    lines.push("參考收盤價：" + safeCell(s.entry_price, 24) + "（非即時成交價）");
  }
  if (s.stop_loss_price || s.target_price) {
    lines.push("參考停損／目標價：" +
      safeCell(s.stop_loss_price || "—", 24) + "／" +
      safeCell(s.target_price || "—", 24));
  }
  if (s.rr_ratio) lines.push("參考風報比：1:" + safeCell(s.rr_ratio, 16));
  const winrate = backtestWinratePercent(s.winrate);
  if (winrate !== null) {
    lines.push("歷史回測勝率：" + winrate.toFixed(1) +
      "%（樣本 " + safeCell(s.samples || "未提供", 12) + " 次）");
  }
  if (s.tech_signals) lines.push("技術訊號：" + safeCell(s.tech_signals, 180));
  // Error notes can contain truncated upstream HTTP URLs; never echo them to LINE.
  if (s.action === "ERROR") {
    lines.push("⚠️ 資料取得或計算失敗；不提供該筆操作建議。");
  } else if (s.risk_notes) {
    lines.push("風險註記：" + safeCell(s.risk_notes, 240));
  }
  return lines.join("\n");
}

async function watchlistMessage(env) {
  const [rows] = await readSheets(env, [QUERY_RANGES.watchlist]);
  const stocks = enabledWatchlistRows(rows);
  const lines = ["📋 目前啟用的觀察清單：" + stocks.length + " 檔"];
  if (!stocks.length) {
    lines.push("目前沒有啟用中的標的。");
  } else {
    for (const stock of stocks.slice(0, MAX_STOCKS_IN_REPLY)) {
      lines.push("• " + stockTitle(stock));
    }
    if (stocks.length > MAX_STOCKS_IN_REPLY) {
      lines.push("尚有 " + (stocks.length - MAX_STOCKS_IN_REPLY) + " 檔未列出。");
    }
  }
  lines.push("以上為 Google Sheets 名單，並非買進建議。");
  return lines.join("\n");
}

async function performanceMessage(env) {
  const [values] = await readSheets(env, [QUERY_RANGES.performance]);
  const records = recordsFromSheet(values, [
    "signal_date", "stock_id", "status", "t20_ret", "t20_date",
    "hit_target", "hit_stop",
  ]);
  if (!records.length) {
    return "📈 歷史選股績效\n目前沒有 BUY 訊號的追蹤紀錄；暫無可計算的勝率或報酬率。";
  }
  const completed = records.filter((row) =>
    row.status.trim() === "完成" && numericPercent(row.t20_ret) !== null
  );
  const lines = [
    "📈 歷史選股績效（非即時）",
    "追蹤總數：" + records.length + " 筆",
    "T+20 完整紀錄：" + completed.length + " 筆",
    "追蹤中／資料未齊：" + (records.length - completed.length) + " 筆",
  ];
  if (!completed.length) {
    lines.push("目前沒有可計算的 T+20 勝率與平均報酬率。");
    return lines.join("\n");
  }

  const returns = completed.map((row) => numericPercent(row.t20_ret));
  const wins = returns.filter((value) => value > 0).length;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  lines.push("T+20 正報酬比例：" + (100 * wins / returns.length).toFixed(1) + "%");
  lines.push("T+20 平均報酬：" + signedPercent(avg));
  lines.push("曾觸及停利／停損：" +
    completed.filter((row) => row.hit_target.trim().toUpperCase() === "Y").length +
    "／" + completed.filter((row) => row.hit_stop.trim().toUpperCase() === "Y").length + " 筆");
  lines.push("最近完成的紀錄：");
  for (const row of completed
    .slice()
    .sort((a, b) => b.signal_date.localeCompare(a.signal_date))
    .slice(0, 5)) {
    lines.push("• " + safeCell(row.stock_id, 12) + "（" +
      safeCell(row.signal_date, 15) + "）T+20 " +
      signedPercent(numericPercent(row.t20_ret)));
  }
  lines.push("以上為歷史樣本統計，不代表未來獲利。");
  return lines.join("\n");
}

async function checkLineSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  let supplied;
  try {
    supplied = Uint8Array.from(atob(signature), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    supplied,
    new TextEncoder().encode(rawBody)
  );
}

async function replyToLine(env, replyToken, message) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: message.slice(0, 4000) }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) console.error("LINE Reply API failed:", response.status);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/") {
      return new Response("LINE Webhook Ready");
    }
    if (path !== "/webhook") return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) {
      return new Response("Missing configuration", { status: 503 });
    }

    const signature = request.headers.get("x-line-signature");
    const body = await request.text();
    if (!(await checkLineSignature(body, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    for (const event of payload.events || []) {
      if (
        event.type !== "message" ||
        event.message?.type !== "text" ||
        event.source?.type !== "group" ||
        !event.replyToken
      ) continue;

      const command = event.message.text.trim();
      const groupId = event.source.groupId;
      const allowedGroupId = (env.LINE_ALLOWED_GROUP_ID || "").trim();
      let message = null;

      if (command === "/群組ID" && !allowedGroupId) {
        message = "群組 ID：" + groupId + "\n請妥善保存，不要公開分享。";
      } else if (allowedGroupId && groupId === allowedGroupId) {
        if (command === "/測試") {
          message = "✅ LINE 機器人連線成功！";
        } else if (
          command === "/資料測試" ||
          command === "/選股" ||
          command === "/觀察" ||
          command === "/績效" ||
          command.startsWith("/個股")
        ) {
          try {
            if (command === "/資料測試") {
              message = await sheetsDiagnosticMessage(env);
            } else if (command === "/選股") {
              message = await screeningMessage(env);
            } else if (command === "/觀察") {
              message = await watchlistMessage(env);
            } else if (command === "/績效") {
              message = await performanceMessage(env);
            } else {
              const match = command.match(/^\/個股\s+([0-9]{4,6})$/);
              message = match
                ? await individualStockMessage(env, match[1])
                : "用法：/個股 2330（請填寫 4～6 位數的台股代號）";
            }
          } catch {
            message = command === "/資料測試"
              ? "⚠️ Google Sheets 讀取失敗，請檢查 Cloudflare Secrets、服務帳戶與工作表權限。"
              : "⚠️ Google Sheets 讀取或資料驗證失敗；請稍後重試，並檢查該批資料是否完整。";
          }
        }
      }
      if (message) await replyToLine(env, event.replyToken, message);
    }

    return new Response("OK", { status: 200 });
  },
};
