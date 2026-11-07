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
      report(1, "📊 *V3.0 每日選股報告* 2026/11/07\n掃描 4 檔 | BUY 0 | WATCH 3 | SKIP 1\n\n🎯 *大盤濾鏡*\n加權指數月線之上\n\n🌙 *夜盤濾鏡*\n昨晚夜盤 -0.3%（中性）\n\n🌡️ *市場氛圍*\n🟡 中性偏多\n池內均漲 +1.2%\n\n📡 *類股強弱排名*\n📈 *半導體* (1檔) 5日均漲+1.3%\n📋 *策略規則*"),
      report(2, "🟢 *BUY: 今日無符合全部條件的標的*\n\n🟡 *WATCH — 接近訊號 TOP 3*\n\n*0050 元大台灣50*  綜合 58 分\n基本面✅ | 技術分 54 | 勝率 60% (10次)\n❓ 差在: 綜合分58(<65)\n\n*2330 台積電*  綜合 61.4 分\n🔥 5日+3.4% | 20日+2.1% | 站上月線\n📌 *明日開盤進場* | 參考價 100.5\n基本面✅ | 技術分 52 | 勝率 62.5% (8次)\n❓ 差在: 綜合分61.4(<65)\n\n*2454 聯發科*  綜合 52 分\n❓ 差在: 基本面未達標"),
      report(3, "🧠 *今日操作建議*\n\n🔑 *最值得關注*\n• *2330 台積電* (WATCH, 61.4分)\n綜合分數領先\n\n📌 *操作方向*\n• 市場中性偏多，選股不選市"),
      report(4, "🔬 *量價深度解析* 2026/11/07\n\n⚠️ *風險警示 — 放量滯漲*\n• 2454 聯發科"),
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
      const messages = JSON.parse(options.body).messages;
      assert.ok(messages.length >= 1 && messages.length <= 5);
      for (const m of messages) {
        assert.equal(m.type, "text");
        assert.ok(m.text.length > 0 && m.text.length <= 5000);
        replies.push(m.text);
      }
      return json({});
    }
    throw new Error("Unexpected outbound call");
  };
  try {
    const response = await worker.fetch(signedCommand(command, sourceGroup), env);
    assert.equal(response.status, 200);
    return { text: replies.join("\n"), replies, accesses };
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


test("/完整報告 restores four saved original sections in one LINE reply (historical)", async () => {
  const { replies, text, accesses } = await query("/完整報告");
  assert.equal(replies.length, 4);
  assert.ok(replies.every((s) => s.includes("行情日：2026-11-06｜狀態：stale")));
  assert.ok(replies.every((s) => s.includes("歷史／未完整驗證")));
  assert.match(replies[0], /市場總覽/);
  assert.match(replies[0], /觀察池市場氛圍/);
  assert.match(replies[0], /觀察池類股強弱排名/);
  assert.match(replies[0], /加權指數月線之上/);
  assert.match(replies[1], /個股完整分析/);
  assert.match(replies[1], /為 0|BUY: 今日無符合全部條件的標的/);
  assert.match(replies[1], /當時的隔日開盤進場假設/);
  assert.match(replies[2], /當時操作建議（歷史）/);
  assert.match(replies[2], /最值得關注/);
  assert.match(replies[2], /操作方向/);
  assert.match(replies[3], /量價深度解析/);
  assert.match(replies[3], /放量滯漲/);
  assert.doesNotMatch(text, /\*今日操作建議\*/);
  assert.equal(accesses.filter((entry) => entry.type === "sheets").length, 1);
});

test("/總覽 shows original watchlist-market sentiment and sector ranks", async () => {
  const { text, replies } = await query("/總覽");
  assert.equal(replies.length, 1);
  assert.match(text, /池內均漲 \+1.2%/);
  assert.match(text, /觀察池類股強弱排名/);
  assert.match(text, /半導體/);
  assert.match(text, /非全台股/);
  assert.match(text, /行情日期：2026-11-06/);
});

test("/建議 shows original focus and strategy direction as historical", async () => {
  const { text } = await query("/建議");
  assert.match(text, /當時操作建議（歷史）/);
  assert.match(text, /最值得關注/);
  assert.match(text, /操作方向/);
  assert.match(text, /2330 台積電/);
  assert.match(text, /不是今日即時行情或買進建議/);
});

test("/量價 restores original volume-risk section", async () => {
  const { text } = await query("/量價");
  assert.match(text, /量價深度解析/);
  assert.match(text, /風險警示/);
  assert.match(text, /放量滯漲/);
});

test("/夜盤 restores day-end filter and distinguishes /盤前", async () => {
  const { text } = await query("/夜盤");
  assert.match(text, /夜盤情緒濾鏡/);
  assert.match(text, /昨晚夜盤 -0.3%/);
  assert.match(text, /請輸入 \/盤前/);
  assert.match(text, /歷史或未完整驗證/);
});

test("/個股 enriches with original source reasons, not synthetic scoring", async () => {
  const { text } = await query("/個股 2330");
  assert.match(text, /原作者本批分析理由（歷史紀錄）/);
  assert.match(text, /基本面✅ \| 技術分 52/);
  assert.match(text, /差在: 綜合分61.4/);
  assert.match(text, /5日\+3.4%/);
  assert.match(text, /歷史或未完整驗證/);
});

test("/盤前 returns no-data message before the premarket job is enabled", async () => {
  const { text, accesses } = await query("/盤前");
  assert.match(text, /尚無已提交的 08:00 夜盤盤前快報/);
  assert.deepEqual(accesses.filter((a) => a.type === "sheets")[0].ranges,
    ["'Reports'!A1:I"]);
});

test("/盤前 displays saved original night-session report only after commit", async () => {
  const data = fixture();
  const premarketId = "premarket-2026-11-06-123";
  data.Reports.push(report(1,
    "🌙 *夜盤盤前快報* 2026/11/06\n台指期夜盤 -0.9%\n📈 開盤方向預判：偏空\n📋 昨日訊號 × 夜盤對照",
    { run_id: premarketId, kind: "premarket", status: "stale",
      signal_count: "4", data_date: "2026-11-06", generated_at_utc: stamp }));
  data.Reports.push(report(0, "1", {
    run_id: premarketId, kind: "premarket", status: "stale",
    signal_count: "4", data_date: "2026-11-06", generated_at_utc: stamp,
  }));
  const { text } = await query("/盤前", data);
  assert.match(text, /台指期夜盤 -0.9%/);
  assert.match(text, /當時開盤方向判斷（歷史）/);
  assert.match(text, /歷史／不完整盤前報告/);
  assert.doesNotMatch(text, /\*夜盤盤前快報\*/);
});

test("/盤前 fails closed if latest stored report is missing one part", async () => {
  const data = fixture();
  data.Reports.push(report(1, "🌙 夜盤報告 part one", {
    kind: "premarket", run_id: "premarket-incomplete", status: "complete",
    generated_at_utc: "2026-11-08T12:00:00Z",
  }));
  data.Reports.push(report(0, "2", {
    kind: "premarket", run_id: "premarket-incomplete", status: "complete",
    generated_at_utc: "2026-11-08T12:00:00Z",
  }));
  const { text } = await query("/盤前", data);
  assert.match(text, /資料驗證失敗/);
  assert.doesNotMatch(text, /part one/);
});

test("long reports paginate without truncation and respect five LINE messages", async () => {
  const data = fixture();
  const original = data.Reports[2][8];
  const longMiddle = original + "\n" + "報告資料完整版 " + "甲".repeat(17_000) + " 最後一行已保存";
  const slices = [];
  for(let i = 0; i < longMiddle.length; i += 20000) {
    slices.push(longMiddle.slice(i, i+20000));
  }
  data.Reports = [
    reportHeaders,
    report(1, data.Reports[1][8]),
    ...slices.map((chunk, i) => report(i+2, chunk)),
    report(slices.length+2, data.Reports[3][8]),
    report(slices.length+3, data.Reports[4][8]),
    report(0, String(slices.length+3)),
  ];
  const first = await query("/完整報告", data);
  assert.equal(first.replies.length, 4);
  assert.match(first.replies[3], /下一組：\/報告 2/);
  assert.ok(first.replies.every((text) => text.length <= 4900));
  const second = await query("/報告 2", data);
  assert.ok(second.replies.length >= 1);
  assert.ok(second.replies.every((text) => text.length <= 4900));
  // The last parts remain reachable, even when the original middle report is >20k.
  let remaining = second.text;
  for(let n=3; n<=10 && /下一組：\/報告 /.test(remaining); n++){
    const next=await query("/報告 "+n,data);
    remaining=next.text;
  }
  assert.match(remaining, /量價深度解析/);
  assert.match(remaining, /放量滯漲/);
});

test("invalid /報告 page and /功能 are handled without public access", async () => {
  const invalid = await query("/報告 abc");
  assert.match(invalid.text, /用法：\/報告 2/);
  assert.equal(invalid.accesses.filter((x) => x.type === "sheets").length, 0);
  const help = await query("/功能");
  assert.match(help.text, /完整報告/);
  assert.match(help.text, /量價/);
  assert.equal(help.accesses.filter((x)=>x.type==="sheets").length,0);
});

test("unauthorized LINE groups cannot request any of the new full reports", async () => {
  for(const command of ["/總覽","/完整報告","/報告 2","/建議","/量價","/夜盤","/盤前","/功能"]){
    const result=await query(command, fixture(), "not-allowed");
    assert.equal(result.replies.length,0);
    assert.equal(result.accesses.length,0);
  }
});


test("/個股 accepts ETF codes with letter suffix (00685L, 00687B)", async () => {
  for (const stockId of ["00685L", "00687B"]) {
    const { text } = await query("/個股 " + stockId);
    assert.match(text, new RegExp(stockId));
    assert.doesNotMatch(text, /用法：/);
  }
  const lower = await query("/個股 00685l");
  assert.match(lower.text, /00685L/);
  const invalid = await query("/個股 00685LL");
  assert.match(invalid.text, /用法：/);
});
