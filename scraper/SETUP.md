# AI 自動抓賽程 — 設定教學（一次性，約 15 分鐘）

設定完成後：**每週一早上 9 點（台北時間）自動抓新賽程寫進 Google Sheet，網站自動更新，你不用做任何事。**

爬蟲永遠**只新增、不修改、不刪除**任何現有資料。單次最多寫入 60 筆，欄位對不上會自動中止。

## 它怎麼運作（15 個來源，三層優先序）

```
Tier 1 主辦賽事方（12 個）  APT / GOP / ZSOP / AJPC / JOPT / OLA / PSC / WPG / APL / APPT / P1 / RDPT
Tier 2 場館方（1 個）        CTP Club 台北
Tier 3 彙整站（2 個）        PokerCalendar.asia API（結構化 JSON，不用 AI）、SoMuchPoker 年度日曆
```

同一場賽事被多個網站列到時，**每個欄位各取 tier 最小（最權威）且有值的來源**。
例如 APT Championship 台北：日期用 APT 官網的、連結用 APT 官網的、彙整站只在官網沒寫時才補。

**Handbook URL 絕不會指向彙整站**（pokercalendar.asia、somuchpoker.com 等都在黑名單裡）。
找不到主辦方或場館的原生連結時**寧可留空**，不會拿別人家的頁面充數。

## 抓不到的怎麼辦：待補清單

爬蟲補不到的買入，會整理成一份清單寫進 Sheet 的 **`AI_待補`** 分頁（第一次跑會自動建立），
每一列都寫明「為什麼抓不到」：

| 主分頁列號 | 開始 | 賽事 | 地點 | 官網連結 | 為什麼抓不到 |
|---|---|---|---|---|---|
| 67 | 2026/10/08 | Poker Dream 26 | 馬來西亞 | pokerdream-live.com | 官網有人機驗證或要登入，爬蟲抓不到——請人工查 |
| 81 | 2026/10/30 | WPT Seoul 2026 | 韓國 仁川 | worldpokertour.com | 從 GitHub 連不上官網（HTTP 403），可能擋機房 IP |
| 77 | 2026/09/04 | Triton SHRS Jeju | 韓國 濟州島 | tritonpokerseries.com | 官網頁面沒列主賽買入 |

你每週打開這個分頁，照清單到官網查了填進**主分頁**，下一輪那一列就會從清單消失。
這個分頁每輪整個重寫，**不要在這裡填資料**。

## 真瀏覽器（Playwright）

有些主辦站的內容靠 JS 載入，純抓網頁只拿到空殼（RPT 官網只有「Royal Poker」11 個字）。
`sources.json` 的 `browserHosts` 列出這些網域，列表抓取和詳情頁補買入都會改用真的 Chromium 載入。
GitHub Actions 每次會多花約 1 分鐘裝瀏覽器。要加新的網域就加進 `browserHosts`。

## 回頭補空欄位

賽事的資訊是分批公布的——先出大概日期，兩三個月前才出賽程表和報名費。
所以爬蟲第一次抓到的一定是最不完整的版本，**每一輪都會回頭把既有列的空欄位補上**：

```
=== 📝 補上既有列的 3 個空欄位（只補空的，不覆蓋已填的）===
  第 88 列 KPC Poker Series October 2026｜ME Buy-in ← 1500000
  第 88 列 KPC Poker Series October 2026｜Currency ← KRW
  第 88 列 KPC Poker Series October 2026｜Handbook URL ← https://www.kpcpoker.com/?lang=en
```

買入金額特別處理：**3 個月內開賽、買入還是空的既有列，會回頭抓它的官網詳情頁**
（報名費通常就是這時候公布）。越快開賽的越優先，跟新增的列共用同一份 Gemini 額度。

規則是**只補空白、不覆蓋**：你手填的、或先前抓到的值一律保留。買入和幣別要嘛一起補、
要嘛都不補（只有金額沒幣別換算不了）。唯一的例外是地點的格式升級——舊列如果是純英文，
會換成雙語寫法，但只有在確認英文部分指的是同一個地方時才換。

## 取消偵測

來源網站把某場賽事標成取消時（`***CANCELLED***`、`已取消` 等），爬蟲**不會刪掉那一列**，
而是在賽事名稱前面加上 `[已取消]`：

```
=== 🚫 偵測到 1 場已取消，在表上加註記（不刪除該列）===
  第 68 列：「Poker Dream 27」→「[已取消] Poker Dream 27」  依據 T3:PokerCalendar.asia
```

只動 Tournament 那一格，日期、地點、買入全部保留。已經標過的不會重複加。
判定也照三層優先序：主辦官網還在列這場賽事的話，就不採信彙整站說的取消。

## 改期偵測

賽事常常「先公布一個日期、之後改期」。爬蟲每次跑都會拿主辦方（Tier 1／2）現在公布的日期，
跟你表上的日期比對，**不一致就在執行 log 裡列出來**：

```
=== ⚠️ 偵測到 2 場日期與主辦方公布的不同 ===
  APT JEJU 2026（第 4 列）：2026-09-25~2026-10-04 → 2026-09-25~2026-10-07  依據 T1:APT
```

預設**只通知、不修改**。要讓它自動改，在手動觸發時勾選「改期時自動更新」，
或把 `.github/workflows/scrape.yml` 裡 `UPDATE_DATES` 那行的 `'0'` 改成 `'1'`（排程執行也會自動改）。
自動更新時**只會動 Start Date / End Date 兩格**，其他欄位一律不碰；日期差超過 45 天視為可能不是同一場，只報不改。

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
改 `scraper/sources.json` 的 `sources` 陣列，加一行：
`{ "tier": 1, "name": "站名", "type": "html", "url": "網址" }`
`tier` 填 1（主辦賽事方）、2（場館方）或 3（彙整站）——數字小的資料會蓋過數字大的。
加完先跑 `node index.mjs --test-fetch` 確認抓得到（這步不需要任何金鑰）。

**Q：為什麼有些來源被併在一起送給 AI？**
Gemini 免費額度是按「呼叫次數」算的，而 Tier 1 那些主辦站的頁面都很小（1,500–8,000 字），
一個一個送等於白白燒額度。所以爬蟲會把網頁來源打包成幾批、一批一次呼叫，14 個來源壓成 3 次。
每一筆抽出來的資料都帶著來源編號，所以 tier 優先序照樣正確。
單一來源本身就很大時（例如 SoMuchPoker 年度日曆約 50,000 字）會自己成一批。

單輪呼叫次數：3 次來源 + 1 次去重 + 最多 20 次詳情頁 ≈ 24 次。
**不要同一天連續測試**，免費額度撞牆後當天就補不了買入金額了（額度以太平洋時間午夜重置，約台北下午 3 點）。

**Q：怎麼確認改動沒把東西弄壞？**
`cd scraper && node test.mjs`——211 項純邏輯測試，不需要金鑰也不連網。GitHub Actions 每次跑之前也會先跑一遍。

**Q：地區收錄範圍？**
**西太平洋（東亞）+ 東南亞 + 澳洲**：台灣、日本、韓國、中國、香港、澳門、蒙古、菲律賓、越南、泰國、
馬來西亞、新加坡、印尼、柬埔寨、寮國、緬甸、汶萊、澳洲。

判斷依據是**賽事舉辦地點**，不是巡迴賽名稱——WPT、EPT、Triton 只要辦在範圍內就收
（WPT Seoul、WPT Cambodia、Triton Jeju 都收；WPT Cyprus、Triton Montenegro 不收）。

範圍外唯一的例外是兩個超大型賽事：夏季 **WSOP**（拉斯維加斯）和冬季 **WSOP Paradise**（巴哈馬）。

南亞（印度、斯里蘭卡）、中亞（烏茲別克）、西亞（土耳其、賽普勒斯）目前都不收。
要調整就改 `index.mjs` 的 `ASIA_COUNTRIES`（加國名）和 `isNonAsiaAllowed()`（加例外賽事）。

**Q：排程突然不跑了？**
GitHub 規定：repo 60 天沒有任何 commit，排程會自動暫停，GitHub 會寄信通知，到 Actions 頁面按一下 re-enable 即可。

**Q：執行失敗會通知嗎？**
會，GitHub 會自動寄失敗通知信到你的 GitHub 註冊信箱。
