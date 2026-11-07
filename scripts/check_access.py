"""Read-only external credentials check for Step 5-3.

This script MUST NOT write to Google Sheets or execute any stock strategy.
Never print raw API payloads, URLs carrying tokens, or credential values.
"""
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

from stock_strategies.config import FINMIND_URL
from stock_strategies.sheet import read_watchlist


REQUIRED = ("FINMIND_TOKEN", "GOOGLE_SHEET_ID", "GOOGLE_CREDS_JSON")


def main() -> int:
    missing = [name for name in REQUIRED if not os.environ.get(name)]
    if missing:
        print("FAIL: missing GitHub Secrets: " + ", ".join(missing))
        return 1

    try:
        watchlist = read_watchlist()
        if not watchlist:
            print("FAIL: Google Sheets Watchlist is empty or no rows enabled")
            return 1
        if any(not r.get("stock_id") for r in watchlist):
            print("FAIL: invalid Watchlist stock_id")
            return 1
        print(f"PASS: Google Sheets Watchlist is readable ({len(watchlist)} enabled rows)")
    except Exception as exc:
        print("FAIL: Google Sheets read error (" + type(exc).__name__ + ")")
        return 1

    try:
        since = (datetime.now(ZoneInfo("Asia/Taipei")).date()
                 - timedelta(days=60)).isoformat()
        response = requests.get(
            FINMIND_URL,
            params={
                "dataset": "TaiwanStockPrice",
                "data_id": "2330",
                "start_date": since,
                "token": os.environ["FINMIND_TOKEN"],
            },
            timeout=25,
        )
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("data", [])
        if not isinstance(rows, list) or not rows:
            print("FAIL: FinMind returned no TaiwanStockPrice rows; check access/quota")
            return 1
        print(f"PASS: FinMind TaiwanStockPrice is readable ({len(rows)} rows)")
    except Exception as exc:
        print("FAIL: FinMind API request error (" + type(exc).__name__ + ")")
        return 1

    print("PASS: Step 5-3 read-only connectivity; no data was written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
