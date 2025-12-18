import { NextResponse } from "next/server";
import Papa from "papaparse";

type Row = {
  "Start Date": string;
  "End Date": string;
  "Location": string;
  "Tournament": string;
  "ME Buy-in": string;
  "Currency": string;
  "Handbook URL": string;
};

export async function GET() {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    return NextResponse.json({ error: "Missing SHEET_CSV_URL" }, { status: 500 });
  }

  const csvText = await fetch(csvUrl, { cache: "no-store" }).then(r => r.text());

  const parsed = Papa.parse<Row>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows = (parsed.data || []).filter(
    r => r["Start Date"] && r["Tournament"]
  );

  // 依開始日排序
  rows.sort(
    (a, b) =>
      new Date(a["Start Date"]).getTime() -
      new Date(b["Start Date"]).getTime()
  );

  return NextResponse.json({ rows });
}
