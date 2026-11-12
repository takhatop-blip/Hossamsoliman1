/**
 * GET /api/slideshow/{id} — حالة مهمة تعليق مصوّر
 * ترجع نفس شكل مهام الدمج: {jobId, status, progress, videoUrl?, size?, duration?, resolution?, error?, expiresAt}
 * (الناتج يُبَث من /api/jobs/{id}/video — جدول المهام مشترك)
 */
const db = require("../../lib/db");
const { json, fail, baseUrlOf } = require("../../lib/utils");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return fail(res, 405, "طريقة غير مسموحة — استخدم GET");
  const { id } = req.query;
  if (!id) return fail(res, 400, "معرف المهمة مطلوب");

  const job = await db.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");

  const base = baseUrlOf(req);
  const out = {
    jobId: id,
    status: job.status,
    progress: Number(job.progress || 0),
    error: job.error || undefined,
    expiresAt: job.expires_at,
  };
  if (job.status === "done") {
    out.videoUrl = `${base}/api/jobs/${id}/video`;
    out.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
    out.size = Number(job.result_size || 0);
    out.duration = Number(job.result_duration || 0);
    out.resolution = job.result_resolution || undefined;
  }
  return json(res, 200, out);
};
