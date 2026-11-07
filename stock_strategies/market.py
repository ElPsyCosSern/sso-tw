"""大盤狀態濾鏡

抓加權指數 (TAIEX) 的日 K 線，判斷目前是否站上 20 日均線。
若跌破月線，main.py 會把所有 BUY 訊號降級為 WATCH，避免在空頭市場
被連續洗損。
"""

from .datasources import get_index_history


def get_market_state(ma_period: int = 20) -> dict:
    """回傳大盤狀態 dict（可指定均線天數，預設 20=月線）"""
    try:
        df = get_index_history("TAIEX")
        if len(df) < ma_period + 1:
            return {"bullish": True, "close": None, "ma20": None,
                    "note": "⚠️ 大盤資料不足，暫不套用濾鏡"}
        df = df.copy()
        df["ma20"] = df["close"].rolling(ma_period).mean()
        latest = df.iloc[-1]
        close = float(latest["close"]); ma20 = float(latest["ma20"])
        bullish = close > ma20
        data_date = str(latest["date"])[:10]
        pct = (close / ma20 - 1) * 100
        if bullish:
            note = f"🟢 加權 {close:.0f} 站上 {ma_period} 日線 ({pct:+.1f}%)，BUY 訊號照常發出"
        else:
            note = f"🔴 加權 {close:.0f} 跌破 {ma_period} 日線 ({pct:+.1f}%)，BUY 全數降為 WATCH"
        return {"bullish": bullish, "close": close, "ma20": ma20,
                "data_date": data_date, "note": note}
    except Exception as e:
        return {"bullish": True, "close": None, "ma20": None,
                "note": f"⚠️ 大盤狀態取得失敗（{str(e)[:60]}），暫不套用濾鏡"}


def apply_market_filter(results: list[dict], market: dict) -> int:
    """若空頭，把 BUY 降為 WATCH。回傳被降級的數量。"""
    if market.get("bullish", True):
        return 0
    downgraded = 0
    for r in results:
        if r.get("action") == "BUY":
            r["action"] = "WATCH"
            r.setdefault("risk_notes", []).append("大盤跌破月線，自動降為 WATCH")
            downgraded += 1
    return downgraded



def apply_instrument_safety_filter(results: list[dict], watchlist: list[dict]) -> int:
    """Guard legacy common-stock BUY rules for ETF and emerging-board securities.

    The generic EPS/ROE gate was designed for listed companies, not ETF funds.
    Emerging-board securities have negotiated trading and no opening auction
    price. Keep reference signals for research but never auto-upgrade to BUY.
    """
    categories = {
        str(row.get("stock_id", "")).strip().upper(): str(row.get("category", "")).strip()
        for row in watchlist
    }
    downgraded = 0
    for result in results:
        stock_id = str(result.get("stock_id", "")).strip().upper()
        category = categories.get(stock_id, "")
        is_etf = category == "ETF"
        is_emerging = category.startswith("興櫃／")
        if not is_etf and not is_emerging:
            continue
        # Only the dedicated 0050 ETF model bypasses the legacy EPS/ROE guard.
        # All other ETFs and emerging-board names remain WATCH-only.
        if is_etf and stock_id == "0050" and result.get("strategy_id") == "equity_etf_0050_v1":
            continue
        notes = result.setdefault("risk_notes", [])
        if result.get("action") == "BUY":
            result["action"] = "WATCH"
            downgraded += 1

        if is_emerging:
            warning = "興櫃採議價交易，無一般開盤價；原隔日開盤進場模型不適用"
            if "entry_rule" in result:
                result["entry_rule"] = warning
        else:
            warning = "ETF 不適用普通股 EPS／ROE 基本面模型；訊號僅供觀察"
            if stock_id.endswith(("L", "R")):
                warning += "；槓桿／反向 ETF 應留意每日倍數及複利路徑風險"
            if "entry_rule" in result:
                result["entry_rule"] = warning
        if warning not in notes:
            notes.append(warning)
    return downgraded


def apply_target_freshness_filter(results: list[dict], today: str) -> int:
    """Prevent weekend or stale 0050/3444 prices from generating current BUY."""
    downgraded = 0
    for signal in results:
        if signal.get("stock_id") not in ("0050", "3444") or signal.get("action") != "BUY":
            continue
        if signal.get("price_date") != today:
            signal["action"] = "WATCH"
            signal.setdefault("risk_notes", []).append(
                "分析使用非當日行情，僅供研究；待下一交易日更新後再評估"
            )
            downgraded += 1
    return downgraded
