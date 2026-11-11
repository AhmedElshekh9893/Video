// POST /api/jobs — إنشاء مهمة دمج (CORS مفتوح، بلا تسجيل دخول)
// يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, nowIso } from "@/lib/turso";
import { MERGE_LIMITS, appOrigin } from "@/lib/config";
import { newJobId, insertSources } from "@/lib/merger/store";
import { expiryIso, lazyCleanup } from "@/lib/merger/cleanup";
import { db } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    await lazyCleanup();

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "الجسم يجب أن يكون JSON صالحًا" }, { status: 400, headers: CORS });
    }

    // تطبيع المدخلات: videos[] اختصار لروابط url، أو sources[] مفصلة
    let raw: Array<{ kind: "url" | "file"; url?: string; name?: string; size?: number; mime?: string }> = [];
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.videos)) {
      raw = (b.videos as unknown[]).map((u) => ({ kind: "url" as const, url: String(u) }));
    } else if (Array.isArray(b.sources)) {
      raw = (b.sources as Record<string, unknown>[]).map((s) => ({
        kind: (String(s.kind ?? "url") === "file" ? "file" : "url") as "url" | "file",
        url: s.url ? String(s.url) : undefined,
        name: s.name ? String(s.name) : undefined,
        size: s.size !== undefined ? Number(s.size) : undefined,
        mime: s.mime ? String(s.mime) : undefined,
      }));
    } else {
      return NextResponse.json({ error: "مطلوب حقل videos (مصفوفة روابط) أو sources (مصفوفة مصادر)" }, { status: 400, headers: CORS });
    }

    if (raw.length < 2) {
      return NextResponse.json({ error: "الدمج يحتاج مقطعَين على الأقل" }, { status: 400, headers: CORS });
    }
    if (raw.length > MERGE_LIMITS.maxSources) {
      return NextResponse.json({ error: `أقصى عدد مقاطع للدمج هو ${MERGE_LIMITS.maxSources}` }, { status: 400, headers: CORS });
    }
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      if (s.kind === "url") {
        if (!s.url || !/^https?:\/\//i.test(s.url)) {
          return NextResponse.json({ error: `المصدر رقم ${i + 1}: يجب أن يكون رابطًا مباشرًا عامًا (http/https)` }, { status: 400, headers: CORS });
        }
      } else {
        if (s.size !== undefined && s.size > MERGE_LIMITS.sourceMaxBytes) {
          return NextResponse.json(
            { error: `حجم المصدر رقم ${i + 1} يتجاوز الحد (${Math.round(MERGE_LIMITS.sourceMaxBytes / 1024 / 1024)}MB)` },
            { status: 413, headers: CORS }
          );
        }
      }
    }

    // سجّل المهمة أولًا ثم أضف المصادر
    const jobId = newJobId();
    const now = nowIso();
    const expiresAt = expiryIso();
    const hasFiles = raw.some((s) => s.kind === "file");
    await db().execute({
      sql: "INSERT INTO jobs (id, status, progress, created_at, updated_at, expires_at) VALUES (?, ?, 0, ?, ?, ?)",
      args: [jobId, hasFiles ? "uploading" : "queued", now, now, expiresAt] as never,
    });
    await insertSources(jobId, raw);

    const origin = appOrigin(req.headers);
    const res: Record<string, unknown> = {
      jobId,
      status: hasFiles ? "uploading" : "queued",
      statusUrl: `${origin}/api/jobs/${jobId}`,
      processUrl: `${origin}/api/jobs/${jobId}/process`,
      expiresAt,
    };
    if (hasFiles) {
      // رابط رفع لكل مصدر ملف + حجم الجزء المطلوب
      let seq = 0;
      res.uploads = raw.map((s, i) => {
        if (s.kind !== "file") return null;
        const idx = i;
        seq = idx;
        return {
          seq: idx,
          uploadUrl: `${origin}/api/upload?job=${jobId}&seq=${idx}&chunk=0`,
          uploadChunkBytes: MERGE_LIMITS.uploadChunkBytes,
          chunks: s.size ? Math.ceil(s.size / MERGE_LIMITS.uploadChunkBytes) : null,
        };
      }).filter(Boolean);
    }
    return NextResponse.json(res, { status: 201, headers: CORS });
  } catch (e) {
    return NextResponse.json({ error: `تعذر إنشاء المهمة: ${(e as Error).message}` }, { status: 500, headers: CORS });
  }
}
