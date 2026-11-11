// تغذية لوحة المهام: أحدث المهام + الإحصائيات (تُحدَّث في الواجهة كل ~5 ثوانٍ)
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats, taskUrls, taskAttempts } from "@/lib/tasks-db";
import type { TaskRow } from "@/lib/tasks-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 20));
    const type = sp.get("type") as TaskRow["type"] | null;
    const status = sp.get("status") as TaskRow["status"] | null;
    const rows = await listRecentTasks(limit, { type: type ?? undefined, status: status ?? undefined });
    const stats = await taskStats();
    return NextResponse.json({
      stats,
      tasks: rows.map((t) => ({
        id: t.id,
        type: t.type,
        model: t.model,
        provider: t.provider,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt.slice(0, 140),
        error: t.error_message,
        urls: t.status === "completed" ? taskUrls(t) : [],
        attempts: taskAttempts(t).length,
        created_at: t.created_at,
        completed_at: t.completed_at,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: `تعذر جلب المهام: ${(e as Error).message}` }, { status: 500 });
  }
}
