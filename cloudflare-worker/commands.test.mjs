import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";

import worker from "./index.mjs";

const lineSecret = "test-hmac-secret";
const groupId = "Gtest123";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" });
const env = {
  LINE_CHANNEL_SECRET: lineSecret,
  LINE_CHANNEL_ACCESS_TOKEN: "line-test-token",
  LINE_ALLOWED_GROUP_ID: groupId,
  GOOGLE_SHEET_ID: "someTestSheet",
  GOOGLE_CREDS_JSON: JSON.stringify({
    type: "service_account",
    client_email: "test@test.iam.gserviceaccount.com",
    private_key: privateKey,
  }),
};

const signalHeaders = [
  "date", "stock_id", "name", "action", "signal_score", "entry_price",
  "stop_loss_price", "target_price", "rr_ratio", "position_pct",
  "winrate", "samples", "tech_signals", "risk_notes", "run_id", "price_date",
];
const reportHeaders = [
  "run_id", "kind", "data_date", "generated_at_utc", "status",
  "signal_count", "error_count", "part", "content",
];
const performanceHeaders = [
  "signal_date", "stock_id", "name", "entry_close", "entry_open",
  "t5_date", "t5_close", "t5_ret", "t10_date", "t10_close", "t10_ret",
  "t20_date", "t20_close", "t20_ret", "hit_target", "hit_stop", "status",
];

const runId = "daily-2026-11-07-42374603633";
const stamp = "2026-11-07T08:00:00+00:00";
function signal(stockId, name, action, score, extras = {}) {
  const row = {
    date: "2026-11-07", stock_id: stockId, name,
    action, signal_score: score, price_date: "2026-11-06",
    run_id: runId, ...extras,
  };
  return signalHeaders.map((h) => String(row[h] ?? ""));
}
function report(part, content, overrides = {}) {
  const row = {
    run_id: runId, kind: "daily", data_date: "2026-11-06",
    generated_at_utc: stamp, status: "stale",
    signal_count: "4", error_count: "0", part: String(part),
    content, ...overrides,
  };
  return reportHeaders.map((h) => String(row[h] ?? ""));
}
function fixture() {
  return {
    Watchlist: [
      ["stock_id", "name", "category", "enabled"],
      ["0050", "元大台灣50", "ETF", "TRUE"],
      ["2330", "台積電", "半導體", "TRUE"],
      ["2317", "鴻海", "電子", "FALSE"],
      ["2454", "聯發科", "電子", "YES"],
      ["2308", "台達電", "電子", "1"],
    ],
    Signals: [
      signalHeaders,
      signal("0050", "元大台灣50", "WATCH", 58, {
        entry_price: "63.7", stop_loss_price: "58.6", target_price: "70.1",
        winrate: "0.6", samples: "10",
      }),
      signal("2330", "台積電", "WATCH", 61.4, {
        entry_price: "100.5", stop_loss_price: "92.46",
        target_price: "110.55", rr_ratio: "1.25",
        winrate: "0.625", samples: "8", tech_signals: "站上月線",
        risk_notes: "量能不足",
      }),
      signal("2454", "聯發科", "WATCH", 52),
      signal("2308", "台達電", "SKIP", 42),
    ],
    Performance: [performanceHeaders],
    Reports: [
      reportHeaders,
      report(1, "segment 1"),
      report(2, "segment 2"),
      report(3, "segment 3"),
      report(4, "segment 4"),
      report(0, "4"),
    ],
  };
}

function signedCommand(text, sourceGroup = groupId) {
  const body = JSON.stringify({
    events: [{
      type: "message",
      message: { type: "text", text },
      source: { type: "group", groupId: sourceGroup },
      replyToken: "example-reply-token",
    }],
  });
  const signature = createHmac("sha256", lineSecret).update(body).digest("base64");
  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "x-line-signature": signature },
    body,
  });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

async function query(command, data = fixture(), sourceGroup = groupId) {
  const previous = globalThis.fetch;
  const accesses = [];
  const replies = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      accesses.push({ type: "oauth", method: options.method });
      return json({ access_token: "mock-token", expires_in: 3600 });
    }
    if (target.startsWith("https://sheets.googleapis.com/v4/spreadsheets/")) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer mock-token");
      const ranges = new URL(target).searchParams.getAll("ranges");
      accesses.push({ type: "sheets", ranges });
      return json({
        valueRanges: ranges.map((r) => ({
          values: data[r.split("!")[0].replaceAll("'", "")] || [],
        })),
      });
    }
    if (target === "https://api.line.me/v2/bot/message/reply") {
      replies.push(JSON.parse(options.body).messages[0].text);
      return json({});
    }
    throw new Error("Unexpected outbound call");
  };
  try {
    const response = await worker.fetch(signedCommand(command, sourceGroup), env);
    assert.equal(response.status, 200);
    return { text: replies[0], replies, accesses };
  } finally {
    globalThis.fetch = previous;
  }
}

test("/觀察 returns enabled stocks and preserves leading zeros", async () => {
  const { text, accesses } = await query("/觀察");
  assert.match(text, /4 檔/);
  assert.match(text, /0050 元大台灣50/);
  assert.match(text, /2330 台積電/);
  assert.doesNotMatch(text, /2317 鴻海/);
  assert.match(text, /並非買進建議/);
  const read = accesses.filter((a) => a.type === "sheets");
  assert.equal(read.length, 1);
  assert.deepEqual(read[0].ranges, ["'Watchlist'!A1:E"]);
});

test("/選股 returns latest fully committed batch, not a current BUY recommendation", async () => {
  const { text, accesses } = await query("/選股");
  assert.match(text, /行情日期：2026-11-06/);
  assert.match(text, /報告狀態：stale/);
  assert.match(text, /歷史或未完整驗證/);
  assert.match(text, /BUY 0｜WATCH 3｜SKIP 1｜ERROR 0/);
  assert.match(text, /0050 元大台灣50/);
  assert.match(text, /2330 台積電/);
  assert.match(text, /台達電/);
  assert.deepEqual(accesses.filter((a) => a.type === "sheets")[0].ranges, [
    "'Signals'!A1:P", "'Reports'!A1:I",
  ]);
});

test("/個股 2330 displays last saved analysis and notes, not live prices", async () => {
  const { text } = await query("/個股 2330");
  assert.match(text, /2330 台積電/);
  assert.match(text, /2026-11-06/);
  assert.match(text, /WATCH｜綜合分數：61.4/);
  assert.match(text, /100.5（非即時成交價）/);
  assert.match(text, /92.46／110.55/);
  assert.match(text, /62.5%（樣本 8 次）/);
  assert.match(text, /風險註記：量能不足/);
  assert.match(text, /歷史或未完整驗證/);
});

test("/個股 with no historical record gives a clear not-found response", async () => {
  const { text } = await query("/個股 9999");
  assert.match(text, /找不到 9999 的已提交分析紀錄/);
});

test("/個股 invalid stock ID gives usage, no API call", async () => {
  const { text, accesses } = await query("/個股 abc");
  assert.match(text, /用法：\/個股 2330/);
  assert.equal(accesses.filter((x) => x.type === "sheets").length, 0);
});

test("/績效 without completed trades does not invent a win rate", async () => {
  const { text, accesses } = await query("/績效");
  assert.match(text, /沒有 BUY 訊號的追蹤紀錄/);
  assert.doesNotMatch(text, /T\+20 平均報酬/);
  assert.deepEqual(accesses.filter((a) => a.type === "sheets")[0].ranges, [
    "'Performance'!A1:Q",
  ]);
});

test("/績效 computes historical T+20 positive-return ratio and mean", async () => {
  const data = fixture();
  const make = (stock, date, ret, target, stop, status) => {
    const row = {
      stock_id: stock, signal_date: date, t20_ret: ret,
      hit_target: target, hit_stop: stop, status,
    };
    return performanceHeaders.map((h) => String(row[h] ?? ""));
  };
  data.Performance.push(make("2330", "2026-06-01", "5.2", "Y", "N", "完成"));
  data.Performance.push(make("2454", "2026-07-01", "-2", "N", "Y", "完成"));
  data.Performance.push(make("0050", "2026-11-06", "", "", "", "追蹤中"));
  const { text } = await query("/績效", data);
  assert.match(text, /追蹤總數：3 筆/);
  assert.match(text, /T\+20 完整紀錄：2 筆/);
  assert.match(text, /追蹤中／資料未齊：1 筆/);
  assert.match(text, /正報酬比例：50.0%/);
  assert.match(text, /平均報酬：\+1.60%/);
  assert.match(text, /曾觸及停利／停損：1／1 筆/);
  assert.match(text, /2454（2026-07-01）T\+20 -2.00%/);
  assert.match(text, /不代表未來獲利/);
});

test("incomplete report segments must fail closed, never show signals", async () => {
  const data = fixture();
  data.Reports.splice(2, 1); // missing report part 2; marker still expects four.
  const { text } = await query("/選股", data);
  assert.match(text, /資料驗證失敗/);
  assert.doesNotMatch(text, /WATCH 3/);
});

test("Signals must match committed run_id and declared count", async () => {
  const data = fixture();
  data.Signals[2][14] = "another-run";
  const { text } = await query("/選股", data);
  assert.match(text, /資料驗證失敗/);
});

test("stock ERROR risk_notes never echo credentials or upstream URLs", async () => {
  const data = fixture();
  data.Signals[2][3] = "ERROR";
  data.Signals[2][13] = "https://api.finmindtrade.com/?token=VERY_SECRET";
  data.Reports[5][6] = "1"; // marker error_count=1
  for (let i = 1; i <= 4; i++) data.Reports[i][6] = "1";
  const { text } = await query("/個股 2330", data);
  assert.match(text, /資料取得或計算失敗/);
  assert.doesNotMatch(text, /VERY_SECRET|finmindtrade/i);
});

test("full column ranges find a newer batch past row 100", async () => {
  const data = fixture();
  for (let i = 0; i < 130; i++) {
    const s = signal("1000", "舊資料", "WATCH", "50");
    s[14] = "old-run-" + i;
    data.Signals.splice(1, 0, s);
  }
  const { text } = await query("/選股", data);
  assert.match(text, /BUY 0｜WATCH 3｜SKIP 1｜ERROR 0/);
  assert.doesNotMatch(text, /舊資料/);
});

test("unauthorized groups cannot invoke any of the four commands", async () => {
  for (const command of ["/選股", "/個股 2330", "/績效", "/觀察"]) {
    const { replies, accesses } = await query(command, fixture(), "not-allowed");
    assert.equal(replies.length, 0);
    assert.equal(accesses.length, 0);
  }
});


test("/個股 supports already percent-formatted Google win rate without multiplying twice", async () => {
  const data = fixture();
  data.Signals[2][10] = "62.5%";
  const { text } = await query("/個股 2330", data);
  assert.match(text, /歷史回測勝率：62\.5%（樣本 8 次）/);
  assert.doesNotMatch(text, /6250%|6250\.0%/);
});

test("/資料測試 requests all Reports so latest report stays correct past row 200", async () => {
  const data = fixture();
  const old = report(0, "1", {
    run_id: "old-2026", data_date: "2026-09-01",
    generated_at_utc: "2026-09-01T00:00:00Z",
  });
  for (let i = 0; i < 230; i++) {
    data.Reports.splice(1, 0, [...old]);
  }
  const { text, accesses } = await query("/資料測試", data);
  assert.match(text, /最近日報：2026-11-06／stale/);
  assert.deepEqual(
    accesses.find((a) => a.type === "sheets").ranges,
    ["'Watchlist'!A1:E101", "'Signals'!A1:P101", "'Performance'!A1:Q101", "'Reports'!A1:I"],
  );
});
