"use client";

import { Fragment, useMemo, useState } from "react";
import { Row, toNumber } from "../lib/types";

function norm(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

// 支援 YYYY-MM-DD / YYYY/MM/DD / YYYY-M-D / YYYY/M/D
function parseDateFlexible(dateStr: string): Date | null {
  const s = String(dateStr ?? "").trim().replace(/　/g, " ").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return new Date(y, mo - 1, d, 0, 0, 0, 0);
}

function daysUntilEnd(endStr: string): number | null {
  const end = parseDateFlexible(endStr);
  if (!end) return null;
  // 統一用台北時區 (UTC+8) 計算，避免不同時區用戶看到不同結果
  const nowTaipei = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const today = new Date(nowTaipei.getFullYear(), nowTaipei.getMonth(), nowTaipei.getDate(), 0, 0, 0, 0);
  const diffMs = end.getTime() - today.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// ===== 日期顯示：年份只在分隔列出現一次，每列只顯示 月/日 =====
function yearOf(dateStr: string): number | null {
  return parseDateFlexible(dateStr)?.getFullYear() ?? null;
}

function mmdd(dateStr: string): string {
  const d = parseDateFlexible(dateStr);
  if (!d) return String(dateStr ?? ""); // 解析不了就原樣顯示，不要讓一格壞掉整列消失
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// 結束日跨年時帶上年份，不然「12/24 → 01/03」看不出是隔年
function endLabel(startStr: string, endStr: string): string {
  const ys = yearOf(startStr);
  const ye = yearOf(endStr);
  const base = mmdd(endStr);
  return ys != null && ye != null && ye !== ys ? `${ye}/${base}` : base;
}

// 地點欄是雙語（「台灣 台北\nTaipei, Taiwan」），下拉選單只顯示第一行比較乾淨
function locationLabel(loc: string): string {
  return String(loc ?? "").split("\n")[0].trim() || loc;
}

function buyInLocal(r: Row): string {
  const rawBuyin = String(r["ME Buy-in"] ?? "").trim();
  if (!rawBuyin) return "-";
  const amount = toNumber(r["ME Buy-in"]);
  const ccy = String(r["Currency"] || "").toUpperCase();
  return amount != null ? `${ccy} ${amount.toLocaleString()}` : rawBuyin;
}

function buyInUsd(r: Row): string {
  return r.usd != null ? `$${Number(r.usd).toFixed(0)}` : "-";
}

function soonText(dLeft: number | null): string {
  if (dLeft == null) return "";
  if (dLeft === 0) return "（今天結束）";
  if (dLeft > 0) return `（剩 ${dLeft} 天）`;
  return `（已結束 ${Math.abs(dLeft)} 天）`;
}

// 快選 chips：顯示中文，比對時中英文關鍵字都認——舊列只有英文地點、新列是雙語
const QUICK_LOCATIONS = [
  { label: "台灣", key: "Taiwan", match: ["taiwan", "台灣"] },
  { label: "韓國", key: "Korea", match: ["korea", "韓國"] },
  { label: "越南", key: "Vietnam", match: ["vietnam", "越南"] },
] as const;

// 澳洲是「加選」：預設不出現，按了「＋ 澳洲」才加進清單（2026-09-24 Wei 指定）
function isAustralia(loc: string | undefined): boolean {
  return /australia|澳洲/i.test(String(loc ?? ""));
}

function matchesQuery(r: Row, q: string): boolean {
  if (!q) return true;
  return norm(r["Tournament"]).includes(q) || norm(r["Location"]).includes(q);
}

export default function ScheduleTable({ rows }: { rows: Row[] }) {
  const [locationPick, setLocationPick] = useState<string>("ALL");
  const [tournamentQuery, setTournamentQuery] = useState<string>("");
  const [showAustralia, setShowAustralia] = useState(false);

  // 下拉：地點清單，用顯示的那行（中文）去重——同一個城市的英文可能寫法不同（雪梨 Sydney / Pyrmont），
  // 用完整字串當選項會出現兩個一模一樣的「澳洲 雪梨」。澳洲沒加選時不列
  const locations = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const loc = String(r["Location"] ?? "").trim();
      if (loc && (showAustralia || !isAustralia(loc))) set.add(locationLabel(loc));
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }, [rows, showAustralia]);

  const toggleAustralia = () => {
    const next = !showAustralia;
    setShowAustralia(next);
    // 關掉時如果下拉還停在某個澳洲城市，那個選項已經不在清單裡了，退回「全部」
    if (!next && isAustralia(locationPick)) setLocationPick("ALL");
  };

  const filtered = useMemo(() => {
    const q = norm(tournamentQuery);
    const quick = QUICK_LOCATIONS.find((x) => x.key === locationPick);

    return rows.filter((r) => {
      const locRaw = String(r["Location"] ?? "").trim();

      if (isAustralia(locRaw)) {
        // 澳洲是加選：沒按「＋ 澳洲」就不出現；按了就加進目前的清單（不管上面選了哪個地區），
        // 只有下拉明確選了某個澳洲城市時，才只留那個城市
        if (!showAustralia) return false;
        if (isAustralia(locationPick) && locationLabel(locRaw) !== locationPick) return false;
      } else if (locationPick !== "ALL") {
        // Location 篩選：下拉比對顯示的那行，chips 用包含
        const loc = norm(locRaw);
        const ok = quick ? quick.match.some((k) => loc.includes(k)) : locationLabel(locRaw) === locationPick;
        if (!ok) return false;
      }

      return matchesQuery(r, q);
    });
  }, [rows, locationPick, tournamentQuery, showAustralia]);

  // 澳洲有幾場符合目前的搜尋：標在「＋ 澳洲」上，讓人知道按下去會多出幾場
  const australiaTotal = useMemo(() => rows.filter((r) => isAustralia(r["Location"])).length, [rows]);
  const australiaMatches = useMemo(() => {
    const q = norm(tournamentQuery);
    return rows.filter((r) => isAustralia(r["Location"]) && matchesQuery(r, q)).length;
  }, [rows, tournamentQuery]);
  // 「顯示 N / 總數」的總數只算目前範圍內的：澳洲沒加選時不算澳洲
  const scopeTotal = showAustralia ? rows.length : rows.length - australiaTotal;

  const igUrl = "https://www.instagram.com/a.smallbean_poker"; // 你要換 IG 就改這裡

  return (
    <div style={{ marginTop: 16 }}>
      {/* 控制列 */}
      <div className="controls">
        <label className="controlItem">
          <span className="label">地點</span>
          <select value={locationPick} onChange={(e) => setLocationPick(e.target.value)} className="select">
            <option value="ALL">全部</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>

        <label className="controlItem controlGrow">
          <span className="label">賽事</span>
          <input
            value={tournamentQuery}
            onChange={(e) => setTournamentQuery(e.target.value)}
            placeholder="搜尋賽事名稱或地點…"
            className="input"
          />
        </label>

        <div className="resultCount">
          顯示 <b>{filtered.length}</b> / {scopeTotal} 場
        </div>
      </div>

      {/* 快選 chips */}
      <div className="chips">
        <button onClick={() => setLocationPick("ALL")} className={`chip ${locationPick === "ALL" ? "chipActive" : ""}`}>
          全部
        </button>

        {QUICK_LOCATIONS.map(({ label, key }) => (
          <button
            key={key}
            onClick={() => setLocationPick(key)}
            className={`chip ${locationPick === key ? "chipActive" : ""}`}
            title={label}
          >
            {label}
          </button>
        ))}

        {/* 加選：跟上面的地區是分開的開關，按了把澳洲賽事加進目前的清單，再按一次拿掉 */}
        <button
          onClick={toggleAustralia}
          className={`chip chipAddon ${showAustralia ? "chipActive" : ""}`}
          aria-pressed={showAustralia}
          title={showAustralia ? "拿掉澳洲賽事" : "加入澳洲賽事"}
        >
          {showAustralia ? "✓" : "＋"} 澳洲
          {australiaMatches > 0 && <span className="chipCount">{australiaMatches}</span>}
        </button>
      </div>

      {/* 桌機：表格 */}
      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th align="left">開始</th>
              <th align="left">結束</th>
              <th align="left">地點</th>
              <th align="left">賽事</th>
              <th align="right">主賽買入（當地）</th>
              <th align="right">主賽買入（USD）</th>
            </tr>
          </thead>

          <tbody>
            {filtered.map((r, i) => {
              // 年份只在換年的地方出現一次：第一列前面（表格最上面）以及跨到下一年時
              const y = yearOf(r["Start Date"]);
              const prevY = i > 0 ? yearOf(filtered[i - 1]["Start Date"]) : null;
              const showYear = y != null && y !== prevY;

              const dLeft = daysUntilEnd(r["End Date"]);
              // ✅ 結束前 3 天到結束後 3 天（你說你改成結束後 3 天就消失）
              const endingSoon = dLeft != null && dLeft <= 3 && dLeft >= -3;

              return (
                <Fragment key={`${r["Start Date"]}-${r["Tournament"]}-${i}`}>
                  {showYear && (
                    <tr className="yearDivider">
                      <td colSpan={6}>{y}</td>
                    </tr>
                  )}
                  <tr className={`row ${endingSoon ? "rowSoon" : ""}`}>
                    <td className="cell nowrap">{mmdd(r["Start Date"])}</td>
                    <td className="cell nowrap">{endLabel(r["Start Date"], r["End Date"])}</td>
                    <td className="cell locationCell">{r["Location"]}</td>

                    <td className="cell tournamentCell">
                      {r["Handbook URL"] ? (
                        <a className="tLink" href={r["Handbook URL"]} target="_blank" rel="noreferrer">
                          {r["Tournament"]}
                        </a>
                      ) : (
                        r["Tournament"]
                      )}
                    </td>

                    <td className="cell nowrap" style={{ textAlign: "right" }}>
                      {buyInLocal(r)}
                    </td>

                    <td className="cell nowrap" style={{ textAlign: "right" }}>
                      {buyInUsd(r)}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 手機：卡片 */}
      <div className="cards">
        {filtered.map((r, i) => {
          const y = yearOf(r["Start Date"]);
          const prevY = i > 0 ? yearOf(filtered[i - 1]["Start Date"]) : null;
          const showYear = y != null && y !== prevY;

          const dLeft = daysUntilEnd(r["End Date"]);
          const endingSoon = dLeft != null && dLeft <= 3 && dLeft >= -3;

          return (
            <Fragment key={`${r["Start Date"]}-${r["Tournament"]}-${i}`}>
              {showYear && <div className="yearDividerCard">{y}</div>}
              <div className={`card ${endingSoon ? "cardSoon" : ""}`}>
                <div className="cardTop">
                  <div className="cardTitle">
                    {r["Handbook URL"] ? (
                      <a className="tLink" href={r["Handbook URL"]} target="_blank" rel="noreferrer">
                        {r["Tournament"]}
                      </a>
                    ) : (
                      r["Tournament"]
                    )}
                  </div>

                  <div className="cardMeta">
                    <span className="pill">
                      {mmdd(r["Start Date"])} → {endLabel(r["Start Date"], r["End Date"])}
                    </span>
                    <span className="pill" title={r["Location"]}>
                      {locationLabel(r["Location"])}
                    </span>
                  </div>
                </div>

                <div className="cardBottom">
                  <div className="kv">
                    <div className="k">主賽買入（當地）</div>
                    <div className="v">{buyInLocal(r)}</div>
                  </div>
                  <div className="kv">
                    <div className="k">主賽買入（USD）</div>
                    <div className="v">{buyInUsd(r)}</div>
                  </div>
                </div>

                {endingSoon && <div className="soonHint">⏳ 即將結束{soonText(dLeft)}</div>}
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* 浮水印 */}
      <div className="footer">
        <span>Made by 豆砸 AsmallBean</span>
        <span className="dot">·</span>
        <a className="ig" href={igUrl} target="_blank" rel="noreferrer">
          IG
        </a>
      </div>
    </div>
  );
}
