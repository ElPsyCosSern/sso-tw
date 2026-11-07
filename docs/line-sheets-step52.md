# Step 5-2：LINE / Google Sheets 報告保存整合

本分支只修改 GitHub Actions 離線分析和 Google Sheets 資料儲存。
不包含 Cloudflare Worker 程式、LINE 即時查詢、部署或正式排程啟用。

## 使用方式

- main.py：保留原有選股、回測、大盤/夜盤濾鏡，寫入 Signals、Performance、Reports。
- premarket.py：保留原有夜盤快報格式，寫入 Reports，不發送 Telegram。
- GitHub Actions Secrets：FINMIND_TOKEN、GOOGLE_SHEET_ID、GOOGLE_CREDS_JSON。
- Google 服務帳戶只需該試算表編輯權及 Google Sheets API 權限。
- 尚未驗收前不要合併至 main。GitHub Actions 的定時排程只讀取預設分支。

## Sheets 資料格式

- Watchlist：stock_id、name、enabled，可另有 category。程式以文字讀取以保留 0050。
- Signals：既有 14 欄向右加上 run_id、price_date。
- Performance：維持原有 17 欄；改用單一範圍更新，避免先 clear 再 append 造成資料清空。
- Reports：新增以下九欄，儲存已完成或有問題的報告快照。

| 欄位 | 說明 |
| --- | --- |
| run_id | daily-日期-GITHUB_RUN_ID 或 premarket-日期-GITHUB_RUN_ID |
| kind | daily / premarket |
| data_date | 實際個股行情日或夜盤日，未知則空白 |
| generated_at_utc | 報告建立時間 (UTC) |
| status | complete / partial / stale / unavailable |
| signal_count | 當批訊號數 |
| error_count | 錯誤訊號數 |
| part | 1～N 是報告文字，0 為提交標記 |
| content | 分段文字；part=0 時為總段數 |

後續 Worker 應先尋找該種類最新且已提交的 part=0，再按照 run_id
讀取相同批次 1～N 段，核對數量，才可顯示報告。
只有 complete 且資料日期符合預期的結果才能標記為有效；partial、
stale 和 unavailable 均需明確警告，不能當成當日有效訊號。

同一個 GitHub workflow run 重跑時，Signals 以 (run_id, stock_id)
覆寫相同資料，避免追加重複訊號；新的 run id 是獨立批次。
報告以 part=0 作為最後的提交標記，避免寫入一半就被查詢。
完整文字採現有 Telegram Markdown 格式保存；後續 LINE 回覆仍需重新處理格式及長度。

## 限制與下一步

- 本分支沒有讀取 Secrets 或觸發真實 FinMind/Google API；部署前需測試權限及完整資料。
- 週末、假日或延遲行情不能只依據工作流程執行日視為最新。
- 現有 Telegram Smoke Test 是手動功能，不影響日常排程；notify.py 的
  send_telegram 保留向後相容，但 main.py/premarket.py 不再呼叫。
- 日後 Worker 只讀取已保存的 Sheets 資料，不重新計算選股。
