/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
 * Content-Type: application/octet-stream — إعادة الرفع لنفس الجزء تستبدله بأمان.
 */
const db = require("../lib/db");
const { LIMITS, json, fail, readRawBody } = require("../lib/utils");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return fail(res, 405, "طريقة غير مسموحة — استخدم POST");

  const jobId = String(req.query.job || "");
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
    return fail(res, 400, "معطيات الرفع ناقصة — يلزم job و seq و chunk");
  }

  const job = await db.getJob(jobId);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");
  if (!["queued", "uploading"].includes(job.status)) {
    return fail(res, 409, `لا يمكن الرفع في حالة "${job.status}"`);
  }

  const sources = await db.getSources(jobId);
  const src = sources.find((s) => s.seq === seq);
  if (!src) return fail(res, 404, "المصدر غير موجود في هذه المهمة");
  if (src.kind !== "file") return fail(res, 400, "هذا المصدر رابط وليس ملفًا — لا يحتاج رفعًا");

  let buf;
  try {
    buf = await readRawBody(req, LIMITS.UPLOAD_CHUNK_BYTES);
  } catch (e) {
    return fail(res, e.code || 400, e.message);
  }
  if (!buf.length) return fail(res, 400, "الجزء فارغ");

  // فحص الحد أثناء الرفع: لا تجاوز لحجم الملف المعلن (بهامش صغير لاختلاف الحسابات)
  const projected = src.uploaded_bytes + buf.length;
  if (src.size && projected > src.size + 64 * 1024) {
    return fail(res, 413, `الحجم المرفوع سيتجاوز حجم الملف المعلن (${src.size} بايت)`);
  }
  if (src.size && src.size > LIMITS.SOURCE_MAX_MB * 1024 * 1024) {
    return fail(res, 413, `حجم الملف يتجاوز ${LIMITS.SOURCE_MAX_MB}MB`);
  }

  await db.insertSourceChunk(jobId, seq, chunk, buf);
  await db.addUploadedBytes(jobId, seq, buf.length);

  // هل اكتمل رفع كل ملفات المهمة؟ ⇒ queued
  const after = await db.getSources(jobId);
  const files = after.filter((s) => s.kind === "file");
  const allDone = files.every((s) => s.size && s.uploaded_bytes >= s.size);
  if (allDone && job.status === "uploading") {
    await db.updateJob(jobId, { status: "queued" });
  }

  return json(res, 200, {
    ok: true,
    received: buf.length,
    uploadedBytes: src.uploaded_bytes + buf.length,
    totalBytes: src.size,
    status: allDone ? "queued" : "uploading",
  });
};
