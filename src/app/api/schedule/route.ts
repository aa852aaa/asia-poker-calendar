import { NextResponse } from "next/server";
import Papa from "papaparse";
import { Row, toNumber } from "../../lib/types";

// ====== 過濾「已結束超過 N 天」 ======
const HIDE_ENDED_AFTER_DAYS = 3;

function parseYMDToTaipeiDate(dateStr: string): Date | null {
  const s = String(dateStr ?? "").trim();
  if (!s) return null;

  // 支援 YYYY-MM-DD / YYYY/MM/DD / YYYY-M-D / YYYY/M/D
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;

  const [, y, mo, d] = m;
  // 固定用台北時區的 00:00
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

export async function GET() {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    return NextResponse.json({ error: "Missing SHEET_CSV_URL" }, { status: 500 });
  }

  const csvText = await fetch(csvUrl, { cache: "no-store" }).then((r) => r.text());

  const parsed = Papa.parse<Row>(csvText, { header: true, skipEmptyLines: true });
  const rawRows = (parsed.data || []).filter((r) => r["Start Date"] && r["Tournament"]);

  // 以 End Date 為準，移除已結束超過 3 天的賽程
  const cutoff = daysAgo(HIDE_ENDED_AFTER_DAYS);
  const filteredRows = rawRows.filter((r) => {
    const end = parseYMDToTaipeiDate(r["End Date"]);
    if (!end) return true; // End Date 缺失或格式不對：先保留避免誤刪
    return end.getTime() >= cutoff.getTime();
  });

  // 排序（Start Date: YYYY-MM-DD）
  filteredRows.sort((a, b) => new Date(a["Start Date"]).getTime() - new Date(b["Start Date"]).getTime());

  // 匯率（失敗時 fallback 為空，不影響主要賽程資料）
  let rates: Record<string, number> = {};
  try {
    rates = await getFxRatesUSDBase();
  } catch (e) {
    console.error("Failed to fetch exchange rates, USD conversion will be unavailable:", e);
  }

  // 計算 USD（若表格已填 ME Buy-in(USD)，就優先用它；否則自算）
  const rows = filteredRows.map((r) => {
    const usdFromSheet = toNumber(r["ME Buy-in(USD)"]);
    if (usdFromSheet != null) {
      return { ...r, usd: usdFromSheet };
    }

    const amount = toNumber(r["ME Buy-in"]);
    if (amount == null) return { ...r, usd: null };

    const usd = convertToUSD(amount, r["Currency"], rates);
    return { ...r, usd };
  });

  return NextResponse.json({ rows });
}
