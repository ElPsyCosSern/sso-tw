"""0050 股票型 ETF：獨立於公司 EPS/ROE 的量價研究（無付費 API）。

限制：
- 0050 2025-06-18 以 1:4 分割，免費原始行情只使用分割後日期，
  絕不將分割前後直接串接回測。
- 回測為未調整配息的價格報酬，成本假設 0.6% 單次來回。
- 不取得 NAV / 折溢價 / 追蹤差距，報告須揭露未驗證。
"""
from __future__ import annotations

import math

import pandas as pd

from .data import get_price_history
from .indicators import add_indicators
from .reporting import taiwan_today

SPLIT_START = "2025-06-18"  # TWSE 0050 ETF 1:4 split effective date
MIN_BARS = 120
HOLD_DAYS = 20
ROUND_TRIP_COST = 0.006  # 0.1425% * 2 + 0.1% tax + assumed slippage ~0.2%
MIN_DAILY_TURNOVER = 5_000_000  # TWD / day; research guard, not an exchange rule
MIN_BACKTEST_TRADES = 8


def _setup_at(df: pd.DataFrame, i: int) -> bool:
    """Close-only signal at i; strictly no future OHLC or volume."""
    if i < 60:
        return False
    row = df.iloc[i]
    ma20, ma60, close = row["ma20"], row["ma60"], row["close"]
    if pd.isna(ma20) or pd.isna(ma60):
        return False
    return (
        float(close) > float(ma20) > float(ma60)
        and float(close) > float(df.iloc[i - 20]["close"])
        and df["Trading_money"].iloc[i - 19:i + 1].mean() >= MIN_DAILY_TURNOVER
    )


def backtest_0050(df: pd.DataFrame) -> dict:
    """Non-overlapping close-signal -> T+1 open -> stop/target/20D exit.

    Daily low/high may hit both stop and target; conservatively assume stop
    first. Gap below stop is exited at actual open, never the desired stop.
    Uses only historical bars and never relies on today's future open.
    """
    returns: list[float] = []
    i = 80
    while i + 1 + HOLD_DAYS < len(df):
        if not _setup_at(df, i):
            i += 1
            continue
        entry_idx = i + 1
        entry = float(df.iloc[entry_idx]["open"])
        if entry <= 0 or not math.isfinite(entry):
            i += 1
            continue
        stop = entry * 0.92
        target = entry * 1.10
        exit_price = float(df.iloc[entry_idx + HOLD_DAYS]["close"])
        for j in range(entry_idx, entry_idx + HOLD_DAYS + 1):
            bar = df.iloc[j]
            day_open = float(bar["open"])
            if day_open <= stop:
                exit_price = day_open
                break
            # Pessimistic ordering if stop and target are both reached.
            if float(bar["low"]) <= stop:
                exit_price = stop
                break
            if day_open >= target or float(bar["high"]) >= target:
                exit_price = target
                break
        returns.append(exit_price / entry - 1 - ROUND_TRIP_COST)
        i = entry_idx + HOLD_DAYS + 1  # never count overlapping positions
    if not returns:
        return {
            "samples": 0, "winrate": None, "avg_net_return": None,
            "worst_net_return": None,
        }
    return {
        "samples": len(returns),
        "winrate": round(sum(ret > 0 for ret in returns) / len(returns), 3),
        "avg_net_return": round(sum(returns) / len(returns), 4),
        "worst_net_return": round(min(returns), 4),
    }


def evaluate_0050(name: str, *, price_history: pd.DataFrame | None = None,
                  as_of: str | None = None) -> dict:
    """Only the verified 0050 equity ETF. Returns existing Signals/Reports keys."""
    today = as_of or taiwan_today()
    result = {
        "stock_id": "0050", "name": name, "date": today,
        "strategy_id": "equity_etf_0050_v1", "risk_notes": [],
    }
    try:
        px = get_price_history("0050", years=2) if price_history is None else price_history
        required = {"date", "open", "high", "low", "close", "volume", "Trading_money"}
        if px.empty or not required.issubset(px.columns):
            raise ValueError("0050 行情缺少必要欄位（含每日成交金額）")
        df = px.copy()
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        if df["date"].isna().any():
            raise ValueError("0050 行情日期格式錯誤")
        # Do not join unadjusted raw prices through the June 2025 1:4 split.
        df = df.loc[(df["date"] >= pd.Timestamp(SPLIT_START)) &
                    (df["date"] <= pd.Timestamp(today))]
        df = df.sort_values("date").reset_index(drop=True)
        if df["date"].duplicated().any():
            raise ValueError("0050 同一交易日行情重複")
        for col in required - {"date"}:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        if df[list(required - {"date"})].isna().any().any():
            raise ValueError("0050 OHLCV 資料不完整")
        if (df[["open", "high", "low", "close"]] <= 0).any().any() or \
                (df[["volume", "Trading_money"]] <= 0).any().any() or \
                (df["high"] < df[["open", "close", "low"]].max(axis=1)).any() or \
                (df["low"] > df[["open", "close", "high"]].min(axis=1)).any():
            raise ValueError("0050 日行情價格／交易量異常")
        if (df["close"].pct_change().abs() > 0.35).any():
            raise ValueError("0050 可能新增分割或行情異常，須先核對公司行動")
        if len(df) < MIN_BARS:
            result.update(action="SKIP")
            result["risk_notes"].append(
                f"0050 分割後歷史僅 {len(df)} 日，未滿 {MIN_BARS} 日；禁止輸出交易訊號"
            )
            return result
        df = add_indicators(df)
        latest = df.iloc[-1]
        close = float(latest["close"])
        last_date = pd.Timestamp(latest["date"]).strftime("%Y-%m-%d")
        vol20 = float(df["volume"].iloc[-20:].mean())
        vol5 = float(df["volume"].iloc[-5:].mean())
        turnover20 = float(df["Trading_money"].iloc[-20:].mean())
        ratio = vol5 / vol20 if vol20 > 0 else 0.0
        ret20 = close / float(df.iloc[-21]["close"]) - 1
        ret5 = close / float(df.iloc[-6]["close"]) - 1
        daily_returns = df["close"].pct_change().iloc[-20:]
        annualized_vol = float(daily_returns.std() * math.sqrt(252))
        if not math.isfinite(annualized_vol):
            raise ValueError("0050 波動率無法可靠計算")
        trending = _setup_at(df, len(df) - 1)
        liquidity = turnover20 >= MIN_DAILY_TURNOVER
        volatility_ok = annualized_vol <= 0.45
        bt = backtest_0050(df)
        samples_ok = bt["samples"] >= MIN_BACKTEST_TRADES
        positive_bt = (
            samples_ok and bt["winrate"] is not None and
            bt["winrate"] >= 0.55 and bt["avg_net_return"] is not None and
            bt["avg_net_return"] > 0
        )
        score = min(100, round(
            (20 if close > latest["ma20"] else 0) +
            (20 if latest["ma20"] > latest["ma60"] else 0) +
            (15 if ret20 > 0 else 0) +
            (10 if ret5 > 0 else 0) +
            (10 if liquidity else 0) +
            (10 if volatility_ok else 0) +
            (15 if positive_bt else 0), 1
        ))
        buy_ready = trending and liquidity and volatility_ok and positive_bt
        action = "BUY" if buy_ready else "WATCH"
        notes = [
            "0050 股票型 ETF：不適用普通股 EPS／ROE 篩選",
            "僅使用 2025/06/18 分割後原始行情；歷史回測不含配息、淨值折溢價與追蹤差距",
            "回測使用收盤訊號、次日開盤進場與 20 交易日退場；含估計來回成本 0.6%，不代表未來勝率",
            "實際下單前須核對最新折溢價、買賣價差及當日行情",
        ]
        if not trending:
            notes.append("20/60 日均線與 20 日動能尚未同時符合多頭條件")
        if not liquidity:
            notes.append(f"20 日平均成交金額僅 {turnover20/1e6:.1f} 百萬元，流動性不足")
        if not volatility_ok:
            notes.append(f"近 20 日年化波動 {annualized_vol*100:.1f}% 超出 45% 研究上限")
        if not samples_ok:
            notes.append(f"非重疊回測僅 {bt['samples']} 筆，未達 {MIN_BACKTEST_TRADES} 筆")
        elif not positive_bt:
            notes.append("扣估計成本後之非重疊歷史測試未達可靠性門檻")
        entry_rule = (
            "收盤符合均線與動能條件，次交易日僅在核對折溢價及價差後"
            "評估限價分批，非保證依參考價成交"
            if buy_ready else
            "未滿足 ETF 專屬條件，先觀察趨勢、量能與官方折溢價，不視為買進訊號"
        )
        result.update({
            "action": action, "signal_score": score,
            "price_date": last_date, "entry_price": round(close, 2),
            "stop_loss_price": round(close * 0.92, 2),
            "target_price": round(close * 1.10, 2),
            "risk_reward_ratio": 1.25, "position_size_pct": 10.0,
            "entry_rule": entry_rule, "risk_notes": notes,
            "components": {
                "instrument_type": "股票型ETF", "fundamental_pass": None,
                "tech_score": score,
                "tech_signals": ["20/60日均線多頭"] if trending else ["觀察20/60日均線"],
                "backtest_winrate": bt["winrate"],
                "backtest_samples": bt["samples"],
                "backtest_avg_net_return": bt["avg_net_return"],
                "backtest_worst_net_return": bt["worst_net_return"],
                "backtest_cost_rate": ROUND_TRIP_COST,
                "backtest_start": SPLIT_START, "backtest_end": last_date,
                "turnover20_twd": round(turnover20),
                "annualized_volatility": round(annualized_vol, 4),
            },
            "trend": {
                "chg_5d": round(ret5 * 100, 2),
                "chg_20d": round(ret20 * 100, 2),
                "vol_ratio": round(ratio, 2),
                "pct_from_high": round((close / df["high"].tail(252).max() - 1) * 100, 1),
                "above_ma20": bool(close > latest["ma20"]),
                "above_ma60": bool(close > latest["ma60"]),
            },
        })
        return result
    except Exception as error:
        result["action"] = "ERROR"
        result["risk_notes"].append("0050 ETF 專屬分析失敗：" + str(error)[:100])
        return result
