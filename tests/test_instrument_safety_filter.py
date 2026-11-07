"""ETF and emerging-market strategy guards; no network or Sheets access."""

from stock_strategies.market import apply_instrument_safety_filter


def test_emerging_buy_downgraded_because_there_is_no_opening_auction():
    signals = [{
        "stock_id": "1260", "action": "BUY", "signal_score": 86,
        "entry_rule": "明日以開盤價進場", "risk_notes": [],
    }]
    watchlist = [{"stock_id": "1260", "name": "富味鄉", "category": "興櫃／食品"}]
    assert apply_instrument_safety_filter(signals, watchlist) == 1
    assert signals[0]["action"] == "WATCH"
    assert "興櫃" in signals[0]["entry_rule"]
    assert "開盤進場模型不適用" in signals[0]["entry_rule"]
    assert len(signals[0]["risk_notes"]) == 1


def test_leveraged_etf_buy_downgraded_without_eps_roe_valuation():
    signals = [{
        "stock_id": "00685L", "action": "BUY",
        "entry_rule": "明日以開盤價進場",
    }]
    watchlist = [{"stock_id": "00685L", "name": "群益臺灣加權正2", "category": "ETF"}]
    assert apply_instrument_safety_filter(signals, watchlist) == 1
    assert signals[0]["action"] == "WATCH"
    assert "ETF 不適用普通股 EPS／ROE" in signals[0]["entry_rule"]
    assert "槓桿" in signals[0]["entry_rule"]
    assert len(signals[0]["risk_notes"]) == 1
    assert apply_instrument_safety_filter(signals, watchlist) == 0
    assert len(signals[0]["risk_notes"]) == 1


def test_bond_etf_watch_keeps_watch_and_adds_fundamental_limitation():
    signals = [{"stock_id": "00687B", "action": "WATCH", "risk_notes": []}]
    watchlist = [{"stock_id": "00687B", "category": "ETF"}]
    assert apply_instrument_safety_filter(signals, watchlist) == 0
    assert signals[0]["action"] == "WATCH"
    assert "EPS／ROE" in signals[0]["risk_notes"][0]


def test_otc_common_stock_buy_unchanged():
    signals = [{
        "stock_id": "6488", "action": "BUY",
        "entry_rule": "明日以開盤價進場", "risk_notes": [],
    }]
    watchlist = [{"stock_id": "6488", "category": "半導體"}]
    assert apply_instrument_safety_filter(signals, watchlist) == 0
    assert signals[0]["action"] == "BUY"
    assert signals[0]["entry_rule"] == "明日以開盤價進場"
    assert signals[0]["risk_notes"] == []


def test_non_buy_emerging_error_not_upgraded():
    signals = [{"stock_id": "7756", "action": "ERROR", "risk_notes": ["資料取得失敗"]}]
    watchlist = [{"stock_id": "7756", "category": "興櫃／觀光餐旅"}]
    assert apply_instrument_safety_filter(signals, watchlist) == 0
    assert signals[0]["action"] == "ERROR"
    assert "資料取得失敗" in signals[0]["risk_notes"][0]
