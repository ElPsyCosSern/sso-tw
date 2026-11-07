# LINE Cloudflare Worker｜研究報告與 Watchlist 管理

本 Worker 連接 LINE 私人群組和 Google Sheets。原有研究報告查詢維持唯讀，只有指定 LINE 管理員可以新增／移除 Watchlist 股票。

**目前功能分支版本：5.8.6（LINE 手動分析與狀態查詢）**。下方 5.8.3／5.8.4 為歷史變更紀錄，正式部署應使用最新固定 Commit。

**狀態**：本版本程式與模擬測試已完成；正式 Cloudflare 仍須手動備份、部署和驗收。本版本不會自行修改線上 Worker、真實試算表或 GitHub 排程。

## Step 5.8.6｜LINE 管理員手動選股分析

- 指定群組管理員輸入 /分析：Worker 查詢既有工作流程；有工作排隊或執行中時拒絕重複提交；否則使用 workflow_dispatch 在 feat/line-sheets-integration 分支執行 daily.yml，validate_only=false。會讀取 Watchlist 所有啟用股票。
- /分析狀態：查最新手動執行工作的狀態、成功/失敗、台灣時間及 GitHub 執行網址，不會重新執行。
- 兩指令沿用 LINE HMAC、允許群組及 LINE_ADMIN_USER_IDS 管理員白名單，不能從 LINE 指定任意儲存庫、工作流程、分支或參數。
- 使用 GitHub 讀取及提交前檢查，搭配 Worker 單執行個體的 90 秒冷卻時間；這不是跨 Worker 執行個體的原子鎖。GitHub Actions 既有 concurrency group 可排隊同分支工作，請勿短時間重複發送。
- Cloudflare 必須新增 Secret GITHUB_ACTIONS_TOKEN。推薦 GitHub Fine-grained personal access token：Resource owner ElPsyCosSern、Repository access 選 Only select repositories → sso-tw，Repository permissions：Actions Read and write，其他保持最小（Metadata Read 為必要）。請設定到期日，切勿貼在聊天、原始碼、LINE 或普通 Variable。
- **上線前提：** GitHub Actions daily.yml 必須在 main（預設分支）註冊後才能透過 API dispatch；功能分支有檔案不代表已註冊。為避免意外開啟每日排程，main 上用於註冊的工作流程應只包含 workflow_dispatch，不包含 schedule。實際運算固定選 feat/line-sheets-integration。
- GitHub Secrets FINMIND_TOKEN、GOOGLE_SHEET_ID、GOOGLE_CREDS_JSON 已是現有設定，應保留在 GitHub。不要把這三份 Secret 帶到 LINE。
- GitHub 接受 dispatch 不等於分析成功；先用 /分析狀態 查 GitHub run，再用 /選股 確認 Reports 和 Signals 的 run_id 與行情日期；ETF／興櫃維持風險防護，休市可能 stale/partial。
- GitHub API 回傳 401、403、404、422、逾時時，LINE 會回覆錯誤，不會偽稱分析成功。Webhook 仍先快速 HTTP 200，再於 waitUntil 進行 GitHub 查詢。

正式驗收：LINE /版本 顯示 5.8.6；/分析狀態 回覆合理；/分析 只啟動一次；GitHub Actions 必須顯示 feat/line-sheets-integration；完成後檢查 Google Sheets Signals/Reports 與 LINE /選股。模擬測試通過不等於正式部署已完成。


## LINE 指令

| 指令 | 權限 | 說明 |
| --- | --- | --- |
| /測試 | 指定群組 | LINE 連線測試 |
| /資料測試 | 指定群組 | Google Sheets 4 表診斷 |
| /觀察 | 指定群組 | 查看啟用中的 Watchlist 股票 |
| /新增 2882 | 群組管理員 | **只輸入代號**，從官方名冊自動填入股票名稱與類股 |
| /新增 0050 | 群組管理員 | 自動辨識元大台灣50／ETF，已存在的空白資料會直接補齊 |
| /新增 00685L | 群組管理員 | 支援英文字母尾碼，辨識上市槓桿型 ETF |
| /新增 00687B | 群組管理員 | 支援上櫃債券 ETF，從櫃買交易名冊確認名稱 |
| /新增 6488 | 群組管理員 | 上櫃股票：環球晶／半導體 |
| /新增 1260 | 群組管理員 | 興櫃股票：富味鄉／興櫃／食品 |
| /新增 2882 國泰金 金融 | 群組管理員 | 保留手動指定名稱與類股的備用方式 |
| /移除 2882 | 群組管理員 | 設 enabled=FALSE，不刪除任何分析紀錄 |
| /分析 | 群組管理員 | 手動觸發已啟用 Watchlist 的 V3 Daily Signal 分析，不表示立即完成 |
| /分析狀態 | 群組管理員 | 查詢最新功能分支的手動選股 GitHub Actions 狀態 |
| /我的ID | 指定群組 | 顯示發話者 User ID，供管理員首次設定 |
| /選股、/個股 2330、/績效 | 指定群組 | 既有選股、個股、績效查詢 |
| /總覽、/建議、/量價、/夜盤、/盤前 | 指定群組 | 既有研究與夜盤報告 |
| /完整報告、/報告 2、/功能 | 指定群組 | 四段完整報告、續頁及使用說明 |

必須通過 LINE HMAC-SHA256 簽章，且 source.type=group、groupId 為 LINE_ALLOWED_GROUP_ID，才會處理指令。其他群組、未簽章請求不能讀取或寫入試算表。

## 第一次設定管理員（Cloudflare Secrets）

1. 在已允許的私人 LINE 群組，**用 LINE 手機版**輸入 /我的ID。
2. 複製機器人回覆中的本人 LINE User ID（通常 U 開頭）。注意此回覆會顯示在群組內，請勿轉傳。
3. 前往 Cloudflare Dashboard → Workers & Pages → stock-line-bot → Settings → Variables and Secrets。
4. 新增 LINE_ADMIN_USER_IDS，**類型選 Secret**，值貼上管理員 User ID。多位管理員可用半形逗號分隔。未設定此 Secret 時，新增、移除全部拒絕。
5. 保留原有五項設定：LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN、LINE_ALLOWED_GROUP_ID、GOOGLE_SHEET_ID、GOOGLE_CREDS_JSON。
6. GOOGLE_CREDS_JSON 必須對目標 Stock-Strategies-TW 具有 Google Sheets 編輯權限。原本的 GitHub Actions 服務帳戶可以重用，不必公開試算表，也不必開通新的 API。
7. 備份 Cloudflare 線上 Worker 程式碼，將已測試版本更新部署；Secrets 請不要貼進聊天室或提交 Git。

LINE 的群組訊息可能沒有 source.userId；當缺少 ID 或不在白名單內時，系統**拒絕寫入**。這是明確 User ID 白名單，不是自動辨識 LINE 群組擔任管理員的角色。

## Watchlist 寫入行為

- 支援 4～6 位 ASCII 數字、或尾端再加一個 A～Z 英文字母的台灣證券代號，包括 0050、006208、00685L、00687B、00980A；輸入小寫尾碼會轉成大寫儲存。是否存在、名稱及市場別仍以官方資料查證，不能只靠代號形式認定有效。
- /新增 2882 若不存在，**自動查證上市櫃公司基本資料**，新增 2882／國泰金／金融／TRUE；/新增 2330 可得到 2330／台積電／半導體／TRUE；/新增 0050 可得到 0050／元大台灣50／ETF／TRUE。
- 名稱取官方簡稱，上櫃／上市／興櫃公司的產業代碼轉成系統類股。興櫃標示「興櫃／產業別」，ETF 顯示 ETF。上櫃 ETF 僅在代號符合官方 ETF 編碼規則且櫃買交易名冊有該代號時辨識（屬代號規則與名冊的交叉推定）。這些都是基本資料，不是即時報價。
- 不存在的官方代號、不認得的產業代碼或官方 API 暫時失效時，**只輸入代號不會新增空白／未分類資料**。必要時可使用 /新增 2882 國泰金 金融 明確指定資料；手動內容未經官方查證，使用者需自行確定正確。
- /新增 已啟用且名稱、類股完整的股票：不重複新增、不寫入。已停用的股票：重新啟用原列。
- **補齊既有不完整資料：** 如先前已透過 /新增 0050 建立 name 空白、category=未分類 的資料，部署此版本後再次輸入 /新增 0050，會在原列填入「元大台灣50／ETF」，不再新增第二筆；已自訂的非空白名稱和非「未分類」類股不會覆蓋。
- /移除 2882：只更新既有列的 enabled=FALSE，保留 Signals、Reports、Performance 與歷史資料。不在名單或已停用時，不進行任何寫入。
- 同一代號在 Watchlist 出現兩筆以上時，停止編輯，避免選錯列。
- 只使用 Google Sheets API values.update（需補齊的單一 name／category／enabled 儲存格）或 values.append（附加一列）；採 RAW 輸入，保存 0050 前導零，不使用 clear 或整表覆寫。
- 原有查詢持續使用 spreadsheets.readonly OAuth scope；只有管理員真正編輯時才另取 spreadsheets OAuth scope，分別快取 token。
- 寫入後從 Sheets 唯讀回查，只有確認股票代號與 enabled 狀態後才回覆成功。
- Sheets values.append 沒有跨 Worker 執行個體的交易鎖；低頻重複指令可避免一般重複，但**多人極短時間同時新增相同代號，仍可能發生競爭條件**。不要宣稱絕對原子性。
- 加入 Watchlist 不會立即產生分析；需要下次執行選股才會更新 Signals 和 Reports。本階段不開每日排程、不主動 LINE 推播、不呼叫 FinMind、不下單。

## 官方資料來源與範圍

管理員輸入只有代號的 /新增 指令時，Worker 會以 HTTPS **依序查詢**相關官方名冊，找到符合的代號即停止，避免同時載入所有名冊導致 Cloudflare CPU 過載：

- 證交所 ETF 基本資料： https://openapi.twse.com.tw/v1/opendata/t187ap47_L （基金代號、基金簡稱）。
- 證交所上市公司基本資料： https://openapi.twse.com.tw/v1/opendata/t187ap03_L （公司代號、公司簡稱、產業別）。
- 櫃買中心上櫃公司基本資料： https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O （SecuritiesCompanyCode、CompanyAbbreviation、SecuritiesIndustryCode）。
- 櫃買中心興櫃公司基本資料： https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R （相同欄位；例如 1260 富味鄉）。
- 櫃買中心上櫃商品行情名冊： https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes （用證券代號與簡稱識別上櫃債券等 ETF，例如 00687B；它是交易名冊，不是 ETF 商品分類 API）。
- 櫃買中心 ETF 代號及商品類別說明： https://www.tpex.org.tw/zh-tw/product/etf/overview/categories.html （B=被動式債券 ETF、L=槓桿、R=反向、A=主動式股票 ETF，還有 C／D／K／T／U 等類型）。
- 產業代碼按臺灣證券交易所正式產業分類對照為系統標籤，例如 24→半導體、17→金融、15→航運。這些標籤是便於觀察池分組的簡稱，不宣稱是官方逐字分類。
- 同一個 Worker 執行個體對查過的代號快取約一小時，避免短時間反覆請求；每一個新代號仍以官方資料確認。
- 僅確認「官方資料集存在這個代號及名稱／產業」，不代表標的符合現有 FinMind 選股引擎的回測條件。若無法辨識上市／上櫃／興櫃／ETF、產業代碼未知或資料源逾時，保持 Watchlist 不變。
- 目前支援上市、上櫃、興櫃股票及上述官方名冊可確認的 ETF；仍不支援海外股票、權證、ETN 和未出現在這些名冊的特殊基金或其他商品。ETF 名稱與商品類型不應只憑字首推測，必須在交易所名冊找到代號。
- **選股策略安全性：** 興櫃的 FinMind 日行情、財報可讀，但無一般開盤價，原有「隔日開盤價進場」不適用；ETF 沒有普通股 EPS／ROE 的基本面意義。現有普通股策略遇到興櫃或 ETF，即使原始分數達 BUY，也先降成 WATCH 並明確註記，直到另行建立並驗證市場／商品專屬策略。上櫃普通股仍使用既有策略。

資料源都不需要新增 API Key，也不需要開放原本 Google Sheet 的公開權限。Cloudflare 的五組既有 Secrets 與 LINE_ADMIN_USER_IDS 設定保持不變。

## /新增 無回覆時的診斷（v5.8.1 修正）

先用 /測試 和 /觀察 確認 LINE Webhook、Sheets 唯讀功能是否正常；若 /觀察 已列出 0050，但沒有名稱，代表 0050 已存在、**尚未成功補齊 name／category**，不應再以空白名稱新增另一筆。

- 前一版 auto-lookup 每次同時下載並解碼三份官方名冊，約 2.7 MB；Cloudflare Workers Free 每請求 CPU 預算僅 10 ms，JSON 解碼可能超出並導致 **1102**、沒有任何 LINE 回覆。這是可能原因，必須以 Cloudflare Logs／Metrics 才能確認。
- v5.8.1 改依代號優先查可能的官方來源，找到資料便立即停止查下一份，像 /新增 0050 只需查證交所 ETF 名冊，不必再解碼上市與上櫃完整資料。
- 新增 /版本，會在白名單群組回覆 5.8.2，確認 Cloudflare 真的部署目前支援上櫃／興櫃與英文尾碼的版本。/測試 和 /觀察 都無法辨認部署版本。
- 如果 /版本 沒有顯示 5.8.2：先檢查 Cloudflare 實際部署版本，以及 LINE Messaging API Webhook endpoint。
- 如果版本正確但 /新增 沒有回覆：到 Cloudflare Dashboard → Workers & Pages → stock-line-bot → Observability / Logs，查看最近一次 /新增 的 invocation status。exceededCpu / 1102 代表資源限制；JavaScript exception 或 Google Sheets 權限錯誤則須依 Log 修復，**不要公開任何密鑰**。
- 正式部署前備份舊程式；部署後先測 /版本，再用已存在但名稱空白的 /新增 0050 修復，並再次確認 /觀察 名稱及 Sheets 只有一筆 0050。

參考：
https://developers.cloudflare.com/workers/platform/limits/
https://developers.cloudflare.com/workers/observability/errors/

## 測試與部署驗收

Node.js 22+，無須安裝 npm 套件：

    node --test cloudflare-worker/index.test.mjs cloudflare-worker/commands.test.mjs cloudflare-worker/watchlist.test.mjs

測試涵蓋：LINE 簽章、群組及管理員白名單、英文尾碼正規化、官方上市／上櫃／興櫃／ETF 名冊（含 00685L、00687B、6488、1260）、代號及類股驗證、0050 空白回填、重複新增、重新啟用、軟刪除、讀寫 OAuth Scope 分離、Google 寫入失敗，以及既有報告查詢；Python 另有興櫃／ETF 策略保守降級測試。

真實部署驗收：
1. LINE 的 /測試、/資料測試、/觀察 應正常。未設定 LINE_ADMIN_USER_IDS 時，新增與移除應被拒絕。
2. 設定管理員 Secret 後，用其他非管理員發送新增指令，應被拒絕且 Sheets 不變。
3. 管理員用**確實想加入的股票**輸入 /新增 股票代號 股票名稱 類股，檢查 /觀察 與 Google Sheets 只新增一筆且 enabled=TRUE。
4. 再次 /新增 同代號不能重複；/移除 後 /觀察 不再列出，但原股票列和歷史紀錄都存在；再次 /新增 要能復原。
5. 其他群組不能查表或寫入，Webhook 未簽章請求必須回 401。
6. 原有的 /總覽、/完整報告、/個股、/盤前 仍能查詢，資料日期與 stale 警示正確。

本機及 CI 的模擬測試通過**不等於已在 Cloudflare 正式環境驗收**。不得宣稱自動部署、合併 main 或啟用排程。

參考資料：
https://developers.line.biz/en/reference/messaging-api/
https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append


## Step 5.8.3｜新增後 Sheets 已更新、LINE 沒有回覆

問題特徵：/觀察 能看到新增股票，但 /新增 當下沒有成功或錯誤回覆。可能原因包括 LINE replyToken 在官方 API／Google Sheets 操作後逾時，或 LINE Reply API 本身出錯。**尚未取得 Cloudflare 正式 Logs，不能斷定真正原因。**

新版採最小回覆期限設計：
1. HMAC、群組白名單、管理員權限檢查照舊。
2. 新增／移除若在約 5 秒內完成「官方查證、Sheets 寫入、回讀驗證」，仍使用**免費 LINE Reply** 回覆完整成功、已存在或錯誤內容。
3. 若超過 5 秒，先以**免費 LINE Reply** 告知「已受理、處理中、尚未確認成功」，避免等待所有外部服務後失去 replyToken。寫入仍由 Cloudflare ctx.waitUntil() 進行；請稍後使用 /觀察 確認結果。
4. LINE Reply API 回 4xx／5xx 時，Cloudflare Log 記錄 line_reply_failed 和 HTTP status；網路例外記錄 line_reply_transport_error。慢速任務結束記錄 watchlist_background_completed（operation、verified/not_verified），不記錄密鑰、LINE 身分 ID、群組 ID、replyToken 或原始訊息內容。
5. **不自動呼叫 LINE Push API**。Push 會計入每月訊息額度，甚至可能產生費用；此修正不新增付費服務。
6. Cloudflare ctx.waitUntil() 在 HTTP 回應後最多延續 30 秒，仍可能遇到 CPU 或等待時間限制。如果收到處理中而 /觀察 沒有出現股票，應查 Cloudflare Logs，不要立即連續重試。
7. 即使 webhook 重送，Google Sheets append 也沒有跨 Worker instance 的原子性；極短時間對同一代號同時操作仍可能重複。此修正沒有新增資料庫、佇列或額外儲存層。

上線驗收：
- 先備份原 Worker，部署後 LINE 的 /版本 必須顯示最新版 5.8.4。
- 在已設定管理員的私人群組先用 /觀察 查看原本股票，再用 /新增 已存在代號 檢查應回覆「已在觀察清單」，不要為測試隨意新增不需要的股票。
- 用真正要新增的股票測試：快則收到「✅ 已新增」；較慢則收到「⏳ 已收到，正在處理」。稍後以 /觀察 確認新增，並檢查 Watchlist 沒有重複。
- 如果仍無回覆，Cloudflare Dashboard → Workers & Pages → stock-line-bot → Observability / Logs，查該時間附近的 line_reply_failed、line_reply_transport_error、invocation status（例如 exceededCpu）。請提供錯誤類型或狀態碼，不要提供完整 webhook request、密鑰或身分識別資料。

參考：
https://developers.line.biz/en/reference/messaging-api/
https://developers.line.biz/en/docs/messaging-api/pricing/
https://developers.cloudflare.com/workers/runtime-apis/context/


## Step 5.8.4｜上櫃／興櫃官方 OpenAPI 被拒時的備援（3444）

問題重現：
- 3444 是利機（上櫃，產業代碼 29，電子通路）；2026-11-07 Windows 實測櫃買 mopsfin_t187ap03_O 回 HTTP 200，找到正確名稱與分類。
- 同一網址在另一網路查詢環境曾回 HTTP 403；**這顯示可能存在依來源 IP 的存取限制，不代表已取得 Cloudflare 正式的 403 紀錄**。
- 1260 富味鄉則在興櫃 mopsfin_t187ap03_R，可能遇到類似網路限制。

處理方式：
1. 正常情況**仍以證交所／櫃買中心官方名冊為優先**。官方 API 取得正確資料後，不使用備援。
2. 當官方來源錯誤、逾時或被拒絕時，才使用現有研究系統已採用的 **FinMind 免費 TaiwanStockInfo API**，以 dataset=TaiwanStockInfo&data_id=股票代號 單檔查詢。**不需要新 Secret、API Token、付費方案或新增 Google Sheets 欄位**。
3. FinMind 依 stock_id、stock_name、industry_category、type、date 驗證，保留最新日期的市場別（twse／tpex／emerging），避免把已轉板股票誤認為興櫃。只接受資料標籤日期在臺灣今日前 14 天內（或最多提前 1 天）。無資料、來源限流、日期過舊、名稱或市場別衝突時**拒絕新增**，不填入猜測資訊。
4. 自動將電子通路業／電子通路類對應為「電子通路」，食品工業對應「食品」；興櫃仍標「興櫃／類股」，ETF 保留專用風險註記。
5. 正式 LINE 回覆中明示「FinMind TaiwanStockInfo（第三方備援）」及資料日期，**不將第三方資料誤稱為官方直接驗證**。新增 Watchlist 不等於已完成選股分析。
6. Cloudflare Logs 新增不含敏感資訊的診斷事件：security_directory_primary_failed（市場別、HTTP status）、security_directory_backup_used、security_directory_backup_failed。不會記錄 LINE User ID、Group ID、Reply Token、Google Secrets 或個人 Watchlist 內容。
7. 已有的 5.8.3「5 秒內 Reply／逾時先告知處理中」機制保留；若備援也失敗，應看到未變更訊息（或先看到處理中，隨後用 /觀察 確認）。

驗收方法：
- 備份現有 Cloudflare Worker 並部署新版後，LINE 的 /版本 應回覆 **5.8.4**。
- 輸入 /新增 3444，應顯示「3444 利機（電子通路）」；/新增 1260 應顯示「1260 富味鄉（興櫃／食品）」。若股票已存在且資料完整，應顯示「已在觀察清單」而不是重複建立。
- /觀察 與 Google Sheets 的 Watchlist 應一致，stock_id 不得重複；只加入實際需要的股票。
- 若仍無法新增，請在 Cloudflare Dashboard → Workers & Pages → stock-line-bot → Observability → Logs 提供 security_directory_primary_failed 的 HTTP status、是否出現 security_directory_backup_used，以及 line_reply_failed 狀態碼，**不要分享完整請求或金鑰**。
- 原有 main、正式 GitHub 排程、Sheets 寫入權限、管理員白名單與 LINE 回覆額度規則均不因本次更新而變動。

相關文件：
- 官方櫃買資料：https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O
- 興櫃資料：https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R
- FinMind 免費台股總覽：https://finmind.github.io/tutor/TaiwanMarket/Technical/


## Step 5.8.5｜Webhook 499 快速 HTTP 200 修正

2026-11-07 Cloudflare 流量畫面顯示 POST /webhook 同時有 200 與 499（Client Closed Request）。499 表示請求端在收到完整回應前先中斷連線，**不等同於 Worker 內部錯誤，也不能僅憑此圖判定是哪個 LINE 指令**。LINE 官方建議 Webhook 收到後約 2 秒內回 HTTP 200，避免上游逾時與重送。

此前 Worker 要等 /新增 的股票查詢、Google Sheets 寫入與 LINE Reply 全部完成，才回 Webhook HTTP 200；即使新增了「5 秒後先回覆 LINE 處理中」，Webhook 仍在等待整個程序。因此出現 499 並不意外。

現在的處理流程：
1. 收到 POST /webhook，先檢查 LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN，讀取原始 Body，驗證 x-line-signature（HMAC-SHA256）；簽章錯誤回 401、JSON 錯誤回 400，均不建立背景任務。
2. 驗證通過後，將事件交給 Cloudflare ExecutionContext 的 ctx.waitUntil()，**不等待**股票查詢、Google Sheets、LINE Reply 完成，立即回 HTTP 200。空 events 也回 200。
3. 在背景工作中保留 LINE 群組白名單、LINE_ADMIN_USER_IDS 管理員檢查、股票名稱官方名冊優先與 FinMind 備援、只改 Watchlist、寫入後讀回驗證。
4. LINE Reply 與 Webhook HTTP 回應是兩個獨立動作：快速完成時回已驗證結果，超過 5 秒則先回「收到、處理中、尚未確認成功」，而非把更新失敗誤報成成功。不新增 LINE Push API 或其他計費流程。
5. 背景工作發生未處理例外會記錄 webhook_processing_error（只記錄 Error 類型）；LINE API 非 2xx 另記錄 line_reply_failed 與 status。不要把 Webhook HTTP 200 當成 LINE 已送達或 Sheets 已完成的證明。
6. Cloudflare ctx.waitUntil() 在 HTTP 回應後最多延續約 30 秒。這是目前的最小改動，而不是可靠工作佇列；如果外部服務長期超時仍可能被終止。需更強可靠性時才評估 Cloudflare Queues 等機制，不在這次擴大範圍。

此版本的模擬驗收應包含：延遲讀取 350ms 時 Webhook HTTP 200 不受阻；慢速上櫃查詢在 HTTP 200 之後仍能完成寫入與 LINE Reply；既有 HMAC 401、無效 JSON 400、不在白名單的群組不能讀寫；原有 /觀察、/新增、/移除、/完整報告等功能仍通過回歸測試。

正式部署指引：
- 先備份線上 Worker，並以本功能分支固定 Commit 的 cloudflare-worker/index.mjs 整份替換後 Deploy；不修改其他 Secrets。
- LINE 的 /版本 必須回覆 5.8.5，否則尚未部署此修正。
- 先驗證 /測試 和 /觀察，然後使用已存在的代號做 /新增 測試，以免產生不需要的 Watchlist 紀錄。若回覆「已在觀察清單」代表讀取正常且沒有重複新增。
- 只有真正想追蹤新股票時才測 /新增 3444／1260；收到「處理中」後稍後用 /觀察 確認結果，不要重送同一請求。
- 觀察 Cloudflare Workers **Invocations 與 Observability Logs**、LINE Developers Console 的 Webhook error statistics。預期新的 POST /webhook 不因慢速外部 API 而出現大量 499；需要比對相同時間窗的請求量及 200/499 比例，不能只看某一筆 200。
- 若仍有 499，核對是否為同一 Worker 的新部署、完整執行紀錄及 LINE error reason（尤其 request_timeout）；不公開 LINE token、群組 ID、User ID 或 Google 服務帳戶。

官方文件：
- https://developers.line.biz/en/docs/messaging-api/receiving-messages/
- https://developers.line.biz/en/docs/messaging-api/check-webhook-error-statistics/
- https://developers.cloudflare.com/workers/runtime-apis/context/
