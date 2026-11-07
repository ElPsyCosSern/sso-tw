/**
 * stock-line-bot — Step 5-4
 *
 * LINE private-group commands:
 *   /測試      Existing connectivity reply
 *   /群組ID    Existing one-time setup command (disabled after whitelist is set)
 *   /資料測試  Read-only Google Sheets diagnostic
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
  "'Reports'!A1:I201",
];

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

async function readSheets(env) {
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
  for (const range of DIAGNOSTIC_RANGES) url.searchParams.append("ranges", range);
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Google Sheets read failed");
  const data = await response.json();
  if (!Array.isArray(data.valueRanges) || data.valueRanges.length !== DIAGNOSTIC_RANGES.length) {
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
        } else if (command === "/資料測試") {
          try {
            message = await sheetsDiagnosticMessage(env);
          } catch {
            message = "⚠️ Google Sheets 讀取失敗，請檢查 Cloudflare Secrets、服務帳戶與工作表權限。";
          }
        }
      }
      if (message) await replyToLine(env, event.replyToken, message);
    }

    return new Response("OK", { status: 200 });
  },
};
