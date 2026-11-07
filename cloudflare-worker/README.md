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

- 只支援 4～6 位 ASCII 數字代號，包括 0050 和 006208；暫不支援含英文字母的特殊股票或 ETF 代號。
- /新增 2882 若不存在，**自動查證上市櫃公司基本資料**，新增 2882／國泰金／金融／TRUE；/新增 2330 可得到 2330／台積電／半導體／TRUE；/新增 0050 可得到 0050／元大台灣50／ETF／TRUE。
- 名稱取官方簡稱，產業別使用證交所／櫃買產業代碼與對照表，轉成系統的類股標籤；ETF 一律顯示 ETF。這是基本資料，不是即時報價。
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

管理員輸入只有代號的 /新增 指令時，Worker 會以 HTTPS 並行查詢官方公開名冊：

- 證交所 ETF 基本資料： https://openapi.twse.com.tw/v1/opendata/t187ap47_L （基金代號、基金簡稱）。
- 證交所上市公司基本資料： https://openapi.twse.com.tw/v1/opendata/t187ap03_L （公司代號、公司簡稱、產業別）。
- 櫃買中心上櫃公司基本資料： https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O （SecuritiesCompanyCode、CompanyAbbreviation、SecuritiesIndustryCode）。
- 產業代碼按臺灣證券交易所正式產業分類對照為系統標籤，例如 24→半導體、17→金融、15→航運。這些標籤是便於觀察池分組的簡稱，不宣稱是官方逐字分類。
- 同一個 Worker 執行個體對查過的代號快取約一小時，避免短時間反覆請求；每一個新代號仍以官方資料確認。
- 僅確認「官方資料集存在這個代號及名稱／產業」，不代表該標的符合現有 FinMind 選股引擎的回測條件。若無法辨識 ETF／上市／上櫃股票、產業代碼未知、資料源逾時或互相衝突，保持 Watchlist 不變。
- 目前未涵蓋興櫃、海外市場、部分特殊代號與其他非上述三份名冊的基金，這些情況要人工核對，不得用字首猜測分類。

資料源都不需要新增 API Key，也不需要開放原本 Google Sheet 的公開權限。Cloudflare 的五組既有 Secrets 與 LINE_ADMIN_USER_IDS 設定保持不變。

## 測試與部署驗收

Node.js 22+，無須安裝 npm 套件：

    node --test cloudflare-worker/index.test.mjs cloudflare-worker/commands.test.mjs cloudflare-worker/watchlist.test.mjs

測試涵蓋：既有 LINE 簽章及群組白名單、管理員白名單、缺少 User ID、未配置 Secret、股票代號格式、**官方 ETF／上市／上櫃名冊解析與類股對照、既有 0050 空白欄位回填、查無代號／來源無法查證時拒絕寫入**、重複新增、重新啟用、軟刪除、ETF 前導零、表頭順序變更、讀寫 OAuth Scope 分離、Google 寫入失敗，以及既有報告查詢。

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
