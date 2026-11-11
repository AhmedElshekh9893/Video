// POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن): سحب ← ترميز ← حفظ
// 200 done | 202 قيد المعالجة | 404 غير موجودة | 500 فشل نهائي {"error":"..."}
import { NextRequest, NextResponse } from "next/server";
import { processJob, JobNotFoundError } from "@/lib/merger/runner";
import { appOrigin } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // ترميز ffmpeg قد يستغرق دقائق (Fluid compute)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await processJob(id, appOrigin(req.headers));
    if (r.kind === "done") return NextResponse.json(r.payload, { headers: CORS });
    if (r.kind === "busy") {
      return NextResponse.json({ status: "processing", jobId: id }, { status: 202, headers: CORS });
    }
    return NextResponse.json({ error: r.error ?? "فشلت المعالجة" }, { status: 500, headers: CORS });
  } catch (e) {
    if (e instanceof JobNotFoundError) {
      return NextResponse.json({ error: "مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" }, { status: 404, headers: CORS });
    }
    return NextResponse.json({ error: `خطأ داخلي: ${(e as Error).message}` }, { status: 500, headers: CORS });
  }
}
