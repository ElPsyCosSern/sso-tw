# Step 5-6｜LINE 台股機器人正式上線前驗收

日期：2026-11-07（台灣週六）
對象：ElPsyCosSern/sso-tw，功能分支 feat/line-sheets-integration
結論：**CONDITIONAL / 尚不啟用正式自動排程**。已完成主要測試與 Worker 公開端點安全檢查；交易日資料時效、正式 LINE 群組內容核對及排程需最後確認。

## VERIFIED：已驗證事實

- 2026-11-07：GitHub main SHA b1110f5b8cdfe3adbffb3c7556095ac3e49f213c；功能分支原始 SHA fed771522f30bdc0229fa5dcc45d4afa73668982。
- GitHub workflow list 只有 App checks，daily 和 premarket workflow 尚未進入預設分支，故未正式排程。
- 必要 GitHub Secrets 名稱均存在：FINMIND_TOKEN、GOOGLE_SHEET_ID、GOOGLE_CREDS_JSON。未讀取任何 Secret 值。
- Step 5-3C 實際驗收：Watchlist 啟用 4 檔，Signals 4 筆（WATCH 3、SKIP 1、BUY 0），Performance 無完成追蹤，Reports 最新資料日 2026-11-06、狀態 stale；相同批次重跑無重複。來源：GitHub Actions run 42375085035。
- Step 5-4：使用者回報 LINE 的 /資料測試 已成功取得 Google Sheets 4 表計數，與上述批次相符。
- 2026-11-07 Worker 公開端點：GET / = HTTP 200（LINE Webhook Ready）；GET /webhook = HTTP 405；未知路徑 = HTTP 404；未簽章 POST /webhook = HTTP 401。
- Step 5-5：四種查詢指令在私人群組皆有回覆，由使用者確認；數值內容尚未獨立逐筆比對。測試有覆蓋群組白名單，但未實際從其他 LINE 群組驗證。

## 本次修正的資料安全問題

1. 個股回測勝率若由 Google Sheets 顯示為百分比，舊程式可能重複乘以 100；加入格式兼容測試與換算。
2. /資料測試 讀 Reports 原本限制前 200 列，歷史累積後可能誤認舊報告為最新；已改讀完整 Reports。
3. daily_status 已阻擋未來日期或太舊的夜盤被當成當日完整分析。
4. premarket_status 已要求今日夜盤資料、最新個股分析日距今 1～3 日，且個股行情日與分析日一致；較長連假保守判 stale。
5. format_premarket 只取最新分析日的 BUY/WATCH；最新一批全為 SKIP 時，不再拿更早 BUY/WATCH 充當前一交易日訊號。
6. premarket.py 對 stale / partial / unavailable 報告只保存狀態警告，不輸出操作預測。
7. 所有修正先提交功能分支，**未直接部署新版 Cloudflare Worker**。

## 上線阻擋事項

| 優先 | 項目 | 目前缺口 |
| --- | --- | --- |
| P0 | 定時選股未在 main 啟用 | GitHub schedule 僅在 default branch 運作；需使用者最後授權 |
| P0 | 尚未在正常交易日驗證 complete | 最近真實批次為 2026-11-06 stale；需下一交易日核對 FinMind 與市場資料時間 |
| P0 | 結果表無獨立檔案備份 | 現有備份只在同一份 Google Sheet 中保存 Watchlist，啟用排程前建議另存完整 Spreadsheet 副本 |
| P1 | LINE 非白名單實測 | 單元測試通過，但尚無真實第二群組驗收 |
| P1 | LINE 四指令顯示值逐筆核對 | 使用者確認有回覆，但尚無完整回覆內容可與 Google Sheets 比對 |
| P1 | 盤前快報尚無 LINE 消費端 | 盤前結果只存 Reports，尚無 /盤前 指令或自動推播；不應默默開啟盤前排程 |
| P1 | 真實 T+20 報酬表現 | Performance 尚無已完成實際樣本，僅驗證程式的計算邏輯 |
| P2 | GitHub Cron 的準時性 | 排程可能延遲；盤前 08:00 台灣時間落在 UTC 整點，需觀察延遲與失敗 |

## 建議 GO-LIVE 流程（尚未執行）

1. 建立包含 Signals、Performance、Reports 的完整 Spreadsheet 獨立副本，確認可還原。
2. 如需部署本輪 Worker 修正，先備份 Cloudflare 正式程式，再更新相同五組 Secrets 的 Worker 程式並做私人群組驗收。
3. 先只考慮正式啟用每日收盤選股；盤前是否啟用由使用者另行決定（目前沒有 LINE 消費端）。
4. 授權合併功能分支至 main，明確確認是否同時開啟排程；未經授權不執行。
5. 首次交易日排程後查核 Github Actions 成功、每檔 price_date、TAIEX data_date、Reports.status、Signals 筆數、LINE 查詢日期與績效更新。
6. 未達標時保留原資料及執行紀錄，先排除問題，不將 stale、partial 等狀態視為當日買進訊號。

官方參考：
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
https://developers.line.biz/en/reference/messaging-api/

本文件不是自動啟用排程或金融交易的授權。
