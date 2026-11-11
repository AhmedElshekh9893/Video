// GET  /api/jobs/{id}/video — بث الناتج من قاعدة Turso بدعم Range (206) لتقديم/ترجيع المشغل
// HEAD — ترويسات فقط. ?download=1 للتحميل المباشر
import { NextRequest, NextResponse } from "next/server";
import { getJob, readOutputRange } from "@/lib/merger/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Accept-Ranges": "bytes",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === "" && m[2] === "") return null;
  if (m[1] === "") {
    // لاحقة bytes=-N → آخر N بايت
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job || job.status !== "done" || !job.video_size) {
    return NextResponse.json(
      { error: "الناتج غير متوفر بعد — المهمة غير مكتملة أو منتهية الصلاحية" },
      { status: 404, headers: CORS }
    );
  }
  const size = job.video_size;
  const range = parseRange(req.headers.get("range"), size);
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;

  const headers = new Headers(CORS);
  headers.set("Content-Type", "video/mp4");
  headers.set("Content-Length", String(end - start + 1));
  headers.set("Cache-Control", "public, max-age=3600");
  const download = req.nextUrl.searchParams.get("download");
  if (download) headers.set("Content-Disposition", `attachment; filename="merged-${id}.mp4"`);

  if (range) {
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    const stream = readOutputRange(id, start, end);
    return new NextResponse(stream as unknown as ReadableStream, { status: 206, headers });
  }
  const stream = readOutputRange(id, 0, size - 1);
  return new NextResponse(stream as unknown as ReadableStream, { status: 200, headers });
}

export async function HEAD(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job || job.status !== "done" || !job.video_size) {
    return new NextResponse(null, { status: 404, headers: CORS });
  }
  const headers = new Headers(CORS);
  headers.set("Content-Type", "video/mp4");
  headers.set("Content-Length", String(job.video_size));
  return new NextResponse(null, { status: 200, headers });
}
