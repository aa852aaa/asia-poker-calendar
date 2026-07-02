import { NextResponse } from "next/server";
import { getScheduleRows } from "../../lib/schedule";

export async function GET() {
  try {
    const rows = await getScheduleRows();
    return NextResponse.json({ rows });
  } catch (e) {
    console.error("GET /api/schedule failed:", e);
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
