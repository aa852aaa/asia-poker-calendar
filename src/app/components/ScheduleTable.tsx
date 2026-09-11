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

// 快選 chips：顯示中文，但比對用英文關鍵字——舊列只有英文地點、新列是雙語，英文兩種都對得到
const QUICK_LOCATIONS = [
  { label: "台灣", key: "Taiwan" },
  { label: "韓國", key: "Korea" },
] as const;

export default function ScheduleTable({ rows }: { rows: Row[] }) {
  const [locationPick, setLocationPick] = useState<string>("ALL");
  const [tournamentQuery, setTournamentQuery] = useState<string>("");

  // 下拉：完整 Location 清單
  const locations = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const loc = String(r["Location"] ?? "").trim();
      if (loc) set.add(loc);
    }
    return Array.from(set).sort((a, b) => locationLabel(a).localeCompare(locationLabel(b), "zh-Hant"));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = norm(tournamentQuery);
    const locAll = locationPick === "ALL";
    const quickKeys: readonly string[] = QUICK_LOCATIONS.map((x) => x.key);

    return rows.filter((r) => {
      const locRaw = String(r["Location"] ?? "").trim();

      // Location 篩選：下拉用全等，chips 用包含
      let locOk = true;
      if (!locAll) {
        const isQuick = quickKeys.includes(locationPick);
        locOk = isQuick ? norm(locRaw).includes(norm(locationPick)) : locRaw === locationPick;
      }
      if (!locOk) return false;

      if (!q) return true;

      const t = norm(r["Tournament"]);
      const l = norm(r["Location"]);
      return t.includes(q) || l.includes(q);
    });
  }, [rows, locationPick, tournamentQuery]);

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
                {locationLabel(loc)}
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
          顯示 <b>{filtered.length}</b> / {rows.length} 場
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
