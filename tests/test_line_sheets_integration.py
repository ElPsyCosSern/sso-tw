"""LINE/Screenshots snapshot safety tests. No live cloud or FinMind calls."""
import pytest

from stock_strategies import reporting, sheet


class FakeWorksheet:
    def __init__(self, rows=None, cols=20):
        self.rows = [list(row) for row in (rows or [])]
        self.col_count = cols
        self.row_count = 1000
        self.calls = []

    def get_all_values(self):
        return [row[:] for row in self.rows]

    def row_values(self, row):
        return self.rows[row - 1][:] if row <= len(self.rows) else []

    def add_cols(self, n):
        self.col_count += n

    def add_rows(self, n):
        self.row_count += n

    def _set(self, row_num, col_num, value):
        while len(self.rows) < row_num:
            self.rows.append([])
        row = self.rows[row_num - 1]
        while len(row) < col_num:
            row.append("")
        row[col_num - 1] = str(value)

    def update(self, range_name, values, value_input_option=None):
        import re
        match = re.fullmatch(r"([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?", range_name)
        assert match, range_name
        c = 0
        for letter in match[1]:
            c = c * 26 + ord(letter) - ord("A") + 1
        start = int(match[2])
        for i, row in enumerate(values):
            for j, val in enumerate(row):
                self._set(start + i, c + j, val)
        self.calls.append(("update", range_name, value_input_option))

    def batch_update(self, updates, value_input_option=None):
        for item in updates:
            self.update(item["range"], item["values"], value_input_option=value_input_option)
        self.calls.append(("batch", len(updates)))

    def append_rows(self, rows, value_input_option=None):
        for row in rows:
            self.rows.append([str(v) for v in row])
        self.calls.append(("append", len(rows), value_input_option))


class FakeSpreadsheet:
    def __init__(self):
        self.sheets = {}

    def worksheet(self, title):
        if title not in self.sheets:
            raise sheet.gspread.WorksheetNotFound(title)
        return self.sheets[title]

    def add_worksheet(self, title, rows, cols):
        result = FakeWorksheet(cols=cols)
        self.sheets[title] = result
        return result


@pytest.fixture
def fake_sheet(monkeypatch):
    doc = FakeSpreadsheet()
    monkeypatch.setattr(sheet, "get_gsheet", lambda: doc)
    return doc


def test_watchlist_preserves_leading_zeros(fake_sheet):
    fake_sheet.sheets["Watchlist"] = FakeWorksheet([
        ["stock_id", "name", "category", "enabled"],
        ["0050", "元大台灣50", "ETF", "TRUE"],
        ["2330", "台積電", "半導體", "FALSE"],
    ])
    assert sheet.read_watchlist()[0]["stock_id"] == "0050"
    assert len(sheet.read_watchlist()) == 1


def test_signals_idempotent_per_run(fake_sheet):
    signal = {"date": "2026-11-06", "stock_id": "0050",
              "name": "元大台灣50", "action": "WATCH",
              "signal_score": 60, "price_date": "2026-11-06"}
    sheet.append_signals([signal], run_id="daily-2026-11-06-99")
    sheet.append_signals([signal], run_id="daily-2026-11-06-99")
    ws = fake_sheet.sheets["Signals"]
    assert len(ws.get_all_values()) == 2
    assert ws.get_all_values()[1][1] == "0050"
    assert ws.get_all_values()[1][14] == "daily-2026-11-06-99"
    assert ws.get_all_values()[1][15] == "2026-11-06"


def test_existing_signals_headers_extend_without_erasing(fake_sheet):
    fake_sheet.sheets["Signals"] = FakeWorksheet([
        sheet.SIGNAL_HEADERS[:14],
        ["2026-10-30", "2330", "台積電", "BUY"] + [""] * 10,
    ], cols=14)
    sheet.append_signals([{"stock_id": "0050", "date": "2026-11-06",
                          "action": "WATCH", "price_date": "2026-11-06"}],
                         run_id="new-run")
    values = fake_sheet.sheets["Signals"].get_all_values()
    assert values[1][1] == "2330"
    assert values[0] == sheet.SIGNAL_HEADERS


def test_failed_performance_write_does_not_call_clear(fake_sheet):
    ws = FakeWorksheet([
        sheet.PERFORMANCE_HEADERS,
        ["2026-11-01", "0050", "元大台灣50"] + [""] * 14,
    ])
    fake_sheet.sheets["Performance"] = ws
    sheet.write_performance([{"signal_date": "2026-11-06", "stock_id": "2330"}])
    assert len(ws.rows) == 2
    assert ws.rows[1][1] == "2330"
    assert [c[0] for c in ws.calls] == ["update"]


def test_report_content_precedes_commit_marker(fake_sheet):
    sheet.save_report(
        run_id="run1", kind="daily", data_date="2026-11-06",
        status="complete", signal_count=1, error_count=0,
        messages=["A" * 20100],
    )
    ws = fake_sheet.sheets["Reports"]
    rows = ws.get_all_values()
    assert len(rows) == 4  # header + two parts + commit marker
    assert rows[-1][7] == "0" and rows[-1][8] == "2"
    assert rows[1][7] == "1" and rows[2][7] == "2"
    sheet.save_report(
        run_id="run1", kind="daily", data_date="2026-11-06",
        status="partial", signal_count=1, error_count=1,
        messages=["new"],
    )
    rows = ws.get_all_values()
    assert len(rows) == 4
    assert rows[-1][4] == "partial" and rows[-1][8] == "1"


def test_daily_status_requires_current_prices_and_complete_sources():
    base = [{"stock_id": "2330", "action": "WATCH", "price_date": "2026-11-06"}]
    watch = [{"stock_id": "2330"}]
    market = {"close": 30000, "data_date": "2026-11-06"}
    night = {"date": "2026-11-06"}
    assert reporting.daily_status(base, watch, market, night, "2026-11-06") == "complete"
    assert reporting.daily_status(base, watch, market, night, "2026-11-07") == "stale"
    assert reporting.daily_status(base, watch, {}, night, "2026-11-06") == "partial"
    assert reporting.daily_status(base, watch, market, None, "2026-11-06") == "partial"
    assert reporting.daily_status([], watch, market, night, "2026-11-06") == "partial"



def test_performance_accepts_blank_first_row_from_sheets(fake_sheet):
    """Google API can return [[]] from a new worksheet before any cells are written."""
    ws = FakeWorksheet([[]], cols=len(sheet.PERFORMANCE_HEADERS))
    fake_sheet.sheets["Performance"] = ws
    sheet.write_performance([])
    assert ws.row_values(1) == sheet.PERFORMANCE_HEADERS
    assert len(ws.get_all_values()) == 1



def test_daily_status_rejects_future_and_old_night_sessions():
    result = [{"stock_id": "2330", "action": "WATCH", "price_date": "2026-11-06"}]
    watch = [{"stock_id": "2330"}]
    market = {"close": 30_000, "data_date": "2026-11-06"}
    assert reporting.daily_status(
        result, watch, market, {"date": "2026-11-09"}, "2026-11-06"
    ) == "partial"
    assert reporting.daily_status(
        result, watch, market, {"date": "2026-11-01"}, "2026-11-06"
    ) == "partial"
    assert reporting.daily_status(
        result, watch, market, {"date": "2026-11-05"}, "2026-11-06"
    ) == "complete"


def test_premarket_status_rejects_stale_or_weekend_test_signals(monkeypatch):
    from datetime import datetime as RealDatetime

    class FakeDatetime:
        @staticmethod
        def now(tz=None):
            return RealDatetime(2026, 11, 9, 8, 0, tzinfo=tz)

    monkeypatch.setattr(reporting, "datetime", FakeDatetime)
    night = {"date": "2026-11-09"}
    friday = [{"date": "2026-11-06", "price_date": "2026-11-06",
               "stock_id": "2330", "action": "WATCH"}]
    assert reporting.premarket_status(night, friday) == "complete"
    assert reporting.premarket_status({"date": "2026-11-07"}, friday) == "stale"
    assert reporting.premarket_status({"date": "2026-11-10"}, friday) == "stale"
    assert reporting.premarket_status(
        night, [{"date": "2026-11-07", "price_date": "2026-11-06",
                 "stock_id": "2330", "action": "WATCH"}]
    ) == "stale"
    assert reporting.premarket_status(
        night, [{"date": "2026-11-05", "price_date": "2026-11-05",
                 "stock_id": "2330", "action": "WATCH"}]
    ) == "stale"
    assert reporting.premarket_status(night, []) == "partial"


def test_premarket_message_does_not_reuse_old_buy_after_new_skip():
    from stock_strategies.notify import format_premarket
    last = [
        {"date": "2026-11-09", "price_date": "2026-11-09",
         "stock_id": "2330", "action": "SKIP"},
        {"date": "2026-11-06", "price_date": "2026-11-06",
         "stock_id": "0050", "name": "old position", "action": "BUY",
         "signal_score": "70"},
    ]
    message = format_premarket(None, last)
    assert "前一交易日無 BUY/WATCH" in message
    assert "0050" not in message
    assert "old position" not in message


def test_premarket_persists_warning_only_when_stale(monkeypatch):
    import premarket

    monkeypatch.setattr(
        premarket.os, "environ",
        {"FINMIND_TOKEN": "dummy", "GOOGLE_SHEET_ID": "dummy",
         "GOOGLE_CREDS_JSON": "dummy"},
    )
    monkeypatch.setattr(premarket, "get_night_session", lambda: {
        "date": "2026-11-09", "pct": 0.0, "label": "平盤",
    })
    monkeypatch.setattr(premarket, "read_latest_signals", lambda limit=300: [
        {"date": "2026-11-07", "price_date": "2026-11-06",
         "stock_id": "2330", "action": "BUY"},
    ])
    monkeypatch.setattr(premarket, "premarket_status", lambda night, signals: "stale")
    monkeypatch.setattr(
        premarket, "format_premarket",
        lambda night, signals: "BUY 2330 明日開盤進場",
    )
    saved = {}
    monkeypatch.setattr(premarket, "save_report", lambda **kwargs: saved.update(kwargs))
    premarket.main()
    assert saved["status"] == "stale"
    assert saved["kind"] == "premarket"
    assert "本次不提供開盤方向" in saved["messages"][0]
    assert "明日開盤進場" not in saved["messages"][0]



def test_original_four_report_headings_remain_compatible_with_line_worker():
    """Contract: Reports.content source sections used by the LINE Worker.

    If the upstream report title or section count changes, review the Worker
    section mapping before deploying, instead of silently dropping content.
    """
    from stock_strategies.notify import format_messages

    signals = [{
        "stock_id": "0050",
        "name": "元大台灣50",
        "action": "SKIP",
        "signal_score": 40,
        "trend": {},
        "components": {},
    }]
    watchlist = [{"stock_id": "0050", "category": "ETF"}]
    messages = format_messages(
        signals,
        watchlist,
        market={"note": "大盤資料示意"},
        night_note="夜盤資料示意",
    )
    assert len(messages) == 4
    assert messages[0].startswith("📊 *V3.0 每日選股報告*")
    assert messages[1].startswith("🟢 *BUY")
    assert messages[2].startswith("🧠 *今日操作建議*")
    assert messages[3].startswith("🔬 *量價深度解析*")
