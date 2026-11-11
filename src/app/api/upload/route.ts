// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات من الواجهة (ثنائي ≤4MB)
// حد طلب Vercel ≈ 4.5MB → الرفع يتم أجزاءً 4MB بنوع application/octet-stream
import { NextRequest, NextResponse } from "next/server";
import { getJob, insertSourceChunk, addSourceBytes, listSources } from "@/lib/merger/store";
import { MERGE_LIMITS } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const jobId = sp.get("job") ?? "";
    const seq = Number(sp.get("seq") ?? "-1");
    const chunk = Number(sp.get("chunk") ?? "-1");
    if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
      return NextResponse.json({ error: "معطيات الرفع ناقصة: job و seq و chunk مطلوبة" }, { status: 400, headers: CORS });
    }
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "المهمة غير موجودة" }, { status: 404, headers: CORS });
    if (job.status === "done" || job.status === "failed" || job.status === "processing") {
      return NextResponse.json({ error: `لا يمكن الرفع في حالة المهمة الحالية (${job.status})` }, { status: 409, headers: CORS });
    }

    const sources = await listSources(jobId);
    const src = sources.find((s) => s.seq === seq);
    if (!src) return NextResponse.json({ error: `المصدر seq=${seq} غير مسجل في هذه المهمة` }, { status: 404, headers: CORS });

    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length) return NextResponse.json({ error: "جسم الطلب فارغ" }, { status: 400, headers: CORS });
    if (buf.length > MERGE_LIMITS.uploadChunkBytes + 64 * 1024) {
      return NextResponse.json(
        { error: `الجزء أكبر من الحد (${Math.round(MERGE_LIMITS.uploadChunkBytes / 1024)}KB تقريبًا)` },
        { status: 413, headers: CORS }
      );
    }

    await insertSourceChunk(jobId, seq, chunk, buf);
    await addSourceBytes(jobId, seq, buf.length);

    // أول جزء تُرفع → الحالة uploading (إن كانت queued)
    if (job.status === "queued") {
      const { updateJob } = await import("@/lib/merger/store");
      await updateJob(jobId, { status: "uploading" });
    }

    return NextResponse.json({ ok: true, seq, chunk, received: buf.length }, { headers: CORS });
  } catch (e) {
    return NextResponse.json({ error: `فشل الرفع: ${(e as Error).message}` }, { status: 500, headers: CORS });
  }
}
