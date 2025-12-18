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
  const n = Number(String(x).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export default async function Page() {
  const res = await fetch("http://localhost:3000/api/schedule", { cache: "no-store" });
  const data = await res.json();
  const rows: Row[] = data.rows ?? [];

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
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
}
