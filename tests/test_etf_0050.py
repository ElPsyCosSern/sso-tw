"""0050 量價策略：合成資料測試，不代表真實回測績效。"""
import numpy as np
import pandas as pd
import pytest

from stock_strategies import etf_0050 as etf
from stock_strategies.notify import format_messages


def synthetic_post_split(n=320) -> pd.DataFrame:
    """Monotonic synthetic post-split price path for deterministic assertions."""
    dates = pd.bdate_range(etf.SPLIT_START, periods=n)
    close = 50.0 + np.arange(n) * 0.12
    return pd.DataFrame({
        "date": dates, "open": close - 0.10, "high": close + 0.60,
        "low": close - 0.60, "close": close, "volume": np.full(n, 1_000_000),
        "Trading_money": close * 1_000_000,
    })


def evaluate_mock(df):
    return etf.evaluate_0050("元大台灣50", price_history=df,
                             as_of=str(df.iloc[-1]["date"])[:10])


def test_0050_has_dedicated_research_without_company_eps_and_allows_conditional_buy():
    result = evaluate_mock(synthetic_post_split())
    assert result["strategy_id"] == "equity_etf_0050_v1"
    assert result["action"] == "BUY"
    assert result["stock_id"] == "0050"
    assert result["components"]["fundamental_pass"] is None
    assert result["components"]["backtest_samples"] >= etf.MIN_BACKTEST_TRADES
    assert result["components"]["backtest_winrate"] > 0.55
    assert result["components"]["backtest_avg_net_return"] > 0
    assert result["components"]["backtest_cost_rate"] == 0.006
    assert result["position_size_pct"] == 10.0
    assert result["price_date"] == str(synthetic_post_split().iloc[-1]["date"])[:10]
    assert any("不含配息" in note for note in result["risk_notes"])


def test_historical_split_is_excluded_before_any_indicator_or_backtest():
    df = synthetic_post_split()
    pre_split = df.iloc[:1].copy()
    pre_split["date"] = pd.Timestamp("2025-06-10")
    for col in ["open", "high", "low", "close"]:
        pre_split[col] *= 4
    combined = pd.concat([pre_split, df], ignore_index=True)
    original = evaluate_mock(df)
    evaluated = evaluate_mock(combined)
    assert evaluated["action"] == original["action"]
    assert evaluated["components"] == original["components"]
    assert evaluated["trend"] == original["trend"]
    assert evaluated["components"]["backtest_start"] == "2025-06-18"


def test_future_appended_data_is_ignored_at_historical_as_of():
    df = synthetic_post_split()
    later = df.iloc[[-1]].copy()
    later["date"] = df.iloc[-1]["date"] + pd.Timedelta(days=5)
    for col in ["open", "high", "low", "close"]:
        later[col] *= 3
    with_future = pd.concat([df, later], ignore_index=True)
    as_of = str(df.iloc[-1]["date"])[:10]
    before = etf.evaluate_0050("元大台灣50", price_history=df, as_of=as_of)
    after = etf.evaluate_0050("元大台灣50", price_history=with_future, as_of=as_of)
    assert before["components"] == after["components"]
    assert before["action"] == after["action"]


def test_incomplete_data_rejects_buy_and_does_not_invent_metrics():
    df = synthetic_post_split(n=100)
    result = evaluate_mock(df)
    assert result["action"] == "SKIP"
    assert any("未滿" in item for item in result["risk_notes"])
    missing_money = synthetic_post_split().drop(columns=["Trading_money"])
    result = evaluate_mock(missing_money)
    assert result["action"] == "ERROR"
    assert any("缺少必要欄位" in item for item in result["risk_notes"])


def test_detects_unannounced_new_split_or_corrupt_price_gap():
    df = synthetic_post_split()
    idx = len(df) - 1
    for col in ["open", "high", "low", "close"]:
        df.loc[idx, col] *= 2
    result = evaluate_mock(df)
    assert result["action"] == "ERROR"
    assert "分割" in result["risk_notes"][0]


def test_still_watch_without_backtest_quality_even_on_uptrend(monkeypatch):
    monkeypatch.setattr(etf, "backtest_0050", lambda df: {
        "samples": 3, "winrate": 1, "avg_net_return": 0.1,
        "worst_net_return": 0.01,
    })
    result = evaluate_mock(synthetic_post_split())
    assert result["action"] == "WATCH"
    assert any("非重疊回測僅 3 筆" in note for note in result["risk_notes"])


def test_same_day_stop_and_target_is_pessimistically_stopped(monkeypatch):
    df = pd.DataFrame({
        "open": np.full(110, 100.0), "high": np.full(110, 101.0),
        "low": np.full(110, 99.0), "close": np.full(110, 100.0),
    })
    df.loc[82, "high"] = 120.0
    df.loc[82, "low"] = 90.0
    monkeypatch.setattr(etf, "_setup_at", lambda _df, i: i == 80)
    bt = etf.backtest_0050(df)
    assert bt["samples"] == 1
    assert bt["winrate"] == 0.0
    assert bt["worst_net_return"] == -0.086  # -8% stop -0.6% costs


def test_gap_down_is_not_filled_at_optimistic_stop(monkeypatch):
    df = pd.DataFrame({
        "open": np.full(110, 100.0), "high": np.full(110, 101.0),
        "low": np.full(110, 99.0), "close": np.full(110, 100.0),
    })
    df.loc[82, ["open", "high", "low", "close"]] = [80.0, 82.0, 79.0, 81.0]
    monkeypatch.setattr(etf, "_setup_at", lambda _df, i: i == 80)
    bt = etf.backtest_0050(df)
    assert bt["worst_net_return"] == -0.206  # gap -20% plus costs


def test_0050_report_does_not_claim_eps_failure_or_force_watch_buy():
    buy = evaluate_mock(synthetic_post_split())
    buy["action"] = "WATCH"
    buy["entry_rule"] = "未滿足 ETF 專屬條件，先觀察"
    report = "\n".join(format_messages(
        [buy], [{"stock_id": "0050", "name": buy["name"], "category": "ETF"}]
    ))
    assert "股票型 ETF 專屬策略" in report
    assert "扣估計成本後勝率" in report
    assert "不適用普通股 EPS／ROE" in report
    assert "基本面未達標" not in report
    assert "明日開盤進場（參考" not in report
    assert "未滿足 ETF 專屬條件" in report or "未形成進場" in report


def test_0050_insufficient_history_is_visible_as_skip_in_reports():
    skipped = evaluate_mock(synthetic_post_split(n=100))
    assert skipped["action"] == "SKIP"
    message = "\n".join(format_messages(
        [skipped], [{"stock_id": "0050", "category": "ETF"}]
    ))
    assert "0050 元大台灣50" in message
    assert "未通過篩選" in message
    assert "未滿" in message
    assert "明日開盤進場（參考" not in message
