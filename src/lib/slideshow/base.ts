/**
 * أدوات مشتركة لمسارات التعليق المصوّر
 */

/** العنوان العام المستخرج من ترويسات الطلب (x-forwarded-host أولًا) */
export function publicBaseOf(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const hostClean = host.split(",")[0].trim();
  const proto =
    (h.get("x-forwarded-proto") || "").split(",")[0].trim() ||
    (hostClean.startsWith("localhost") || hostClean.startsWith("127.") ? "http" : "https");
  return hostClean ? `${proto}://${hostClean}` : "";
}

/**
 * العنوان الذي ستُبنى منه روابط النتيجة النهائية (ثابتة عبر النشرات):
 * 1) PUBLIC_BASE_URL إن ضُبط
 * 2) VERCEL_PROJECT_PRODUCTION_URL (يحقنه Vercel في نشرات الإنتاج — دومين المشروع الثابت)
 * 3) ترويسات الطلب نفسها
 */
export function slideshowResultBase(req: Request): string {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod.replace(/\/+$/, "")}`;
  return publicBaseOf(req);
}

/** عنوان الاستدعاء الذاتي لإطلاق معالجة التعليق (دالة serverless مستقلة) */
export function slideshowSelfBase(): string {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://127.0.0.1:3000";
}
