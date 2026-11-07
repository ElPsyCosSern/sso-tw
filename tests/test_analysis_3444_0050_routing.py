"""End-to-end daily orchestration routing without live FinMind or Google access."""
import main as app


def minimal_signal(sid, name, *, strategy_id="default", date="2026-11-06"):
    return {
        "stock_id": sid, "name": name, "strategy_id": strategy_id,
        "date": date, "price_date": date, "action": "BUY",
        "signal_score": 82, "entry_price": 80, "stop_loss_price": 73.6,
        "target_price": 88, "risk_reward_ratio": 1.25,
        "position_size_pct": 5, "entry_rule": "限價分批",
        "risk_notes": [], "components": {"tech_signals": []},
        "trend": {"chg_5d": 1.2, "above_ma20": True, "above_ma60": True},
    }


def test_daily_routes_3444_to_liquidity_guard_and_0050_to_etf_model(monkeypatch):
    date = "2026-11-06"
    calls, saved = [], {}
    rows = [
        {"stock_id": "3444", "name": "利機", "category": "電子通路"},
        {"stock_id": "0050", "name": "元大台灣50", "category": "ETF"},
    ]
    for env in app.REQUIRED_ENV:
        monkeypatch.setenv(env, "fake-non-production")
    monkeypatch.setenv("GITHUB_RUN_ID", "mock-123")
    monkeypatch.setattr(app, "taiwan_today", lambda: date)
    monkeypatch.setattr(app, "read_watchlist", lambda: rows)
    monkeypatch.setattr(app, "get_market_state",
                        lambda: {"bullish": True, "close": 30000,
                                 "data_date": date, "note": "測試大盤"})
    monkeypatch.setattr(app, "get_night_session", lambda: {"date": date})
    monkeypatch.setattr(app, "night_filter_note", lambda _: "測試夜盤")
    monkeypatch.setattr(app, "apply_night_filter", lambda *_: 0)
    monkeypatch.setattr(app, "read_performance", lambda: [])
    monkeypatch.setattr(app, "update_performance", lambda *_: [])
    monkeypatch.setattr(app, "write_performance", lambda *_: None)
    monkeypatch.setattr(app, "perf_summary",
                        lambda _: {"count": 0})
    monkeypatch.setattr(app, "format_messages", lambda *_args, **_kwargs: ["study"])
    monkeypatch.setattr(app.time, "sleep", lambda _: None)
    monkeypatch.setattr(app, "evaluate_0050", lambda name: (
        calls.append(("etf", name)) or
        minimal_signal("0050", name, strategy_id="equity_etf_0050_v1")
    ))

    def ordinary(sid, name, *, min_avg_turnover_twd=0):
        calls.append(("ordinary", sid, min_avg_turnover_twd))
        return minimal_signal(sid, name)

    monkeypatch.setattr(app, "evaluate", ordinary)
    monkeypatch.setattr(app, "append_signals",
                        lambda signals, *, run_id: saved.update(
                            signals=signals, run_id=run_id))
    monkeypatch.setattr(app, "save_report", lambda **kwargs: saved.update(report=kwargs))
    app.main()
    assert ("etf", "元大台灣50") in calls
    assert ("ordinary", "3444", 5_000_000) in calls
    assert len(saved["signals"]) == 2
    assert [signal["action"] for signal in saved["signals"]] == ["BUY", "BUY"]
    assert next(s for s in saved["signals"] if s["stock_id"] == "3444")[
        "strategy_id"] == "otc_3444_v1"
    assert saved["run_id"] == "daily-2026-11-06-mock-123"
    assert saved["report"]["status"] == "complete"
    assert saved["report"]["signal_count"] == 2
