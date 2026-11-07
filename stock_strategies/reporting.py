"""對外報告狀態判斷；不更改原有選股評分或回測規則。"""
from datetime import datetime, date
from zoneinfo import ZoneInfo


TAIPEI = ZoneInfo("Asia/Taipei")


def taiwan_today() -> str:
    return datetime.now(TAIPEI).date().isoformat()


def daily_status(signals: list[dict], watchlist: list[dict], market: dict, night: dict | None, today: str):
    """標示完整/部分失敗/過期，僅 complete 才可視為當日有效分析。"""
    if not watchlist or len(signals) != len(watchlist):
        return "partial"
    if any(s.get("action") == "ERROR" for s in signals):
        return "partial"
    if not market or market.get("close") is None or not night:
        return "partial"
    dates = {str(s.get("price_date") or "") for s in signals}
    if dates != {today}:
        return "stale"
    return "complete"


def premarket_status(night: dict | None, latest_signals: list[dict]) -> str:
    if not night:
        return "unavailable"
    try:
        age = (datetime.now(TAIPEI).date() - date.fromisoformat(night["date"])).days
    except (KeyError, TypeError, ValueError):
        return "partial"
    if age < 0 or age > 3:
        return "stale"
    if not latest_signals or any(not s.get("date") for s in latest_signals):
        return "partial"
    return "complete"


def daily_data_date(signals: list[dict]) -> str:
    """唯有所有股票的實際行情日一致，才輸出明確的資料日期。"""
    dates = {str(s.get("price_date") or "") for s in signals}
    if len(dates) != 1 or "" in dates:
        return ""
    return next(iter(dates))
