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

function num(x: string): number | null {
  const n = Number(String(x ?? "").replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export default async function Page() {
  const font = { fontFamily: "system-ui, sans-serif" as const };

  try {
    const csvUrl = process.env.SHEET_CSV_URL;

    if (!csvUrl) {
      return (
        <main style={{ padding: 24, ...font }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
          <p style={{ marginTop: 12 }}>
            ❌ Missing <code>SHEET_CSV_URL</code> (請到 Vercel → Settings → Environment Variables 設定，並 Redeploy)
          </p>
        </main>
      );
    }

    const resp = await fetch(csvUrl, { cache: "no-store" });
    const text = await resp.text();

    if (!resp.ok) {
      return (
        <main style={{ padding: 24, ...font }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
          <p style={{ marginTop: 12 }}>
            ❌ Fetch CSV failed: {resp.status} {resp.statusText}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 12, padding: 12, border: "1px solid #ddd" }}>
            {text.slice(0, 400)}
          </pre>
        </main>
      );
    }

    if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
      return (
        <main style={{ padding: 24, ...font }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
          <p style={{ marginTop: 12 }}>
            ❌ CSV URL 回傳的是 HTML（不是 CSV）。通常是 Sheets 沒有 Publish 成 CSV 或連結貼錯。
          </p>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 12, padding: 12, border: "1px solid #ddd" }}>
            {text.slice(0, 400)}
          </pre>
        </main>
      );
    }

    const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
    const rows = (parsed.data || []).filter((r) => r["Start Date"] && r["Tournament"]);
    rows.sort((a, b) => new Date(a["Start Date"]).getTime() - new Date(b["Start Date"]).getTime());

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
                <th align="right">Buy-in</th>
                <th align="right">Currency</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const amount = num(r["ME Buy-in"]);
                const ccy = (r["Currency"] || "").toUpperCase();
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
                    <td align="right">{amount != null ? amount.toLocaleString() : r["ME Buy-in"]}</td>
                    <td align="right">{ccy}</td>
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
