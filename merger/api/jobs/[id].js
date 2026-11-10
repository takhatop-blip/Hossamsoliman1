/**
 * GET    /api/jobs/{id} — الحالة + التقدم (0-100) + الرابط عند الاكتمال
 * DELETE /api/jobs/{id} — حذف فوري شامل
 */
const db = require("../../lib/db");
const { json, fail, baseUrlOf } = require("../../lib/utils");

module.exports = async (req, res) => {
  const { id } = req.query;
  if (!id) return fail(res, 400, "معرف المهمة مطلوب");

  const job = await db.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");

  if (req.method === "DELETE") {
    await db.deleteJobAll(id);
    return json(res, 200, { ok: true, deleted: id });
  }
  if (req.method !== "GET") return fail(res, 405, "طريقة غير مسموحة — استخدم GET أو DELETE");

  const base = baseUrlOf(req);
  const out = {
    jobId: id,
    status: job.status,
    progress: Number(job.progress || 0),
    expiresAt: job.expires_at,
  };
  if (job.status === "done") {
    out.videoUrl = `${base}/api/jobs/${id}/video`;
    out.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
    out.size = Number(job.result_size || 0);
    out.duration = Number(job.result_duration || 0);
    out.resolution = job.result_resolution || null;
  }
  if (job.status === "failed") {
    out.error = job.error || "فشل الدمج";
  }
  return json(res, 200, out);
};
