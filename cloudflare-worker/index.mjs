/**
 * stock-line-bot — Step 5-7 original research report integration
 *
 * Existing /測試, /群組ID, /資料測試, /選股, /個股, /績效, /觀察
 * Admin-only /新增, /移除; setup command /我的ID (allowed group only)
 * New /總覽, /建議, /量價, /夜盤, /盤前, /完整報告, /報告 N, /功能
 * All commands are confined to a signed, whitelisted LINE private group.
 *
 * No public Sheet endpoints. Only authorized editors may update Watchlist.
 * All other Google Sheets operations remain read-only; no npm dependency.
 * Before production deployment, compare this file with the deployed source.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

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

// Cache read and write tokens separately; regular lookups must remain read-only.
const tokenCache = new Map();

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

async function getGoogleAccessToken(env, scope = SHEETS_SCOPE) {
  if (scope !== SHEETS_SCOPE && scope !== SHEETS_WRITE_SCOPE) {
    throw new Error("Unsupported OAuth scope");
  }
  const nowMs = Date.now();
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > nowMs + 60_000) return cached.value;

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
    scope,
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
  tokenCache.set(scope, {
    value: tokenData.access_token,
    expiresAt: nowMs + Math.max(0, Number(tokenData.expires_in || 3600)) * 1000,
  });
  return tokenData.access_token;
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
    return {
      marker,
      signals: currentSignals,
      parts: parts.sort((a, b) => Number(a.part) - Number(b.part)),
    };
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
  if (s.action !== "ERROR") {
    try {
      const originalDetails = extractOriginalStockDetail(batch, stockId);
      if (originalDetails.length) {
        lines.push("📑 原作者本批分析理由（" +
          (batchIsCurrent(batch) ? "今日資料" : "歷史紀錄") + "）：");
        lines.push(...originalDetails);
      } else {
        lines.push("本次完整報告沒有可擷取的個股理由；可輸入 /完整報告 閱讀原文。");
      }
    } catch {
      lines.push("原始個股詳情格式無法解析；請使用 /選股 查看基本訊號。");
    }
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


const WATCHLIST_WRITE_RANGE = "'Watchlist'";
const STOCK_ID_PATTERN = /^[0-9]{4,6}$/;

function colName(index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid column");
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}


// Official TWSE / TPEx security master lists; not price or live-quote APIs.
// Code meanings are taken from official exchange industry classification.
const TWSE_ETF_CATALOG = "https://openapi.twse.com.tw/v1/opendata/t187ap47_L";
const TWSE_STOCK_CATALOG = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
const TPEX_STOCK_CATALOG = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";

const INDUSTRY_CATEGORIES = Object.freeze({
  "01": "水泥", "02": "食品", "03": "塑膠", "04": "紡織",
  "05": "電機機械", "06": "電器電纜", "08": "玻璃陶瓷",
  "09": "造紙", "10": "鋼鐵", "11": "橡膠", "12": "汽車",
  "14": "建材營造", "15": "航運", "16": "觀光餐旅", "17": "金融",
  "18": "貿易百貨", "19": "綜合", "20": "其他",
  "21": "化學", "22": "生技醫療", "23": "油電燃氣",
  "24": "半導體", "25": "電腦及週邊設備", "26": "光電",
  "27": "通信網路", "28": "電子零組件", "29": "電子通路",
  "30": "資訊服務", "31": "其他電子", "32": "文化創意",
  "33": "農業科技", "35": "綠能環保", "36": "數位雲端",
  "37": "運動休閒", "38": "居家生活", "80": "管理股票",
});

const officialSecurityCache = new Map();
const OFFICIAL_SECURITY_CACHE_MS = 60 * 60 * 1000;

async function readOfficialCatalog(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error("Official stock directory unavailable");
  const records = await response.json();
  if (!Array.isArray(records) || records.length < 1 || records.length > 12000) {
    throw new Error("Unexpected official stock directory schema");
  }
  return records;
}

function shortOfficialName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 35 || /[\r\n\t<>]/.test(name)) {
    throw new Error("Invalid official stock name");
  }
  return name;
}

function matchCatalog(records, stockId, idColumn, nameColumn, industryColumn, market) {
  const matches = records.filter((row) =>
    row && typeof row === "object" &&
    String(row[idColumn] ?? "").trim() === stockId
  );
  if (matches.length > 1) throw new Error("Duplicated official stock code");
  if (!matches.length) return null;
  const match = matches[0];
  const name = shortOfficialName(match[nameColumn]);
  if (market === "ETF") return { name, category: "ETF", source: "證交所 ETF 名冊" };
  const industryCode = String(match[industryColumn] ?? "").trim().padStart(2, "0");
  const category = INDUSTRY_CATEGORIES[industryCode];
  if (!category) throw new Error("Unsupported official industry code");
  return { name, category, source: market === "TWSE" ? "證交所上市公司名冊" : "櫃買中心上櫃公司名冊" };
}

async function lookupStockMetadata(stockId) {
  if (!STOCK_ID_PATTERN.test(stockId)) throw new Error("Invalid stock ID");
  const cached = officialSecurityCache.get(stockId);
  if (cached && cached.expiry > Date.now()) return cached.metadata;

  // Parallel public queries keep the LINE Reply API within its reply-token TTL.
  const catalogs = [
    { url: TWSE_ETF_CATALOG, id: "基金代號", name: "基金簡稱", industry: null, market: "ETF" },
    { url: TWSE_STOCK_CATALOG, id: "公司代號", name: "公司簡稱", industry: "產業別", market: "TWSE" },
    { url: TPEX_STOCK_CATALOG, id: "SecuritiesCompanyCode", name: "CompanyAbbreviation",
      industry: "SecuritiesIndustryCode", market: "TPEX" },
  ];
  const responses = await Promise.allSettled(catalogs.map(async (spec) => {
    const rows = await readOfficialCatalog(spec.url);
    return matchCatalog(rows, stockId, spec.id, spec.name, spec.industry, spec.market);
  }));
  const valid = responses.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
  if (valid.length > 1) throw new Error("Conflicting official stock listings");
  if (!valid.length) {
    if (responses.some((r) => r.status === "rejected")) {
      throw new Error("Official stock directory not fully available");
    }
    return null;
  }
  officialSecurityCache.set(stockId, { expiry: Date.now() + OFFICIAL_SECURITY_CACHE_MS, metadata: valid[0] });
  return valid[0];
}

function metadataIncomplete(current) {
  return !current?.name || !current?.category ||
    ["未分類", "待分類"].includes(current.category);
}

function parseWatchlist(values, stockId) {
  if (!values.length || !Array.isArray(values[0])) {
    throw new Error("Watchlist header missing");
  }
  const headers = values[0].map((v) => String(v).trim());
  const required = ["stock_id", "name", "category", "enabled"];
  if (required.some((column) => headers.indexOf(column) < 0) ||
      new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) {
    throw new Error("Watchlist schema mismatch");
  }
  const stockCol = headers.indexOf("stock_id");
  const nameCol = headers.indexOf("name");
  const categoryCol = headers.indexOf("category");
  const enabledCol = headers.indexOf("enabled");
  const matches = [];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i]?.[stockCol] ?? "").trim() === stockId) {
      matches.push({
        sheetRow: i + 1,
        name: String(values[i]?.[nameCol] ?? "").trim(),
        category: String(values[i]?.[categoryCol] ?? "").trim(),
        enabled: ["TRUE", "1", "YES"].includes(
          String(values[i]?.[enabledCol] ?? "").trim().toUpperCase()
        ),
      });
    }
  }
  if (matches.length > 1) throw new Error("Duplicate stock IDs in Watchlist");
  return { headers, nameCol, categoryCol, enabledCol, match: matches[0] || null };
}

function isWatchlistAdmin(env, userId) {
  // Unlike the group whitelist, the editor allowlist must be explicitly set.
  if (!userId || !env.LINE_ADMIN_USER_IDS) return false;
  const allowed = String(env.LINE_ADMIN_USER_IDS)
    .split(/[,\s;]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  return allowed.includes(userId);
}

async function writeWatchlistValue(env, operation, a1Range, rowValues) {
  if (!env.GOOGLE_SHEET_ID || !env.GOOGLE_CREDS_JSON) {
    throw new Error("Google Sheets bindings missing");
  }
  const spreadsheetId = String(env.GOOGLE_SHEET_ID).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) throw new Error("Invalid spreadsheet ID");
  // Only two permitted operations: update a single existing enabled cell,
  // or append exactly one new Watchlist row; never clear/replace the worksheet.
  if (operation !== "update" && operation !== "append") {
    throw new Error("Invalid Watchlist operation");
  }
  const token = await getGoogleAccessToken(env, SHEETS_WRITE_SCOPE);
  const url = new URL(
    "https://sheets.googleapis.com/v4/spreadsheets/" + spreadsheetId +
    "/values/" + encodeURIComponent(a1Range) + (operation === "append" ? ":append" : "")
  );
  url.searchParams.set("valueInputOption", "RAW");
  if (operation === "append") url.searchParams.set("insertDataOption", "INSERT_ROWS");

  const response = await fetch(url.toString(), {
    method: operation === "append" ? "POST" : "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      range: a1Range,
      majorDimension: "ROWS",
      values: [rowValues],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Google Sheets write failed");
  const result = await response.json();
  const changed = operation === "append"
    ? Number(result.updates?.updatedRows)
    : Number(result.updatedCells);
  if (changed !== 1) {
    throw new Error("Unexpected Google Sheets update result");
  }
}

async function changeWatchlist(env, action, stockId, name = "", category = "") {
  if (action !== "add" && action !== "remove") throw new Error("Invalid action");
  if (!STOCK_ID_PATTERN.test(stockId)) throw new Error("Invalid stock ID");

  const [before] = await readSheets(env, [WATCHLIST_WRITE_RANGE]);
  const sheet = parseWatchlist(before, stockId);
  const current = sheet.match;

  let official = null;
  let expectedName = current?.name || name;
  let expectedCategory = current?.category || category;

  if (action === "add") {
    // A previously enabled but incomplete row (e.g. 0050 / 未分類)
    // is repaired in place, without overwriting custom names/categories.
    const needName = !current?.name && !name;
    const needCategory = (!current?.category ||
      ["未分類", "待分類"].includes(current.category)) && !category;
    if ((!current || metadataIncomplete(current)) && (needName || needCategory)) {
      try {
        official = await lookupStockMetadata(stockId);
      } catch {
        return "⚠️ 官方證券基本資料暫時無法驗證，未變更 " + stockId +
          "。請稍後重試，或明確提供股票名稱與類股。";
      }
      if (!official) {
        return "⛔ 查無 " + stockId +
          " 的上市 ETF／上市公司／上櫃公司官方基本資料，未新增或修改。";
      }
    }
    expectedName = current?.name || name || official?.name || "";
    expectedCategory = (current?.category &&
      !["未分類", "待分類"].includes(current.category))
      ? current.category
      : category || official?.category || "";

    if (!expectedName || !expectedCategory) {
      return "⚠️ 股票名稱或類股仍不完整，未變更觀察清單。";
    }
    if (current?.enabled && !metadataIncomplete(current)) {
      return "ℹ️ " + stockId + " " + current.name + "（" +
        current.category + "）已在觀察清單內，無須重複新增。";
    }

    if (current) {
      const rowAddress = (columnIndex) =>
        "'Watchlist'!" + colName(columnIndex) + current.sheetRow;
      // Only write cells that actually require an update.
      if (!current.enabled) {
        await writeWatchlistValue(env, "update", rowAddress(sheet.enabledCol), ["TRUE"]);
      }
      if (!current.name) {
        await writeWatchlistValue(env, "update", rowAddress(sheet.nameCol), [expectedName]);
      }
      if (!current.category || ["未分類", "待分類"].includes(current.category)) {
        await writeWatchlistValue(env, "update", rowAddress(sheet.categoryCol), [expectedCategory]);
      }
    } else {
      const row = sheet.headers.map((header) => {
        if (header === "stock_id") return stockId;
        if (header === "name") return expectedName;
        if (header === "category") return expectedCategory;
        if (header === "enabled") return "TRUE";
        return "";
      });
      await writeWatchlistValue(env, "append", WATCHLIST_WRITE_RANGE, row);
    }
  } else {
    if (!current) return "ℹ️ " + stockId + " 不在觀察清單，沒有需要停用的資料。";
    if (!current.enabled) return "ℹ️ " + stockId + " 已停用，無須重複操作。";
    await writeWatchlistValue(
      env, "update",
      "'Watchlist'!" + colName(sheet.enabledCol) + current.sheetRow,
      ["FALSE"]
    );
  }

  // Read back from Google before claiming the command took effect.
  const [after] = await readSheets(env, [WATCHLIST_WRITE_RANGE]);
  const verified = parseWatchlist(after, stockId).match;
  if (!verified || verified.enabled !== (action === "add") ||
      (action === "add" &&
        (verified.name !== expectedName || verified.category !== expectedCategory))) {
    throw new Error("Watchlist read-back verification failed");
  }
  if (action === "remove") {
    return "✅ " + stockId + " 已停用（enabled=FALSE），原有分析紀錄保留。輸入 /觀察 確認。";
  }
  const detail = stockId + " " + expectedName + "（" + expectedCategory + "）";
  const actionText = current
    ? current.enabled ? "已自動補齊原有觀察清單資料" : "已重新啟用並確認資料"
    : "已新增到觀察清單";
  return "✅ " + detail + " " + actionText + "（enabled=TRUE）。" +
    (official ? "\n資料來源：" + official.source + "（非即時行情）。" : "") +
    "\n新的選股結果須等下次執行分析後才會產生。";
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


/**
 * Render the original reports rather than rebuilding market analysis in Worker.
 * save_report() stores each original format_messages() section in Reports.content
 * (possibly split into 20k-character parts); part=0 is the commit marker.
 */
const DAILY_SECTIONS = [
  { key: "overview", title: "市場總覽", start: /^📊\s*\*?V3\.\d+\s*每日選股報告[^\n]*/m },
  { key: "details", title: "個股完整分析", start: /^🟢\s*\*?BUY(?:\s|:|—)[^\n]*/m },
  { key: "advice", title: "操作建議", start: /^🧠\s*\*?今日操作建議[^\n]*/m },
  { key: "volume", title: "量價深度解析", start: /^🔬\s*\*?量價深度解析[^\n]*/m },
];

function originalReportSections(batch) {
  if (!batch.parts || !batch.parts.length) throw new Error("Report body missing");
  const full = batch.parts.map((part) => part.content).join("\n");
  const starts = DAILY_SECTIONS.map((s) => full.search(s.start));
  if (starts.some((at) => at < 0) ||
      starts.some((at, i) => i > 0 && at <= starts[i - 1])) {
    throw new Error("Unknown daily report format");
  }
  return Object.fromEntries(
    DAILY_SECTIONS.map((s, i) => [
      s.key,
      full.slice(starts[i], starts[i + 1] ?? full.length).trim(),
    ])
  );
}

function sanitizeReportText(text, isHistorical) {
  let content = String(text)
    // Telegram markdown asterisks are not formatting in LINE plain text.
    .replace(/\*/g, "")
    // No raw access tokens or credentialed upstream URLs in chat.
    .replace(/https?:\/\/[^\s]*(?:token|api[_-]?key|secret|authorization)[^\s]*/gi, "[敏感網址已隱藏]")
    .replace(/\b(token|access_token|api[_-]?key|secret)\s*[=:]\s*[^\s]+/gi, "$1=[隱藏]")
    .replace(/市場氛圍/g, "觀察池市場氛圍")
    .replace(/類股強弱排名/g, "觀察池類股強弱排名");
  if (isHistorical) {
    content = content
      .replace(/今日操作建議/g, "當時操作建議（歷史）")
      .replace(/明日開盤進場/g, "當時的隔日開盤進場假設（已過期）")
      .replace(/(?:今日)?開盤方向預判/g, "當時開盤方向判斷（歷史）");
  }
  return content;
}

function splitLongText(text, limit = 3500) {
  const pieces = [];
  let remaining = String(text);
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    // LINE counts UTF-16 code units; don't cut a surrogate pair in half.
    if (cut > 0 && /[\uD800-\uDBFF]/.test(remaining[cut - 1])) cut--;
    if (cut <= 0) throw new Error("Unable to split report");
    pieces.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    if (remaining.startsWith("\n")) {
      pieces[pieces.length - 1] += "\n";
      remaining = remaining.slice(1);
    }
  }
  if (remaining) pieces.push(remaining);
  return pieces.length ? pieces : [""];
}

function dailyReportPages(batch) {
  const sections = originalReportSections(batch);
  const historical = !batchIsCurrent(batch);
  const date = safeCell(batch.marker.data_date || "未知", 18);
  const status = safeCell(batch.marker.status, 20);
  const warning = historical
    ? "⚠️ 歷史／未完整驗證，不可當作今日買進或開盤建議。"
    : "✅ 當日資料，並非即時報價或保證獲利的交易指示。";
  const allPages = [];
  for (const section of DAILY_SECTIONS) {
    const original = sections[section.key];
    const content = sanitizeReportText(original, historical);
    const chunks = splitLongText(content, 3500);
    chunks.forEach((part, i) => {
      const title = "📑 " + section.title + (chunks.length > 1 ? "（" + (i + 1) + "/" + chunks.length + "）" : "");
      const caveat = section.key === "overview"
        ? "\n📌 市場氛圍與類股強弱僅統計 Watchlist 觀察池，非全台股。"
        : "";
      allPages.push([
        title,
        "行情日：" + date + "｜狀態：" + status,
        warning + caveat,
        "",
        part,
      ].join("\n"));
    });
  }
  return allPages;
}

function pageGroup(pages, page = 1) {
  const maxGroup = Math.ceil(pages.length / 4);
  if (!Number.isSafeInteger(page) || page < 1 || page > maxGroup) {
    return "沒有第 " + page + " 組；本報告共有 " + maxGroup + " 組。請輸入 /完整報告。";
  }
  const from = (page - 1) * 4;
  const visible = pages.slice(from, from + 4);
  if (page < maxGroup) {
    const tail = "\n\n📖 下一組：/報告 " + (page + 1) +
      "（每次以最新提交的批次重新讀取）";
    visible[visible.length - 1] += tail;
  }
  // LINE reply API max 5 messages, each max 5000 UTF-16 code units.
  if (visible.length > 5 || visible.some((s) => s.length > 4900)) {
    throw new Error("LINE report length limit exceeded");
  }
  return visible;
}

async function fullReportMessage(env, group = 1) {
  const batch = await latestBatchForQuery(env);
  if (!batch) return "📭 尚無可供查看的已提交每日報告。";
  return pageGroup(dailyReportPages(batch), group);
}

async function reportSectionMessage(env, sectionName) {
  const batch = await latestBatchForQuery(env);
  if (!batch) return "📭 尚無可供查看的已提交每日報告。";
  const sections = originalReportSections(batch);
  const content = sanitizeReportText(sections[sectionName], !batchIsCurrent(batch));
  const lines = [
    "📑 " + DAILY_SECTIONS.find((s) => s.key === sectionName).title,
    ...batchHeader(batch),
  ];
  if (sectionName === "overview") {
    lines.push("📌 以下市場氛圍及類股排名只統計 Watchlist，非全台股。");
  }
  const head = lines.join("\n") + "\n\n";
  const chunks = splitLongText(content, 3500).map((s) => head + s);
  if (chunks.length > 4) {
    return ["報告較長，請使用 /完整報告 並依提示輸入 /報告 2、/報告 3 閱讀完整內容。"];
  }
  return chunks;
}

function extractOriginalStockDetail(batch, stockId) {
  const sections = originalReportSections(batch);
  const lines = sections.details.split("\n");
  const stockLine = new RegExp("^\\*?" + stockId + "\\s+");
  const start = lines.findIndex((line) => stockLine.test(line));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length &&
      !/^\*?[0-9]{4,6}\s/.test(lines[end]) &&
      !/^[🟢🟡]\s*\*?(?:BUY|WATCH)/.test(lines[end])) {
    end++;
  }
  return lines.slice(start + 1, end)
    .filter((line) => /^(?:🔥|📈|📉|💥|基本面|💡\s*為何買|❓\s*差在)/.test(line.trim()))
    .map((line) => safeCell(sanitizeReportText(line, !batchIsCurrent(batch)), 260))
    .filter(Boolean);
}

async function nightFilterMessage(env) {
  const batch = await latestBatchForQuery(env);
  if (!batch) return "📭 尚無夜盤濾鏡歷史報告。";
  const sections = originalReportSections(batch);
  const match = sections.overview.match(/^🌙\s*\*?夜盤濾鏡\*?\s*\n([^\n]+)/m);
  const lines = ["🌙 收盤後夜盤情緒濾鏡（非盤前即時行情）", ...batchHeader(batch)];
  lines.push(match
    ? sanitizeReportText(match[1], !batchIsCurrent(batch))
    : "這份日報沒有可擷取的夜盤濾鏡註記。");
  lines.push("如需早上 08:00 夜盤快報，請輸入 /盤前。");
  return lines.join("\n");
}

function committedPremarketReport(reportValues) {
  const reports = recordsFromSheet(reportValues, [
    "run_id", "kind", "part", "content", "status", "data_date", "generated_at_utc",
  ]);
  const markers = reports
    .filter((row) => row.kind === "premarket" && row.part.trim() === "0")
    .sort((a, b) => b.generated_at_utc.localeCompare(a.generated_at_utc));
  if (!markers.length) return null;
  const marker = markers[0];
  if (!marker.run_id ||
      !["complete", "partial", "stale", "unavailable"].includes(marker.status)) {
    throw new Error("Invalid premarket marker");
  }
  const total = Number(marker.content);
  const parts = reports
    .filter((r) => r.kind === "premarket" && r.run_id === marker.run_id && r.part !== "0")
    .sort((a, b) => Number(a.part) - Number(b.part));
  if (!Number.isSafeInteger(total) || total < 1 || total > 100 ||
      parts.length !== total ||
      parts.some((r, i) =>
        Number(r.part) !== i + 1 || !r.content || r.status !== marker.status)) {
    throw new Error("Incomplete premarket report");
  }
  return { marker, parts };
}

async function premarketMessage(env) {
  const [reportValues] = await readSheets(env, [QUERY_RANGES.reports]);
  const report = committedPremarketReport(reportValues);
  if (!report) {
    return "📭 尚無已提交的 08:00 夜盤盤前快報；正式盤前排程目前尚未啟用。";
  }
  const isCurrent = report.marker.status === "complete" &&
    report.marker.data_date === taiwanDate();
  const header = [
    "🌙 最近盤前夜盤快報",
    "夜盤資料標籤日：" + safeCell(report.marker.data_date || "未知", 18) +
      "｜狀態：" + safeCell(report.marker.status, 20),
    isCurrent
      ? "✅ 盤前資料已通過時效驗證，仍非即時行情或必然開盤方向。"
      : "⚠️ 歷史／不完整盤前報告，不可當作今日開盤方向預判。",
    "",
  ].join("\n");
  const body = sanitizeReportText(report.parts.map((p) => p.content).join("\n"), !isCurrent);
  const chunks = splitLongText(body, 3500).map((part) => header + part);
  return chunks.length <= 4
    ? chunks
    : "這份夜盤快報太長，為避免內容截斷而停止顯示。";
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
  const texts = Array.isArray(message) ? message : [message];
  if (!texts.length || texts.length > 5 ||
      texts.some((text) => typeof text !== "string" || !text || text.length > 4900)) {
    throw new Error("LINE response length/count invalid");
  }
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      replyToken,
      messages: texts.map((text) => ({ type: "text", text })),
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
        } else if (command === "/我的ID") {
          message = event.source.userId
            ? "🔐 你的 LINE User ID：" + event.source.userId +
              "\n請勿轉傳此個人識別碼；將它設定為 Cloudflare Secret：LINE_ADMIN_USER_IDS。"
            : "⚠️ LINE 沒有提供你的 User ID，無法建立編輯權限。請改用 LINE 手機版發送此指令。";
        } else if (command.startsWith("/新增") || command.startsWith("/移除")) {
          const isAdd = command.startsWith("/新增");
          const match = isAdd
            ? command.match(/^\/新增\s+([0-9]{4,6})(?:\s+([^\s]{1,30}))?(?:\s+([^\s]{1,30}))?$/u)
            : command.match(/^\/移除\s+([0-9]{4,6})$/u);
          if (!match) {
            message = isAdd
              ? "用法：/新增 2882 或 /新增 2882 國泰金 金融（僅支援 4～6 位數字代號）"
              : "用法：/移除 2882（僅支援 4～6 位數字代號）";
          } else if (!String(env.LINE_ADMIN_USER_IDS || "").trim()) {
            message = "⛔ 尚未設定 LINE_ADMIN_USER_IDS，觀察清單寫入功能維持停用。";
          } else if (!event.source.userId) {
            message = "⛔ LINE 未提供 User ID，無法確認管理員身分；請使用 LINE 手機版重試。";
          } else if (!isWatchlistAdmin(env, event.source.userId)) {
            message = "⛔ 只有已設定的管理員可以修改觀察清單。";
          } else {
            try {
              message = await changeWatchlist(
                env, isAdd ? "add" : "remove", match[1], match[2] || "", match[3] || ""
              );
            } catch {
              message = "⚠️ Watchlist 更新或回讀驗證失敗，請先用 /觀察 確認資料，再決定是否重試。";
            }
          }
        } else if (
          command === "/資料測試" ||
          command === "/選股" ||
          command === "/觀察" ||
          command === "/績效" ||
          command === "/完整報告" ||
          command === "/總覽" ||
          command === "/建議" ||
          command === "/量價" ||
          command === "/夜盤" ||
          command === "/盤前" ||
          command === "/功能" ||
          command.startsWith("/報告") ||
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
            } else if (command === "/完整報告") {
              message = await fullReportMessage(env);
            } else if (command.startsWith("/報告")) {
              const match = command.match(/^\/報告\s+([1-9][0-9]{0,2})$/);
              message = match
                ? await fullReportMessage(env, Number(match[1]))
                : "用法：/報告 2（查看完整報告的下一組內容）";
            } else if (command === "/總覽") {
              message = await reportSectionMessage(env, "overview");
            } else if (command === "/建議") {
              message = await reportSectionMessage(env, "advice");
            } else if (command === "/量價") {
              message = await reportSectionMessage(env, "volume");
            } else if (command === "/夜盤") {
              message = await nightFilterMessage(env);
            } else if (command === "/盤前") {
              message = await premarketMessage(env);
            } else if (command === "/功能") {
              message = "📚 LINE 台股研究查詢\n" +
                "/總覽－市場氛圍與類股強弱\n" +
                "/選股－BUY/WATCH/SKIP 摘要\n" +
                "/個股 2330－個股分析與理由\n" +
                "/建議－原作者操作建議\n" +
                "/量價－量價深度解析\n" +
                "/夜盤－最新日報夜盤濾鏡\n" +
                "/盤前－08:00 夜盤盤前快報\n" +
                "/完整報告－四大研究報告\n" +
                "/報告 2－完整報告續頁\n" +
                "/觀察、/績效、/資料測試－既有查詢\n" +
                "/新增 2882－新增／重新啟用（管理員）\n" +
                "/移除 2882－停用但保留歷史（管理員）\n" +
                "/我的ID－取得管理員設定用 User ID\n" +
                "僅供研究參考，所有行情日期請以回覆標示為準。";
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
