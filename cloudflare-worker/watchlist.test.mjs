import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import worker from "./index.mjs";

const adminId = "U" + "a".repeat(32);
const secondAdmin = "U" + "c".repeat(32);
const otherUserId = "U" + "b".repeat(32);
const groupId = "Gprivate";
const lineSecret = "test-line-secret";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" });
const publicKey = createPublicKey(privateKey);
const baseEnv = {
  LINE_CHANNEL_SECRET: lineSecret,
  LINE_CHANNEL_ACCESS_TOKEN: "line-access-token",
  LINE_ALLOWED_GROUP_ID: groupId,
  LINE_ADMIN_USER_IDS: adminId + ", " + secondAdmin,
  GOOGLE_SHEET_ID: "example-sheet-id",
  GOOGLE_CREDS_JSON: JSON.stringify({
    type: "service_account",
    client_email: "test@example.iam.gserviceaccount.com",
    private_key: privateKey,
  }),
};

const original = [
  ["stock_id", "name", "category", "enabled"],
  ["0050", "元大台灣50", "ETF", "TRUE"],
  ["2330", "台積電", "半導體", "FALSE"],
];

function signedRequest(message, userId = adminId, sourceGroup = groupId) {
  const body = JSON.stringify({
    events: [{
      type: "message",
      source: { type: "group", groupId: sourceGroup, ...(userId ? { userId } : {}) },
      message: { type: "text", text: message },
      replyToken: "mock-reply-token",
    }],
  });
  const signature = createHmac("sha256", lineSecret).update(body).digest("base64");
  return new Request("https://worker.test/webhook", {
    method: "POST",
    headers: { "x-line-signature": signature },
    body,
  });
}

function responseJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function columnIndex(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}

async function simulate(command, opts = {}) {
  const rows = structuredClone(opts.rows ?? original);
  const config = { ...baseEnv, ...(opts.env ?? {}) };
  const calls = [];
  const replies = [];
  const timeline = [];
  const pending = [];
  let sheetsReadCount = 0;
  let catalogDelayUsed = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (requestUrl, options) => {
    const u = new URL(String(requestUrl));
    if (u.href === "https://oauth2.googleapis.com/token") {
      assert.equal(options.method, "POST");
      const jwt = new URLSearchParams(options.body).get("assertion");
      const [head, claim, signature] = jwt.split(".");
      const claims = JSON.parse(Buffer.from(claim, "base64url").toString());
      assert.equal(claims.iss, "test@example.iam.gserviceaccount.com");
      assert.equal(JSON.parse(Buffer.from(head, "base64url").toString()).alg, "RS256");
      assert.ok(verify("RSA-SHA256", Buffer.from(head + "." + claim),
        publicKey, Buffer.from(signature, "base64url")));
      assert.ok([
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
      ].includes(claims.scope));
      calls.push({ type: "oauth", scope: claims.scope });
      return responseJson({
        access_token: claims.scope.endsWith("readonly") ? "read-token" : "write-token",
        expires_in: 30,
      });
    }
    if (u.host === "openapi.twse.com.tw" || u.host === "www.tpex.org.tw") {
      calls.push({ type: "catalog", url: u.href });
      if (opts.delayCatalogMs && !catalogDelayUsed) {
        catalogDelayUsed = true;
        await new Promise((resolve) => setTimeout(resolve, opts.delayCatalogMs));
      }
      if (opts.catalogUnavailable || (opts.blockTpex && u.host === "www.tpex.org.tw")) {
        return responseJson({ error: "official source unavailable" }, opts.blockTpex ? 403 : 503);
      }
      if (u.pathname.endsWith("/t187ap47_L")) {
        return responseJson([
          { "基金代號": "0050", "基金簡稱": "元大台灣50" },
          { "基金代號": "006208", "基金簡稱": "富邦台50" },
          { "基金代號": "00685L", "基金簡稱": "群益臺灣加權正2" },
        ]);
      }
      if (u.pathname.endsWith("/t187ap03_L")) {
        return responseJson([
          { "公司代號": "2330", "公司簡稱": "台積電", "產業別": "24" },
          { "公司代號": "2882", "公司簡稱": "國泰金", "產業別": "17" },
          { "公司代號": "2603", "公司簡稱": "長榮", "產業別": "15" },
          { "公司代號": "8888", "公司簡稱": "未知類股", "產業別": "99" },
        ]);
      }
      if (u.pathname.endsWith("/mopsfin_t187ap03_O")) {
        return responseJson([
          { SecuritiesCompanyCode: "6488", CompanyAbbreviation: "環球晶",
            SecuritiesIndustryCode: "24" },
          { SecuritiesCompanyCode: "3444", CompanyAbbreviation: "利機",
            SecuritiesIndustryCode: "29" },
          { SecuritiesCompanyCode: "3260", CompanyAbbreviation: "威剛",
            SecuritiesIndustryCode: "24" },
        ]);
      }
      if (u.pathname.endsWith("/mopsfin_t187ap03_R")) {
        return responseJson([
          { SecuritiesCompanyCode: "1260", CompanyAbbreviation: "富味鄉",
            SecuritiesIndustryCode: "02" },
          { SecuritiesCompanyCode: "7756", CompanyAbbreviation: "多那之",
            SecuritiesIndustryCode: "16" },
        ]);
      }
      if (u.pathname.endsWith("/tpex_mainboard_quotes")) {
        return responseJson([
          { SecuritiesCompanyCode: "00687B", CompanyName: "國泰20年美債" },
          { SecuritiesCompanyCode: "009825", CompanyName: "聯邦美國金融創新" },
        ]);
      }
      throw new Error("Unknown official catalog endpoint");
    }
    if (u.host === "api.finmindtrade.com") {
      calls.push({ type: "finmind", code: u.searchParams.get("data_id") });
      assert.equal(options.method, "GET");
      assert.equal(u.pathname, "/api/v4/data");
      assert.equal(u.searchParams.get("dataset"), "TaiwanStockInfo");
      assert.equal(options.headers.Authorization, undefined);
      if (opts.finMindUnavailable) return responseJson({ error: "rate limit" }, 429);
      const code = u.searchParams.get("data_id");
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const rows = {
        "3444": [
          { stock_id: "3444", stock_name: "利機", industry_category: "電子通路類",
            type: "tpex", date: "2026-10-23" },
          { stock_id: "3444", stock_name: "利機", industry_category: "電子通路業",
            type: "tpex", date },
        ],
        "1260": [
          { stock_id: "1260", stock_name: "富味鄉", industry_category: "食品工業",
            type: "emerging", date },
        ],
        "1294": [
          { stock_id: "1294", stock_name: "漢田生技", industry_category: "生技醫療業",
            type: "emerging", date: "2024-09-25" },
          { stock_id: "1294", stock_name: "漢田生技", industry_category: "生技醫療業",
            type: "tpex", date },
        ],
        "00687B": [
          { stock_id: "00687B", stock_name: "國泰20年美債",
            industry_category: "ETF", type: "tpex", date },
        ],
      };
      const data = structuredClone(rows[code] || []);
      if (opts.finMindStale) data.forEach((item) => { item.date = "2025-01-01"; });
      if (opts.finMindConflict && data.length) {
        data.push({ ...data.at(-1), stock_name: "不一致名稱" });
      }
      return responseJson({ msg: "success", status: 200, data });
    }
    if (u.host === "sheets.googleapis.com" && u.pathname.endsWith("/values:batchGet")) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer read-token");
      const ranges = u.searchParams.getAll("ranges");
      calls.push({ type: "read", ranges });
      sheetsReadCount++;
      if (sheetsReadCount === 2 && opts.delayVerificationMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayVerificationMs));
      }
      return responseJson({
        valueRanges: ranges.map((r) => ({
          values: r === "'Watchlist'" || r.startsWith("'Watchlist'!")
            ? rows : [],
        })),
      });
    }
    if (u.host === "sheets.googleapis.com" && u.pathname.includes("/values/")) {
      calls.push({ type: "write", method: options.method, url: u.href, body: JSON.parse(options.body) });
      timeline.push("write");
      assert.equal(options.headers.Authorization, "Bearer write-token");
      assert.equal(u.searchParams.get("valueInputOption"), "RAW");
      if (opts.denyWrite) return responseJson({ error: "forbidden" }, 403);
      const body = JSON.parse(options.body);
      assert.equal(body.majorDimension, "ROWS");
      assert.equal(body.values.length, 1);
      if (u.pathname.endsWith(":append")) {
        assert.equal(options.method, "POST");
        assert.equal(u.searchParams.get("insertDataOption"), "INSERT_ROWS");
        assert.deepEqual(body.values[0].length, rows[0].length);
        rows.push(body.values[0].map(String));
        return responseJson({ updates: { updatedRows: 1 } });
      }
      assert.equal(options.method, "PUT");
      const a1 = decodeURIComponent(u.pathname.split("/values/")[1]);
      const match = a1.match(/^'Watchlist'!([A-Z]+)([0-9]+)$/);
      assert.ok(match);
      const column = columnIndex(match[1]);
      const row = Number(match[2]) - 1;
      assert.ok(row >= 1);
      assert.equal(body.values[0].length, 1);
      rows[row][column] = String(body.values[0][0]);
      return responseJson({ updatedCells: 1 });
    }
    if (u.href === "https://api.line.me/v2/bot/message/reply") {
      assert.equal(options.method, "POST");
      timeline.push("reply");
      if (opts.replyStatus && opts.replyStatus !== 200) {
        return responseJson({ message: "simulated LINE error" }, opts.replyStatus);
      }
      replies.push(...JSON.parse(options.body).messages.map((m) => m.text));
      return responseJson({});
    }
    throw new Error("Unexpected network call: " + u.origin);
  };
  try {
    const handler = opts.fresh
      ? (await import("./index.mjs?test=" + encodeURIComponent(opts.fresh))).default
      : worker;
    const response = await handler.fetch(signedRequest(
      command, opts.userId === undefined ? adminId : opts.userId, opts.group ?? groupId
    ), config, {
      waitUntil: (promise) => { pending.push(promise); },
    });
    assert.equal(response.status, 200);
    if (pending.length) await Promise.all(pending);
    return { rows, calls, replies, timeline, text: replies.join("\n") };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("/我的ID returns own LINE User ID in the allowed group without Google access", async () => {
  const { text, calls } = await simulate("/我的ID");
  assert.match(text, new RegExp(adminId));
  assert.equal(calls.filter((c) => c.type !== "oauth").length, 0);
});

test("/我的ID without source.userId explains mobile/consent requirement", async () => {
  const { text, calls } = await simulate("/我的ID", { userId: "" });
  assert.match(text, /沒有提供你的 User ID/);
  assert.equal(calls.length, 0);
});

test("/新增 2882 resolves official stock name and industry and writes one row", async () => {
  const { rows, calls, text } = await simulate("/新增 2882");
  assert.deepEqual(rows.at(-1), ["2882", "國泰金", "金融", "TRUE"]);
  assert.match(text, /2882 國泰金（金融） 已新增/);
  assert.match(text, /證交所上市公司名冊/);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname),
    ["/v1/opendata/t187ap03_L"]);
  assert.equal(calls.filter((c) => c.type === "write").length, 1);
  assert.ok(calls.filter((c) => c.type === "oauth").some((c) => c.scope.endsWith("/spreadsheets")));
  assert.ok(calls.filter((c) => c.type === "oauth").some((c) => c.scope.endsWith(".readonly")));
});

test("/新增 with a name and category uses user-supplied values, not invented lookup", async () => {
  const { rows, text } = await simulate("/新增 2882 國泰金 金融");
  assert.deepEqual(rows.at(-1), ["2882", "國泰金", "金融", "TRUE"]);
  assert.doesNotMatch(text, /未分類/);
});

test("/新增 006208 auto-detects ETF and preserves six-digit code", async () => {
  const { rows, text, calls } = await simulate("/新增 006208");
  assert.deepEqual(rows.at(-1), ["006208", "富邦台50", "ETF", "TRUE"]);
  assert.match(text, /006208 富邦台50（ETF） 已新增/);
  assert.match(text, /證交所 ETF 名冊/);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname),
    ["/v1/opendata/t187ap47_L"]);
});

test("/新增 already enabled returns idempotent message without any update", async () => {
  const { rows, calls, text } = await simulate("/新增 0050");
  assert.deepEqual(rows, original);
  assert.match(text, /已在觀察清單/);
  assert.equal(calls.filter((c) => c.type === "write").length, 0);
  assert.ok(calls.some((c) => c.type === "read"));
  assert.equal(calls.filter((c) => c.type === "catalog").length, 0);
});

test("/新增 re-enables disabled row without replacing its name or category", async () => {
  const { rows, calls, text } = await simulate("/新增 2330");
  assert.deepEqual(rows[2], ["2330", "台積電", "半導體", "TRUE"]);
  const writes = calls.filter((c) => c.type === "write");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.match(text, /已重新啟用/);
});

test("/移除 0050 changes only its enabled cell, preserving original name", async () => {
  const { rows, calls, text } = await simulate("/移除 0050");
  assert.deepEqual(rows[1], ["0050", "元大台灣50", "ETF", "FALSE"]);
  assert.deepEqual(rows[2], original[2]);
  assert.equal(calls.filter((c) => c.type === "write").length, 1);
  assert.match(text, /原有分析紀錄保留/);
});

test("/移除 already disabled row is idempotent", async () => {
  const { rows, calls, text } = await simulate("/移除 2330");
  assert.deepEqual(rows, original);
  assert.match(text, /已停用/);
  assert.equal(calls.filter((c) => c.type === "write").length, 0);
});

test("/移除 missing stock is no-op", async () => {
  const { rows, calls, text } = await simulate("/移除 2882");
  assert.deepEqual(rows, original);
  assert.match(text, /不在觀察清單/);
  assert.equal(calls.filter((c) => c.type === "write").length, 0);
});

test("/觀察 remains read-only and retains zero-prefixed ETFs", async () => {
  const { calls, text } = await simulate("/觀察");
  assert.match(text, /0050 元大台灣50/);
  assert.doesNotMatch(text, /2330 台積電/);
  assert.equal(calls.filter((c) => c.type === "write").length, 0);
  assert.ok(calls.filter((c) => c.type === "oauth").every((c) => c.scope.endsWith(".readonly")));
});

test("other group members cannot write even if the group itself is allowed", async () => {
  for (const command of ["/新增 2882", "/移除 0050"]) {
    const result = await simulate(command, { userId: otherUserId });
    assert.match(result.text, /只有已設定的管理員/);
    assert.equal(result.calls.length, 0);
    assert.deepEqual(result.rows, original);
  }
});

test("any group other than LINE_ALLOWED_GROUP_ID cannot query or write", async () => {
  for (const command of ["/新增 2882", "/移除 0050", "/我的ID", "/觀察"]) {
    const result = await simulate(command, { group: "Goutside" });
    assert.equal(result.replies.length, 0);
    assert.equal(result.calls.length, 0);
  }
});

test("when LINE_ADMIN_USER_IDS is not configured writes fail closed", async () => {
  const result = await simulate("/新增 2882", { env: { LINE_ADMIN_USER_IDS: "" } });
  assert.match(result.text, /尚未設定 LINE_ADMIN_USER_IDS/);
  assert.equal(result.calls.length, 0);
});

test("when LINE omits userId writes fail closed", async () => {
  const result = await simulate("/移除 0050", { userId: "" });
  assert.match(result.text, /LINE 未提供 User ID/);
  assert.equal(result.calls.length, 0);
});

test("multiple admin user IDs are accepted from the secret", async () => {
  const { rows } = await simulate("/移除 0050", { userId: secondAdmin });
  assert.equal(rows[1][3], "FALSE");
});

test("unrecognized stock ID syntax is rejected before Google is called", async () => {
  for (const command of [
    "/新增", "/新增 28A2", "/新增 2330;DROP", "/新增 123",
    "/新增 1234567", "/移除", "/移除 2330 9999",
  ]) {
    const result = await simulate(command);
    assert.match(result.text, /用法/);
    assert.equal(result.calls.length, 0);
  }
});

test("write failure never claims success and leaves Watchlist unchanged", async () => {
  const result = await simulate("/新增 2882", { denyWrite: true });
  assert.deepEqual(result.rows, original);
  assert.match(result.text, /更新或回讀驗證失敗/);
  assert.doesNotMatch(result.text, /已新增|已重新啟用/);
});

test("duplicate stock IDs in Watchlist are rejected without updating either row", async () => {
  const rows = [...structuredClone(original), ["0050", "duplicate", "ETF", "FALSE"]];
  const result = await simulate("/移除 0050", { rows });
  assert.deepEqual(result.rows, rows);
  assert.match(result.text, /更新或回讀驗證失敗/);
  assert.equal(result.calls.filter((x) => x.type === "write").length, 0);
});

test("enabled column may be reordered; only the right cell gets changed", async () => {
  const rows = [
    ["enabled", "category", "name", "stock_id"],
    ["FALSE", "半導體", "台積電", "2330"],
  ];
  const result = await simulate("/新增 2330", { rows });
  assert.deepEqual(result.rows[1], ["TRUE", "半導體", "台積電", "2330"]);
  assert.match(result.calls.find((x) => x.type === "write").url, /Watchlist.*A2/);
});

test("/新增 writes no formulas, score or existing signal rows", async () => {
  const rows = [...structuredClone(original), ["2317", "=FORMULA()", "電子", "FALSE"]];
  const result = await simulate("/新增 2603 長榮 航運", { rows });
  assert.deepEqual(result.rows[3], rows[3]);
  assert.deepEqual(result.rows[4], ["2603", "長榮", "航運", "TRUE"]);
  assert.equal(result.calls.filter((c) => c.type === "write").length, 1);
  assert.ok(result.calls.filter((c) => c.type === "write").every(c => c.url.includes("Watchlist")));
});


test("/版本 identifies deployed Worker source without Google calls", async () => {
  const { text, calls } = await simulate("/版本");
  assert.match(text, /5\.8\.4/);
  assert.equal(calls.length, 0);
});

test("/新增 0050 repairs an already enabled row with blank name and 未分類", async () => {
  const rows = [
    ["stock_id", "name", "category", "enabled"],
    ["0050", "", "未分類", "TRUE"],
  ];
  const result = await simulate("/新增 0050", { rows });
  assert.deepEqual(result.rows[1], ["0050", "元大台灣50", "ETF", "TRUE"]);
  assert.match(result.text, /已自動補齊原有觀察清單資料/);
  assert.match(result.text, /證交所 ETF 名冊/);
  assert.deepEqual(result.calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname),
    ["/v1/opendata/t187ap47_L"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.calls.filter((x) => x.type === "write").length, 2);
});

test("/新增 0050 preserves a custom label and fills only missing category", async () => {
  const rows = [
    ["stock_id", "name", "category", "enabled"],
    ["0050", "我的台灣50", "未分類", "TRUE"],
  ];
  const result = await simulate("/新增 0050", { rows });
  assert.deepEqual(result.rows[1], ["0050", "我的台灣50", "ETF", "TRUE"]);
  assert.equal(result.calls.filter((c) => c.type === "write").length, 1);
});

test("/新增 6488 resolves TPEX name and official industry into category", async () => {
  const { rows, text, calls } = await simulate("/新增 6488");
  assert.deepEqual(rows.at(-1), ["6488", "環球晶", "半導體", "TRUE"]);
  assert.match(text, /櫃買中心上櫃公司名冊/);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname),
    ["/openapi/v1/mopsfin_t187ap03_O"]);
});

test("/新增 unknown ticker fails closed, never appends fake metadata", async () => {
  const result = await simulate("/新增 9999");
  assert.deepEqual(result.rows, original);
  assert.match(result.text, /查無 9999 的上市 ETF／上市公司／上櫃／興櫃公司基本資料/);
  assert.equal(result.calls.filter((c) => c.type === "write").length, 0);
});

test("official data API errors never silently store blank name or 未分類", async () => {
  const result = await simulate("/新增 7777", { catalogUnavailable: true });
  assert.deepEqual(result.rows, original);
  assert.match(result.text, /官方證券基本資料暫時無法驗證/);
  assert.equal(result.calls.filter((c) => c.type === "write").length, 0);
});

test("existing incomplete data is not overwritten when official service is unreachable", async () => {
  const rows = [
    ["stock_id", "name", "category", "enabled"],
    ["7777", "", "未分類", "TRUE"],
  ];
  const result = await simulate("/新增 7777", { rows, catalogUnavailable: true });
  assert.deepEqual(result.rows, rows);
  assert.equal(result.calls.filter((c) => c.type === "write").length, 0);
});

test("manual /新增 name and category still works without a catalog lookup", async () => {
  const result = await simulate("/新增 2882 國泰金 金融", { catalogUnavailable: true });
  assert.deepEqual(result.rows.at(-1), ["2882", "國泰金", "金融", "TRUE"]);
  assert.equal(result.calls.filter((c) => c.type === "catalog").length, 0);
});

test("unknown industry metadata never guesses a category", async () => {
  // Test an official company whose industry code is absent from the approved mapping.
  const result = await simulate("/新增 8888");
  assert.equal(result.calls.filter((c) => c.type === "write").length, 0);
  assert.deepEqual(result.rows, original);
});


test("/新增 can re-enable and fill an incomplete disabled ETF in place", async () => {
  const rows = [
    ["stock_id", "name", "category", "enabled"],
    ["0050", "", "未分類", "FALSE"],
  ];
  const result = await simulate("/新增 0050", { rows });
  assert.deepEqual(result.rows[1], ["0050", "元大台灣50", "ETF", "TRUE"]);
  assert.equal(result.rows.length, 2);
  assert.match(result.text, /已重新啟用並確認資料/);
  assert.equal(result.calls.filter((c) => c.type === "write").length, 3);
});


test("/新增 00685L auto-resolves leveraged ETF and warns about ordinary-stock strategy", async () => {
  const { rows, calls, text } = await simulate("/新增 00685L");
  assert.deepEqual(rows.at(-1), ["00685L", "群益臺灣加權正2", "ETF", "TRUE"]);
  assert.match(text, /槓桿及反向 ETF/);
  assert.match(text, /證交所 ETF 名冊/);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname),
    ["/v1/opendata/t187ap47_L"]);
});

test("/新增 accepts lowercase 00685l and stores canonical uppercased 00685L", async () => {
  const { rows } = await simulate("/新增 00685l");
  assert.equal(rows.at(-1)[0], "00685L");
});

test("/新增 00687B finds an OTC bond ETF from official TPEx market listing", async () => {
  const { rows, calls, text } = await simulate("/新增 00687B");
  assert.deepEqual(rows.at(-1), ["00687B", "國泰20年美債", "ETF", "TRUE"]);
  assert.match(text, /櫃買上櫃行情名冊/);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname), [
    "/v1/opendata/t187ap47_L", "/openapi/v1/tpex_mainboard_quotes",
  ]);
});

test("/新增 1260 reads official TPEx emerging-company directory", async () => {
  const { rows, text, calls } = await simulate("/新增 1260");
  assert.deepEqual(rows.at(-1), ["1260", "富味鄉", "興櫃／食品", "TRUE"]);
  assert.match(text, /櫃買中心興櫃公司名冊/);
  assert.match(text, /沒有一般股票的開盤價/);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname), [
    "/openapi/v1/mopsfin_t187ap03_R",
  ]);
});

test("/新增 7756 searches emerging first and names the venue", async () => {
  const { rows, calls } = await simulate("/新增 7756");
  assert.deepEqual(rows.at(-1), ["7756", "多那之", "興櫃／觀光餐旅", "TRUE"]);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname), [
    "/openapi/v1/mopsfin_t187ap03_R",
  ]);
});

test("/新增 3260 remains an OTC stock (not emerging)", async () => {
  const { rows, calls } = await simulate("/新增 3260");
  assert.deepEqual(rows.at(-1), ["3260", "威剛", "半導體", "TRUE"]);
  assert.deepEqual(calls.filter((c) => c.type === "catalog").map((c) => new URL(c.url).pathname), [
    "/v1/opendata/t187ap03_L", "/openapi/v1/mopsfin_t187ap03_O",
  ]);
});

test("/移除 00685L disables exact alphanumeric row without erasing its name", async () => {
  const rows = [...structuredClone(original), ["00685L", "群益臺灣加權正2", "ETF", "TRUE"]];
  const result = await simulate("/移除 00685L", { rows });
  assert.deepEqual(result.rows.at(-1), ["00685L", "群益臺灣加權正2", "ETF", "FALSE"]);
  assert.equal(result.calls.filter((c) => c.type === "write").length, 1);
});

test("/新增 00685L re-enables previously disabled leveraged ETF without duplication", async () => {
  const rows = [...structuredClone(original), ["00685L", "群益臺灣加權正2", "ETF", "FALSE"]];
  const result = await simulate("/新增 00685L", { rows });
  assert.deepEqual(result.rows.at(-1), ["00685L", "群益臺灣加權正2", "ETF", "TRUE"]);
  assert.equal(result.rows.length, rows.length);
  assert.equal(result.calls.filter((c) => c.type === "catalog").length, 0);
});

test("/觀察 shows alphanumeric ETF and emerging rows after an add", async () => {
  const rows = [...structuredClone(original),
    ["00685L", "群益臺灣加權正2", "ETF", "TRUE"],
    ["1260", "富味鄉", "興櫃／食品", "TRUE"]];
  const { text } = await simulate("/觀察", { rows });
  assert.match(text, /00685L 群益臺灣加權正2/);
  assert.match(text, /1260 富味鄉/);
});

test("invalid alphanumeric stock IDs fail closed before Sheets reads", async () => {
  for (const command of ["/新增 00685LL", "/新增 L00685", "/新增 00B85L",
    "/新增 00685_", "/移除 00685LL", "/新增 1234567L"]) {
    const result = await simulate(command);
    assert.match(result.text, /用法/);
    assert.equal(result.calls.length, 0);
  }
});


test("/新增 sends an early free LINE acknowledgement when Sheets verification is slow", async () => {
  // Reproduces: the new stock row was committed, but read-back took long
  // enough that LINE didn't receive the old final reply.
  const result = await simulate("/新增 00685L", {
    delayVerificationMs: 5200,
  });
  assert.deepEqual(result.rows.at(-1), ["00685L", "群益臺灣加權正2", "ETF", "TRUE"]);
  assert.equal(result.replies.length, 1);
  assert.match(result.text, /已收到 \/新增 00685L/);
  assert.match(result.text, /不代表寫入成功/);
  assert.match(result.text, /\/觀察/);
  assert.deepEqual(result.timeline, ["write", "reply"]);
});

test("/新增 fast path still replies with verified success, not an unverified acknowledgement", async () => {
  const result = await simulate("/新增 00685L");
  assert.match(result.text, /^✅ 00685L/);
  assert.doesNotMatch(result.text, /⏳/);
  assert.deepEqual(result.timeline, ["write", "reply"]);
});

test("failed LINE Reply is observable, without undoing an already verified Sheets write", async () => {
  const logs = [];
  const oldLog = console.error;
  console.error = (...args) => logs.push(args);
  try {
    const result = await simulate("/新增 00685L", { replyStatus: 400 });
    assert.equal(result.replies.length, 0);
    assert.deepEqual(result.rows.at(-1), ["00685L", "群益臺灣加權正2", "ETF", "TRUE"]);
    assert.deepEqual(result.timeline, ["write", "reply"]);
    assert.ok(logs.some((entry) => entry[0] === "line_reply_failed" &&
      entry[1]?.status === 400));
    assert.doesNotMatch(JSON.stringify(logs), /line-access-token|mock-reply-token|test-line-secret/);
  } finally {
    console.error = oldLog;
  }
});

test("slow rejected admin operation replies pending instead of asserting success", async () => {
  const result = await simulate("/新增 0000", { delayCatalogMs: 5200 });
  assert.match(result.text, /已收到 \/新增 0000/);
  assert.match(result.text, /不代表寫入成功/);
  assert.equal(result.calls.filter((call) => call.type === "write").length, 0);
  assert.deepEqual(result.rows, original);
});


test("/新增 3444 uses the official TPEx directory and sets electronic distribution sector", async () => {
  const { rows, calls, text } = await simulate("/新增 3444", { fresh: "3444-official" });
  assert.deepEqual(rows.at(-1), ["3444", "利機", "電子通路", "TRUE"]);
  assert.match(text, /櫃買中心上櫃公司名冊/);
  assert.equal(calls.filter((call) => call.type === "finmind").length, 0);
  assert.equal(calls.filter((call) => call.type === "write").length, 1);
});

test("/新增 3444 falls back safely to free per-code FinMind when TPEx returns 403", async () => {
  const { rows, calls, text } = await simulate("/新增 3444", {
    fresh: "3444-403", blockTpex: true,
  });
  assert.deepEqual(rows.at(-1), ["3444", "利機", "電子通路", "TRUE"]);
  assert.match(text, /^✅ 3444 利機（電子通路）/);
  assert.match(text, /FinMind TaiwanStockInfo（第三方備援/);
  assert.equal(calls.filter((call) => call.type === "write").length, 1);
  assert.deepEqual(calls.filter((call) => call.type === "finmind").map((c) => c.code), ["3444"]);
  assert.deepEqual(calls.filter((call) => call.type === "catalog").map((c) => new URL(c.url).pathname), [
    "/v1/opendata/t187ap03_L", "/openapi/v1/mopsfin_t187ap03_O",
  ]);
});

test("/新增 1260 falls back to FinMind's emerging type if TPEx refuses requests", async () => {
  const { rows, calls, text } = await simulate("/新增 1260", {
    fresh: "1260-403", blockTpex: true,
  });
  assert.deepEqual(rows.at(-1), ["1260", "富味鄉", "興櫃／食品", "TRUE"]);
  assert.match(text, /興櫃採議價交易/);
  assert.match(text, /第三方備援/);
  assert.deepEqual(calls.filter((call) => call.type === "finmind").map((c) => c.code), ["1260"]);
  assert.equal(calls.filter((c) => c.type === "write").length, 1);
});

test("TPEx unavailable and FinMind rate-limited: never writes an unverified symbol", async () => {
  const { rows, calls, text } = await simulate("/新增 3444", {
    fresh: "3444-backup-denied", blockTpex: true, finMindUnavailable: true,
  });
  assert.deepEqual(rows, original);
  assert.equal(calls.filter((call) => call.type === "write").length, 0);
  assert.match(text, /官方證券基本資料暫時無法驗證/);
});

test("FinMind stale last update cannot authorize Watchlist insertion", async () => {
  const { rows, calls, text } = await simulate("/新增 3444", {
    fresh: "3444-stale", blockTpex: true, finMindStale: true,
  });
  assert.deepEqual(rows, original);
  assert.equal(calls.filter((call) => call.type === "write").length, 0);
  assert.match(text, /官方證券基本資料暫時無法驗證/);
});

test("FinMind contradictory newest names do not silently pick one", async () => {
  const { rows, calls, text } = await simulate("/新增 3444", {
    fresh: "3444-conflict", blockTpex: true, finMindConflict: true,
  });
  assert.deepEqual(rows, original);
  assert.equal(calls.filter((call) => call.type === "write").length, 0);
  assert.match(text, /官方證券基本資料暫時無法驗證/);
});

test("a non-manager cannot trigger FinMind fallback or write Sheets", async () => {
  const { rows, calls, text } = await simulate("/新增 3444", {
    fresh: "3444-not-admin", blockTpex: true, userId: otherUserId,
  });
  assert.deepEqual(rows, original);
  assert.equal(calls.length, 0);
  assert.match(text, /只有已設定的管理員/);
});


test("fallback uses latest FinMind market when a stock transferred from emerging to TPEx", async () => {
  const { rows, calls, text } = await simulate("/新增 1294", {
    fresh: "1294-transfer-latest", blockTpex: true,
  });
  assert.deepEqual(rows.at(-1), ["1294", "漢田生技", "生技醫療", "TRUE"]);
  assert.doesNotMatch(text, /興櫃採議價交易/);
  assert.match(text, /FinMind TaiwanStockInfo/);
  assert.equal(calls.filter((call) => call.type === "finmind").length, 1);
});
