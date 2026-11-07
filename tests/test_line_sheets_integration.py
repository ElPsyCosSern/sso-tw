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
