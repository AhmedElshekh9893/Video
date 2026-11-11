// GET /api/config — الحدود العامة + version (تُستخدم لفحص جهوزية خدمة الدمج)
import { NextResponse } from "next/server";
import { MERGE_LIMITS, MERGER_VERSION, mergerExternalBase } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  return NextResponse.json(
    {
      version: MERGER_VERSION,
      maxSources: MERGE_LIMITS.maxSources,
      sourceMaxMB: Math.round(MERGE_LIMITS.sourceMaxBytes / 1024 / 1024),
      outputMaxMB: Math.round(MERGE_LIMITS.outputMaxBytes / 1024 / 1024),
      maxTotalDurationSec: MERGE_LIMITS.maxTotalDurationSec,
      uploadChunkBytes: MERGE_LIMITS.uploadChunkBytes,
      retentionHours: MERGE_LIMITS.retentionHours,
      mode: mergerExternalBase() ? "external" : "internal",
    },
    { headers: CORS }
  );
}
