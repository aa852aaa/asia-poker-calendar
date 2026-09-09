import Papa from "papaparse";
import { Row, toNumber } from "./types";

// ====== 過濾「已結束超過 N 天」 ======
const HIDE_ENDED_AFTER_DAYS = 3;

// ====== 非台灣賽事的買入門檻 ======
// 顯示規則（由上往下判斷，符合任一條就顯示）：
//   1. 台灣（台北）的賽事——一律顯示
//   2. 在 ALWAYS_SHOW_SERIES 豁免清單裡的系列——一律顯示，不看買入
//   3. 主賽事買入 ≥ MIN_USD_OUTSIDE_TAIWAN
//   4. 以上都不符合（含買入不明）——隱藏
const MIN_USD_OUTSIDE_TAIWAN = 500;

// 豁免清單：知名／大型系列，就算表格還沒填買入金額也要顯示。
// 比對不分大小寫，且要求前後是字界，所以 "APT" 不會誤中 "ADAPT"、"APPT"。
// 要增減直接改這個陣列。
const ALWAYS_SHOW_SERIES: string[] = [
  "APT",                        // Asian Poker Tour（不會誤中 APPT，APT 不是 APPT 的子字串）
  "APPT",                       // PokerStars Live 亞太
  "WSOP", "World Series of Poker",
  "WPT",                        // 只有辦在收錄範圍內的才會進到這裡（首爾、柬埔寨）
  "Triton",
  "Poker Dream",
  "GOP", "Gods of Poker",       // 賽事名有時寫成「The Trial of Wisdom - GOP Taipei」
  "MGM",                        // MGM Poker Championship，澳門唯一的系列
  "KPC", "Korea Poker Cup",
  "RDPT", "Jeju Poker Festival", // Red Dragon 的賽事有時不掛 RDPT 前綴
];

function matchesSeries(text: string, series: string): boolean {
  const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

// Location 欄是人工填的，格式像「台灣 台北 / Taipei, Taiwan」，中英文都可能出現
export function isLocalTaiwan(location: string | undefined): boolean {
  return /taiwan|taipei|台灣|台北/i.test(String(location ?? ""));
}

export function isAlwaysShowSeries(tournament: string | undefined): boolean {
  const t = String(tournament ?? "");
  return ALWAYS_SHOW_SERIES.some((s) => matchesSeries(t, s));
}

// 這一列該不該出現在網站上。
// fxAvailable=false（匯率 API 掛了）時整條規則停用：第三方服務出問題不該讓網站整片空白。
export function passesBuyInFloor(row: Row, fxAvailable: boolean): boolean {
  if (!fxAvailable) return true;
  if (isLocalTaiwan(row["Location"])) return true;
  if (isAlwaysShowSeries(row["Tournament"])) return true;
  if (row.usd == null) return false; // 買入不明且不在豁免清單 → 隱藏
  return row.usd >= MIN_USD_OUTSIDE_TAIWAN;
}

// 支援 YYYY-MM-DD / YYYY/MM/DD / YYYY-M-D / YYYY/M/D，固定當台北時區 00:00
export function parseYMDToTaipeiDate(dateStr: string): Date | null {
  const s = String(dateStr ?? "").trim();
  if (!s) return null;

  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;

  const [, y, mo, d] = m;
  return new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00+08:00`);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// 每日更新一次（Next.js fetch cache）
async function getFxRatesUSDBase(): Promise<Record<string, number>> {
  const res = await fetch("https://open.er-api.com/v6/latest/USD", {
    next: { revalidate: 60 * 60 * 24 }, // 24h
  });
  if (!res.ok) throw new Error(`FX fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  // data.rates: { TWD: 32.1, KRW: 1380, ... } 代表 1 USD = X 當地幣
  return (data?.rates ?? {}) as Record<string, number>;
}

function convertToUSD(amountLocal: number, ccyRaw: string, rates: Record<string, number>): number | null {
  const ccy = (ccyRaw || "").trim().toUpperCase();
  if (!ccy) return null;

  // 特例：USDT 當作 1:1 USD
  if (ccy === "USDT") return amountLocal;
  if (ccy === "USD") return amountLocal;

  const r = rates[ccy];
  if (!r || r === 0) return null;

  // 因為 r 表示 1 USD = r 當地幣，所以 當地幣換 USD = amountLocal / r
  return amountLocal / r;
}

// 抓 Google Sheets CSV → 過濾已結束 → 排序 → 換算 USD
// 頁面（ISR）與 /api/schedule 共用這一份邏輯
export async function getScheduleRows(): Promise<Row[]> {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    throw new Error("Missing SHEET_CSV_URL");
  }

  // CSV 最多每 60 秒抓一次，避免每個請求都打 Google
  const res = await fetch(csvUrl, { next: { revalidate: 60 } });
  if (!res.ok) {
    throw new Error(`Sheet CSV fetch failed: ${res.status} ${res.statusText}`);
  }
  const csvText = await res.text();

  const parsed = Papa.parse<Row>(csvText, { header: true, skipEmptyLines: true });
  const rawRows = (parsed.data || []).filter((r) => r["Start Date"] && r["Tournament"]);

  // 以 End Date 為準，移除已結束超過 3 天的賽程
  const cutoff = daysAgo(HIDE_ENDED_AFTER_DAYS);
  const filteredRows = rawRows.filter((r) => {
    const end = parseYMDToTaipeiDate(r["End Date"]);
    if (!end) return true; // End Date 缺失或格式不對：先保留避免誤刪
    return end.getTime() >= cutoff.getTime();
  });

  // 排序：統一用同一個解析器，避免 YYYY/M/D 與 YYYY-MM-DD 混用時順序不一致
  filteredRows.sort((a, b) => {
    const ta = parseYMDToTaipeiDate(a["Start Date"])?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const tb = parseYMDToTaipeiDate(b["Start Date"])?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });

  // 匯率（失敗時 fallback 為空，不影響主要賽程資料）
  let rates: Record<string, number> = {};
  try {
    rates = await getFxRatesUSDBase();
  } catch (e) {
    console.error("Failed to fetch exchange rates, USD conversion will be unavailable:", e);
  }

  // 計算 USD（若表格已填 ME Buy-in(USD)，就優先用它；否則自算）
  const withUsd = filteredRows.map((r) => {
    const usdFromSheet = toNumber(r["ME Buy-in(USD)"]);
    if (usdFromSheet != null) {
      return { ...r, usd: usdFromSheet };
    }

    const amount = toNumber(r["ME Buy-in"]);
    if (amount == null) return { ...r, usd: null };

    const usd = convertToUSD(amount, r["Currency"], rates);
    return { ...r, usd };
  });

  // 買入門檻要在換算 USD 之後才能判斷，所以放在最後
  // （在這裡過濾而不是在畫面上，濾掉的資料就不會傳到瀏覽器，地區下拉選單也不會列出空的地區）
  const fxAvailable = Object.keys(rates).length > 0;
  return withUsd.filter((r) => passesBuyInFloor(r, fxAvailable));
}
