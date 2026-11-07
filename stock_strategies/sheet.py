import os
import json
from datetime import datetime, timezone

import gspread
from google.oauth2.service_account import Credentials


SIGNAL_HEADERS = [
    "date", "stock_id", "name", "action", "signal_score",
    "entry_price", "stop_loss_price", "target_price",
    "rr_ratio", "position_pct", "winrate", "samples",
    "tech_signals", "risk_notes", "run_id", "price_date",
]

REPORT_HEADERS = [
    "run_id", "kind", "data_date", "generated_at_utc",
    "status", "signal_count", "error_count", "part", "content",
]


def _records(ws) -> list[dict]:
    """使用原始文字讀取，避免 Google Sheets 的 0050 被轉成數字 50。"""
    values = ws.get_all_values()
    if not values:
        return []
    headers = [str(v).strip() for v in values[0]]
    return [
        {header: str(row[i]) if i < len(row) else "" for i, header in enumerate(headers)}
        for row in values[1:]
        if any(str(value).strip() for value in row)
    ]


def _ensure_sheet(sh, title: str, headers: list[str]):
    try:
        ws = sh.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(title=title, rows=1000, cols=len(headers))

    existing = [h.strip() for h in ws.row_values(1)]
    if existing and existing != headers[:len(existing)]:
        raise ValueError(f"{title} 欄位格式不符合預期；未自動覆蓋既有資料")
    if len(existing) < len(headers):
        if ws.col_count < len(headers):
            ws.add_cols(len(headers) - ws.col_count)
        ws.update(
            range_name=f"A1:{gspread.utils.rowcol_to_a1(1, len(headers))}",
            values=[headers],
            value_input_option="RAW",
        )
    return ws


def get_gsheet():
    creds_json = os.environ["GOOGLE_CREDS_JSON"]
    creds_dict = json.loads(creds_json)
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
    gc = gspread.authorize(creds)
    return gc.open_by_key(os.environ["GOOGLE_SHEET_ID"])


def read_watchlist() -> list[dict]:
    """從 Watchlist 讀取股票清單，保留 ETF 代號的前導零。"""
    ws = get_gsheet().worksheet("Watchlist")
    return [
        r for r in _records(ws)
        if r.get("stock_id", "").strip()
        and r.get("enabled", "").strip().upper() in ("TRUE", "1", "YES")
    ]


def append_signals(signals: list[dict], *, run_id: str):
    """儲存一批選股結果；同一 run_id + stock_id 重試時覆寫，不重複新增。"""
    if not signals:
        return
    if not run_id:
        raise ValueError("run_id 不可為空")

    ws = _ensure_sheet(get_gsheet(), "Signals", SIGNAL_HEADERS)
    values = ws.get_all_values()
    existing = {}
    for row_number, row in enumerate(values[1:], start=2):
        if len(row) >= len(SIGNAL_HEADERS) and row[14] and row[1]:
            existing[(row[14], row[1])] = row_number

    updates, additions, seen = [], [], set()
    for s in signals:
        sid = str(s.get("stock_id", "")).strip()
        if not sid or sid in seen:
            raise ValueError(f"同一批次股票代號缺漏或重複：{sid}")
        seen.add(sid)
        c = s.get("components", {})
        row = [
            s.get("date", ""), sid, s.get("name", ""), s.get("action", ""),
            s.get("signal_score", ""), s.get("entry_price", ""),
            s.get("stop_loss_price", ""), s.get("target_price", ""),
            s.get("risk_reward_ratio", ""), s.get("position_size_pct", ""),
            c.get("backtest_winrate", ""), c.get("backtest_samples", ""),
            ", ".join(c.get("tech_signals", [])),
            " / ".join(s.get("risk_notes", [])),
            run_id, s.get("price_date", ""),
        ]
        row_number = existing.get((run_id, sid))
        if row_number is not None:
            updates.append({
                "range": f"A{row_number}:P{row_number}",
                "values": [row],
            })
        else:
            additions.append(row)

    if updates:
        ws.batch_update(updates, value_input_option="RAW")
    if additions:
        ws.append_rows(additions, value_input_option="RAW")


def _ensure_watchlist_headers(ws) -> list[str]:
    """讀第一列 headers，沒 headers 就建好 stock_id/name/enabled 三欄。"""
    values = ws.get_all_values()
    if not values:
        headers = ["stock_id", "name", "enabled"]
        ws.append_row(headers)
        return headers
    headers = [h.strip() for h in values[0]]
    if "stock_id" not in headers or "enabled" not in headers:
        # 既有 sheet 有資料但 schema 不符，謹慎處理 — 不擅自改 headers
        return headers
    return headers


def add_to_watchlist(stock_id: str, name: str = "") -> dict:
    """加一檔到 Watchlist 分頁。

    若該 stock_id 已存在但 enabled=FALSE → 直接改回 TRUE（重啟用）
    若已存在且 enabled=TRUE → 不重複加，回傳 status='exists'
    若不存在 → append 新 row（enabled=TRUE）
    """
    sh = get_gsheet()
    ws = sh.worksheet("Watchlist")
    headers = _ensure_watchlist_headers(ws)

    sid_col = headers.index("stock_id") + 1  # gspread 是 1-based
    name_col = headers.index("name") + 1 if "name" in headers else None
    en_col = headers.index("enabled") + 1

    rows = _records(ws)
    for i, r in enumerate(rows, start=2):  # row 1 是 header
        if str(r.get("stock_id", "")).strip() == str(stock_id).strip():
            current = str(r.get("enabled", "")).upper()
            if current in ("TRUE", "1", "YES"):
                return {
                    "status": "exists",
                    "stock_id": stock_id,
                    "name": r.get("name", name),
                }
            ws.update_cell(i, en_col, "TRUE")
            return {
                "status": "reenabled",
                "stock_id": stock_id,
                "name": r.get("name", name),
            }

    # 不存在 → append
    new_row = [""] * len(headers)
    new_row[sid_col - 1] = str(stock_id)
    if name_col is not None:
        new_row[name_col - 1] = name
    new_row[en_col - 1] = "TRUE"
    ws.append_row(new_row)
    return {"status": "added", "stock_id": stock_id, "name": name}


def remove_from_watchlist(stock_id: str) -> dict:
    """把 Watchlist 該 stock_id 的 enabled 改成 FALSE（軟刪除，保留歷史）"""
    sh = get_gsheet()
    ws = sh.worksheet("Watchlist")
    headers = _ensure_watchlist_headers(ws)
    if "enabled" not in headers:
        return {"status": "no_enabled_column"}
    en_col = headers.index("enabled") + 1

    rows = _records(ws)
    for i, r in enumerate(rows, start=2):
        if str(r.get("stock_id", "")).strip() == str(stock_id).strip():
            ws.update_cell(i, en_col, "FALSE")
            return {"status": "disabled", "stock_id": stock_id}
    return {"status": "not_found", "stock_id": stock_id}


def read_latest_signals(limit: int = 50) -> list[dict]:
    """讀取最新訊號，保留原始股票代號文字。"""
    try:
        ws = get_gsheet().worksheet("Signals")
    except gspread.WorksheetNotFound:
        return []
    rows = _records(ws)
    return rows[-limit:][::-1] if limit > 0 else []


PERFORMANCE_HEADERS = [
    "signal_date", "stock_id", "name", "entry_close", "entry_open",
    "t5_date", "t5_close", "t5_ret",
    "t10_date", "t10_close", "t10_ret",
    "t20_date", "t20_close", "t20_ret",
    "hit_target", "hit_stop", "status",
]


def read_performance() -> list[dict]:
    """讀取 Performance 的現有追蹤紀錄（保留代號前導零）。"""
    try:
        ws = get_gsheet().worksheet("Performance")
    except gspread.WorksheetNotFound:
        return []
    return _records(ws)


def write_performance(records: list[dict]):
    """單次覆寫資料區，不先清空工作表；失敗時避免留下空白成績單。"""
    sh = get_gsheet()
    try:
        ws = sh.worksheet("Performance")
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(
            title="Performance", rows=max(2000, len(records) + 100),
            cols=len(PERFORMANCE_HEADERS),
        )

    existing = ws.get_all_values()
    if existing and existing[0][:len(PERFORMANCE_HEADERS)] != PERFORMANCE_HEADERS:
        raise ValueError("Performance 欄位格式不符合預期；未覆蓋既有資料")

    rows = [PERFORMANCE_HEADERS] + [
        [r.get(h, "") for h in PERFORMANCE_HEADERS] for r in records
    ]
    old_count = len(existing)
    total_count = max(len(rows), old_count)
    if ws.row_count < total_count:
        ws.add_rows(total_count - ws.row_count)
    rows.extend([[""] * len(PERFORMANCE_HEADERS) for _ in range(total_count - len(rows))])
    ws.update(
        range_name=f"A1:Q{total_count}", values=rows, value_input_option="RAW"
    )



def save_report(
    *,
    run_id: str,
    kind: str,
    data_date: str,
    status: str,
    signal_count: int,
    error_count: int,
    messages: list[str],
):
    """先儲存報告分段，最後才寫完成標記，避免 LINE 讀到未完成批次。

    part=0 是提交標記；每個完整的文字部分存一列（不超過 Sheets 儲存格限制）。
    """
    if not run_id or kind not in ("daily", "premarket"):
        raise ValueError("無效的 run_id 或報告種類")
    if status not in ("complete", "partial", "stale", "unavailable"):
        raise ValueError("無效的報告狀態")

    parts = []
    for message in messages:
        text = str(message)
        # Google Sheets 單一儲存格最多 50,000 字元；保守限制 20,000。
        if not text:
            continue
        parts.extend(text[i:i + 20000] for i in range(0, len(text), 20000))

    ws = _ensure_sheet(get_gsheet(), "Reports", REPORT_HEADERS)
    existing = ws.get_all_values()
    indexed = {}
    for row_number, row in enumerate(existing[1:], start=2):
        if len(row) >= 8 and row[0] and row[1] and row[7]:
            indexed[(row[0], row[1], str(row[7]))] = row_number

    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = [
        [run_id, kind, data_date, stamp, status,
         signal_count, error_count, i, text]
        for i, text in enumerate(parts, start=1)
    ]
    # 提交標記必須在所有內容已確認寫入後才建立。
    commit = [
        run_id, kind, data_date, stamp, status,
        signal_count, error_count, 0, str(len(parts)),
    ]

    def upsert(items):
        updates, additions = [], []
        for row in items:
            key = (run_id, kind, str(row[7]))
            existing_row = indexed.get(key)
            if existing_row:
                updates.append({"range": f"A{existing_row}:I{existing_row}", "values": [row]})
            else:
                additions.append(row)
        if updates:
            ws.batch_update(updates, value_input_option="RAW")
        if additions:
            ws.append_rows(additions, value_input_option="RAW")

    # 如果同批次需要重試，先移除舊的完成標記，避免還沒寫完就能被查到。
    marker_row = indexed.get((run_id, kind, "0"))
    if marker_row:
        ws.update(
            range_name=f"E{marker_row}", values=[["writing"]],
            value_input_option="RAW",
        )
    upsert(rows)
    upsert([commit])
