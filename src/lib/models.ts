/**
 * سجل الموديلات والمزودون
 * ============================================================
 * - الاسم canonical هو ما يراه عميل MCP، ونقبل صيغًا بديلة (شرطات/نقاط) ونوحّدها.
 * - providers: من يستطيع خدمة الموديل — تُجرَّب مفاتيحهم كلها بالترتيب التسلسلي.
 * - providerModel: اسم الموديل كما يُرسل لكل مزود (قابل للتجاوز بمتغيرات بيئة).
 */

export type ProviderId = "kie" | "cometapi" | "pollinations";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  /** اسم الموديل لكل مزود يدعمه — Partial لأن المزودين بلا مفتاح (مثل pollinations) يخدمون الصور فقط */
  providerModel: Partial<Record<ProviderId, string>>;
}

const env = (v?: string | null) => (v && v.trim() ? v.trim() : null);

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi", "pollinations"],
    providerModel: {
      kie: env(process.env.KIE_IMAGE_MODEL) ?? "gpt-image-2-6/flare-text-to-image",
      // عند CometAPI: موديل flare الفعلي في كتالوجهم الحي (api.cometapi.com/api/models) هو gpt-image-2.5-flare
      cometapi: env(process.env.COMETAPI_IMAGE_MODEL) ?? "gpt-image-2.5-flare",
      // Pollinations: مزود مجاني بلا مفتاح (خطة Free Access) — يُجرَّب أخيرًا بالترتيب التسلسلي
      pollinations: env(process.env.POLLINATIONS_IMAGE_MODEL) ?? "flux",
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: env(process.env.KIE_VIDEO_MODEL) ?? "grok-imagine-video-1-5-preview",
      // عند CometAPI: المعرّف الرسمي في كتالوجهم الحي هو grok-imagine-video (نقطة /grok/v1/videos/generations)
      cometapi: env(process.env.COMETAPI_VIDEO_MODEL) ?? "grok-imagine-video",
    },
  },
];

/** توحيد اسم الموديل عبر aliases — يعيد canonical أو null إن كان مجهولًا */
export function resolveModel(name: string): ModelDef | null {
  const n = (name || "").trim();
  for (const m of MODELS) {
    if (m.canonical === n || m.aliases.includes(n)) return m;
  }
  return null;
}

export function modelByCanonical(name: string): ModelDef | null {
  return MODELS.find((m) => m.canonical === name) ?? null;
}
