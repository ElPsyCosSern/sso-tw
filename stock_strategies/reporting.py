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
    if dates != {today} or market.get("data_date") != today:
        return "stale"
    # Night-session records can carry the next session's date (e.g. Friday
    # night labelled Monday). Never certify a future or old session as current.
    try:
        night_age = (date.fromisoformat(today)
                     - date.fromisoformat(str(night["date"]))).days
    except (KeyError, TypeError, ValueError):
        return "partial"
    if night_age not in (0, 1):
        return "partial"
    return "complete"


def premarket_status(night: dict | None, latest_signals: list[dict]) -> str:
    """Only call a premarket report complete with today's night data and
    a genuinely fresh prior-day stock batch (weekend: up to 3 calendar days).
    """
    if not night:
        return "unavailable"
    today = datetime.now(TAIPEI).date()
    try:
        night_age = (today - date.fromisoformat(str(night["date"]))).days
    except (KeyError, TypeError, ValueError):
        return "partial"
    if night_age != 0:
        return "stale"
    if not latest_signals or any(not s.get("date") for s in latest_signals):
        return "partial"
    try:
        latest_date = max(date.fromisoformat(str(s["date"])) for s in latest_signals)
    except (TypeError, ValueError):
        return "partial"
    if (today - latest_date).days not in (1, 2, 3):
        return "stale"
    freshest = [s for s in latest_signals if str(s["date"]) == latest_date.isoformat()]
    if any(str(s.get("price_date") or "") != latest_date.isoformat() for s in freshest):
        return "stale"
    if any(s.get("action") == "ERROR" for s in freshest):
        return "partial"
    return "complete"


def daily_data_date(signals: list[dict]) -> str:
    """唯有所有股票的實際行情日一致，才輸出明確的資料日期。"""
    dates = {str(s.get("price_date") or "") for s in signals}
    if len(dates) != 1 or "" in dates:
        return ""
    return next(iter(dates))
