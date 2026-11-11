// GET /api/jobs/{id} — الحالة + التقدم (0–100) + الرابط عند الاكتمال
// DELETE /api/jobs/{id} — حذف فوري شامل
import { NextRequest, NextResponse } from "next/server";
import { getJob, deleteJobCascade } from "@/lib/merger/store";
import { JobNotFoundError } from "@/lib/merger/runner";
import { appOrigin } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const job = await getJob(id);
    if (!job) {
      return NextResponse.json({ error: "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" }, { status: 404, headers: CORS });
    }
    const origin = appOrigin(req.headers);
    const body: Record<string, unknown> = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      expiresAt: job.expires_at,
    };
    if (job.status === "done") {
      body.videoUrl = `${origin}/api/jobs/${job.id}/video`;
      body.downloadUrl = `${origin}/api/jobs/${job.id}/video?download=1`;
      body.size = job.video_size;
      body.duration = job.duration;
      body.resolution = job.resolution;
    }
    if (job.status === "failed") body.error = job.error;
    return NextResponse.json(body, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ error: `تعذر جلب الحالة: ${(e as Error).message}` }, { status: 500, headers: CORS });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "المهمة غير موجودة" }, { status: 404, headers: CORS });
  }
  await deleteJobCascade(id);
  return NextResponse.json({ ok: true, deleted: id }, { headers: CORS });
}
