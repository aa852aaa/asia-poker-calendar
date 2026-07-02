// AI 自動抓賽程：抓來源網站 → Gemini 抽取 → 與 Sheet 去重 → 寫入 Google Sheet 主分頁
//
// 用法：
//   node index.mjs               正式跑（需要環境變數，見 SETUP.md）
//   DRY_RUN=1 node index.mjs     試跑：只印出會新增的列，不寫入 Sheet
//   node index.mjs --test-fetch  只測試來源網頁抓不抓得到（不需要任何金鑰）

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
const TEST_FETCH = process.argv.includes("--test-fetch");

const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_NEW_PER_SOURCE = 30; // 單一來源單次最多新增筆數（防 LLM 幻覺灌爆表格）
const MAX_APPEND_TOTAL = 60; // 單次執行寫入總上限
const PAGE_TEXT_LIMIT = 350_000; // 餵給 LLM 的每頁文字上限（字元）
const GEMINI_CALL_GAP_MS = 7_000; // 免費額度 10 RPM，兩次呼叫間隔 7 秒
const HIDE_ENDED_AFTER_DAYS = 3; // 與網站一致：結束超過 3 天的不收

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

// ---------- 小工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taipeiTodayYMD() {
  // GitHub Actions 是 UTC，統一換算成台北日期
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
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

// 判斷「新抓到的賽事」是否已存在（同名 + 日期重疊 = 同一場）
function isDuplicate(ev, existing) {
  const s1 = parseYMD(ev["Start Date"]);
  const e1 = parseYMD(ev["End Date"]) ?? s1;
  for (const ex of existing) {
    const sim = jaccard(ev["Tournament"], ex["Tournament"]);
    if (sim < 0.5) continue;
    const s2 = parseYMD(ex["Start Date"]);
    const e2 = parseYMD(ex["End Date"]) ?? s2;
    if (s1 == null || s2 == null) return true; // 日期比不了就保守當重複，寧可漏不要錯
    if (rangesOverlap(s1, e1, s2, e2)) return true;
  }
  return false;
}

// ---------- 抓網頁 ----------

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// HTML → 純文字，但保留連結網址（LLM 需要它填 detail_url）
function htmlToText(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>/gi, (_, href) => {
      const abs = href.startsWith("http") ? href : href.startsWith("/") ? origin + href : "";
      return abs ? ` [link:${abs}] ` : " ";
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
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
  return `你是資料抽取工具。以下是撲克賽程網站「${sourceName}」列表頁的純文字（[link:...] 是該處的連結網址）。
抽出所有「錦標賽系列」（festival / series，一整檔賽事節），每個系列一筆。

規則：
- 只要亞洲地區（台灣、日本、韓國、菲律賓、越南、澳門、香港、馬來西亞、新加坡、泰國、柬埔寨、印度、蒙古、烏茲別克、斯里蘭卡、尼泊爾等）。歐洲、美洲、澳洲、紐西蘭不要。
- 日期一律輸出 YYYY-MM-DD，年份要依上下文推斷正確。
- 只列「今天（${today}）當天或之後才結束」的系列；已結束的不要。
- location 用英文「City, Country」格式，例如 "Taipei, Taiwan"、"Jeju, South Korea"。
- detail_url 填該系列詳情頁的完整網址（從 [link:...] 取），找不到就填空字串。
- 找不到的欄位填空字串，不要編造。

頁面內容：
${text}`;
}

function detailPrompt(name, text) {
  return `以下是撲克賽事系列「${name}」詳情頁的純文字。找出「主賽事（Main Event）的買入金額（buy-in）」。

注意：
- 要的是 buy-in（買入費），不是保證獎池（GTD / guarantee / prize pool）。
- 金額若寫成 33,000+3,000 這種「賽事費+行政費」，請加總成一個數字。
- me_buyin 只輸出數字；整頁找不到主賽事買入就輸出 null，不要猜。
- currency 用 ISO 代碼（TWD、JPY、KRW、USD、PHP、VND、MYR、HKD、SGD、THB、MOP、CNY、INR 等），找不到填空字串。
- handbook_url 填官方 handbook 或完整賽程表的連結（從 [link:...] 取），找不到填空字串。

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

  const rows = values.slice(1).map((arr) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = String(arr[i] ?? "").trim()));
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

// ---------- 驗證 ----------

function validateEvent(ev, todayTs) {
  const s = parseYMD(ev.start_date);
  const e = parseYMD(ev.end_date);
  if (String(ev.tournament ?? "").trim().length < 4) return "名稱太短";
  if (s == null || e == null) return "日期格式不對";
  if (e < s) return "結束早於開始";
  if ((e - s) / 86400_000 > 60) return "賽期超過 60 天（可疑）";
  if (e < todayTs - HIDE_ENDED_AFTER_DAYS * 86400_000) return "已結束";
  const year = Number(ev.start_date.slice(0, 4));
  const nowYear = Number(taipeiTodayYMD().slice(0, 4));
  if (year < nowYear - 1 || year > nowYear + 2) return "年份可疑";
  if (!String(ev.location ?? "").trim()) return "沒有地點";
  return null;
}

// ---------- 主流程 ----------

async function loadSources() {
  const raw = JSON.parse(await readFile(path.join(__dirname, "sources.json"), "utf8"));
  const year = Number(taipeiTodayYMD().slice(0, 4));
  const month = Number(taipeiTodayYMD().slice(5, 7));
  const out = [];
  for (const src of raw) {
    if (src.enabled === false) continue;
    if (src.url.includes("{YEAR}")) {
      out.push({ ...src, url: src.url.replaceAll("{YEAR}", String(year)) });
      // 11、12 月時順便看明年的月曆頁
      if (month >= 11) {
        out.push({
          ...src,
          name: `${src.name} (${year + 1})`,
          url: src.url.replaceAll("{YEAR}", String(year + 1)),
        });
      }
    } else {
      out.push(src);
    }
  }
  return out;
}

async function main() {
  const sources = await loadSources();

  if (TEST_FETCH) {
    // 不需要金鑰的連線測試：確認每個來源抓得到、文字量正常
    const outDir = path.join(__dirname, "..", ".scraper-test");
    await mkdir(outDir, { recursive: true });
    for (const src of sources) {
      try {
        const html = await fetchPage(src.url);
        const text = htmlToText(html, src.url);
        const file = path.join(outDir, `${src.name.replace(/[^\w]+/g, "_")}.txt`);
        await writeFile(file, text, "utf8");
        console.log(`✅ ${src.name}: HTML ${html.length} 字元 → 純文字 ${text.length} 字元 → ${file}`);
      } catch (e) {
        console.log(`❌ ${src.name}: ${e.message}`);
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

  const collected = []; // 本次要新增的（跨來源共用，避免兩站抓到同一場重複寫）

  for (const src of sources) {
    console.log(`\n=== 來源：${src.name} ===`);
    let events;
    try {
      const html = await fetchPage(src.url);
      const text = htmlToText(html, src.url);
      if (text.length < 500) throw new Error(`頁面內容太少（${text.length} 字元），可能被擋`);
      await sleep(GEMINI_CALL_GAP_MS);
      events = await geminiJSON(listingPrompt(src.name, today, text), LISTING_SCHEMA);
    } catch (e) {
      console.error(`❌ ${src.name} 抓取/抽取失敗：${e.message}`);
      continue; // 單一來源失敗不影響其他來源
    }
    console.log(`抽到 ${events.length} 筆`);

    let added = 0;
    for (const ev of events) {
      if (added >= MAX_NEW_PER_SOURCE) {
        console.warn(`⚠️ 已達單來源上限 ${MAX_NEW_PER_SOURCE} 筆，其餘略過`);
        break;
      }
      const bad = validateEvent(ev, todayTs);
      if (bad) {
        console.log(`  跳過（${bad}）：${ev.tournament} ${ev.start_date}`);
        continue;
      }
      const candidate = {
        "Start Date": ev.start_date,
        "End Date": ev.end_date,
        "Location": String(ev.location).trim(),
        "Tournament": String(ev.tournament).trim(),
        "ME Buy-in": "",
        "Currency": "",
        "Handbook URL": String(ev.detail_url ?? "").trim(),
        _detailUrl: String(ev.detail_url ?? "").trim(),
      };
      if (isDuplicate(candidate, existing) || isDuplicate(candidate, collected)) continue;
      collected.push(candidate);
      added++;
      console.log(`  🆕 ${candidate["Start Date"]} ${candidate["Tournament"]} @ ${candidate["Location"]}`);
    }
  }

  if (!collected.length) {
    console.log("\n沒有新賽程，本次結束。");
    return;
  }

  const toAppend = collected.slice(0, MAX_APPEND_TOTAL);
  if (collected.length > toAppend.length) {
    console.warn(`⚠️ 超過單次寫入上限，只寫前 ${MAX_APPEND_TOTAL} 筆，其餘下次再收`);
  }

  // 第二段：只對「真正新增」的賽事抓詳情頁補買入資訊
  for (const ev of toAppend) {
    if (!ev._detailUrl || !/^https?:\/\//.test(ev._detailUrl)) continue;
    try {
      const html = await fetchPage(ev._detailUrl);
      const text = htmlToText(html, ev._detailUrl);
      await sleep(GEMINI_CALL_GAP_MS);
      const d = await geminiJSON(detailPrompt(ev["Tournament"], text), DETAIL_SCHEMA);
      const buyin = Number(d?.me_buyin);
      if (Number.isFinite(buyin) && buyin > 0 && buyin < 100_000_000) {
        ev["ME Buy-in"] = String(buyin);
        ev["Currency"] = String(d?.currency ?? "").trim().toUpperCase();
      }
      const hb = String(d?.handbook_url ?? "").trim();
      if (/^https?:\/\//.test(hb)) ev["Handbook URL"] = hb;
    } catch (e) {
      console.warn(`  詳情頁失敗（買入留白）：${ev["Tournament"]} — ${e.message}`);
    }
  }

  // 有 Source 欄就標記 AI，方便在 Sheet 裡辨識
  for (const ev of toAppend) {
    delete ev._detailUrl;
    if (headers.includes("Source")) ev["Source"] = "AI";
  }

  console.log(`\n=== 準備寫入 ${toAppend.length} 筆 ===`);
  for (const ev of toAppend) {
    console.log(
      `  ${ev["Start Date"]} ~ ${ev["End Date"]} | ${ev["Tournament"]} | ${ev["Location"]} | ${ev["Currency"]} ${ev["ME Buy-in"] || "-"}`,
    );
  }

  if (DRY_RUN) {
    console.log("\n（DRY_RUN 模式：以上只是預覽，沒有寫入 Sheet）");
    return;
  }

  const written = await appendRows(client, tab, headers, toAppend);
  console.log(`\n✅ 已寫入 ${written} 列到分頁「${tab}」`);
}

main().catch((e) => {
  console.error("執行失敗：", e);
  process.exit(1);
});
