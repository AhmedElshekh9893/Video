// فحص الجهوزية الشامل — تُعرض نتيجته في هيدر لوحة التحكم
import { NextResponse } from "next/server";
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { getMergerService, mergerLimitsJson } from "@/lib/merger-service";
import { binsHealthy } from "@/lib/merger/ffmpeg";
import { mergerExternalBase } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  let database = "turso-error";
  let schemaOk = false;
  try {
    schemaOk = await ensureSchema().then(() => true).catch(() => false);
    if (schemaOk && (await dbHealthy())) database = "turso-connected";
  } catch {
    database = "turso-error";
  }

  // جهوزية خدمة الدمج: داخلية → توفر ثنائيات ffmpeg؛ خارجية → فحص /api/config بمهلة 4 ثوانٍ
  let mergerHealthy = false;
  const externalBase = mergerExternalBase();
  try {
    if (externalBase) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(`${externalBase}/api/config`, { signal: ctl.signal });
      clearTimeout(t);
      mergerHealthy = res.ok;
    } else {
      mergerHealthy = await binsHealthy();
    }
  } catch {
    mergerHealthy = false;
  }

  return NextResponse.json({
    ok: database === "turso-connected" && mergerHealthy,
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { mode: externalBase ? "external" : "internal", base: externalBase || "(داخلي)", healthy: mergerHealthy },
    limits: mergerLimitsJson(),
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
