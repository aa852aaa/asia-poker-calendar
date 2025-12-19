export const revalidate = 60;
import { headers } from "next/headers";

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

function toNumber(x: string | undefined): number | null {
  const n = Number(String(x ?? "").replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export default async function Page() {
  const font = { fontFamily: "system-ui, sans-serif" as const };

  try {
    // ✅ 改成抓我們的 API（這裡會包含 usd）
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

        <div style={{ overflowX: "auto", marginTop: 16 }}>
          <table cellPadding={10} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th align="left">Start</th>
                <th align="left">End</th>
                <th align="left">Location</th>
                <th align="left">Tournament</th>
                <th align="right">Buy-in (Local)</th>
                <th align="right">Buy-in (USD)</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((r, i) => {
                const amount = toNumber(r["ME Buy-in"]);
                const ccy = String(r["Currency"] || "").toUpperCase();
                const usd = r.usd;

                return (
                  <tr key={i} style={{ borderTop: "1px solid #ddd" }}>
                    <td>{r["Start Date"]}</td>
                    <td>{r["End Date"]}</td>
                    <td>{r["Location"]}</td>
                    <td>
                      {r["Handbook URL"] ? (
                        <a href={r["Handbook URL"]} target="_blank" rel="noreferrer">
                          {r["Tournament"]}
                        </a>
                      ) : (
                        r["Tournament"]
                      )}
                    </td>
                    <td align="right">
                      {(() => {
                        const raw = String(r["ME Buy-in"] ?? "").trim();

                        // ✅ 沒填 / 空白 → 顯示 "-"
                        if (!raw) return "-";

                        // ✅ 有數字 → 顯示 幣別 + 千分位
                        if (amount != null) return `${ccy} ${amount.toLocaleString()}`;

                        // ✅ 不是數字但有內容（例如 TBA / TBD）→ 原樣顯示
                        return raw;
                      })()}
                    </td>
                    <td align="right">{usd != null ? `$${Number(usd).toFixed(0)}` : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
