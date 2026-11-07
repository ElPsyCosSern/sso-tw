"""夜盤盤前快報

早上排程（台灣 08:00，夜盤 05:00 收完、開盤 09:00 前）讀昨晚台指期夜盤
+ 昨日選股訊號，保存今日開盤方向預判與個股順風/逆風對照至 Google Sheets。

執行: uv run python premarket.py
"""

import os
import sys
from datetime import datetime

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from stock_strategies.night_session import get_night_session
from stock_strategies.sheet import read_latest_signals, save_report
from stock_strategies.notify import format_premarket
from stock_strategies.reporting import premarket_status, taiwan_today


REQUIRED_ENV = [
    "FINMIND_TOKEN",
    "GOOGLE_SHEET_ID",
    "GOOGLE_CREDS_JSON",
]


def main():
    missing = [k for k in REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        print(f"❌ 缺少環境變數: {missing}", file=sys.stderr)
        sys.exit(1)

    today = taiwan_today()
    run_id = f"premarket-{today}-{os.environ.get('GITHUB_RUN_ID', 'manual')}"

    # 1. 取得台指期夜盤
    print(f"[{datetime.now()}] 取得台指期夜盤...")
    night = get_night_session()
    if night:
        print(f"  → {night['date']} 夜盤 {night['pct']:+.2f}% ({night['label']})")
    else:
        print("  → 夜盤資料暫時取不到")

    # 2. 讀昨日訊號（沿用 14:30 排程寫進 Signals 分頁的結果）
    #    讀 300 筆以涵蓋多日（單日掃描可能就數十筆 SKIP），
    #    只使用最新訊號日；若當日全為 SKIP，不回頭抓更舊的 BUY/WATCH。
    print("讀取昨日訊號...")
    try:
        signals = read_latest_signals(limit=300)
    except Exception as e:
        print(f"⚠️ 讀取訊號失敗: {e}", file=sys.stderr)
        signals = []
    print(f"  → {len(signals)} 筆")

    # 3. 保存快報，LINE 查詢時不重新呼叫 FinMind。
    status = premarket_status(night, signals)
    if status == "complete":
        message = format_premarket(night, signals)
    else:
        message = (
            f"⚠️ 盤前報告狀態：{status}。夜盤或前一交易日資料未通過時效驗證，"
            "本次不提供開盤方向或個股操作建議。"
        )
    save_report(
        run_id=run_id,
        kind="premarket",
        data_date=night["date"] if night else today,
        status=status,
        signal_count=len(signals),
        error_count=int(night is None),
        messages=[message],
    )
    print(f"✅ 盤前報告已寫入 Sheets（{status}；run_id={run_id}）")


if __name__ == "__main__":
    main()
