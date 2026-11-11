// GET /api/cron — حذف المهام المنتهية (Cron يومي عبر vercel.json)
import { NextResponse } from "next/server";
import { deleteExpiredJobs } from "@/lib/merger/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const deleted = await deleteExpiredJobs();
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
