"""3444 上櫃流動性、ETF 降級保護與價格資料契約測試。"""
import importlib

import pandas as pd

from tests.conftest import make_price_df
from stock_strategies import data, market
from stock_strategies.notify import format_messages

module = importlib.import_module("stock_strategies.evaluate")


def fake_common(monkeypatch, turnover):
    price = make_price_df()
    if turnover is not None:
        price["Trading_money"] = [turnover] * len(price)
    monkeypatch.setattr(module, "get_price_history", lambda *_: price.copy())
    monkeypatch.setattr(module, "get_fundamental", lambda _: {
        "eps": {2024: 10, 2025: 12}, "roe": {2024: 18, 2025: 20},
    })
    monkeypatch.setattr(module, "backtest", lambda *_: {
        "winrate": 0.9, "samples": 12, "avg_return": 0.05,
    })
    monkeypatch.setattr(module, "tech_score_at", lambda *_: {
        "score": 100, "signals": ["均線多頭"],
    })
    monkeypatch.setattr(module, "detect_patterns", lambda *_: {
        "patterns": [], "bonus": 0, "details": {},
    })


def test_3444_can_be_buy_after_normal_stock_gates_and_liquidity(monkeypatch):
    fake_common(monkeypatch, 8_200_000)
    result = module.evaluate("3444", "利機", min_avg_turnover_twd=5_000_000)
    assert result["action"] == "BUY"
    assert result["components"]["liquidity_pass"] is True
    assert result["components"]["avg_turnover20_twd"] == 8_200_000
    assert result["position_size_pct"] <= 5.0
    assert "限價" in result["entry_rule"]


def test_3444_low_turnover_blocks_buy_without_changing_historical_score(monkeypatch):
    fake_common(monkeypatch, 2_000_000)
    result = module.evaluate("3444", "利機", min_avg_turnover_twd=5_000_000)
    assert result["action"] == "WATCH"
    assert result["components"]["liquidity_pass"] is False
    assert result["signal_score"] >= 65
    assert "不代表可於隔日開盤成交" in result["entry_rule"]
    assert any("平均成交金額" in note for note in result["risk_notes"])


def test_3444_missing_turnover_fails_closed(monkeypatch):
    fake_common(monkeypatch, None)
    result = module.evaluate("3444", "利機", min_avg_turnover_twd=5_000_000)
    assert result["action"] == "WATCH"
    assert result["components"]["avg_turnover20_twd"] is None
    assert any("流動性不明" in note for note in result["risk_notes"])


def test_other_common_stock_has_no_new_liquidity_dependency(monkeypatch):
    fake_common(monkeypatch, None)
    result = module.evaluate("2330", "台積電")
    assert result["action"] == "BUY"
    assert "avg_turnover20_twd" not in result["components"]


def test_new_0050_strategy_bypasses_only_own_etf_guard():
    rows = [{"stock_id": "0050", "category": "ETF"},
            {"stock_id": "00685L", "category": "ETF"},
            {"stock_id": "1260", "category": "興櫃／食品"}]
    signals = [
        {"stock_id": "0050", "strategy_id": "equity_etf_0050_v1", "action": "BUY"},
        {"stock_id": "00685L", "strategy_id": "default", "action": "BUY"},
        {"stock_id": "1260", "action": "BUY"},
    ]
    assert market.apply_instrument_safety_filter(signals, rows) == 2
    assert [s["action"] for s in signals] == ["BUY", "WATCH", "WATCH"]


def test_0050_and_3444_stale_signals_never_claim_current_buy():
    signals = [
        {"stock_id": "0050", "price_date": "2026-11-06", "action": "BUY"},
        {"stock_id": "3444", "price_date": "2026-11-06", "action": "BUY"},
        {"stock_id": "2330", "price_date": "2026-11-06", "action": "BUY"},
    ]
    assert market.apply_target_freshness_filter(signals, "2026-11-08") == 2
    assert [s["action"] for s in signals] == ["WATCH", "WATCH", "BUY"]
    assert market.apply_target_freshness_filter(signals, "2026-11-08") == 0


def test_fresh_0050_and_3444_keep_verified_buy():
    signals = [
        {"stock_id": "0050", "price_date": "2026-11-06", "action": "BUY"},
        {"stock_id": "3444", "price_date": "2026-11-06", "action": "BUY"},
    ]
    assert market.apply_target_freshness_filter(signals, "2026-11-06") == 0


def test_finmind_price_contract_parses_date_and_turnover(monkeypatch):
    source = pd.DataFrame([{
        "date": "2026-11-06", "open": "62", "max": "63", "min": "61",
        "close": "62.9", "Trading_Volume": "120000",
        "Trading_money": "8220000",
    }])
    monkeypatch.setattr(data, "fetch_finmind_cached", lambda *_: source.copy())
    out = data.get_price_history("3444")
    assert isinstance(out.iloc[0]["date"], pd.Timestamp)
    assert out.iloc[0]["Trading_money"] == 8_220_000
    assert out.iloc[0]["volume"] == 120000


def test_3444_skip_keeps_reason_and_price_visible_in_line_report():
    skipped = {
        "stock_id": "3444", "name": "利機", "action": "SKIP",
        "signal_score": 35.3, "price_date": "2026-11-06",
        "entry_price": 62.9, "stop_loss_price": 57.87,
        "target_price": 69.19, "risk_reward_ratio": 1.25,
        "position_size_pct": 5,
        "entry_rule": "未達基本面門檻，先觀察",
        "risk_notes": ["基本面未過門檻"],
        "components": {"fundamental_pass": False, "backtest_samples": 4},
    }
    message = "\n".join(format_messages(
        [skipped], [{"stock_id": "3444", "category": "電子通路"}]
    ))
    assert "3444 利機" in message
    assert "3444／0050 未通過篩選" in message
    assert "基本面未過門檻" in message
    assert "上櫃研究參考價" in message
    assert "明日開盤進場（參考" not in message
