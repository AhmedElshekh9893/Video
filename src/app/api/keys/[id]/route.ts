// تعطيل/تنشيط/حذف مفتاح يدويًا من الواجهة
import { NextRequest, NextResponse } from "next/server";
import { getKeyById, setKeyStatus, deleteKey } from "@/lib/keys-db";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  if (action !== "disable" && action !== "enable") {
    return NextResponse.json({ error: "action يجب أن يكون disable أو enable" }, { status: 400 });
  }
  const key = await getKeyById(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await setKeyStatus(id, action === "disable" ? "disabled" : "active");
  const updated = await getKeyById(id);
  return NextResponse.json({
    key: updated
      ? { id: updated.id, provider: updated.provider, label: updated.label, masked: maskKey(updated.api_key), status: updated.status }
      : null,
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKeyById(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
