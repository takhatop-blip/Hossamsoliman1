/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن)
 * ينزّل/يسحب المصادر ← يرمّز ← يحفظ، ويرجع مباشرة:
 * {status:"done", videoUrl, downloadUrl, size, duration, resolution, expiresAt}
 * لو المهمة قيد المعالجة فعله يرجع 202.
 * تقدم الخريطة: 0-40 سحب المصادر، 40-90 ترميز، 100 اكتمال.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const db = require("../../../lib/db");
const { LIMITS, json, fail, baseUrlOf, humanBytes } = require("../../../lib/utils");
const { downloadToTemp, mergeVideos } = require("../../../lib/ffmpeg");

const running = new Set(); // قفل بالذاكرة ضد التزامن داخل نفس النسخة

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return fail(res, 405, "طريقة غير مسموحة — استخدم POST");
  const { id } = req.query;
  if (!id) return fail(res, 400, "معرف المهمة مطلوب");

  const job = await db.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");

  // مكتملة سابقًا ⇒ نفس النتيجة (idempotent)
  if (job.status === "done") {
    return json(res, 200, doneResponse(id, job, baseUrlOf(req)));
  }
  if (job.status === "failed") {
    return fail(res, 409, `المهمة فشلت سابقًا: ${job.error || "غير معروف"} — أنشئ مهمة جديدة`);
  }
  if (job.status === "processing" || running.has(id)) {
    return json(res, 202, { status: "processing", progress: Number(job.progress || 0) });
  }

  running.add(id);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${id}-`));
  const localFiles = [];
  try {
    await db.updateJob(id, { status: "processing", progress: 0, error: null });
    const sources = await db.getSources(id);
    if (sources.length < 2) {
      throw Object.assign(new Error(`الدمج يحتاج مقطعَين على الأقل — المهمة تحتوي ${sources.length}`), { status: 400 });
    }
    if (sources.length > LIMITS.MAX_SOURCES) {
      throw Object.assign(new Error(`أقصى عدد مقاطع للدمج هو ${LIMITS.MAX_SOURCES}`), { status: 400 });
    }

    // ---------- 0-40: سحب المصادر ----------
    for (const s of sources) {
      const dest = path.join(tmpDir, `src-${s.seq}.bin`);
      if (s.kind === "url") {
        // التنزيل بمعدّل بايتات لفحص الحد أثناء العمل
        let reported = -1;
        await downloadToTemp(s.url, dest, (received) => {
          const frac = Math.min(0.99, received / (40 * 1024 * 1024)); // تقدير تفصيلي
          const pct = Math.min(40, Math.round(((localFiles.length + frac) / sources.length) * 40));
          if (pct !== reported) {
            reported = pct;
            void db.updateJob(id, { progress: pct });
          }
        });
      } else {
        // مصدر مرفوع: تحقق الاكتمال ثم التجميع من أجزاء Turso
        if (!s.size || s.uploaded_bytes < s.size) {
          throw Object.assign(
            new Error(`الملف "${s.name || s.seq}" غير مكتمل الرفع (${s.uploaded_bytes}/${s.size} بايت)`),
            { status: 409 }
          );
        }
        await db.writeSourceChunksToFile(id, s.seq, dest, fs);
      }
      localFiles.push(dest);
      const pct = Math.round(((localFiles.length) / sources.length) * 40);
      await db.updateJob(id, { progress: pct });
    }

    // ---------- 40-90: الترميز ----------
    const outPath = path.join(tmpDir, "merged.mp4");
    const meta = await mergeVideos(localFiles, outPath, (r) => {
      const pct = 40 + Math.round(r * 50);
      void db.updateJob(id, { progress: Math.min(90, pct) });
    });

    // ---------- حفظ الناتج في Turso ----------
    await db.updateJob(id, { progress: 95 });
    const size = await db.storeOutputFile(id, outPath, fs);
    // بعد نجاح الدمج نحذف أجزاء المصادر — الناتج فقط هو المطلوب
    await db.deleteSourceChunks(id);

    await db.updateJob(id, {
      status: "done",
      progress: 100,
      error: null,
      result_size: size,
      result_duration: Number(meta.duration.toFixed(2)),
      result_resolution: meta.resolution,
    });
    const updated = await db.getJob(id);
    return json(res, 200, doneResponse(id, updated, baseUrlOf(req)));
  } catch (e) {
    // فشل واضح برسالة وليس انهيارًا — الحالة failed مع تنظيف /tmp
    await db.updateJob(id, { status: "failed", error: (e.message || "فشل الدمج").slice(0, 500) }).catch(() => {});
    return fail(res, e.status || 500, e.message || "فشل الدمج");
  } finally {
    running.delete(id);
    // /tmp فقط أثناء المعالجة — نظّفه دائمًا
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* تجاهل */
    }
  }
};

function doneResponse(id, job, base) {
  return {
    status: "done",
    videoUrl: `${base}/api/jobs/${id}/video`,
    downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
    size: Number(job.result_size || 0),
    duration: Number(job.result_duration || 0),
    resolution: job.result_resolution,
    expiresAt: job.expires_at,
  };
}
