/**
 * قوالب الأسلوب للفيديو الكرتوني (text-to-video بلا صور)
 * ============================================================
 * - كل قالب = سطر أسلوب إنجليزي يُدمَج في بداية الوصف قبل إرساله لموديل الفيديو
 *   (الموديلات الإنجليزية تلتزم الأسلوب بشكل أدق عند الصياغة الإنجليزية، والوصف العربي يبقى كما هو بعده).
 * - الأداة generate_cartoon_video تستخدمها؛ الافتراضي «ديزني» حسب طلب المستخدم.
 */

export interface StylePreset {
  id: string;
  /** تسمية عربية للعرض في الردود والواجهة */
  label: string;
  /** سطر الأسلوب الإنجليزي المُدمج في الوصف النهائي */
  prompt: string;
}

export const STYLE_PRESETS: Record<string, StylePreset> = {
  disney: {
    id: "disney",
    label: "ديزني كلاسيكي",
    prompt:
      "Disney-style classic animation, hand-crafted storybook cartoon look, expressive big-eyed characters with fluid squash-and-stretch motion, vibrant saturated colors, whimsical fairy-tale scenery, soft magical glow lighting, cheerful family-friendly mood, no photorealism.",
  },
  pixar: {
    id: "pixar",
    label: "بيكسار ثلاثي الأبعاد",
    prompt:
      "Pixar-style modern 3D CGI animation, stylized rounded characters with subtle facial expressions, cinematic volumetric lighting, rich color grading, heartwarming storytelling mood, high production value, no photorealism.",
  },
  anime: {
    id: "anime",
    label: "أنمي ياباني",
    prompt:
      "Japanese anime style, cel-shaded characters with expressive faces and dynamic action lines, vivid colors, detailed painted backgrounds, cinematic anime cinematography, no photorealism.",
  },
  cartoon: {
    id: "cartoon",
    label: "كرتون ثنائي الأبعاد",
    prompt:
      "Playful 2D cartoon style, bold clean outlines, flat vivid colors, exaggerated cartoon motion with comedic timing, simple cheerful backgrounds, no photorealism.",
  },
};

/** توحيد معرّف الأسلوب (يقبل صيغًا شائعة) — القيمة الفارغة تعيد الافتراضي (ديزني)، والمجهول يعيد null */
export function resolveStyle(id?: string | null): StylePreset | null {
  const n = (id || "").trim().toLowerCase();
  if (!n) return STYLE_PRESETS.disney;
  if (STYLE_PRESETS[n]) return STYLE_PRESETS[n];
  // صيغ بديلة شائعة يتوقعها العميل
  const alt: Record<string, string> = {
    "3d": "pixar",
    cgi: "pixar",
    "3d-cartoon": "pixar",
    "3d_cartoon": "pixar",
    japanese: "anime",
    manga: "anime",
    "2d": "cartoon",
    "2d-cartoon": "cartoon",
    "2d_cartoon": "cartoon",
    classic: "disney",
    walt: "disney",
    "walt-disney": "disney",
  };
  return alt[n] ? STYLE_PRESETS[alt[n]] : null;
}
