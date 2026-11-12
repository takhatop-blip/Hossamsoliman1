/**
 * POST /api/slideshow/{id}/process — تنفيذ التعليق المصوّر كاملًا (متزامن)
 * المراحل: 0-30 تنزيل الصور | 30-55 توليد/تنزيل الصوت (TTS مجاني) | 55-95 ترميز | 100 اكتمال
 * يرجع مباشرة: {status:"done", videoUrl, downloadUrl, size, duration, resolution, expiresAt}
 * لو قيد المعالجة فعله يرجع 202.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const db = require("../../../lib/db");
const { json, fail, baseUrlOf } = require("../../../lib/utils");
const { downloadToTemp } = require("../../../lib/ffmpeg");
const { synthesizeNarration, audioDuration } = require("../../../lib/tts");
const { buildSlideshow, canvasFor } = require("../../../lib/slideshow");

const running = new Set(); // قفل بالذاكرة ضد التزامن داخل نفس النسخة

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return fail(res, 405, "طريقة غير مسموحة — استخدم POST");
  const { id } = req.query;
  if (!id) return fail(res, 400, "معرف المهمة مطلوب");

  const job = await db.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");

  if (job.status === "done") return json(res, 200, doneResponse(id, job, baseUrlOf(req)));
  if (job.status === "failed") {
    return fail(res, 409, `المهمة فشلت سابقًا: ${job.error || "غير معروف"} — أنشئ مهمة جديدة`);
  }
  if (job.status === "processing" || running.has(id)) {
    return json(res, 202, { status: "processing", progress: Number(job.progress || 0) });
  }

  const meta = await db.getSlideshowMeta(id);
  if (!meta || !Array.isArray(meta.images) || !meta.images.length) {
    return fail(res, 409, "معطيات المهمة مفقودة — أنشئ مهمة جديدة");
  }

  running.add(id);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `slide-${id}-`));
  try {
    await db.updateJob(id, { status: "processing", progress: 0, error: null });

    // ---------- 0-30: تنزيل الصور ----------
    const imageFiles = [];
    for (let i = 0; i < meta.images.length; i++) {
      const ext = /\.png(\?|$)/i.test(meta.images[i]) ? ".png" : ".jpg";
      const dest = path.join(tmpDir, `img-${String(i).padStart(2, "0")}${ext}`);
      let reported = -1;
      await downloadToTemp(meta.images[i], dest, (received) => {
        const frac = Math.min(0.99, received / (8 * 1024 * 1024));
        const pct = Math.min(30, Math.round(((i + frac) / meta.images.length) * 30));
        if (pct !== reported) {
          reported = pct;
          void db.updateJob(id, { progress: pct });
        }
      });
      imageFiles.push(dest);
      await db.updateJob(id, { progress: Math.round(((i + 1) / meta.images.length) * 30) });
    }

    // ---------- 30-55: الصوت (TTS مجاني أو رابط جاهز) ----------
    let audioPath = null;
    if (meta.audio_url) {
      audioPath = path.join(tmpDir, "narration-src");
      await downloadToTemp(meta.audio_url, audioPath);
    } else if (meta.narration_text) {
      const { audioPath: ttsPath } = await synthesizeNarration(meta.narration_text, tmpDir, {
        lang: meta.voice_lang || "ar",
        onProgress: (r) => {
          const pct = 30 + Math.round(r * 25);
          void db.updateJob(id, { progress: pct });
        },
      });
      audioPath = ttsPath;
    }
    if (audioPath) {
      const A = audioDuration(audioPath);
      if (!A || A < 0.5) throw new Error("الصوت المولّد فارغ أو تالف");
    }

    // ---------- 55-95: الترميز ----------
    const { W, H } = canvasFor(meta.resolution || "720p", meta.aspect_ratio || "16:9");
    const outPath = path.join(tmpDir, "slideshow.mp4");
    const metaOut = await buildSlideshow({
      imageFiles,
      audioPath,
      outPath,
      W,
      H,
      perImageSecs: meta.per_image_seconds || 5,
      onProgress: (r) => {
        const pct = 55 + Math.round(r * 40);
        void db.updateJob(id, { progress: Math.min(95, pct) });
      },
    });

    // ---------- حفظ الناتج في Turso ----------
    await db.updateJob(id, { progress: 97 });
    const size = await db.storeOutputFile(id, outPath, fs);

    await db.updateJob(id, {
      status: "done",
      progress: 100,
      error: null,
      result_size: size,
      result_duration: Number(metaOut.duration.toFixed(2)),
      result_resolution: metaOut.resolution,
    });
    const updated = await db.getJob(id);
    return json(res, 200, doneResponse(id, updated, baseUrlOf(req)));
  } catch (e) {
    await db.updateJob(id, { status: "failed", error: (e.message || "فشل بناء الفيديو").slice(0, 500) }).catch(() => {});
    return fail(res, e.status || 500, e.message || "فشل بناء الفيديو");
  } finally {
    running.delete(id);
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
