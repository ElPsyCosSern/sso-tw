import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";

import worker from "./index.mjs";

const LINE_SECRET = "line-test-secret";
const GOOD_GROUP = "G001";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" });
const publicKey = (await import("node:crypto")).createPublicKey(privateKey);

const env = {
  LINE_CHANNEL_SECRET: LINE_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN: "line-test-access-token",
  LINE_ALLOWED_GROUP_ID: GOOD_GROUP,
  GOOGLE_SHEET_ID: "testSheet0123",
  GOOGLE_CREDS_JSON: JSON.stringify({
    type: "service_account",
    client_email: "test@sample.iam.gserviceaccount.com",
    private_key: privateKey,
  }),
};

function signedMessage(command, groupId = GOOD_GROUP) {
  const body = JSON.stringify({
    events: [{
      type: "message",
      message: { type: "text", text: command },
      source: { type: "group", groupId },
      replyToken: "test-reply-token",
    }],
  });
  const signature = createHmac("sha256", LINE_SECRET).update(body).digest("base64");
  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "x-line-signature": signature },
    body,
  });
}

async function withNetwork(mock, action) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await action();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("public GET only exposes health text", async () => {
  const response = await worker.fetch(new Request("https://worker.example/"), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "LINE Webhook Ready");
  const notFound = await worker.fetch(new Request("https://worker.example/secrets"), {});
  assert.equal(notFound.status, 404);
});

test("reject unsigned or wrongly signed LINE requests", async () => {
  const response = await worker.fetch(new Request("https://worker.example/webhook", {
    method: "POST",
    body: JSON.stringify({ events: [] }),
  }), env);
  assert.equal(response.status, 401);
});

test("preserve /測試 and never access Google for ordinary connection check", async () => {
  const replies = [];
  const response = await withNetwork(async (url, options) => {
    assert.equal(url, "https://api.line.me/v2/bot/message/reply");
    replies.push(JSON.parse(options.body));
    return jsonResponse({});
  }, () => worker.fetch(signedMessage("/測試"), env));
  assert.equal(response.status, 200);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].messages[0].text, "✅ LINE 機器人連線成功！");
});

test("ignore message from non-whitelisted group", async () => {
  let networkCalls = 0;
  const response = await withNetwork(async () => {
    networkCalls++;
    throw new Error("network request must not be sent");
  }, () => worker.fetch(signedMessage("/資料測試", "OTHER_GROUP"), env));
  assert.equal(response.status, 200);
  assert.equal(networkCalls, 0);
});

test("Google reads request ONLY Sheets read-only OAuth scope", async () => {
  const calls = [];
  const example = [
    { values: [
      ["stock_id", "name", "category", "enabled"],
      ["0050", "ETF", "ETF", "TRUE"],
      ["2330", "Stock", "Tech", "TRUE"],
    ] },
    { values: [
      ["date", "stock_id", "name", "action", "signal_score", "entry_price", "stop_loss_price", "target_price", "rr_ratio", "position_pct", "winrate", "samples", "tech_signals", "risk_notes", "run_id", "price_date"],
      ["2026-11-07", "0050", "ETF", "WATCH"],
      ["2026-11-07", "2330", "Stock", "SKIP"],
    ] },
    { values: [["signal_date", "stock_id", "name", "entry_close", "entry_open", "t5_date", "t5_close", "t5_ret", "t10_date", "t10_close", "t10_ret", "t20_date", "t20_close", "t20_ret", "hit_target", "hit_stop", "status"]] },
    { values: [
      ["run_id", "kind", "data_date", "generated_at_utc", "status", "signal_count", "error_count", "part", "content"],
      ["run1", "daily", "2026-11-06", "2026-11-07T00:00:00+00:00", "stale", "2", "0", "1", "report"],
      ["run1", "daily", "2026-11-06", "2026-11-07T00:00:00+00:00", "stale", "2", "0", "0", "1"],
    ] },
  ];
  const response = await withNetwork(async (url, options) => {
    const target = String(url);
    calls.push({ target, method: options.method });
    if (target === "https://oauth2.googleapis.com/token") {
      assert.equal(options.method, "POST");
      const params = new URLSearchParams(options.body);
      const assertion = params.get("assertion");
      const [a, b, c] = assertion.split(".");
      assert.equal(JSON.parse(Buffer.from(a, "base64url").toString()).alg, "RS256");
      const claims = JSON.parse(Buffer.from(b, "base64url").toString());
      assert.equal(claims.iss, "test@sample.iam.gserviceaccount.com");
      assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets.readonly");
      assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
      assert.ok(verify("RSA-SHA256", Buffer.from(a + "." + b), publicKey, Buffer.from(c, "base64url")));
      return jsonResponse({ access_token: "fake-access-token", expires_in: 60 });
    }
    if (target.startsWith("https://sheets.googleapis.com/v4/spreadsheets/")) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer fake-access-token");
      assert.equal(new URL(target).searchParams.getAll("ranges").length, 4);
      return jsonResponse({ valueRanges: example });
    }
    if (target === "https://api.line.me/v2/bot/message/reply") {
      const text = JSON.parse(options.body).messages[0].text;
      assert.match(text, /Google Sheets 唯讀連線成功/);
      assert.match(text, /觀察清單：2 檔啟用/);
      assert.match(text, /Signals：2 筆/);
      assert.match(text, /最近日報：2026-11-06／stale/);
      assert.match(text, /非今日即時交易訊號/);
      return jsonResponse({});
    }
    throw new Error("Unexpected network target");
  }, () => worker.fetch(signedMessage("/資料測試"), env));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
});

test("missing Google credentials gives safe LINE error, no data leak", async () => {
  let googleCalled = false;
  const response = await withNetwork(async (url, options) => {
    if (String(url).includes("googleapis")) {
      googleCalled = true;
      throw new Error("unexpected Google call");
    }
    const text = JSON.parse(options.body).messages[0].text;
    assert.match(text, /Google Sheets 讀取失敗/);
    assert.doesNotMatch(text, /private_key|fake-access-token|-----BEGIN/i);
    return jsonResponse({});
  }, () => worker.fetch(signedMessage("/資料測試"), {
    ...env,
    GOOGLE_CREDS_JSON: "",
  }));
  assert.equal(response.status, 200);
  assert.equal(googleCalled, false);
});

test("LINE group ID setup remains disabled after whitelist configured", async () => {
  let called = false;
  await withNetwork(async () => {
    called = true;
    return jsonResponse({});
  }, () => worker.fetch(signedMessage("/群組ID"), env));
  assert.equal(called, false);
});
