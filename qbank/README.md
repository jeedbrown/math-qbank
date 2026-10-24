# 數學題庫分析模組（qbank）— 獨立測試版

獨立於正式網站的本機模組：匯入原始題庫 → 保留 21 欄原樣 → 產生 AI 分析指令（教師手動貼到現有 AI 訂閱服務）→ 貼回 JSON 結果並以規準驗證 → 教師審核 → 匯出。不串接任何付費 API，不寫入正式網站、正式題庫或部署設定。

- 執行環境：Node.js 22 以上（使用內建 `node:sqlite`、`node:test`，**零外部套件**）。
- 工作資料庫：`qbank/data/qbank.sqlite`（已列入 `.gitignore`；可用環境變數 `QBANK_DB` 另指定）。
- 文件：`qbank/docs/`。測試：`node --test qbank/test/qbank.test.js`。

## 快速開始

```bash
# 1. 啟動本機介面（只綁 127.0.0.1:8787）
node qbank/server.js
# 瀏覽器開 http://127.0.0.1:8787/

# 或用命令列
node qbank/cli.js import qbank/samples/sample_questions.csv   # 匯入（先 --preview 可只預覽）
node qbank/cli.js stats                                        # 總覽數字
node qbank/cli.js prompt --pending                             # 產生 AI 分析指令（檔案寫到 qbank/data/prompts/）
node qbank/cli.js import-ai 結果.json                           # 匯入 AI 回傳 JSON（逐筆驗證）
node qbank/cli.js queue                                        # 待審核清單
node qbank/cli.js review <分析ID> confirm --reviewer 王老師     # 教師確認（或 modify / return）
node qbank/cli.js export confirmed --out 已確認.csv              # 匯出
node qbank/cli.js help                                         # 全部指令
```

## 教師操作流程（介面版）

1. **匯入題目**：選擇 Google 試算表下載的 CSV → 預覽（看欄位偵測、新增／新版本／拒絕）→ 確認匯入。
2. **題目搜尋**：依來源、年級、課綱代碼、單元、技能、迷思概念、課程企劃、審核狀態、品質旗標搜尋；勾選題目。
3. **批次 AI 分析**：選「只分析尚未完成的題目」或勾選題目 → 產生指令 → 複製貼到 ChatGPT／Claude 等現有服務 → 把回傳 JSON 貼回「貼回 AI 結果」→ 系統逐筆驗證（ID、版本、課綱代碼、技能詞彙、迷思概念欄位），通過的進待審核，錯的被拒絕且不寫入。
4. **單題分析／審核**：左邊原始題目與既有類題（唯讀），右邊教師最後確認；下方 AI 建議與判斷理由。可「接受」「修改後接受」「退回（需原因）」。題目更新後舊分析會標示「可能失效」，不能直接接受。
5. **類題工作區**：勾選題目 → 選操作（換數字、換情境、調整複雜度、不同解法）→ 產生指令 → 貼回 JSON → 自動算式驗算 → 教師核准。原題與既有類題一、類題二永遠不被覆蓋。
6. **分類規準**：唯讀檢視課綱代碼表、技能詞彙、單元草案、活動類型；可送出「新增詞彙建議」，不會直接改正式詞庫。
7. **匯出與備份**：已確認分析、待審核、異常清單、課程關聯、原始題目、完整備份；一致性檢查。

## 目錄

```
qbank/
  cli.js            命令列工具
  server.js         本機 HTTP 伺服器（127.0.0.1）＋ JSON API
  ui/index.html     繁體中文測試介面（單頁，手機可讀）
  lib/
    csv.js          CSV 解析／輸出（引號內換行、BOM）
    ids.js          21 欄定義、題目 ID、內容指紋
    db.js           SQLite 結構
    vocab.js        分類規準讀取（課綱代碼、年級、技能、單元、活動類型）
    importer.js     匯入預覽／寫入、去重、版本、品質旗標
    analysis.js     分析欄位定義、AI 結果驗證、儲存、版本
    prompts.js      AI 指令產生與切批
    review.js       教師審核
    verify.js       安全算式驗算
    variants.js     類題匯入、驗算、核准
    exporter.js     匯出、備份、一致性檢查
    stats.js        總覽與搜尋
  vocab/            分類規準檔（課綱代碼表由教育部課綱 PDF 抽出；技能／單元為草案）
  samples/          虛構示範題（8 題，同 21 欄）
  test/             node:test 測試（22 項，含反向案例）
  docs/             架構、欄位對照、相容性、規準草案與待裁定、提示詞範本、測試結果、未完成事項、交接
  data/             工作資料庫與產生的指令檔（不進版控）
  private/          原始題庫副本與匯出（不進版控；原題為出版社資料）
```

## 架構（五層）

| 層 | 落點 | 說明 |
|---|---|---|
| 第一層 總題庫 | `questions`、`question_versions`、`question_flags` | 原始 21 欄逐字保存在 `raw_json`；身分鍵＝題庫來源＋套別＋題號；內容變動另存版本 |
| 第二層 題目分析 | `analyses`、`vocab_suggestions` | 分析結果以 JSON 存放，記錄分析來源（rule／ai／manual）、規準版本、題目版本、審核狀態 |
| 第三層 類題與解答 | `variants` | 既有類題鏡像（existing_1／existing_2）與 AI 類題（ai）分開；驗算狀態與教師核准分開 |
| 第四層 教師審核 | `review_log` | 每次接受／修改／退回都留前後內容 |
| 第五層 教學應用 | `course_links` | 題目 × 課程企劃 × 堂次 多對多；不以堂次編號當題目主鍵 |

所有層以 `questions.id`（永久 ID）關聯。正式題庫寫回介面預留在匯出層，本次不啟用。

## 雲端測試版（Cloudflare Workers ＋ D1）

同一套程式可部署成獨立 Worker 給教師在瀏覽器使用：`qbank/worker.js`＋`qbank/wrangler.jsonc`，資料庫改用 D1，整站以帳號密碼（密鑰 `QBANK_AUTH`）保護並禁止索引。步驟與檢查清單見 `docs/07_雲端測試版部署.md`。本機模擬：`npx wrangler dev --config qbank/wrangler.jsonc --local`。

## 安全與限制

- 伺服器只綁 `127.0.0.1`，無登入機制，**不可對外暴露**；正式整合時須加權限控制。
- `qbank/data/`、`qbank/private/` 不進版控；原題（出版社資料）與匯出檔不得放進公開 repo 或公開網址。
- CSV 匯入只保留儲存格顯示文字；試算表的 HYPERLINK 公式與連結目標不會保留（見 docs/01）。
