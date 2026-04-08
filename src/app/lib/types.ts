export type Row = {
  "Start Date": string;
  "End Date": string;
  "Location": string;
  "Tournament": string;
  "ME Buy-in": string;
  "ME Buy-in(USD)"?: string;
  "Currency": string;
  "Handbook URL": string;
  usd?: number | null;
};

export function toNumber(x: string | undefined): number | null {
  const s = String(x ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}
