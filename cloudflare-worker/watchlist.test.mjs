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
    if (u.host === "sheets.googleapis.com" && u.pathname.endsWith("/values:batchGet")) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer read-token");
      const ranges = u.searchParams.getAll("ranges");
      calls.push({ type: "read", ranges });
      return responseJson({
        valueRanges: ranges.map((r) => ({
          values: r === "'Watchlist'" || r.startsWith("'Watchlist'!")
            ? rows : [],
        })),
      });
    }
    if (u.host === "sheets.googleapis.com" && u.pathname.includes("/values/")) {
      calls.push({ type: "write", method: options.method, url: u.href, body: JSON.parse(options.body) });
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
      replies.push(...JSON.parse(options.body).messages.map((m) => m.text));
      return responseJson({});
    }
    throw new Error("Unexpected network call: " + u.origin);
  };
  try {
    const response = await worker.fetch(signedRequest(
      command, opts.userId === undefined ? adminId : opts.userId, opts.group ?? groupId
    ), config);
    assert.equal(response.status, 200);
    return { rows, calls, replies, text: replies.join("\n") };
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

test("/新增 2882 only writes one new row with default category", async () => {
  const { rows, calls, text } = await simulate("/新增 2882");
  assert.deepEqual(rows.at(-1), ["2882", "", "未分類", "TRUE"]);
  assert.match(text, /2882 已新增/);
  assert.match(text, /名稱未填/);
  assert.equal(calls.filter((c) => c.type === "write").length, 1);
  assert.ok(calls.filter((c) => c.type === "oauth").some((c) => c.scope.endsWith("/spreadsheets")));
  assert.ok(calls.filter((c) => c.type === "oauth").some((c) => c.scope.endsWith(".readonly")));
});

test("/新增 with a name and category uses user-supplied values, not invented lookup", async () => {
  const { rows, text } = await simulate("/新增 2882 國泰金 金融");
  assert.deepEqual(rows.at(-1), ["2882", "國泰金", "金融", "TRUE"]);
  assert.doesNotMatch(text, /名稱未填/);
});

test("/新增 006208 preserves six-digit ETF codes exactly", async () => {
  const { rows, text } = await simulate("/新增 006208");
  assert.equal(rows.at(-1)[0], "006208");
  assert.match(text, /006208 已新增/);
});

test("/新增 already enabled returns idempotent message without any update", async () => {
  const { rows, calls, text } = await simulate("/新增 0050");
  assert.deepEqual(rows, original);
  assert.match(text, /已在觀察清單/);
  assert.equal(calls.filter((c) => c.type === "write").length, 0);
  assert.ok(calls.some((c) => c.type === "read"));
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
