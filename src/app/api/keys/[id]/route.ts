/**
 * PATCH  /api/keys/{id} — تعطيل/تنشيط يدوي {status: "active" | "disabled"}
 * DELETE /api/keys/{id} — حذف المفتاح
 */
import { deleteApiKey, getApiKey, updateApiKey } from "@/lib/turso";
import { toSafeKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as { status?: string };
    if (body.status !== "active" && body.status !== "disabled") {
      return Response.json({ error: 'القيمة المقبولة للحالة: "active" أو "disabled"' }, { status: 400 });
    }
    const existing = await getApiKey(id);
    if (!existing) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    await updateApiKey(id, { status: body.status });
    const row = await getApiKey(id);
    return Response.json({ key: row ? toSafeKey(row) : null });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const existing = await getApiKey(id);
    if (!existing) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    await deleteApiKey(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}
