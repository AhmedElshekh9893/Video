// إدارة المفاتيح — الإخفاء إلزامي: لا يُعاد المفتاح الكامل في أي استجابة أبدًا
import { NextRequest, NextResponse } from "next/server";
import { listKeys, createKey, findDuplicate, type KeyProvider } from "@/lib/keys-db";
import { maskKey } from "@/lib/keys";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function masked(k: Awaited<ReturnType<typeof listKeys>>[number]) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function GET() {
  try {
    const keys = await listKeys();
    return NextResponse.json({ keys: keys.map(masked) });
  } catch (e) {
    return NextResponse.json({ error: `تعذر جلب المفاتيح: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const body = await req.json().catch(() => ({}));
    const provider = String(body.provider ?? "").toLowerCase();
    const apiKey = String(body.api_key ?? "").trim();
    const label = String(body.label ?? "").trim().slice(0, 100);

    if (provider !== "kie" && provider !== "cometapi") {
      return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    if (apiKey.length < 8) {
      return NextResponse.json({ error: "المفتاح قصير جدًا — الصق المفتاح الكامل" }, { status: 400 });
    }
    if (await findDuplicate(provider, apiKey)) {
      return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار" }, { status: 409 });
    }
    const key = await createKey(provider as KeyProvider, apiKey, label);
    return NextResponse.json({ key: masked(key) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: `تعذر إضافة المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}
