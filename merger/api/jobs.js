/**
 * POST /api/jobs — إنشاء مهمة دمج
 * يقبل: {"videos":["رابط1","رابط2"]} أو
 *       {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * يرجع 201: {jobId, status:"queued"|"uploading", statusUrl, processUrl, expiresAt, uploads?, uploadChunkBytes?}
 */
const db = require("../lib/db");
const { LIMITS, json, fail, readJsonBody, genId, baseUrlOf } = require("../lib/utils");

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

  // توحيد المصادر من الشكلين المقبولين
  let sources = [];
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u || "").trim() }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) => {
      const kind = s && s.kind === "file" ? "file" : "url";
      if (kind === "url") return { kind: "url", url: String(s.url || "").trim() };
      return {
        kind: "file",
        name: String(s.name || `file-${genId()}`),
        size: Number(s.size || 0),
        mime: String(s.mime || "video/mp4"),
      };
    });
  } else {
    return fail(res, 400, 'مطلوب حقل "videos" (مصفوفة روابط) أو "sources" (مصفوفة مصادر)');
  }

  if (sources.length < 1) return fail(res, 400, "أضف رابطًا واحدًا على الأقل — الدمج النهائي يحتاج مقطعَين على الأقل");
  if (sources.length > LIMITS.MAX_SOURCES) {
    return fail(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.MAX_SOURCES}`);
  }
  for (const s of sources) {
    if (s.kind === "url") {
      if (!/^https?:\/\//i.test(s.url || "")) {
        return fail(res, 400, "كل المقاطع يجب أن تكون روابط http/https مباشرة وعامة");
      }
    } else {
      if (!s.size || s.size <= 0) return fail(res, 400, `الملف "${s.name}" بحجم غير صالح`);
      if (s.size > LIMITS.SOURCE_MAX_MB * 1024 * 1024) {
        return fail(res, 413, `حجم الملف "${s.name}" يتجاوز ${LIMITS.SOURCE_MAX_MB}MB`);
      }
    }
  }

  // تنظيف كسول للمهام المنتهية
  try {
    await db.cleanupExpired();
  } catch {
    /* التنظيف أفضلية */
  }

  const hasFiles = sources.some((s) => s.kind === "file");
  const jobId = genId();
  const job = await db.insertJob({ id: jobId, status: hasFiles ? "uploading" : "queued" });
  await db.insertSources(jobId, sources);

  const base = baseUrlOf(req);
  const resp = {
    jobId,
    status: job.status,
    statusUrl: `${base}/api/jobs/${jobId}`,
    processUrl: `${base}/api/jobs/${jobId}/process`,
    expiresAt: job.expires_at,
  };
  if (hasFiles) {
    resp.uploads = sources
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.kind === "file")
      .map(({ s, i }) => ({
        seq: i,
        name: s.name,
        size: s.size,
        uploadUrl: `${base}/api/upload?job=${jobId}&seq=${i}`,
      }));
    resp.uploadChunkBytes = LIMITS.UPLOAD_CHUNK_BYTES;
  }
  return json(res, 201, resp);
};
