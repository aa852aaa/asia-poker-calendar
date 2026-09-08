// AI 自動抓賽程：多來源 → 三層優先序合併 → LLM 去重 → 寫入 Google Sheet 主分頁
//
// 用法：
//   node index.mjs               正式跑（需要環境變數，見 SETUP.md）
//   DRY_RUN=1 node index.mjs     試跑：只印出會新增的列，不寫入 Sheet
//   UPDATE_DATES=1 node index.mjs  額外允許「改期自動更新」既有列的日期（預設關閉，只通知不改）
//   node index.mjs --test-fetch  只測試來源網頁抓不抓得到（不需要任何金鑰）
//
// 設計原則：
//   1. 預設只新增、不修改、不刪除任何現有列（唯一例外是開了 UPDATE_DATES 的改期更新）
//   2. 三層優先序：主辦賽事方(1) > 場館方(2) > 彙整站(3)。同一場賽事，每個欄位取 tier 最小且有值的來源
//   3. Handbook URL 絕不指向彙整站（linkBlacklist），寧可留空
//   4. 任何一步判斷不了就保守跳過——寧可漏，不要寫錯

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JWT } from "google-auth-library";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "";
const SHEET_ID = process.env.SHEET_ID ?? "";
const SHEET_TAB = process.env.SHEET_TAB ?? ""; // 留空 = 自動用試算表的第一個分頁
const DRY_RUN = process.env.DRY_RUN === "1";
const UPDATE_DATES = process.env.UPDATE_DATES === "1";
const TEST_FETCH = process.argv.includes("--test-fetch");

const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_NEW_PER_SOURCE = 30; // 單一來源單次最多抽出筆數（防 LLM 幻覺灌爆表格）
const MAX_APPEND_TOTAL = 60; // 單次執行寫入總上限
const MAX_DATE_SHIFT_DAYS = 45; // 改期偵測：日期差超過這個天數就不當成同一場的改期，只報不改
const PAGE_TEXT_LIMIT = 350_000; // 餵給 LLM 的每頁文字上限（字元）
const GEMINI_CALL_GAP_MS = 7_000; // 免費額度 10 RPM，兩次呼叫間隔 7 秒
const HIDE_ENDED_AFTER_DAYS = 3; // 與網站一致：結束超過 3 天的不收

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// Sheet 必須要有的欄位（防呆：接錯分頁就直接中止，不會亂寫）
const REQUIRED_HEADERS = [
  "Start Date",
  "End Date",
  "Location",
  "Tournament",
  "ME Buy-in",
  "Currency",
  "Handbook URL",
];

// ---------- 地區規則 ----------
// 收錄範圍：西太平洋（東亞）+ 東南亞。依「賽事舉辦地點」判斷，不是依巡迴賽名稱——
// WPT、EPT 這類國際巡迴賽只要辦在範圍內就收（WPT Seoul、WPT Cambodia 都收）。
// 唯一的地點例外是超大型賽事：夏季 WSOP（拉斯維加斯）與冬季 WSOP Paradise（巴哈馬）。
const ASIA_COUNTRIES = new Set([
  // 東亞 / 西太平洋
  "taiwan", "japan", "south korea", "korea", "north korea", "china",
  "hong kong", "macau", "macao", "mongolia",
  // 東南亞
  "philippines", "vietnam", "thailand", "malaysia", "singapore", "indonesia",
  "cambodia", "laos", "myanmar", "burma", "brunei", "timor-leste", "east timor",
  // 註：南亞（印度、斯里蘭卡、尼泊爾）、中亞（烏茲別克、哈薩克）、西亞（土耳其、
  // 賽普勒斯、喬治亞、亞美尼亞）刻意都不列入——超出「西太平洋 + 東南亞」的範圍。
  // 之後若要收（例如 Poker Dream 斯里蘭卡站變重要了）就把國名加進這裡。
]);

// 國名/城市正規化（彙整站的資料常常很髒）
const COUNTRY_FIX = {
  "korea, republic of": "South Korea",
  "korea": "South Korea",
  "viet nam": "Vietnam",
  "macao": "Macau",
  "russian federation": "Russia",
  "taiwan, province of china": "Taiwan",
};
const CITY_FIX = {
  "hà nội": "Hanoi",
  "hạ long": "Ha Long",
  "jeju,korea": "Jeju",
  "shinjuku city": "Tokyo",
};

export function fixCountry(s) {
  const k = String(s ?? "").trim().toLowerCase();
  return COUNTRY_FIX[k] ?? String(s ?? "").trim();
}
export function fixCity(s) {
  const k = String(s ?? "").trim().toLowerCase();
  return CITY_FIX[k] ?? String(s ?? "").trim();
}

export function isAsia(location) {
  const parts = String(location ?? "").split(",").map((x) => x.trim().toLowerCase());
  return parts.some((p) => ASIA_COUNTRIES.has(p));
}

// 非亞洲的白名單：只有 WSOP 本賽事（夏季拉斯維加斯）與 WSOP Paradise（冬季巴哈馬）
export function isNonAsiaAllowed(name) {
  const n = String(name ?? "");
  if (/circuit/i.test(n)) return false; // WSOP Circuit 的歐美站不算
  return /\bwsop\b|world series of poker/i.test(n);
}

export function passesGeoRule(ev) {
  if (isAsia(ev.Location)) return true;
  if (isNonAsiaAllowed(ev.Tournament)) return true;
  return false;
}

// ---------- 小工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taipeiTodayYMD() {
  // GitHub Actions 是 UTC，統一換算成台北日期
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

function shiftYMD(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00+08:00`) + days * 86400_000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

function parseYMD(s) {
  const m = String(s ?? "")
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T00:00:00+08:00`);
  return Number.isFinite(t) ? t : null;
}

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/20\d\d/g, " ") // 年份不算名字的一部分
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a, b) {
  const ta = new Set(normName(a).split(" ").filter(Boolean));
  const tb = new Set(normName(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function rangesOverlap(s1, e1, s2, e2, slackDays = 3) {
  const slack = slackDays * 86400_000;
  return s1 - slack <= e2 && s2 - slack <= e1;
}

// 保守版重複判定（只在 LLM 去重失敗時當退路用：寧可漏不要錯）
export function isDuplicateConservative(ev, existing) {
  const s1 = parseYMD(ev["Start Date"]);
  const e1 = parseYMD(ev["End Date"]) ?? s1;
  for (const ex of existing) {
    const s2 = parseYMD(ex["Start Date"]);
    const e2 = parseYMD(ex["End Date"]) ?? s2;
    if (s1 == null || s2 == null) return true;
    if (!rangesOverlap(s1, e1, s2, e2)) continue;
    // 日期重疊時，名稱有一點像就當重複（縮寫 vs 全名對不上，所以門檻放低）
    if (jaccard(ev["Tournament"], ex["Tournament"]) >= 0.25) return true;
  }
  return false;
}

// ---------- 抓網頁 ----------

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en,zh-TW;q=0.9,ja;q=0.8,ko;q=0.7" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// HTML → 純文字。保留三樣 LLM 需要的東西：
//   [link:網址]  連結（用來填 Handbook URL）
//   [img:說明]   圖片 alt —— 有些站（Red Dragon、APL）把賽事名稱只放在圖片 alt 裡，丟掉就等於漏資料
//   註解區塊移除 —— 避免抓到網站註解掉的舊內容
export function htmlToText(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<img[^>]*\balt="([^"]+)"[^>]*>/gi, (_, alt) => ` [img:${alt}] `)
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>/gi, (_, href) => {
      const abs = href.startsWith("http")
        ? href
        : href.startsWith("/")
          ? origin + href
          : origin + "/" + href.replace(/^\.\//, "");
      return ` [link:${abs}] `;
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PAGE_TEXT_LIMIT);
}

// ---------- Gemini ----------

async function geminiJSON(prompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      console.warn(`Gemini ${res.status}，第 ${attempt} 次重試前等 30 秒...`);
      await sleep(30_000);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini 回應沒有內容");
    return JSON.parse(text);
  }
  throw new Error("Gemini 重試 3 次仍失敗");
}

const LISTING_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      tournament: { type: "STRING" },
      start_date: { type: "STRING", description: "YYYY-MM-DD" },
      end_date: { type: "STRING", description: "YYYY-MM-DD" },
      location: { type: "STRING", description: "City, Country（英文）" },
      detail_url: { type: "STRING" },
    },
    required: ["tournament", "start_date", "end_date", "location"],
  },
};

const GROUPING_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      candidate_indexes: { type: "ARRAY", items: { type: "INTEGER" } },
      already_in_sheet: { type: "BOOLEAN" },
      matched_sheet_row: { type: "STRING" },
    },
    required: ["candidate_indexes", "already_in_sheet"],
  },
};

const DETAIL_SCHEMA = {
  type: "OBJECT",
  properties: {
    me_buyin: { type: "NUMBER", nullable: true },
    currency: { type: "STRING" },
    handbook_url: { type: "STRING" },
  },
  required: [],
};

function listingPrompt(sourceName, today, text) {
  return `你是資料抽取工具。以下是撲克賽程網站「${sourceName}」列表頁的純文字。
標記說明：[link:網址] 是該處的連結；[img:文字] 是圖片的說明文字——有些網站把賽事名稱或日期只放在圖片說明裡，要一起看。

抽出所有「錦標賽系列」（festival / series，一整檔賽事節），每個系列一筆。

地區規則（一律依「賽事舉辦地點」判斷，不要依巡迴賽的名稱判斷）：
- 要：東亞與東南亞——台灣、日本、韓國、中國、香港、澳門、蒙古、菲律賓、越南、泰國、馬來西亞、新加坡、印尼、柬埔寨、寮國、緬甸、汶萊。
- WPT、EPT、Triton 這類國際巡迴賽，只要辦在上述地點就要收（例如 WPT Seoul、WPT Cambodia、Triton Jeju 都要）。
- 不要：上述地點以外的——歐洲、美洲、澳洲、紐西蘭、印度、斯里蘭卡、尼泊爾、中亞、土耳其、賽普勒斯等，即使是知名巡迴賽也不要。
- 唯一的地點例外：「WSOP（世界撲克大賽本賽事，夏季拉斯維加斯）」和「WSOP Paradise（冬季巴哈馬）」這兩個即使不在上述地點也要收。

其他規則：
- 日期一律輸出 YYYY-MM-DD，年份要依上下文推斷正確。
- 只列「今天（${today}）當天或之後才結束」的系列；已結束的不要。
- 標示為取消（CANCELLED / 已取消）的不要。
- location 用英文「City, Country」格式，例如 "Taipei, Taiwan"、"Jeju, South Korea"。頁面上只有國家沒有城市時就只填國家。
- detail_url 填該系列詳情頁的完整網址（從 [link:...] 取），找不到就填空字串。
- 找不到的欄位填空字串，不要編造。頁面上沒有日期的系列就不要輸出。

頁面內容：
${text}`;
}

function groupingPrompt(candidates, sheetRows) {
  const cand = candidates
    .map(
      (c, i) =>
        `${i}. ${c["Start Date"]} ~ ${c["End Date"]} | ${c.Location} | ${c.Tournament}  [來源 T${c._tier}:${c._src}]`,
    )
    .join("\n");
  const sheet = sheetRows
    .map((r) => `- ${r["Start Date"]} ~ ${r["End Date"]} | ${r.Location} | ${r.Tournament}`)
    .join("\n");

  return `你在幫一個亞洲撲克賽程表做「同場賽事辨識」。有兩份清單：

【A. 表格現有資料】（人工維護，賽事名常用縮寫，例如 HPC = Harbour Poker Cup、OLA = Ola Poker Tour、APC = Asia Poker Championship、TMT = Taiwan Millions Tournament、GOP = Gods of Poker、ZSOP = Zodiac Series of Poker、APT = Asian Poker Tour、APPT = Asia Pacific Poker Tour、JOPT = Japan Open Poker Tour、RDPT = Red Dragon Poker Tour）
${sheet || "（表格目前是空的）"}

【B. 從各網站抓到的候選】（同一場賽事可能被不同網站用不同名字列出來，日期也可能差幾天）
${cand}

請把 B 分組，每組 = 同一場實體賽事，並判斷這組是不是 A 裡面已經有的。

判斷準則：
- 同一場賽事的判斷看「主辦系列 + 城市 + 日期區間」。名稱寫法不同（縮寫、加副標題、加年份、翻譯）不影響，例如 "HPC" 和 "Harbour Poker Cup"、"GOP Taipei 2026 II" 和 "The Trial of Wisdom - GOP Taipei 2026 II" 都是同一場。
- 但同一個系列在同一個城市的「不同檔期」是不同賽事，不可以合併，例如 "Manila Megastack Warm-up"(11/23-26) 和 "Manila Megastack 25"(11/28-12/07) 是兩場。
- 表格是人工維護的，資料可能是賽事「剛公布時」的日期，之後主辦方改期了。所以日期差幾天甚至一兩週都可能是同一場改期，不要因為日期不同就判成不同場——請以「主辦系列 + 城市」為主要依據。
- 不確定是不是同一場時，寧可判成「不同場」而且「不在表格裡」——寫錯了人可以刪，漏掉了就沒人知道。

輸出：每組一筆，candidate_indexes 填該組包含的 B 索引數字，already_in_sheet 填這組是否已存在於 A，matched_sheet_row 填對應到的 A 那一列的賽事名稱原文（沒有就空字串）。
B 裡的每個索引都必須恰好出現在一組裡，不可以遺漏、不可以重複。`;
}

function detailPrompt(name, text) {
  return `以下是撲克賽事系列「${name}」官網頁面的純文字（[link:...] 是連結，[img:...] 是圖片說明）。

請找出兩件事：
1. 主賽事（Main Event）的買入金額（buy-in）
2. 這個系列專屬頁面的網址

注意：
- 要的是 buy-in（買入費），不是保證獎池（GTD / guarantee / prize pool / 게런티）。獎池金額通常大很多，不要拿錯。
- 金額若寫成 33,000+3,000 這種「賽事費+行政費」，請加總成一個數字。
- me_buyin 只輸出數字；整頁找不到主賽事買入就輸出 null，不要猜。
- currency 用 ISO 代碼（TWD、JPY、KRW、USD、PHP、VND、MYR、HKD、SGD、THB、MOP、CNY、INR、EUR 等），找不到填空字串。
- handbook_url 填「這個系列自己的頁面」網址（從 [link:...] 取，例如 /series/xxx-2026）。找不到就填空字串，不要拿首頁充數。

頁面內容：
${text}`;
}

// ---------- Google Sheets ----------

function sheetsClient() {
  const creds = JSON.parse(SA_JSON);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function resolveTabName(client) {
  if (SHEET_TAB) return SHEET_TAB;
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
  });
  const title = res.data?.sheets?.[0]?.properties?.title;
  if (!title) throw new Error("讀不到試算表分頁名稱");
  return title;
}

async function getSheetRows(client, tab) {
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}!A1:Z10000`,
  });
  const values = res.data?.values ?? [];
  if (!values.length) throw new Error("分頁是空的（連標題列都沒有）");

  const headers = values[0].map((h) => String(h ?? "").trim());
  for (const h of REQUIRED_HEADERS) {
    if (!headers.includes(h)) {
      throw new Error(`分頁缺少必要欄位「${h}」— 是不是接錯分頁了？為安全起見中止，不寫入任何資料。`);
    }
  }

  const rows = values.slice(1).map((arr, i) => {
    const obj = { _row: i + 2 }; // 試算表實際列號（第 1 列是標題）
    headers.forEach((h, j) => (obj[h] = String(arr[j] ?? "").trim()));
    return obj;
  });
  return { headers, rows };
}

async function appendRows(client, tab, headers, newEvents) {
  const values = newEvents.map((ev) => headers.map((h) => ev[h] ?? ""));
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    method: "POST",
    data: { values },
  });
  return res.data?.updates?.updatedRows ?? 0;
}

// 改期更新：只改 Start Date / End Date 兩格，其他欄位一律不動
export function colLetter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

async function updateDateCells(client, tab, headers, changes) {
  const si = headers.indexOf("Start Date");
  const ei = headers.indexOf("End Date");
  const data = [];
  for (const c of changes) {
    data.push({
      range: `${tab}!${colLetter(si)}${c.row}`,
      values: [[c.newStart]],
    });
    data.push({
      range: `${tab}!${colLetter(ei)}${c.row}`,
      values: [[c.newEnd]],
    });
  }
  await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
    method: "POST",
    data: { valueInputOption: "RAW", data },
  });
  return changes.length;
}

// ---------- 驗證 ----------

export function validateEvent(ev, todayTs) {
  const s = parseYMD(ev["Start Date"]);
  const e = parseYMD(ev["End Date"]);
  if (String(ev.Tournament ?? "").trim().length < 3) return "名稱太短";
  if (s == null || e == null) return "日期格式不對";
  if (e < s) return "結束早於開始";
  if ((e - s) / 86400_000 > 60) return "賽期超過 60 天（可疑）";
  if (e < todayTs - HIDE_ENDED_AFTER_DAYS * 86400_000) return "已結束";
  const year = Number(String(ev["Start Date"]).slice(0, 4));
  const nowYear = Number(taipeiTodayYMD().slice(0, 4));
  if (year < nowYear - 1 || year > nowYear + 2) return "年份可疑";
  if (!String(ev.Location ?? "").trim()) return "沒有地點";
  if (/cancel|取消/i.test(ev.Tournament)) return "已取消";
  if (!passesGeoRule(ev)) return `地區不收（${ev.Location}）`;
  return null;
}

// ---------- 來源 ----------

async function loadSources() {
  const raw = JSON.parse(await readFile(path.join(__dirname, "sources.json"), "utf8"));
  const today = taipeiTodayYMD();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const blacklist = new RegExp(
    "(" + (raw.linkBlacklist ?? []).map((d) => d.replace(/\./g, "\\.")).join("|") + ")",
    "i",
  );

  const out = [];
  for (const src of raw.sources ?? []) {
    if (src.enabled === false) continue;
    const expand = (u) =>
      u
        .replaceAll("{TODAY+18M}", shiftYMD(today, 550))
        .replaceAll("{TODAY}", today)
        .replaceAll("{YEAR}", String(year));
    out.push({ ...src, url: expand(src.url) });
    // 11、12 月時順便看明年的年度日曆頁
    if (src.url.includes("{YEAR}") && month >= 11) {
      out.push({
        ...src,
        name: `${src.name} (${year + 1})`,
        url: src.url.replaceAll("{YEAR}", String(year + 1)),
      });
    }
  }
  out.sort((a, b) => a.tier - b.tier);
  return { sources: out, blacklist };
}

// 彙整站的連結不能用（會讓網站上的連結指回別人家）
export function cleanLink(url, blacklist) {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\//.test(u)) return "";
  if (blacklist.test(u)) return "";
  return u;
}

// tier 3 的 PokerCalendar.asia：The Events Calendar REST API，結構化資料，不需要 LLM
export function parseTribeEvents(json, blacklist) {
  return (json.events ?? []).map((e) => {
    const org = (e.organizer ?? [])[0];
    // 原生連結優先序：主辦官網 > 場館官網。API 自己的 e.url 是彙整站頁面，一律不用
    const native = cleanLink(org?.website || e.venue?.website || "", blacklist);
    const city = fixCity(e.venue?.city ?? "");
    const country = fixCountry(e.venue?.country ?? "");
    return {
      tournament: String(e.title ?? "").replace(/&#8211;|&#8212;/g, "-").replace(/&amp;/g, "&").trim(),
      start_date: String(e.start_date ?? "").slice(0, 10),
      end_date: String(e.end_date ?? "").slice(0, 10),
      location: [city, country].filter(Boolean).join(", "),
      detail_url: native,
    };
  });
}

async function collectFromSource(src, today, blacklist) {
  const body = await fetchPage(src.url);
  if (src.type === "json") return parseTribeEvents(JSON.parse(body), blacklist);

  const text = htmlToText(body, src.url);
  if (text.length < 300) throw new Error(`頁面內容太少（${text.length} 字元），可能被擋或改版`);
  await sleep(GEMINI_CALL_GAP_MS);
  return await geminiJSON(listingPrompt(src.name, today, text), LISTING_SCHEMA);
}

// ---------- 合併（三層優先序）----------

// LLM 分組：判斷哪些候選是同一場、哪些已存在於 Sheet
async function groupCandidates(candidates, sheetRows) {
  const groups = await geminiJSON(groupingPrompt(candidates, sheetRows), GROUPING_SCHEMA);

  const seen = new Set();
  const clean = [];
  for (const g of groups ?? []) {
    const idxs = (g.candidate_indexes ?? []).filter(
      (i) => Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i),
    );
    if (!idxs.length) continue;
    idxs.forEach((i) => seen.add(i));
    clean.push({ idxs, alreadyInSheet: !!g.already_in_sheet, matched: g.matched_sheet_row ?? "" });
  }
  // LLM 漏掉的索引：各自成一組，交給保守判定處理（寧可漏不要錯）
  const missed = candidates.map((_, i) => i).filter((i) => !seen.has(i));
  if (missed.length) {
    console.warn(`⚠️ LLM 分組漏了 ${missed.length} 筆，改用保守判定處理這幾筆`);
    for (const i of missed) clean.push({ idxs: [i], alreadyInSheet: null, matched: "" });
  }
  return clean;
}

// 一組候選 → 一筆列，每個欄位取 tier 最小且有值的來源
export function mergeGroup(group, candidates) {
  const rows = group.idxs.map((i) => candidates[i]).sort((a, b) => a._tier - b._tier);
  const out = { ...rows[0] };
  for (const f of ["Start Date", "End Date", "Location", "Tournament", "Handbook URL"]) {
    if (out[f]) continue;
    const donor = rows.find((r) => r[f]);
    if (donor) out[f] = donor[f];
  }
  out._srcs = rows.map((r) => `T${r._tier}:${r._src}`);
  out._bestTier = rows[0]._tier;
  return out;
}

// 把 LLM 給的 matched_sheet_row 對回實際那一列
export function findSheetRow(name, sheetRows) {
  const exact = sheetRows.filter((r) => r.Tournament === name);
  if (exact.length === 1) return exact[0];
  const scored = sheetRows
    .map((r) => ({ r, s: jaccard(r.Tournament, name) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s);
  return scored.length === 1 || (scored.length > 1 && scored[0].s > scored[1].s + 0.2)
    ? scored[0].r
    : null;
}

// 改期偵測：既有列的日期 vs 主辦方（tier 1/2）現在公布的日期
export function detectDateChange(merged, sheetRow) {
  if (!sheetRow) return null;
  if (merged._bestTier > 2) return null; // 只信主辦方與場館方，彙整站的日期不拿來改人工資料
  const changes = {};
  for (const [f, key] of [["Start Date", "newStart"], ["End Date", "newEnd"]]) {
    const oldTs = parseYMD(sheetRow[f]);
    const newTs = parseYMD(merged[f]);
    if (oldTs == null || newTs == null) return null;
    if (Math.abs(newTs - oldTs) > MAX_DATE_SHIFT_DAYS * 86400_000) return null; // 差太多，可能根本不是同一場
    if (oldTs !== newTs) changes[key] = merged[f];
  }
  if (!Object.keys(changes).length) return null;
  return {
    row: sheetRow._row,
    tournament: sheetRow.Tournament,
    oldStart: sheetRow["Start Date"],
    oldEnd: sheetRow["End Date"],
    newStart: changes.newStart ?? sheetRow["Start Date"],
    newEnd: changes.newEnd ?? sheetRow["End Date"],
    src: merged._srcs[0],
  };
}

// ---------- 主流程 ----------

async function main() {
  const { sources, blacklist } = await loadSources();

  if (TEST_FETCH) {
    // 不需要金鑰的連線測試：確認每個來源抓得到、文字量正常
    const outDir = path.join(__dirname, "..", ".scraper-test");
    await mkdir(outDir, { recursive: true });
    for (const src of sources) {
      try {
        const body = await fetchPage(src.url);
        const text = src.type === "json" ? body : htmlToText(body, src.url);
        const file = path.join(outDir, `T${src.tier}_${src.name.replace(/[^\w]+/g, "_")}.txt`);
        await writeFile(file, text, "utf8");
        console.log(`${text.length > 300 ? "✅" : "⚠️ "} T${src.tier} ${src.name}: ${text.length} 字元 → ${file}`);
      } catch (e) {
        console.log(`❌ T${src.tier} ${src.name}: ${e.message}`);
      }
    }
    return;
  }

  if (!GEMINI_API_KEY || !SA_JSON || !SHEET_ID) {
    console.log("ℹ️ 尚未設定 GEMINI_API_KEY / GOOGLE_SERVICE_ACCOUNT_JSON / SHEET_ID，跳過執行（見 scraper/SETUP.md）。");
    return; // exit 0：secrets 還沒設好前，排程不要一直報錯
  }

  const today = taipeiTodayYMD();
  const todayTs = parseYMD(today);

  const client = sheetsClient();
  const tab = await resolveTabName(client);
  const { headers, rows: existing } = await getSheetRows(client, tab);
  console.log(`Sheet 分頁「${tab}」現有 ${existing.length} 列\n`);

  // ── 第 1 段：各來源抽取（依 tier 由小到大）──
  const candidates = [];
  for (const src of sources) {
    let events;
    try {
      events = await collectFromSource(src, today, blacklist);
    } catch (e) {
      console.error(`❌ T${src.tier} ${src.name} 失敗：${e.message}`);
      continue; // 單一來源失敗不影響其他來源
    }
    let kept = 0;
    for (const ev of (events ?? []).slice(0, MAX_NEW_PER_SOURCE)) {
      const row = {
        "Start Date": String(ev.start_date ?? "").trim(),
        "End Date": String(ev.end_date ?? "").trim() || String(ev.start_date ?? "").trim(),
        "Location": String(ev.location ?? "").trim(),
        "Tournament": String(ev.tournament ?? "").trim(),
        "ME Buy-in": "",
        "Currency": "",
        "Handbook URL": cleanLink(ev.detail_url, blacklist),
        _tier: src.tier,
        _src: src.name.split(" ")[0],
      };
      if (validateEvent(row, todayTs)) continue;
      candidates.push(row);
      kept++;
    }
    console.log(`✅ T${src.tier} ${src.name}: 抽到 ${events?.length ?? 0} 筆，通過驗證 ${kept} 筆`);
  }

  if (!candidates.length) {
    console.log("\n所有來源都沒有抓到有效賽程，本次結束。");
    return;
  }
  console.log(`\n=== 候選合計 ${candidates.length} 筆，開始分組去重 ===`);

  // ── 第 2 段：LLM 分組 + 與 Sheet 去重 + 改期偵測 ──
  let groups;
  try {
    await sleep(GEMINI_CALL_GAP_MS);
    groups = await groupCandidates(candidates, existing);
  } catch (e) {
    console.warn(`⚠️ LLM 分組失敗（${e.message}），全部改用保守判定`);
    groups = candidates.map((_, i) => ({ idxs: [i], alreadyInSheet: null, matched: "" }));
  }

  const collected = [];
  const dateChanges = [];
  let skippedExisting = 0;
  for (const g of groups) {
    const row = mergeGroup(g, candidates);
    // alreadyInSheet === null 代表 LLM 沒判（漏了或整個失敗）→ 用保守判定
    const exists =
      g.alreadyInSheet === null ? isDuplicateConservative(row, existing) : g.alreadyInSheet;
    if (exists) {
      skippedExisting++;
      const chg = detectDateChange(row, findSheetRow(g.matched, existing));
      if (chg) dateChanges.push(chg);
      continue;
    }
    // 同批之間再擋一次，避免 LLM 分組沒抓到的重複
    if (collected.some((c) => isDuplicateConservative(row, [c]))) continue;
    collected.push(row);
  }
  console.log(`分成 ${groups.length} 場｜Sheet 已有 ${skippedExisting} 場｜準備新增 ${collected.length} 場`);

  // 改期報告（不論有沒有要新增都要印）
  if (dateChanges.length) {
    console.log(`\n=== ⚠️ 偵測到 ${dateChanges.length} 場日期與主辦方公布的不同 ===`);
    for (const c of dateChanges) {
      console.log(
        `  ${c.tournament}（第 ${c.row} 列）：${c.oldStart}~${c.oldEnd} → ${c.newStart}~${c.newEnd}  依據 ${c.src}`,
      );
    }
    if (!UPDATE_DATES) console.log("  （UPDATE_DATES 未開啟，只通知不修改；要自動更新請設 UPDATE_DATES=1）");
  }

  const toAppend = collected
    .sort((a, b) => a["Start Date"].localeCompare(b["Start Date"]))
    .slice(0, MAX_APPEND_TOTAL);
  if (collected.length > toAppend.length) {
    console.warn(`⚠️ 超過單次寫入上限，只寫前 ${MAX_APPEND_TOTAL} 筆，其餘下次再收`);
  }

  // ── 第 3 段：抓官網詳情頁補買入金額與專屬連結 ──
  if (toAppend.length) {
    console.log(`\n=== 補買入金額與原生連結（${toAppend.length} 筆）===`);
    for (const ev of toAppend) {
      const entry = ev["Handbook URL"];
      if (!entry) continue;
      try {
        const text = htmlToText(await fetchPage(entry), entry);
        if (text.length < 300) continue;
        await sleep(GEMINI_CALL_GAP_MS);
        const d = await geminiJSON(detailPrompt(ev.Tournament, text), DETAIL_SCHEMA);

        const buyin = Number(d?.me_buyin);
        if (Number.isFinite(buyin) && buyin > 0 && buyin < 100_000_000) {
          ev["ME Buy-in"] = String(buyin);
          ev["Currency"] = String(d?.currency ?? "").trim().toUpperCase();
        }
        // 專屬頁面連結只接受同網域的（避免被導到別的地方）
        const hb = cleanLink(d?.handbook_url, blacklist);
        const host = (u) => new URL(u).hostname.replace(/^www\./, "");
        if (hb && host(hb) === host(entry)) ev["Handbook URL"] = hb;
      } catch (e) {
        console.warn(`  詳情頁失敗（買入留白）：${ev.Tournament} — ${e.message}`);
      }
    }
  }

  // 有 Source 欄就標記 AI，方便在 Sheet 裡辨識
  const srcNote = new Map();
  for (const ev of toAppend) {
    srcNote.set(ev, ev._srcs);
    delete ev._tier;
    delete ev._src;
    delete ev._srcs;
    delete ev._bestTier;
    if (headers.includes("Source")) ev["Source"] = "AI";
  }

  console.log(`\n=== 準備寫入 ${toAppend.length} 筆 ===`);
  for (const ev of toAppend) {
    console.log(
      `  ${ev["Start Date"]} ~ ${ev["End Date"]} | ${ev.Location} | ${ev.Tournament} | ` +
        `${ev.Currency} ${ev["ME Buy-in"] || "-"} | ${ev["Handbook URL"] || "（連結留空）"}` +
        `  [${(srcNote.get(ev) ?? []).join(",")}]`,
    );
  }

  if (DRY_RUN) {
    console.log("\n（DRY_RUN 模式：以上只是預覽，沒有寫入 Sheet，也沒有更新任何日期）");
    return;
  }

  if (toAppend.length) {
    const written = await appendRows(client, tab, headers, toAppend);
    console.log(`\n✅ 已寫入 ${written} 列到分頁「${tab}」`);
  } else {
    console.log("\n沒有新賽程要寫入。");
  }

  if (UPDATE_DATES && dateChanges.length) {
    const n = await updateDateCells(client, tab, headers, dateChanges);
    console.log(`✅ 已更新 ${n} 場的日期（只改日期欄，其他欄位未動）`);
  }
}

// 只有被直接執行時才跑主流程；被 test.mjs import 時不跑
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((e) => {
    console.error("執行失敗：", e);
    process.exit(1);
  });
}
