# LINE Cloudflare Worker｜Step 5-7 原作者完整研究報告

沿用現有已實測的 LINE 私人群組 Webhook、Google Sheets 唯讀 OAuth 與原作者分析報告。

- Step 5-4、5-5：LINE 私人群組已有成功回覆（由使用者回報）。
- **Step 5-7：此版本加入完整研究報告／夜盤查詢，尚需在 Cloudflare 手動部署並實測。**
- 本目錄只有程式與模擬測試，沒有任何 Secrets；不新增資料庫、npm 套件、試算表寫入或 FinMind 即時請求。
- **不包含 LINE 主動推播，也沒有啟用 GitHub 每日選股或盤前排程。**

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
| /總覽 | 直接讀取原作者市場總覽、大盤濾鏡、觀察池氛圍與類股強弱 |
| /建議 | 直接讀取原作者最值得關注及當時操作方向 |
| /量價 | 直接讀取原作者量價深度解析與風險警示 |
| /夜盤 | 讀取最新選股報告的夜盤情緒濾鏡（非隔日盤前） |
| /盤前 | 讀取最近已提交的夜盤盤前快報；未啟用時明確顯示無資料 |
| /完整報告 | 一次讀取原作者全部四段日報，使用 LINE 多則訊息呈現 |
| /報告 2 | 日報過長時依序取下一組（每次最多四頁）；不使用資料庫 |
| /功能 | 顯示可用指令 |

所有指令只回覆已通過 LINE HMAC-SHA256 簽章且來源為 LINE_ALLOWED_GROUP_ID 的私人群組。
除設定階段的 /群組ID 外，其他群組、私訊及沒有白名單的群組無法讀取股票資料。
GET / 只有 LINE Webhook Ready，沒有對外開放 Sheets 查詢端點。

### 資料正確性

- /選股 與 /個股 只查有 Reports 的 daily 完成標記（part=0）且各段報告齊全的批次。
- Reports.signal_count 必須等於該 run_id 的 Signals 行數，股票 ID 不得重複；錯誤批次停止回覆分析，不會默默將不完整資料當成最新訊號。
- stale、partial、unavailable，或 complete 但行情日期非台灣當天，必須顯示 **非當日買進建議**。即使是今日完成批次，也不是即時報價。
- /個股 的 ERROR 訊號不回傳上游例外原文，避免公開包含 API URL 的錯誤內容。
- /績效 沒有完成紀錄時不虛構勝率；「正報酬比例」是 T+20 報酬大於 0 的歷史樣本比例，非未來勝率。
- 原作者的四段日報已由 Python format_messages() 存在 Reports.content；Worker **只還原文字**，不自行重算市場氛圍、類股或操作建議。
- 只有 Reports.part=0 提交標記、報告分段及 Signals 批次均完整時才顯示；若缺段、數量不符或格式陌生，拒絕冒充完整報告。
- 市場氛圍、類股強弱的母體是 Watchlist 觀察池（目前先前測得啟用 4 檔），**不是台灣全市場行情**；LINE 回覆加註限制。
- stale/歷史報告的每一頁都有資料日期與非即時提示，將過期的「明日開盤進場」改為歷史策略假設；不將舊操作方向當今日決策。
- LINE Reply API 最多五則訊息、每則文字 5000 UTF-16 單位；本版按更保守的長度分頁，不靜默截斷。盤前報告的狀態不同於日報，須先核對提交分段。
- /個股 的「為何買／差在哪」取自已存的原作者個股詳情；原文缺欄時明確告知，不捏造理由。
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
5. 在原 LINE 私人群組依序測試 /測試、/資料測試、/選股、/個股 2330、/總覽、/建議、/量價、/完整報告、/夜盤、/盤前、/功能。
   - 若 /完整報告 出現「下一組」，輸入 /報告 2，逐組驗證報告沒有漏段。
   - 若尚無 premarket 報告，/盤前 顯示無資料為**預期結果**，不是新程式故障。
   - 確認標籤 stale 時，各段報告都是歷史資訊，而非今日交易建議。
6. 現有測試資料的預期：4 檔啟用、Signals 4 筆、Performance 0 筆，行情 2026-11-06、stale。這僅為前次實測資料，若 Sheet 已更新，顯示結果會不同。
7. 驗收安全性：非白名單群組不應獲得股票資料，Webhook 的未簽章請求應被 401 拒絕。

不得將本目錄當成已自動部署的證據。本階段**不合併 main、不更動 GitHub Actions 的正式排程，也不自動推播 LINE**。
上線前請確認 Cloudflare 運作版本與本檔一致，並用實際 Sheets 的 Reports 日期、片段與內容完成核對。
