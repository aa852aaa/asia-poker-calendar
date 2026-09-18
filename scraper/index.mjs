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

// 想換模型不必改 code：在 GitHub Secrets 或環境變數設 GEMINI_MODEL 即可
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const MAX_NEW_PER_SOURCE = 30; // 單一來源單次最多抽出筆數（防 LLM 幻覺灌爆表格）
const MAX_APPEND_TOTAL = 60; // 單次執行寫入總上限
const MAX_DATE_SHIFT_DAYS = 45; // 改期偵測：日期差超過這個天數就不當成同一場的改期，只報不改
// 額度相關的參數跟著模型走，所以做成環境變數（GitHub 的 repository variables），換模型不用改 code：
//   GEMINI_DAILY_LIMIT  該模型免費層的每日上限。gemini-3.6-flash 實測 20；gemini-3.5-flash-lite 是 500
//   MAX_DETAIL_CALLS    單輪最多抓幾個詳情頁補買入
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const GEMINI_DAILY_LIMIT = envInt("GEMINI_DAILY_LIMIT", 20);
const MAX_DETAIL_CALLS = envInt("MAX_DETAIL_CALLS", 20);
const DETAIL_LOOKAHEAD_DAYS = 90; // 既有列買入還是空的：只回頭抓「這幾天內開賽」的（報名費通常這時候才公布）
const BATCH_CHAR_LIMIT = 120_000; // 一批合併送給 LLM 的文字上限
const BATCH_MAX_SOURCES = 5; // 一批最多幾個來源
// 抽取和去重是必要的，詳情頁補買入是加值，所以額度快用完時先犧牲詳情頁。留 10% 餘裕給重試。
const GEMINI_DAILY_BUDGET = Math.max(4, Math.floor(GEMINI_DAILY_LIMIT * 0.9));
const LONG_FESTIVAL_DAYS = 21; // 超過這個天數就在預覽標 ⚠️ 提醒人看一眼（不擋，只提醒）
const CANCEL_MARK = "[已取消]"; // 來源公布取消時，加在既有列的賽事名稱前面（不刪除該列）
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
// 收錄範圍：西太平洋（東亞）+ 東南亞 + 澳洲（2026-09-16 Wei 加入）。依「賽事舉辦地點」判斷，
// 不是依巡迴賽名稱——WPT、EPT 這類國際巡迴賽只要辦在範圍內就收（WPT Seoul、WPT Cambodia 都收）。
// 唯一的地點例外是超大型賽事：夏季 WSOP（拉斯維加斯）與冬季 WSOP Paradise（巴哈馬）。
const ASIA_COUNTRIES = new Set([
  // 東亞 / 西太平洋
  "taiwan", "japan", "south korea", "korea", "north korea", "china",
  "hong kong", "macau", "macao", "mongolia",
  // 東南亞
  "philippines", "vietnam", "thailand", "malaysia", "singapore", "indonesia",
  "cambodia", "laos", "myanmar", "burma", "brunei", "timor-leste", "east timor",
  // 澳洲
  "australia",
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

// ---------- 真瀏覽器（Playwright）----------
// 有些站的內容靠 JS 載入，純 fetch 只拿到空殼（RPT 官網只有「Royal Poker」11 個字、KPC 只有導覽列）。
// sources.json 的 browserHosts 列出這些網域，列表抓取和詳情頁補買入都改用真瀏覽器。
// Playwright 用 dynamic import 延後載入：測試和大多數來源都不需要它。
let browserHosts = new Set();
let browserPromise = null;

export function needsBrowser(url, hosts = browserHosts) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return [...hosts].some((b) => h === b || h.endsWith("." + b));
  } catch {
    return false;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) => chromium.launch({ headless: true }));
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    (await browserPromise).close();
  } catch {
    /* 關不掉也無所謂，程式要結束了 */
  }
  browserPromise = null;
}

async function fetchWithBrowser(url) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // 等網路安靜下來代表 SPA 把資料拉完了；有些站一直有背景請求，等不到就算了，拿當下的內容
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
    return await page.content();
  } finally {
    await ctx.close();
  }
}

// ---------- 抓網頁 ----------

async function fetchPage(url, { json = false } = {}) {
  if (!json && needsBrowser(url)) return fetchWithBrowser(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en,zh-TW;q=0.9,ja;q=0.8,ko;q=0.7",
        // 有些網站的防護會擋掉沒帶 Accept 的請求（看起來像機器人）
        Accept: json
          ? "application/json, text/plain, */*"
          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// JSON 來源專用：PokerCalendar.asia 從 GitHub Actions 抓有時會回 HTML（從一般網路正常），
// 疑似機房 IP 被防護擋掉。重試一次，並把回傳內容的開頭記進 log 以便判斷是什麼擋的。
async function fetchJson(src) {
  let lastHead = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = await fetchPage(src.url, { json: true });
    try {
      return JSON.parse(body);
    } catch {
      lastHead = body.replace(/\s+/g, " ").slice(0, 300);
      console.warn(`  ${src.name} 回傳的不是 JSON（第 ${attempt} 次）：${lastHead}`);
      if (attempt < 2) await sleep(5_000);
    }
  }
  throw new Error(`連續兩次都不是 JSON，跳過這個來源。回傳開頭：${lastHead}`);
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

// 從 404 錯誤訊息裡找 Google 建議的接替模型。訊息長這樣：
//   "This model models/gemini-2.5-flash is no longer available to new users.
//    Please update your code to use models/gemini-3.6-flash ..."
// 取第一個和目前不同的 models/xxx。找不到就回 null（交給呼叫端丟錯）。
export function pickReplacementModel(errorText, currentModel) {
  const names = [...String(errorText).matchAll(/models\/([a-z0-9][a-z0-9.\-]*)/gi)].map((m) => m[1]);
  return names.find((n) => n !== currentModel) ?? null;
}

// 目前使用的模型。Google 下架舊模型時，404 的錯誤訊息會指名接替的模型，
// 遇到就自動換過去並記在 log——不必等人改 code 才能恢復。
// （2026-09-08 那次 gemini-2.5-flash 下架，15 個來源有 14 個一次全掛就是這樣來的）
let geminiModel = GEMINI_MODEL;
// 每日額度用完後，這輪剩下的呼叫直接放棄，不要每一筆都再空轉重試一次
// （上一輪就是這樣，每筆失敗要等 2 分鐘，整輪多花好幾分鐘還是拿不到東西）
let dailyQuotaGone = false;
let geminiCalls = 0; // 本輪已「嘗試」幾次（含失敗的），用來守住每日額度

// 429 分兩種：每分鐘上限（等一下就會恢復）和每日上限（今天不用再試了）。
// Google 會在錯誤內容裡寫是哪一種，看不出來時當成每分鐘、還可以再等。
export function isDailyQuotaError(raw) {
  return /per\s*day|perday|daily/i.test(String(raw));
}

async function geminiJSON(prompt, schema) {
  if (dailyQuotaGone) throw new Error("Gemini 今日額度已用完，本輪跳過");

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  // 每一次嘗試都算進每日 20 次額度——包括被 Google 自己 503 打回來的。
  // 2026-09-11 實測：兩輪合計 20 次嘗試（其中 9 次是 503 重試）就撞牆，一次成功的都沒多。
  // 所以計數放在發請求之前，不是成功之後。
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    geminiCalls++;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const raw = await res.text();
      if (isDailyQuotaError(raw) || attempt >= 2) {
        dailyQuotaGone = true;
        // 把 Google 回的原文留在 log 裡：才看得出撞到的是哪一個上限、額度多少
        console.warn(`  Gemini 額度訊息原文：${raw.replace(/\s+/g, " ").slice(0, 500)}`);
        throw new Error("Gemini 額度已用完（429），本輪後續呼叫全部跳過");
      }
      console.warn(`Gemini 429（每分鐘上限），等 60 秒後再試一次...`);
      await sleep(60_000);
      continue;
    }
    if (res.status >= 500) {
      // 503 是 Google 那邊過載，多等一點再試比較容易過；每次重試都燒額度，所以次數壓在 3
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`Gemini ${res.status}，等 60 秒後第 ${attempt + 1} 次嘗試...`);
        await sleep(60_000);
      }
      continue;
    }
    if (res.status === 404) {
      const raw = await res.text();
      const next = pickReplacementModel(raw, geminiModel);
      if (next) {
        console.warn(`⚠️ 模型 ${geminiModel} 已無法使用，依 Google 的建議自動改用 ${next}`);
        geminiModel = next;
        continue;
      }
      throw new Error(`Gemini HTTP 404: ${raw.slice(0, 300)}`);
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini 回應沒有內容");
    return JSON.parse(text);
  }
  throw new Error(`Gemini 連續 ${MAX_ATTEMPTS} 次都失敗（Google 那邊過載）`);
}

const LISTING_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      source_index: { type: "INTEGER", description: "這筆來自第幾個來源（0 起算）" },
      tournament: { type: "STRING" },
      start_date: { type: "STRING", description: "YYYY-MM-DD" },
      end_date: { type: "STRING", description: "YYYY-MM-DD" },
      location: { type: "STRING", description: "City, Country（英文）" },
      detail_url: { type: "STRING" },
      cancelled: { type: "BOOLEAN", description: "頁面上標示為取消就填 true" },
      me_buyin: { type: "NUMBER", nullable: true, description: "主賽事買入，列表上有寫才填" },
      currency: { type: "STRING", description: "買入的幣別 ISO 代碼" },
      buyin_evidence: { type: "STRING", description: "頁面上寫這個買入金額的那句原文，有填 me_buyin 就一定要填" },
    },
    required: ["source_index", "tournament", "start_date", "end_date", "location"],
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
    buyin_evidence: { type: "STRING", description: "頁面上寫這個買入金額的那句原文，有填 me_buyin 就一定要填" },
    handbook_url: { type: "STRING" },
  },
  required: [],
};

function listingPrompt(items, today) {
  const multi = items.length > 1;
  const blocks = items
    .map((it, i) => {
      // 固定場館的來源（CTP、WWP、PokerStars Live Manila…）頁面上常不重複寫地點，lite 模型不會從上下文推，
      // 所以在標頭直接告訴它。但場館站也會順便列別處的賽事（Manila 的站列了 APPT Korea），名稱寫了別處就照名稱。
      const hint = it.src.location
        ? `（這個來源的賽事預設都在 ${it.src.location}：頁面上沒寫地點的就填 "${it.src.location}"；賽事名稱本身寫了別的城市或國家的，照名稱填）`
        : "";
      return `===== 來源 ${i}：${it.src.name}${hint} =====\n${it.text}`;
    })
    .join("\n\n");

  return `你是資料抽取工具。以下是 ${items.length} 個撲克賽程網站列表頁的純文字${
    multi ? "，用「===== 來源 k：名稱 =====」這行分隔" : ""
  }。
標記說明：[link:網址] 是該處的連結；[img:文字] 是圖片的說明文字——有些網站把賽事名稱或日期只放在圖片說明裡，要一起看。

抽出所有「錦標賽系列」（festival / series，一整檔賽事節），每個系列一筆。
每一筆都要填 source_index，標明它來自上面第幾個來源（就是那個 k，從 0 開始數）。
不同來源的內容彼此獨立，不要混在一起，也不要把某個來源的賽事算到別的來源頭上。

地區規則（一律依「賽事舉辦地點」判斷，不要依巡迴賽的名稱判斷）：
- 要：東亞、東南亞、澳洲——台灣、日本、韓國、中國、香港、澳門、蒙古、菲律賓、越南、泰國、馬來西亞、新加坡、印尼、柬埔寨、寮國、緬甸、汶萊、澳洲。
- WPT、EPT、Triton 這類國際巡迴賽，只要辦在上述地點就要收（例如 WPT Seoul、WPT Cambodia、Triton Jeju 都要）。
- 不要：上述地點以外的——歐洲、美洲、紐西蘭、印度、斯里蘭卡、尼泊爾、中亞、土耳其、賽普勒斯等，即使是知名巡迴賽也不要。
- 只要「錦標賽系列」（一整檔賽事節）。每日／每週的例行賽程表（DAILY SCHEDULE、Weekly、每日賽）不是系列，不要輸出。
- 唯一的地點例外：「WSOP（世界撲克大賽本賽事，夏季拉斯維加斯）」和「WSOP Paradise（冬季巴哈馬）」這兩個即使不在上述地點也要收。

其他規則：
- 日期一律輸出 YYYY-MM-DD，年份要依上下文推斷正確。
- 只列「今天（${today}）當天或之後才結束」的系列；已結束的不要。
- 頁面上標示為取消的（CANCELLED / ***CANCELLED*** / 已取消 / 中止）**也要輸出**，但把 cancelled 設成 true，
  而且 tournament 要填「拿掉取消字樣之後的原始賽事名稱」（例如頁面寫「***CANCELLED*** Poker Dream 27 Jeju」，
  就填「Poker Dream 27 Jeju」）。沒有取消字樣的一律填 false。
- location 用英文「City, Country」格式，例如 "Taipei, Taiwan"、"Jeju, South Korea"。頁面上只有國家沒有城市時就只填國家。
- detail_url 填該系列詳情頁的完整網址（從 [link:...] 取），找不到就填空字串。
- 找不到的欄位填空字串，不要編造。頁面上沒有日期的系列就不要輸出。
- tournament 要能「單獨看懂」。列表上如果只寫短標題（例如「2026 Sapporo #02」），請從頁面標題或
  網站名稱找出所屬的巡迴賽／系列名稱補在前面（變成「JOPT 2026 Sapporo #02」）。
  這個名稱會單獨顯示在賽程表上，旁邊沒有任何說明。
- me_buyin：**列表上有明確寫出主賽事（Main Event）買入金額時才填**，只填數字，currency 填 ISO 代碼
  （TWD、JPY、KRW、USD、PHP、VND、MYR、HKD、SGD、THB、MOP、CNY、AUD 等）。
  ⚠️ 要的是 buy-in（買入費／報名費），**絕對不是保證獎池**（GTD / guarantee / prize pool / 保證獎金 /
  게런티 / 総額）——獎池通常大好幾個數量級，拿錯會讓表格完全失真。
  有填 me_buyin 就**一定要**在 buyin_evidence 填「頁面上寫這個金額的那句原文」（例如「主賽 Buy-in NT$33,000」）。
  原文裡如果是「保證獎金」「GTD」這類字，那就不是買入，me_buyin 填 null。分不清楚或頁面沒寫就填 null，絕對不要猜。

頁面內容：

${blocks}`;
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
- currency 用 ISO 代碼（TWD、JPY、KRW、USD、PHP、VND、MYR、HKD、SGD、THB、MOP、CNY、AUD、INR、EUR 等），找不到填空字串。
- 有填 me_buyin 就**一定要**在 buyin_evidence 填「頁面上寫這個金額的那句原文」。
  原文裡是「保證獎金」「GTD」「Prize Pool」這類字的話那不是買入，me_buyin 要填 null。
- handbook_url 填「這個系列自己的頁面」網址（從 [link:...] 取，例如 /series/xxx-2026）。找不到就填空字串，不要拿首頁充數。

頁面內容：
${text}`;
}

// ---------- Google Sheets ----------

// Google Sheets 的暫時性錯誤（連線被重置、逾時、5xx）要重試，不能整輪直接死掉。
// 2026-09-14 週一排程就是這樣：爬了 7 分鐘全部成功，最後寫入時一個 ECONNRESET 讓整輪 exit 1，
// 補到的買入沒寫進去，還寄了失敗信。權限錯誤（403）、資料錯誤（400）這類不是暫時性的，不重試。
const TRANSIENT_NET = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed/i;

export function isTransientSheetsError(e) {
  const status = e?.response?.status ?? (typeof e?.code === "number" ? e.code : undefined);
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  return TRANSIENT_NET.test(String(e?.message ?? "")) || TRANSIENT_NET.test(String(e?.code ?? ""));
}

async function withRetry(fn, label) {
  const waits = [5_000, 15_000, 30_000];
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientSheetsError(e) || attempt > waits.length) throw e;
      const wait = waits[attempt - 1];
      console.warn(`  Google Sheets 暫時性錯誤（${label}）：${String(e?.message ?? e).slice(0, 100)}，${wait / 1000} 秒後重試...`);
      await sleep(wait);
    }
  }
}

function sheetsClient() {
  const creds = JSON.parse(SA_JSON);
  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  // 所有對 Sheets 的呼叫都經過這裡，讀寫一律有重試
  return {
    request: (opts) => withRetry(() => jwt.request(opts), `${opts.method ?? "GET"} ${String(opts.url).split("/").pop().split("?")[0]}`),
  };
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

// 補空白：把指定格子填上值。呼叫端已經確認過那些格子原本是空的（Location 格式升級除外）
async function fillBlankCells(client, tab, headers, fills) {
  await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
    method: "POST",
    data: {
      valueInputOption: "RAW",
      data: fills.map((f) => ({
        range: `${tab}!${colLetter(headers.indexOf(f.col))}${f.row}`,
        values: [[f.value]],
      })),
    },
  });
  return fills.length;
}

// 取消註記：只在既有列的賽事名稱前加上標記，不刪除、不動其他欄位
async function annotateCancelled(client, tab, headers, changes) {
  const ti = headers.indexOf("Tournament");
  await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
    method: "POST",
    data: {
      valueInputOption: "RAW",
      data: changes.map((c) => ({
        range: `${tab}!${colLetter(ti)}${c.row}`,
        values: [[c.newName]],
      })),
    },
  });
  return changes.length;
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

// 取消的賽事不會被新增，只用來比對既有列然後加註記，所以驗證放寬：
// 只要名稱和日期站得住腳就好，不要求地點，也不套地區規則
// （彙整站對取消的場次常常連地點都不填，要求太嚴反而漏掉該註記的）。
// 每日／每週的例行賽程不是錦標賽系列。2026-09-16 GLPC 官網把「DAILY SCHEDULE 14.9---20.9」
// 列在 series 區，AI 照抄進來寫進了表格。
const RECURRING_NAME = /\bdaily\b|\bweekly\b|daily schedule|每日|每週|週賽/i;

export function validateEvent(ev, todayTs) {
  const s = parseYMD(ev["Start Date"]);
  const e = parseYMD(ev["End Date"]);
  if (String(ev.Tournament ?? "").trim().length < 3) return "名稱太短";
  if (RECURRING_NAME.test(ev.Tournament)) return "例行賽程不是錦標賽系列";
  if (s == null || e == null) return "日期格式不對";
  if (e < s) return "結束早於開始";
  if ((e - s) / 86400_000 > 60) return "賽期超過 60 天（可疑）";
  // 彙整站的年度日曆頁很雜，AI 偶爾把公告日期當成賽期（WSOP Paradise 被抽成 9/16 單日，
  // 實際是 12/1–12/18）。錦標賽系列不會只有一天，彙整站來的單日資料一律當誤讀。
  if (ev._tier === 3 && e === s) return "彙整站的單日賽事（可能誤讀日期）";
  if (e < todayTs - HIDE_ENDED_AFTER_DAYS * 86400_000) return "已結束";
  const year = Number(String(ev["Start Date"]).slice(0, 4));
  const nowYear = Number(taipeiTodayYMD().slice(0, 4));
  if (year < nowYear - 1 || year > nowYear + 2) return "年份可疑";
  if (ev._cancelled) return null;
  if (!String(ev.Location ?? "").trim()) return "沒有地點";
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
  browserHosts = new Set((raw.browserHosts ?? []).map((h) => String(h).toLowerCase().replace(/^www\./, "")));
  // 泛用連結集合（見 isGenericLink）：系列官網、來源列表頁、更正表左右兩邊的值
  const genericLinks = new Set();
  for (const e of raw.seriesLinks ?? []) genericLinks.add(normalizeLink(e.url));
  for (const s of raw.sources ?? []) genericLinks.add(normalizeLink(s.url));
  for (const [from, rule] of Object.entries(raw.linkFixes ?? {})) {
    genericLinks.add(normalizeLink(from));
    genericLinks.add(normalizeLink(typeof rule === "string" ? rule : rule?.to));
  }
  genericLinks.delete("");
  return { sources: out, blacklist, seriesLinks: raw.seriesLinks ?? [], linkFixes: raw.linkFixes ?? {}, genericLinks };
}

export function festivalDays(ev) {
  const s = parseYMD(ev["Start Date"]);
  const e = parseYMD(ev["End Date"]);
  return s == null || e == null ? 0 : Math.round((e - s) / 86400_000) + 1;
}

// Wei 手填的 Location 是雙語：「台灣 台北\nTaipei, Taiwan」、只有國家時是「馬來西亞 \nMalaysia」。
// 爬蟲原本只寫英文，混在表裡看起來很突兀，所以照他的格式補上中文。
const ZH_COUNTRY = {
  taiwan: ["台灣", "Taiwan"],
  japan: ["日本", "Japan"],
  "south korea": ["韓國", "Korea"], // Wei 的表寫「Korea」不是「South Korea」
  korea: ["韓國", "Korea"],
  philippines: ["菲律賓", "Philippines"],
  vietnam: ["越南", "Vietnam"],
  malaysia: ["馬來西亞", "Malaysia"],
  singapore: ["新加坡", "Singapore"],
  macau: ["澳門", "Macau"],
  "hong kong": ["香港", "Hong Kong"],
  thailand: ["泰國", "Thailand"],
  cambodia: ["柬埔寨", "Cambodia"],
  china: ["中國", "China"],
  indonesia: ["印尼", "Indonesia"],
  mongolia: ["蒙古", "Mongolia"],
  australia: ["澳洲", "Australia"],
  bahamas: ["巴哈馬", "Bahamas"],
  "united states": ["美國", "United States"],
};
const ZH_CITY = {
  taipei: "台北", "taipei city": "台北", kaohsiung: "高雄",
  jeju: "濟州島", incheon: "仁川", seoul: "首爾", busan: "釜山",
  manila: "馬尼拉", "metro manila": "馬尼拉", cebu: "宿霧", clark: "克拉克",
  hanoi: "河內", "ho chi minh city": "胡志明市", "ha long": "下龍灣", "phu quoc": "富國島", "da nang": "峴港",
  tokyo: "東京", osaka: "大阪", sapporo: "札幌", fukuoka: "福岡", nagoya: "名古屋", kyoto: "京都",
  "kuala lumpur": "吉隆坡", pahang: "彭亨", genting: "雲頂",
  cotai: "路氹", macau: "澳門", "hong kong": "香港", singapore: "新加坡",
  bangkok: "曼谷", "phnom penh": "金邊", sanya: "三亞", hengqin: "橫琴",
  paradise: "天堂島", "las vegas": "拉斯維加斯",
  // 澳洲：彙整站給的是郊區名，這裡對到大家認得的城市
  melbourne: "墨爾本", "south melbourne": "墨爾本", southbank: "墨爾本", "southbank, melbourne": "墨爾本",
  sydney: "雪梨", kogarah: "雪梨", revesby: "雪梨", kingsford: "雪梨", pyrmont: "雪梨",
  "st johns park": "雪梨", "st. johns park": "雪梨",
  "surfers paradise": "黃金海岸", "gold coast": "黃金海岸",
  brisbane: "布里斯本", "red hill": "布里斯本", townsville: "湯斯維爾",
  adelaide: "阿德雷德", "mawson lakes": "阿德雷德", perth: "伯斯", albury: "奧爾伯里",
};

// 列表頁本來就寫了買入金額時直接用，省下一次詳情頁的 LLM 呼叫（每日只有 20 次很珍貴）。
// 上限擋掉明顯是保證獎池被誤當成買入的情況（沒有主賽事買入是一億起跳的）。
// 2026-09-16 Win Win Poker 的「主賽保證獎金 $10,000,000 NTD」被 lite 模型當成買入寫進表格，
// 台北賽事直接顯示在網站上（TWD 10,000,000 ≈ $316,000）。提示詞早就警告過不要拿獎池，
// 光靠提示詞擋不住，所以加兩道程式防線：
//   1. 換算成美元的上限——Triton 的超高額買入也才 $100k–$250k，超過 $300k 一定是獎池
//   2. AI 必須附上「頁面上寫這個金額的那句原文」，那句話有獎池字樣、沒有買入字樣就不算
const ROUGH_USD_RATE = {
  USD: 1, TWD: 32, JPY: 155, KRW: 1380, PHP: 57, VND: 25500, MYR: 4.5, HKD: 7.8, SGD: 1.35,
  THB: 34, MOP: 8, CNY: 7.2, AUD: 1.5, NZD: 1.65, EUR: 0.92, GBP: 0.78, INR: 84, IDR: 15800, KHR: 4100,
};
const MAX_BUYIN_USD = 300_000;
const BUYIN_WORDS = /buy.?in|entry\s*fee|entry|買入|報名費|參賽費|バイイン|바이인/i;
const GTD_WORDS = /\bgtd\b|guarante|保證|保底|獎池|獎金|prize\s*pool|総額|賞金|게런티|보장|프라이즈/i;

export function pickBuyIn(ev) {
  const blank = { "ME Buy-in": "", Currency: "" };
  const n = Number(ev?.me_buyin);
  const ccy = String(ev?.currency ?? "").trim().toUpperCase();
  if (!Number.isFinite(n) || n <= 0 || !/^[A-Z]{3}$/.test(ccy)) return blank;

  const rate = ROUGH_USD_RATE[ccy];
  if (rate ? n / rate > MAX_BUYIN_USD : n >= 100_000_000) return blank;

  // 沒附原文的一律不信：這個數字會直接公開在網站上，寧可留白等下次
  const evidence = String(ev?.buyin_evidence ?? "").trim();
  if (!evidence) return blank;
  if (GTD_WORDS.test(evidence) && !BUYIN_WORDS.test(evidence)) return blank;

  return { "ME Buy-in": String(n), Currency: ccy };
}

export function formatLocation(location) {
  const raw = String(location ?? "").trim();
  if (!raw) return "";
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const countryEn = parts[parts.length - 1] ?? "";
  let cityEn = parts.length > 1 ? parts.slice(0, -1).join(", ") : "";
  // 城市國家同名（Singapore, Singapore／Macau, Macau）就當成只有國家，不要寫成「新加坡 新加坡」
  if (cityEn.toLowerCase() === countryEn.toLowerCase()) cityEn = "";

  const hit = ZH_COUNTRY[countryEn.toLowerCase()];
  if (!hit) return raw; // 對照表沒有的國家就原樣保留英文，不要生出半殘的雙語字串
  const [zhCountry, enCountry] = hit;
  const zhCity = ZH_CITY[cityEn.toLowerCase()] ?? "";

  const en = cityEn ? `${cityEn}, ${enCountry}` : enCountry;
  return `${zhCountry} ${zhCity}\n${en}`;
}

// 有些主辦站的列表只寫「2026 Sapporo #02」，品牌名放在頁面別處，抽出來的名稱單獨看不懂
// （放到網站上會變成一列「2026 Sapporo #02」）。來源設了 brand 就在缺品牌時補在前面。
export function applyBrand(name, brand) {
  const n = String(name ?? "").trim();
  if (!brand || !n) return n;
  const has = new RegExp(`(^|[^a-z0-9])${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
  return has.test(n) ? n : `${brand} ${n}`;
}

// 抓不到該場賽事的專屬連結時，用 sources.json 的 seriesLinks 補上主辦系列的官網。
// 依賴彙整站提供連結是錯的做法——彙整站一掛，整輪的連結就全空了（2026-09-10 就是這樣）。
// 同一個縮寫在不同地區指不同東西：APL 在澳洲是 Australian Poker League、在韓國是 Ace Poker League；
// APT 在澳洲是 Australian Poker Tour、在亞洲是 Asian Poker Tour。
// 對照表的項目可以設 country（字串或陣列），只在賽事地點的國家符合時才採用。有限定的要排在沒限定的前面。
function countryOf(location) {
  // 雙語格式是「中文\n英文」，國家取英文那行（最後一行）的最後一段
  const en = String(location ?? "").split("\n").pop() ?? "";
  const parts = en.split(",");
  return parts[parts.length - 1]?.trim().toLowerCase() ?? "";
}

export function seriesLink(tournament, seriesLinks, location = "") {
  const name = String(tournament ?? "");
  if (!name) return "";
  const country = countryOf(location);
  for (const entry of seriesLinks ?? []) {
    if (entry.country) {
      const allowed = (Array.isArray(entry.country) ? entry.country : [entry.country]).map((c) => c.toLowerCase());
      if (!allowed.includes(country)) continue;
    }
    for (const alias of entry.match ?? []) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(name)) return entry.url;
    }
  }
  return "";
}

// 彙整站的連結不能用（會讓網站上的連結指回別人家）
export function cleanLink(url, blacklist) {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\//.test(u)) return "";
  if (blacklist.test(u)) return "";
  return u;
}

// 連結比對用的正規化：不分大小寫、不管 http/https、不管 www.、不管結尾斜線
export function normalizeLink(url) {
  return String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

// 「泛用連結」＝系列官網首頁、來源列表頁、更正表裡的值——都不是某一場賽事的專屬頁。
// sources.json 載入時算出這個集合（loadSources）。既有列的連結若只是泛用連結，
// 主辦方這輪給了專屬頁就可以升級（detectBlankFills）；認的是「一模一樣」的值，Wei 手填的專屬連結不會中。
export function isGenericLink(url, genericLinks) {
  const n = normalizeLink(url);
  return !!n && (genericLinks ?? new Set()).has(n);
}

// 網址 → 主機名（不含 www.）；傳進來的本身就是主機名也行
export function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return String(u ?? "").trim().toLowerCase().replace(/^www\./, "");
  }
}

// 兩個網址（或主機名）是不是同一個網站：比對「可註冊網域」——poker-dream.com、events.japanopenpoker.com
// 和 japanopenpoker.com 算同一個；winwinpoker.com.tw 這種二級後綴要多留一段，不然所有 .com.tw 都會相同
export function sameDomain(a, b) {
  const base = (h) => {
    const parts = hostOf(h).split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    const sld = parts[parts.length - 2];
    const tld = parts[parts.length - 1];
    const twoLevel = /^(com|co|net|org|gov|edu|ac|or|ne)$/.test(sld) && tld.length === 2;
    return parts.slice(twoLevel ? -3 : -2).join(".");
  };
  const x = base(a);
  return !!x && x === base(b);
}

// tier 3 的 PokerCalendar.asia：The Events Calendar REST API，結構化資料，不需要 LLM
export function parseTribeEvents(json, blacklist) {
  return (json.events ?? []).map((e) => {
    const org = (e.organizer ?? [])[0];
    // 原生連結優先序：主辦官網 > 場館官網。API 自己的 e.url 是彙整站頁面，一律不用
    const native = cleanLink(org?.website || e.venue?.website || "", blacklist);
    const city = fixCity(e.venue?.city ?? "");
    const country = fixCountry(e.venue?.country ?? "");
    const rawTitle = String(e.title ?? "")
      .replace(/&#8211;|&#8212;/g, "-")
      .replace(/&amp;/g, "&")
      .trim();
    // PCA 用「***CANCELLED*** 賽事名」標記取消，把標記拆下來當旗標、名稱留乾淨的
    const { name, cancelled } = stripCancelMark(rawTitle);
    return {
      tournament: name,
      start_date: String(e.start_date ?? "").slice(0, 10),
      end_date: String(e.end_date ?? "").slice(0, 10),
      location: [city, country].filter(Boolean).join(", "),
      detail_url: native,
      cancelled,
    };
  });
}

// 把名稱裡的取消字樣拆下來，回傳乾淨名稱 + 是否取消
export function stripCancelMark(title) {
  const t = String(title ?? "").trim();
  // 只認完整的字：「Cancellation Policy」這種不會被誤判成取消
  const word = /\*{0,3}\s*(cancell?ed|已取消|中止)\s*\*{0,3}/i;
  if (!word.test(t)) return { name: t, cancelled: false };
  const name = t
    .replace(new RegExp(word.source, "gi"), " ")
    .replace(/[（([【]\s*[)）\]】]/g, " ") // 字樣拿掉後留下的空括號一起清掉
    .replace(/^[\s\-–—:：|]+|[\s\-–—:：|]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { name, cancelled: true };
}

async function fetchSourceText(src) {
  const body = await fetchPage(src.url);
  const text = htmlToText(body, src.url);
  if (text.length < 300) throw new Error(`頁面內容太少（${text.length} 字元），可能被擋或改版`);
  return text;
}

// 把多個網頁來源打包成幾批，一批一次 LLM 呼叫。
// Gemini 免費額度是以「呼叫次數」計的，而 T1 那些主辦站的頁面都很小（1,500–8,000 字），
// 一個一個送等於白白燒掉額度。合併後 15 次可以壓到 4 次左右。
// 單一來源本身就超過上限時會自己成一批（例如 SoMuchPoker 年度日曆 55,000 字）。
export function packBatches(items, charLimit = BATCH_CHAR_LIMIT, maxPerBatch = BATCH_MAX_SOURCES) {
  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const it of items) {
    const tooMany = cur.length >= maxPerBatch;
    const tooLong = curLen + it.text.length > charLimit;
    if (cur.length && (tooMany || tooLong)) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(it);
    curLen += it.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
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
  // 連結是哪個來源給的要記下來：升級既有列的泛用連結時，只信主辦方／場館方（tier 1、2）給的專屬頁
  let linkDonor = rows[0]["Handbook URL"] ? rows[0] : null;
  for (const f of ["Start Date", "End Date", "Location", "Tournament", "Handbook URL"]) {
    if (out[f]) continue;
    const donor = rows.find((r) => r[f]);
    if (!donor) continue;
    out[f] = donor[f];
    if (f === "Handbook URL") linkDonor = donor;
  }
  out._srcs = rows.map((r) => `T${r._tier}:${r._src}`);
  out._bestTier = rows[0]._tier;
  out._linkTier = linkDonor ? linkDonor._tier : Infinity;
  out._linkHost = linkDonor ? String(linkDonor._srcHost ?? "") : "";
  return out;
}

// 把 LLM 給的 matched_sheet_row 對回實際那一列
export function findSheetRow(name, sheetRows) {
  // 名稱是空的或太短就不要猜——空字串會去比對到表格裡的空白列，然後把註記寫進那一列。
  // （2026-09-09 真的發生過：LLM 分組失敗導致 matched 是空字串，結果第 16 列被寫進「[已取消]」）
  const target = String(name ?? "").trim();
  if (target.length < 3) return null;

  // 表格裡的空白列同樣不能當成比對對象
  const rows = sheetRows.filter((r) => String(r.Tournament ?? "").trim().length >= 3);

  const exact = rows.filter((r) => r.Tournament.trim() === target);
  if (exact.length === 1) return exact[0];

  const scored = rows
    .map((r) => ({ r, s: jaccard(r.Tournament, target) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s);
  return scored.length === 1 || (scored.length > 1 && scored[0].s > scored[1].s + 0.2)
    ? scored[0].r
    : null;
}

// 賽事的資訊是分批公布的：先出大概日期，兩三個月前才出賽程表和報名費。
// 所以第一次抓到的一定是最不完整的版本，之後每一輪都要回頭把空的欄位補上，
// 否則買入永遠空白——而買入正是網站顯示門檻的依據。
//
// 規則是「只補空白，不覆蓋」：Wei 手填的、或先前抓到的值一律保留。
// 唯一的例外是 Location 的格式升級（同一個地點，只是換成雙語寫法），
// 而且要先確認英文部分指的是同一個地方才換。
const CJK = /[一-鿿]/;

function sameePlace(a, b) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/south korea/g, "korea")
      .replace(/[^a-z]/g, "");
  return norm(a) === norm(b) && norm(a).length > 0;
}

export function detectBlankFills(merged, sheetRow, genericLinks = new Set()) {
  if (!sheetRow) return [];
  const blank = (v) => String(v ?? "").trim() === "";
  const fills = [];

  // 買入和幣別要嘛一起補、要嘛都不補——只有金額沒幣別換算不了
  if (blank(sheetRow["ME Buy-in"]) && !blank(merged["ME Buy-in"]) && !blank(merged.Currency)) {
    fills.push({ col: "ME Buy-in", value: merged["ME Buy-in"] });
    if (blank(sheetRow.Currency)) fills.push({ col: "Currency", value: merged.Currency });
  }

  const oldLink = String(sheetRow["Handbook URL"] ?? "").trim();
  const newLink = String(merged["Handbook URL"] ?? "").trim();
  if (!oldLink && newLink) {
    fills.push({ col: "Handbook URL", value: newLink });
  } else if (
    // 連結升級：表上那格只是系列首頁這種泛用連結（seriesLinks 補的、或以前寫錯的），而主辦方／場館方
    // 這輪給了該場賽事的專屬頁 → 換成專屬頁。專屬頁才有賽程和買入，詳情頁抓買入靠的就是它
    // （2026-09-19：Poker Dream 26、Manila Super Series 24 的買入官網都有，就是卡在連結只到首頁）。
    // 三個條件缺一不可：舊的認得出來是泛用連結（一模一樣才算，Wei 手填的專屬連結不會中）、
    // 新的來自 tier 1/2、新的跟來源網站或舊連結同一個網站（防 AI 從頁面上撿到贊助商之類的連結）。
    oldLink &&
    newLink &&
    normalizeLink(oldLink) !== normalizeLink(newLink) &&
    isGenericLink(oldLink, genericLinks) &&
    !isGenericLink(newLink, genericLinks) &&
    (merged._linkTier ?? Infinity) <= 2 &&
    (sameDomain(newLink, merged._linkHost) || sameDomain(newLink, oldLink))
  ) {
    fills.push({ col: "Handbook URL", value: newLink, why: "升級為專屬連結" });
  }

  // 舊列是純英文地點時升級成雙語。只有在確認指的是同一個地方時才換。
  // merged 這時候還是英文（雙語轉換只在寫入新列前做），所以這裡自己轉一次
  const oldLoc = String(sheetRow.Location ?? "");
  const newLoc = formatLocation(merged.Location);
  if (oldLoc.trim() && !CJK.test(oldLoc) && CJK.test(newLoc)) {
    const enHalf = newLoc.split("\n").pop() ?? "";
    if (sameePlace(oldLoc, enHalf)) fills.push({ col: "Location", value: newLoc });
  }

  return fills.map((f) => ({ ...f, row: sheetRow._row, tournament: sheetRow.Tournament }));
}

// 詳情頁要抓哪些：新增的列優先，再來是既有列裡買入還是空的、3 個月內開賽的（越快開賽越前面）。
// 既有列用的是它自己那格的連結（或這輪剛排入要補的連結），不需要跟候選比對，所以沒有對錯列的風險。
export function detailTargets(toAppend, existing, blankFills, todayTs) {
  const blank = (v) => String(v ?? "").trim() === "";
  const fresh = toAppend
    .filter((ev) => !blank(ev["Handbook URL"]) && blank(ev["ME Buy-in"]))
    .map((ev) => ({ kind: "new", ev, url: ev["Handbook URL"], name: ev.Tournament }));

  const horizon = todayTs + DETAIL_LOOKAHEAD_DAYS * 86400_000;
  const notEnded = todayTs - HIDE_ENDED_AFTER_DAYS * 86400_000;
  const pendingUrl = (row) =>
    blankFills.find((f) => f.row === row._row && f.col === "Handbook URL")?.value ?? "";

  const soon = existing
    .filter((r) => blank(r["ME Buy-in"]) && !String(r.Tournament ?? "").includes(CANCEL_MARK))
    .map((r) => ({ r, s: parseYMD(r["Start Date"]), e: parseYMD(r["End Date"]) }))
    .filter(({ s, e }) => s != null && s <= horizon && (e ?? s) >= notEnded)
    .sort((a, b) => a.s - b.s)
    .map(({ r }) => ({
      kind: "existing",
      row: r,
      // 這輪剛排入要改的連結（更正錯值／升級成專屬頁／補空白）一定比表上現有的好，優先用它抓詳情頁
      url: pendingUrl(r) || String(r["Handbook URL"] ?? "").trim(),
      name: r.Tournament,
    }))
    .filter((t) => /^https?:\/\//.test(t.url));

  return [...fresh, ...soon];
}

// ---------- 待補清單 ----------
// 爬蟲補不到的買入，整理成一份清單寫進 Sheet 的「AI_待補」分頁，讓 Wei 照清單人工填。
// 把「找」的工作自動化、「填」的工作留給人——這是抓不到的資料的兜底。
// 在主分頁填好買入，下一輪這一列就會從清單消失。
const TODO_TAB = "AI_待補";
// 這些網域人機驗證或要登入，爬蟲永遠抓不到，清單上直接講明要人工
const MANUAL_ONLY_HOSTS = /facebook\.com|pokerdream-live\.com|thehendonmob\.com/i;

export function buildTodoList(existing, blankFills, detailOutcome, todayTs) {
  const blank = (v) => String(v ?? "").trim() === "";
  const filledNow = new Set(blankFills.filter((f) => f.col === "ME Buy-in").map((f) => f.row));
  const pendingLink = (r) => blankFills.find((f) => f.row === r._row && f.col === "Handbook URL")?.value ?? "";
  const notEnded = todayTs - HIDE_ENDED_AFTER_DAYS * 86400_000;
  const horizon = todayTs + DETAIL_LOOKAHEAD_DAYS * 86400_000;

  const out = [];
  for (const r of existing) {
    if (!blank(r["ME Buy-in"]) || filledNow.has(r._row)) continue;
    if (String(r.Tournament ?? "").includes(CANCEL_MARK)) continue;
    const s = parseYMD(r["Start Date"]);
    const e = parseYMD(r["End Date"]) ?? s;
    if (s == null || e == null || e < notEnded) continue;

    const link = String(r["Handbook URL"] ?? "").trim() || pendingLink(r);
    let why;
    if (!link) why = "沒有官網連結，無從抓取——請補連結或直接填買入";
    else if (MANUAL_ONLY_HOSTS.test(link)) why = "官網有人機驗證或要登入，爬蟲抓不到——請人工查";
    else if (detailOutcome.has(r._row)) why = detailOutcome.get(r._row) || "";
    else if (s > horizon) why = `開賽還早（超過 ${DETAIL_LOOKAHEAD_DAYS} 天），之後會自動抓`;
    else why = "本輪沒輪到，下次再試";
    if (why === "") continue; // 這輪補到了

    out.push({
      row: r._row,
      tournament: r.Tournament,
      start: r["Start Date"],
      location: String(r.Location ?? "").split("\n")[0].trim(),
      link,
      why,
    });
  }
  out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return out;
}

async function ensureTab(client, title) {
  const meta = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`,
  });
  const titles = (meta.data?.sheets ?? []).map((s) => s.properties?.title);
  if (titles.includes(title)) return;
  await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    method: "POST",
    data: { requests: [{ addSheet: { properties: { title } } }] },
  });
  console.log(`  已建立分頁「${title}」`);
}

async function writeTodoTab(client, todo, when) {
  await ensureTab(client, TODO_TAB);
  const range = encodeURIComponent(TODO_TAB);
  const header = [
    [`此分頁由爬蟲每輪重寫（${when}），請勿在這裡填資料。在「主分頁」填好買入，下一輪這一列就會消失。`],
    [],
    ["主分頁列號", "開始", "賽事", "地點", "官網連結", "為什麼抓不到"],
  ];
  const body = todo.map((t) => [t.row, t.start, t.tournament, t.location, t.link, t.why]);
  await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}!A1:Z1000:clear`,
    method: "POST",
  });
  await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}!A1?valueInputOption=RAW`,
    method: "PUT",
    data: { values: [...header, ...body] },
  });
  return body.length;
}

// 爬蟲以前寫錯、後來查明的連結（sources.json 的 linkFixes）：既有列的 Handbook URL
// 完全等於已知錯值時換成正確的。這不需要跟候選比對——掃整張表，只認「一模一樣」的值，
// 所以 Wei 手填的連結不會被誤改。（RPT 的 royalpokerclub.vn → FB 粉專 就是第一個案例）
// 更正的值可以是字串（無條件）或 { to, ifCountry }（只對特定國家的列）：
// 例如 acepokerleague.com 對韓國的 APL 是對的、對澳洲的 APL 是錯的，只能更正澳洲那幾列。
export function detectLinkFixes(existing, linkFixes) {
  const map = new Map(Object.entries(linkFixes ?? {}).map(([k, v]) => [k.trim(), v]));
  if (!map.size) return [];
  const out = [];
  for (const r of existing) {
    const cur = String(r["Handbook URL"] ?? "").trim();
    const rule = map.get(cur);
    if (!rule) continue;
    const to = typeof rule === "string" ? rule : rule.to;
    if (!to || to === cur) continue;
    if (typeof rule === "object" && rule.ifCountry) {
      const want = (Array.isArray(rule.ifCountry) ? rule.ifCountry : [rule.ifCountry]).map((c) => c.toLowerCase());
      if (!want.includes(countryOf(r.Location))) continue;
    }
    out.push({ row: r._row, tournament: r.Tournament, col: "Handbook URL", value: to, why: "更正錯連結" });
  }
  return out;
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
  const { sources, blacklist, seriesLinks, linkFixes, genericLinks } = await loadSources();

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
  console.log(`Sheet 分頁「${tab}」現有 ${existing.length} 列`);
  console.log(`模型 ${GEMINI_MODEL}｜每日上限 ${GEMINI_DAILY_LIMIT}（守門 ${GEMINI_DAILY_BUDGET}）｜詳情頁上限 ${MAX_DETAIL_CALLS}\n`);

  // ── 第 1 段：各來源抽取 ──
  const candidates = [];
  const tally = new Map(); // src -> { raw, kept }

  const addEvents = (src, events) => {
    const t = tally.get(src) ?? { raw: 0, kept: 0, why: new Map() };
    for (const ev of events ?? []) {
      t.raw++;
      if (t.kept >= MAX_NEW_PER_SOURCE) continue; // 單一來源上限，防 LLM 幻覺灌爆表格
      // 先補品牌再拿去比對系列連結——JOPT 的原始名稱是「2026 Sapporo #02」，
      // 補成「JOPT 2026 Sapporo #02」之後才對得到 japanopenpoker.com
      const name = applyBrand(ev.tournament, src.brand);
      const row = {
        "Start Date": String(ev.start_date ?? "").trim(),
        "End Date": String(ev.end_date ?? "").trim() || String(ev.start_date ?? "").trim(),
        // 有些主辦站每場賽事不重複寫城市（都在同一個場館），AI 不一定會從上下文推；來源可以設預設地點
        "Location": String(ev.location ?? "").trim() || String(src.location ?? "").trim(),
        "Tournament": name,
        ...pickBuyIn(ev),
        // 優先用該場賽事的專屬連結；沒有就退回主辦系列官網；再沒有才留空
        "Handbook URL":
          cleanLink(ev.detail_url, blacklist) ||
          seriesLink(name, seriesLinks, String(ev.location ?? "").trim() || String(src.location ?? "")),
        _tier: src.tier,
        _src: src.name.split(" ")[0],
        _srcHost: hostOf(src.url), // 連結升級時用來確認專屬頁真的在這個來源的網站上
        _cancelled: ev.cancelled === true,
      };
      const bad = validateEvent(row, todayTs);
      if (bad) {
        // 記下被退回的原因，log 才看得出「抽到 6 筆通過 0 筆」是為什麼
        const key = bad.replace(/（.*$/, "");
        t.why.set(key, (t.why.get(key) ?? 0) + 1);
        continue;
      }
      candidates.push(row);
      t.kept++;
    }
    tally.set(src, t);
  };

  // JSON 來源（PokerCalendar.asia）：結構化資料直接解析，完全不用 LLM
  for (const src of sources.filter((s) => s.type === "json")) {
    try {
      addEvents(src, parseTribeEvents(await fetchJson(src), blacklist));
    } catch (e) {
      console.error(`❌ T${src.tier} ${src.name} 失敗：${e.message}`);
    }
  }

  // 網頁來源：先全部抓下來，再打包成幾批一起送 LLM——Gemini 免費額度是按呼叫次數算的
  const fetched = [];
  for (const src of sources.filter((s) => s.type === "html")) {
    try {
      fetched.push({ src, text: await fetchSourceText(src) });
    } catch (e) {
      console.error(`❌ T${src.tier} ${src.name} 抓取失敗：${e.message}`);
    }
  }
  const batches = packBatches(fetched);
  if (fetched.length) {
    console.log(
      `網頁來源 ${fetched.length} 個 → 併成 ${batches.length} 批送 AI（省下 ${fetched.length - batches.length} 次呼叫）`,
    );
  }

  for (const [i, batch] of batches.entries()) {
    const names = batch.map((b) => b.src.name).join("、");
    try {
      await sleep(GEMINI_CALL_GAP_MS);
      const events = (await geminiJSON(listingPrompt(batch, today), LISTING_SCHEMA)) ?? [];

      // 依 source_index 分派回各來源。標不出來的算給這批裡最不權威的（tier 數字最大）那個，
      // 免得彙整站的資料被誤當成主辦方的、在合併時蓋掉正確值。
      const fallback = batch.reduce((a, b) => (b.src.tier > a.src.tier ? b : a)).src;
      const bucket = new Map(batch.map((it) => [it.src, []]));
      let misrouted = 0;
      for (const ev of events) {
        const it = batch[ev?.source_index];
        if (!it) misrouted++;
        bucket.get(it?.src ?? fallback)?.push(ev);
      }
      if (misrouted) console.warn(`  ⚠️ 第 ${i + 1} 批有 ${misrouted} 筆沒標明來源，算到「${fallback.name}」`);
      for (const [src, evs] of bucket) addEvents(src, evs);
    } catch (e) {
      console.error(`❌ 第 ${i + 1} 批失敗（${names}）：${e.message}`);
    }
  }

  for (const src of sources) {
    const t = tally.get(src);
    if (!t) continue;
    const why = [...t.why.entries()].map(([k, n]) => `${k} ×${n}`).join("、");
    console.log(`✅ T${src.tier} ${src.name}: 抽到 ${t.raw} 筆，通過驗證 ${t.kept} 筆${why ? `（退回：${why}）` : ""}`);
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
  const cancellations = [];
  // 先掃一遍已知錯連結的更正（不需要候選比對），後面的補空白會接著往這個陣列加
  const blankFills = detectLinkFixes(existing, linkFixes);
  let skippedExisting = 0;
  let skippedCancelled = 0;
  for (const g of groups) {
    const rows = g.idxs.map((i) => candidates[i]);
    const row = mergeGroup(g, candidates);
    // alreadyInSheet === null 代表 LLM 沒判（漏了或整個失敗）→ 用保守判定
    const exists =
      g.alreadyInSheet === null ? isDuplicateConservative(row, existing) : g.alreadyInSheet;
    const sheetRow = exists ? findSheetRow(g.matched, existing) : null;

    // 取消的判定也照 tier 優先序：主辦官網還在列這場，就不採信彙整站說的取消
    const minCancelTier = Math.min(...rows.filter((r) => r._cancelled).map((r) => r._tier), Infinity);
    const minActiveTier = Math.min(...rows.filter((r) => !r._cancelled).map((r) => r._tier), Infinity);

    if (minCancelTier <= minActiveTier) {
      skippedCancelled++;
      // 取消的一律不新增；已經在表上的就加註記，那一列本身不動也不刪。
      // 三道防線：LLM 沒真的判過就不動表格、目標列必須有賽事名、同一列只寫一次。
      const judged = g.alreadyInSheet !== null;
      const named = sheetRow && String(sheetRow.Tournament ?? "").trim().length >= 3;
      const done = sheetRow && cancellations.some((c) => c.row === sheetRow._row);
      if (judged && named && !done && !String(sheetRow.Tournament).includes(CANCEL_MARK)) {
        const said = rows.find((r) => r._cancelled && r._tier === minCancelTier);
        cancellations.push({
          row: sheetRow._row,
          oldName: sheetRow.Tournament,
          newName: `${CANCEL_MARK} ${sheetRow.Tournament}`.trim(),
          src: `T${said._tier}:${said._src}`,
        });
      }
      continue;
    }
    if (exists) {
      skippedExisting++;
      // 同樣的道理：LLM 沒真的判過（走保守退路）就沒有可靠的對應列，不要去改表格
      if (g.alreadyInSheet !== null) {
        const chg = detectDateChange(row, sheetRow);
        if (chg && !dateChanges.some((c) => c.row === chg.row)) dateChanges.push(chg);
        // 賽程表和報名費是後來才公布的，每輪都回頭補一次空欄位
        for (const f of detectBlankFills(row, sheetRow, genericLinks)) {
          const i = blankFills.findIndex((x) => x.row === f.row && x.col === f.col);
          if (i < 0) blankFills.push(f);
          // 同一格已經排了「更正錯連結」（換成另一個泛用連結）時，主辦方給的專屬頁更好，用專屬頁蓋掉
          else if (f.why === "升級為專屬連結" && blankFills[i].why === "更正錯連結") blankFills[i] = f;
        }
      }
      continue;
    }
    // 同批之間再擋一次，避免 LLM 分組沒抓到的重複
    if (collected.some((c) => isDuplicateConservative(row, [c]))) continue;
    collected.push(row);
  }
  console.log(
    `分成 ${groups.length} 場｜Sheet 已有 ${skippedExisting} 場｜已取消 ${skippedCancelled} 場｜準備新增 ${collected.length} 場`,
  );

  if (blankFills.length) {
    console.log(`\n=== 📝 補上既有列的 ${blankFills.length} 個空欄位（只補空的，不覆蓋已填的）===`);
    for (const f of blankFills) {
      const why = f.why ? `（${f.why}）` : "";
      console.log(`  第 ${f.row} 列 ${f.tournament}｜${f.col} ← ${String(f.value).replace(/\n/g, " / ")}${why}`);
    }
  }

  if (cancellations.length) {
    console.log(`\n=== 🚫 偵測到 ${cancellations.length} 場已取消，在表上加註記（不刪除該列）===`);
    for (const c of cancellations) {
      console.log(`  第 ${c.row} 列：「${c.oldName}」→「${c.newName}」  依據 ${c.src}`);
    }
  }

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
  // 這段是加值，不是必要：抓不到就讓買入留白，絕不影響前面已經確定的賽事資料。
  // 目標有兩種，共用同一個額度：
  //   1. 這輪要新增的列（優先）
  //   2. 既有列裡買入還是空的、而且 3 個月內開賽的——報名費通常就是這時候公布，
  //      第一次抓到時還沒有，不回頭抓就永遠是空的
  const targets = detailTargets(toAppend, existing, blankFills, todayTs);
  // 每一筆既有列的結果：row → 原因字串（空字串 = 補到了）。給後面的「待補清單」用
  const detailOutcome = new Map();
  if (targets.length) {
    const nNew = targets.filter((t) => t.kind === "new").length;
    console.log(`\n=== 補買入金額與原生連結（新增 ${nNew} 筆 + 既有列 ${targets.length - nNew} 筆）===`);
    let detailCalls = 0;
    const host = (u) => new URL(u).hostname.replace(/^www\./, "");
    let stopped = "";
    for (const t of targets) {
      if (dailyQuotaGone) stopped = "本輪額度用完，下次再試";
      else if (detailCalls >= MAX_DETAIL_CALLS) stopped = `本輪已抓 ${MAX_DETAIL_CALLS} 筆詳情頁，下次再試`;
      else if (geminiCalls >= GEMINI_DAILY_BUDGET) stopped = "本輪額度用完，下次再試";
      if (stopped) {
        if (t.kind === "existing") detailOutcome.set(t.row._row, stopped);
        continue;
      }
      try {
        const text = htmlToText(await fetchPage(t.url), t.url);
        if (text.length < 300) {
          if (t.kind === "existing") detailOutcome.set(t.row._row, "官網頁面是空殼（內容靠 JS，尚未列入瀏覽器名單）");
          continue;
        }
        await sleep(GEMINI_CALL_GAP_MS);
        detailCalls++;
        const d = await geminiJSON(detailPrompt(t.name, text), DETAIL_SCHEMA);

        const got = pickBuyIn(d);
        // 專屬頁面連結只接受同網域的（避免被導到別的地方）
        const hb = cleanLink(d?.handbook_url, blacklist);
        const deeper = hb && host(hb) === host(t.url) && hb !== t.url ? hb : "";

        if (t.kind === "new") {
          if (got["ME Buy-in"]) Object.assign(t.ev, got);
          if (deeper) t.ev["Handbook URL"] = deeper;
        } else {
          // 既有列：只補空的。買入和幣別一起補；連結只在表上那格還是空的時候補（含這輪剛排入的）
          const add = (col, value) => {
            const i = blankFills.findIndex((f) => f.row === t.row._row && f.col === col);
            const entry = { row: t.row._row, tournament: t.row.Tournament, col, value };
            if (i >= 0) blankFills[i] = entry;
            else blankFills.push(entry);
          };
          if (got["ME Buy-in"]) {
            add("ME Buy-in", got["ME Buy-in"]);
            add("Currency", got.Currency);
            detailOutcome.set(t.row._row, "");
            console.log(`  📝 第 ${t.row._row} 列 ${t.row.Tournament}｜買入 ← ${got.Currency} ${got["ME Buy-in"]}`);
          } else {
            detailOutcome.set(t.row._row, "官網頁面沒列主賽買入");
          }
          // 詳情頁若指出更深一層的專屬頁，表上那格是空的、或只是泛用連結（系列首頁）時就換成專屬頁
          const current =
            blankFills.find((f) => f.row === t.row._row && f.col === "Handbook URL")?.value ??
            String(t.row["Handbook URL"] ?? "").trim();
          if (deeper && (!current || isGenericLink(current, genericLinks))) add("Handbook URL", deeper);
        }
      } catch (e) {
        const why = /HTTP 40[13]|HTTP 5|fetch failed|ECONN|aborted|timeout/i.test(e.message)
          ? `從 GitHub 連不上官網（${e.message.slice(0, 40)}），可能擋機房 IP`
          : `抓取失敗（${e.message.slice(0, 60)}）`;
        if (t.kind === "existing") detailOutcome.set(t.row._row, why);
        console.warn(`  詳情頁失敗（買入留白）：${t.name} — ${e.message}`);
      }
    }
    if (stopped) console.warn(`  ${stopped}`);
  }

  // 有 Source 欄就標記 AI，方便在 Sheet 裡辨識
  const srcNote = new Map();
  for (const ev of toAppend) {
    srcNote.set(ev, ev._srcs);
    // 地點改成 Wei 手填的雙語格式。放在最後才轉，因為地區規則和去重都是用英文比對的
    ev.Location = formatLocation(ev.Location);
    delete ev._tier;
    delete ev._src;
    delete ev._srcs;
    delete ev._srcHost;
    delete ev._bestTier;
    delete ev._linkTier;
    delete ev._linkHost;
    if (headers.includes("Source")) ev["Source"] = "AI";
  }

  console.log(`\n=== 準備寫入 ${toAppend.length} 筆 ===`);
  const longOnes = toAppend.filter((ev) => festivalDays(ev) > LONG_FESTIVAL_DAYS);
  for (const ev of toAppend) {
    const mark = festivalDays(ev) > LONG_FESTIVAL_DAYS ? "⚠️" : " ";
    console.log(
      `${mark} ${ev["Start Date"]} ~ ${ev["End Date"]} | ${ev.Location} | ${ev.Tournament} | ` +
        `${ev.Currency} ${ev["ME Buy-in"] || "-"} | ${ev["Handbook URL"] || "（連結留空）"}` +
        `  [${(srcNote.get(ev) ?? []).join(",")}]`,
    );
  }
  if (longOnes.length) {
    console.log(
      `\n⚠️ 上面標記的 ${longOnes.length} 場賽期超過 ${LONG_FESTIVAL_DAYS} 天，可能是來源網站的月曆被誤讀成賽期，` +
        `建議進 Sheet 看一眼：${longOnes.map((e) => e.Tournament).join("、")}`,
    );
  }

  // 待補清單：主分頁裡買入還是空的、還沒結束的，連同「為什麼抓不到」
  const todo = buildTodoList(existing, blankFills, detailOutcome, todayTs);
  if (todo.length) {
    console.log(`\n=== 📋 待人工補買入 ${todo.length} 筆（會寫到分頁「${TODO_TAB}」）===`);
    for (const t of todo) console.log(`  第 ${t.row} 列 ${t.start} ${t.tournament}｜${t.why}`);
  }

  if (DRY_RUN) {
    console.log("\n（DRY_RUN 模式：以上只是預覽，沒有寫入 Sheet，也沒有補空欄位、更新日期、加取消註記或寫待補清單）");
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

  if (cancellations.length) {
    const n = await annotateCancelled(client, tab, headers, cancellations);
    console.log(`✅ 已為 ${n} 場加上「${CANCEL_MARK}」註記（該列保留，其他欄位未動）`);
  }

  if (blankFills.length) {
    const n = await fillBlankCells(client, tab, headers, blankFills);
    console.log(`✅ 已補上 ${n} 個空欄位（原本有值的一個都沒動）`);
  }

  // 待補清單每輪重寫（它是爬蟲自己的分頁，不是使用者資料；清單空了也要寫，讓舊的消失）
  try {
    const when = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    const n = await writeTodoTab(client, todo, when);
    console.log(`✅ 待補清單已更新到分頁「${TODO_TAB}」：${n} 筆`);
  } catch (e) {
    // 清單寫不進去不該讓整輪失敗——主要工作都已經完成了
    console.warn(`⚠️ 待補清單寫入失敗（不影響其他結果）：${e.message}`);
  }
}

// 只有被直接執行時才跑主流程；被 test.mjs import 時不跑
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main()
    .catch((e) => {
      console.error("執行失敗：", e);
      process.exitCode = 1;
    })
    .finally(closeBrowser); // 瀏覽器不關的話 process 不會結束
}
