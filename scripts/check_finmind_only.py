"""One-off, read-only verification of FinMind API access. Does not print secrets."""
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

from stock_strategies.config import FINMIND_URL


def main():
    token = os.environ.get("FINMIND_TOKEN", "")
    if not token:
        print("FAIL: FINMIND_TOKEN missing")
        return 1
    try:
        today = datetime.now(ZoneInfo("Asia/Taipei")).date()
        response = requests.get(
            FINMIND_URL,
            params={
                "dataset": "TaiwanStockPrice",
                "data_id": "2330",
                "start_date": (today - timedelta(days=60)).isoformat(),
                "token": token,
            },
            timeout=25,
        )
        response.raise_for_status()
        payload = response.json()
        rows = payload.get("data", [])
        if not isinstance(rows, list) or not rows:
            print("FAIL: FinMind returned no price rows; check access or quota")
            return 1
        print(f"PASS: FinMind TaiwanStockPrice readable ({len(rows)} rows)")
        return 0
    except Exception as exc:
        print("FAIL: FinMind API request error (" + type(exc).__name__ + ")")
        return 1


if __name__ == "__main__":
    sys.exit(main())
