/**
 * GET  /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
 * POST /api/keys — إضافة مفتاح {provider, api_key, label?} مع رفض التكرار لنفس المزود
 */
import { toSafeKey } from "@/lib/keys";
import { getAllKeys, insertApiKey, keyExists } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const rows = await getAllKeys();
    // إخفاء المفاتيح إلزامي — لا يُعاد المفتاح الكامل في أي استجابة إطلاقًا
    return Response.json({ keys: rows.map(toSafeKey) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = (body.provider || "").trim();
    const apiKey = (body.api_key || "").trim();
    const label = (body.label || "").trim();

    if (provider !== "kie" && provider !== "cometapi" && provider !== "pollinations") {
      return Response.json({ error: "المزود غير صالح — القيم المقبولة: kie أو cometapi أو pollinations" }, { status: 400 });
    }
    // pollinations يعمل بلا مفتاح، لكن يُقبل توكن اختياري لمستويات أعلى إن أُتيح مستقبلًا
    if (!apiKey && provider !== "pollinations") {
      return Response.json({ error: "المفتاح مطلوب" }, { status: 400 });
    }
    if (await keyExists(provider, apiKey)) {
      return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — لا يُقبل التكرار" }, { status: 409 });
    }
    const row = await insertApiKey({ provider, api_key: apiKey, label });
    return Response.json({ key: toSafeKey(row) }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}
