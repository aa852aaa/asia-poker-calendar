import { headers } from "next/headers";
import ScheduleTable from "./components/ScheduleTable";

export const revalidate = 60;

type Row = {
  "Start Date": string;
  "End Date": string;
  "Location": string;
  "Tournament": string;
  "ME Buy-in": string;
  "Currency": string;
  "Handbook URL": string;
  usd?: number | null;
};

export default async function Page() {
  const font = { fontFamily: "system-ui, sans-serif" as const };

  try {
    // 取目前網域（本機/線上都通用），組成絕對 URL
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const proto = h.get("x-forwarded-proto") ?? "http";
    const url = `${proto}://${host}/api/schedule`;

    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    if (!res.ok) {
      return (
        <main style={{ padding: 24, ...font }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
          <p style={{ marginTop: 12 }}>
            ❌ Fetch /api/schedule failed: {res.status} {res.statusText}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 12, padding: 12, border: "1px solid #ddd" }}>
            {text.slice(0, 800)}
          </pre>
        </main>
      );
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return (
        <main style={{ padding: 24, ...font }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
          <p style={{ marginTop: 12 }}>❌ /api/schedule did not return JSON.</p>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 12, padding: 12, border: "1px solid #ddd" }}>
            {text.slice(0, 800)}
          </pre>
        </main>
      );
    }

    if (data?.error) {
      return (
        <main style={{ padding: 24, ...font }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
          <p style={{ marginTop: 12 }}>❌ API error: {String(data.error)}</p>
          <p style={{ marginTop: 8 }}>
            （通常是 Vercel 沒設定 <code>SHEET_CSV_URL</code> 或 Sheets CSV 連結不對）
          </p>
        </main>
      );
    }

    const rows: Row[] = data?.rows ?? [];

    return (
      <main style={{ padding: 24, ...font }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>

        {/* ✅ 改成用 Client Component：Location 國家快選 + Tournament 搜尋 */}
        <ScheduleTable rows={rows} />
      </main>
    );
  } catch (e: any) {
    return (
      <main style={{ padding: 24, ...font }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
        <p style={{ marginTop: 12 }}>❌ Server error:</p>
        <pre style={{ whiteSpace: "pre-wrap", marginTop: 12, padding: 12, border: "1px solid #ddd" }}>
          {String(e?.stack || e?.message || e)}
        </pre>
      </main>
    );
  }
}
