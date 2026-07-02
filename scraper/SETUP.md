# AI 自動抓賽程 — 設定教學（一次性，約 15 分鐘）

設定完成後：**每週一早上 9 點（台北時間）自動抓新賽程寫進 Google Sheet，網站自動更新，你不用做任何事。**

爬蟲永遠**只新增、不修改、不刪除**任何現有資料。單次最多寫入 60 筆，欄位對不上會自動中止。

---

## 你需要準備 4 個 GitHub Secrets

| Secret 名稱 | 是什麼 | 去哪拿 |
|---|---|---|
| `GEMINI_API_KEY` | Gemini 免費 API 金鑰 | 步驟 1 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google 服務帳號金鑰（整包 JSON） | 步驟 2 |
| `SHEET_ID` | 試算表的 ID | 步驟 3 |
| `SHEET_TAB` | 分頁名稱（可留空 = 用第一個分頁） | 步驟 3 |

---

## 步驟 1：拿 Gemini API key（2 分鐘，免費）

1. 開 https://aistudio.google.com/apikey （用你的 Google 帳號登入）
2. 點「**Create API key**」→ 選任一個 Google Cloud 專案（或讓它自動建）
3. 複製那串 `AIza...` 開頭的金鑰 → 這就是 `GEMINI_API_KEY`

> 免費額度就夠用：本爬蟲每週只呼叫幾十次，離免費上限（每天 250 次）很遠。

## 步驟 2：建 Google 服務帳號（5 分鐘）

服務帳號（service account）= 一個機器人 Google 帳號，讓爬蟲能寫入你的 Sheet。

1. 開 https://console.cloud.google.com/ → 選一個專案（用步驟 1 那個就好）
2. 左上選單 →「API 和服務」→「程式庫」→ 搜「**Google Sheets API**」→ 點「**啟用**」
3. 左上選單 →「IAM 與管理」→「**服務帳戶**」→「**建立服務帳戶**」
   - 名稱隨便取，例如 `poker-scraper` → 建立 → 角色不用選 → 完成
4. 點進剛建好的服務帳戶 →「**金鑰**」分頁 →「新增金鑰」→「建立新的金鑰」→ 選 **JSON** → 會下載一個 `.json` 檔
5. 用記事本打開那個 JSON 檔，**全選複製整份內容** → 這就是 `GOOGLE_SERVICE_ACCOUNT_JSON`
6. JSON 裡有一行 `"client_email": "poker-scraper@....iam.gserviceaccount.com"` → 複製這個 email
7. 打開你的賽程 Google Sheet → 右上「**共用**」→ 貼上那個 email → 權限選「**編輯者**」→ 傳送

## 步驟 3：拿 Sheet ID 和分頁名稱（1 分鐘）

- 打開賽程 Sheet，看網址列：
  `https://docs.google.com/spreadsheets/d/`**`這一段就是SHEET_ID`**`/edit#gid=0`
- `SHEET_TAB` = 賽程資料所在的分頁名稱（Sheet 下方的頁籤文字）。如果資料就在第一個分頁，這個 secret 可以不設。

## 步驟 4：把 4 個 Secrets 填進 GitHub（3 分鐘）

1. 開 https://github.com/aa852aaa/asia-poker-calendar/settings/secrets/actions
2. 點「**New repository secret**」，逐一新增：
   - Name: `GEMINI_API_KEY`，Secret: 貼步驟 1 的金鑰
   - Name: `GOOGLE_SERVICE_ACCOUNT_JSON`，Secret: 貼整份 JSON 內容
   - Name: `SHEET_ID`，Secret: 貼試算表 ID
   - Name: `SHEET_TAB`，Secret: 分頁名稱（資料在第一個分頁就跳過）

## 步驟 5：試跑一次（2 分鐘）

1. 開 https://github.com/aa852aaa/asia-poker-calendar/actions → 左邊點「**AI 抓賽程**」
2. 右邊「**Run workflow**」→ 「試跑」保持勾選 ✅ → 綠色按鈕 Run
3. 等 2–5 分鐘跑完，點進去看 log：會列出「準備寫入 N 筆」的預覽清單，**但不會真的寫入**
4. 預覽看起來 OK → 再 Run 一次，這次**取消勾選**「試跑」→ 就會真的寫進 Sheet，網站 60 秒內更新

之後每週一早上會自動跑（不試跑、直接寫入）。

---

## 常見問題

**Q：它會動到我手動填的資料嗎？**
不會。爬蟲只會在表格最下面「新增」列，永遠不修改、不刪除既有的列。已存在的賽事（名字相近＋日期重疊）會自動跳過。

**Q：想在 Sheet 裡分辨哪些是 AI 加的？**
在 Sheet 標題列最右邊加一欄，標題打 `Source`——之後 AI 新增的列會自動在這欄寫 `AI`。（不加也完全不影響運作）

**Q：抓錯了怎麼辦？**
直接在 Sheet 裡改掉或刪那一列即可。改過的列爬蟲不會再動它。

**Q：想加新的來源網站？**
改 `scraper/sources.json`，加一行 `{ "name": "站名", "url": "網址" }`。

**Q：排程突然不跑了？**
GitHub 規定：repo 60 天沒有任何 commit，排程會自動暫停，GitHub 會寄信通知，到 Actions 頁面按一下 re-enable 即可。

**Q：執行失敗會通知嗎？**
會，GitHub 會自動寄失敗通知信到你的 GitHub 註冊信箱。
