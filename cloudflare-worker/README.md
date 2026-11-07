# LINE Cloudflare Worker｜Step 5-4～5-5

本目錄保留已驗證的 LINE 私人群組 Webhook，新增 Step 5-5 四個 Google Sheets **唯讀查詢指令**。

- 已上線 Step 5-4：使用者回報私人群組 /資料測試 成功查詢 Google Sheets。
- Step 5-5：程式已寫在 index.mjs，**正式 Cloudflare Worker 尚未部署此版本**。
- 本目錄只包含程式和模擬測試，**不包含任何憑證**。無須新資料庫、npm 套件、Sheets 公開權限或 FinMind 即時請求。

## LINE 指令

| 指令 | 行為 |
| --- | --- |
| /測試 | 原 LINE Reply API 連線測試 |
| /資料測試 | 既有 Google Sheets 4 表唯讀診斷（各有列數上限） |
| /群組ID | 尚未設定白名單時取得群組 ID，設定後停用 |
| /選股 | 顯示最近已提交的日報批次與 BUY/WATCH/SKIP/ERROR 數量及名單 |
| /個股 2330 | 顯示這檔股票最近一次已提交分析、收盤參考價、風控及回測資訊 |
| /績效 | 由 Performance 計算 T+20 正報酬比例、平均報酬與歷史紀錄 |
| /觀察 | 列出 Watchlist 已啟用的標的，保留 0050 等前導零 |

所有指令只回覆已通過 LINE HMAC-SHA256 簽章且來源為 LINE_ALLOWED_GROUP_ID 的私人群組。
除設定階段的 /群組ID 外，其他群組、私訊及沒有白名單的群組無法讀取股票資料。
GET / 只有 LINE Webhook Ready，沒有對外開放 Sheets 查詢端點。

### 資料正確性

- /選股 與 /個股 只查有 Reports 的 daily 完成標記（part=0）且各段報告齊全的批次。
- Reports.signal_count 必須等於該 run_id 的 Signals 行數，股票 ID 不得重複；錯誤批次停止回覆分析，不會默默將不完整資料當成最新訊號。
- stale、partial、unavailable，或 complete 但行情日期非台灣當天，必須顯示 **非當日買進建議**。即使是今日完成批次，也不是即時報價。
- /個股 的 ERROR 訊號不回傳上游例外原文，避免公開包含 API URL 的錯誤內容。
- /績效 沒有完成紀錄時不虛構勝率；「正報酬比例」是 T+20 報酬大於 0 的歷史樣本比例，非未來勝率。
- 查詢指令使用 Google Sheets 全欄讀取，避免資料超過前 100 列後顯示錯誤的「最新」結果；對很大的表格，未來應依實際使用量監測延遲與 API 配額。
- 選股訊號由 GitHub Actions 既有分析流程保存，Worker 不計算新訊號、不修改 Sheet、不下單。

## Cloudflare Secrets

全部使用 Cloudflare Worker 的 Secret，勿提交 Git、貼入對話或設成公開變數：

- LINE_CHANNEL_SECRET：原有
- LINE_CHANNEL_ACCESS_TOKEN：原有
- LINE_ALLOWED_GROUP_ID：原有
- GOOGLE_SHEET_ID：已於 Step 5-4 設定
- GOOGLE_CREDS_JSON：已於 Step 5-4 設定

使用 Google OAuth 2.0 服務帳戶的 https://www.googleapis.com/auth/spreadsheets.readonly 範圍，
使用 Worker WebCrypto RS256 簽署 JWT，不需要 Google API Key、公開試算表或額外依賴。

## 測試與部署

在 Node.js 22 或以上執行：

    node --test cloudflare-worker/index.test.mjs cloudflare-worker/commands.test.mjs

測試使用虛構服務帳戶金鑰與模擬 HTTP 回應，不會呼叫真實 Google 或 LINE，不代表線上部署已完成。
GitHub Actions 的 App checks 也會執行這兩個測試檔案。

**正式部署必須使用者在 Cloudflare Dashboard 執行：**

1. 開啟已存在的 stock-line-bot → Edit Code，先備份目前線上程式到本機。
2. 確認線上程式與這個檔案的既有 /webhook、簽章驗證、白名單和 /資料測試 一致，且沒有額外功能；如有差異，先合併再更新。
3. 從此功能分支的 cloudflare-worker/index.mjs Raw 取得完整程式碼，更新 Worker 並 Deploy。
4. **不需要更改或重新上傳五項 Secrets**，除非 Cloudflare Dashboard 顯示缺失。
5. 在原 LINE 私人群組依序測試 /測試、/資料測試、/觀察、/選股、/個股 2330、/績效。
6. 現有測試資料的預期：4 檔啟用、Signals 4 筆、Performance 0 筆，行情 2026-11-06、stale。這僅為前次實測資料，若 Sheet 已更新，顯示結果會不同。
7. 驗收安全性：非白名單群組不應獲得股票資料，Webhook 的未簽章請求應被 401 拒絕。

不得將本目錄當成已自動部署的證據。本階段**不合併 main、不更動 GitHub Actions 的正式排程**。
