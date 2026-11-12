/**
 * POST /api/slideshow — إنشاء مهمة تعليق مصوّر (صور + صوت راوي)
 * الجسم: {
 *   images: ["رابط صورة", ...]            // 1..20 رابط http/https مباشر
 *   narration_text?: "نص التعليق"          // يُولَّد صوته بـ TTS مجاني
 *   audio_url?: "رابط صوت جاهز"            // بديل عن narration_text (mp3/wav/m4a)
 *   voice_lang?: "ar"                      // لغة صوت TTS (افتراضي ar)
 *   per_image_seconds?: 5                  // عند غياب الصوت (1..30)
 *   resolution?: "480p"|"720p"|"1080p"     // افتراضي 720p
 *   aspect_ratio?: "16:9"|"9:16"|"1:1"     // افتراضي 16:9
 * }
 * يرجع 201: {jobId, status:"queued", statusUrl, processUrl, videoUrl*(بعد الاكتمال), expiresAt}
 */
const db = require("../lib/db");
const { LIMITS, json, fail, readJsonBody, genId, baseUrlOf } = require("../lib/utils");

const MAX_IMAGES = 20;

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return fail(res, 405, "طريقة غير مسموحة — استخدم POST");

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return fail(res, e.code || 400, e.message);
  }
  if (!body || typeof body !== "object") return fail(res, 400, "JSON تالف — يلزم جسم بصيغة application/json");

  const images = (Array.isArray(body.images) ? body.images : []).map((u) => String(u || "").trim()).filter(Boolean);
  if (!images.length) return fail(res, 400, 'مطلوب حقل "images" — رابط صورة واحدة على الأقل (http/https مباشر)');
  if (images.length > MAX_IMAGES) return fail(res, 400, `أقصى عدد صور هو ${MAX_IMAGES}`);
  for (const u of images) {
    if (!/^https?:\/\//i.test(u)) {
      return fail(res, 400, "كل الصور يجب أن تكون روابط http/https مباشرة وعامة");
    }
  }

  const narrationText = typeof body.narration_text === "string" ? body.narration_text.trim() : "";
  const audioUrl = typeof body.audio_url === "string" ? body.audio_url.trim() : "";
  if (!narrationText && !audioUrl) {
    return fail(res, 400, 'مطلوب نص التعليق "narration_text" أو رابط صوت جاهز "audio_url"');
  }
  if (narrationText && audioUrl) {
    return fail(res, 400, "مرّر narration_text أو audio_url — ليس الاثنين معًا");
  }
  if (audioUrl && !/^https?:\/\//i.test(audioUrl)) {
    return fail(res, 400, "audio_url يجب أن يكون رابط http/https مباشرًا");
  }
  if (narrationText.length > 8000) {
    return fail(res, 400, "نص التعليق طويل جدًا (الحد 8000 حرف)");
  }

  const voiceLang = String(body.voice_lang || "ar").trim() || "ar";
  const perImage = Number(body.per_image_seconds ?? 5);
  if (!Number.isFinite(perImage) || perImage < 1 || perImage > 30) {
    return fail(res, 400, "per_image_seconds يجب أن يكون بين 1 و 30 ثانية");
  }
  const resolution = ["480p", "720p", "1080p"].includes(body.resolution) ? body.resolution : "720p";
  const aspect = ["16:9", "9:16", "1:1"].includes(body.aspect_ratio) ? body.aspect_ratio : "16:9";

  // تنظيف كسول للمهام المنتهية
  try {
    await db.cleanupExpired();
  } catch {
    /* التنظيف أفضلية */
  }

  const jobId = genId();
  const job = await db.insertJob({ id: jobId, status: "queued" });
  await db.setSlideshowMeta(jobId, {
    images,
    narration_text: narrationText,
    audio_url: audioUrl,
    voice_lang: voiceLang,
    per_image_seconds: perImage,
    resolution,
    aspect_ratio: aspect,
  });

  const base = baseUrlOf(req);
  return json(res, 201, {
    jobId,
    status: job.status,
    statusUrl: `${base}/api/slideshow/${jobId}`,
    processUrl: `${base}/api/slideshow/${jobId}/process`,
    expiresAt: job.expires_at,
  });
};
