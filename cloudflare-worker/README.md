# LINE Cloudflare Worker｜研究報告與 Watchlist 管理

本 Worker 連接 LINE 私人群組和 Google Sheets。原有研究報告查詢維持唯讀，只有指定 LINE 管理員可以新增／移除 Watchlist 股票。

**狀態**：本版本程式與模擬測試已完成；正式 Cloudflare 仍須手動備份、部署和驗收。本版本不會自行修改線上 Worker、真實試算表或 GitHub 排程。

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
