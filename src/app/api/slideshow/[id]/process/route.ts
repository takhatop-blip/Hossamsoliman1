/**
 * POST /api/slideshow/[id]/process — تنفيذ التعليق المصوّر كاملًا (متزامن)
 * ============================================================
 * المراحل: 0-30 تنزيل الصور | 30-55 توليد/تنزيل الصوت (TTS مجاني) | 55-95 ترميز | 100 اكتمال.
 * يعمل في دالة serverless مستقلة (maxDuration 300) — المنسّق يطلقه بنداء ذاتي
 * ثم يتابع الحالة من قاعدة البيانات مباشرة عبر get_task.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getSsJob, updateSsJob, storeSsOutputFile } from "@/lib/slideshow/jobs";
import { downloadToTemp } from "@/lib/slideshow/ffmpeg";
import { synthesizeNarration, audioDuration } from "@/lib/slideshow/tts";
import { buildSlideshow, canvasFor } from "@/lib/slideshow/builder";
import { slideshowResultBase } from "@/lib/slideshow/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const running = new Set<string>(); // قفل بالذاكرة ضد التزامن داخل نفس النسخة

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return Response.json({ error: "معرف المهمة مطلوب" }, { status: 400 });

  const job = await getSsJob(id);
  if (!job) {
    return Response.json({ error: "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)" }, { status: 404 });
  }
  if (job.status === "done") {
    return Response.json(donePayload(id, job, slideshowResultBase(req)));
  }
  if (job.status === "failed") {
    return Response.json(
      { error: `المهمة فشلت سابقًا: ${job.error || "غير معروف"} — أنشئ مهمة جديدة` },
      { status: 409 }
    );
  }
  if (job.status === "processing" || running.has(id)) {
    return Response.json({ status: "processing", progress: job.progress }, { status: 202 });
  }

  let meta: { images?: string[]; audio_url?: string; narration_text?: string; voice_lang?: string; per_image_seconds?: number; resolution?: string; aspect_ratio?: string };
  try {
    meta = JSON.parse(job.params_json || "{}");
  } catch {
    meta = {};
  }
  if (!Array.isArray(meta.images) || !meta.images.length) {
    return Response.json({ error: "معطيات المهمة مفقودة — أنشئ مهمة جديدة" }, { status: 409 });
  }
  const imageUrls: string[] = meta.images;

  running.add(id);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `slide-${id.slice(0, 8)}-`));
  try {
    await updateSsJob(id, { status: "processing", progress: 0, error: null });

    // ---------- 0-30: تنزيل الصور ----------
    const imageFiles: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const ext = /\.png(\?|$)/i.test(imageUrls[i]) ? ".png" : ".jpg";
      const dest = path.join(tmpDir, `img-${String(i).padStart(2, "0")}${ext}`);
      let reported = -1;
      await downloadToTemp(imageUrls[i], dest, (received) => {
        const frac = Math.min(0.99, received / (8 * 1024 * 1024));
        const pct = Math.min(30, Math.round(((i + frac) / imageUrls.length) * 30));
        if (pct !== reported) {
          reported = pct;
          void updateSsJob(id, { progress: pct });
        }
      });
      imageFiles.push(dest);
      await updateSsJob(id, { progress: Math.round(((i + 1) / imageUrls.length) * 30) });
    }

    // ---------- 30-55: الصوت (TTS مجاني أو رابط جاهز) ----------
    let audioPath: string | null = null;
    if (meta.audio_url) {
      audioPath = path.join(tmpDir, "narration-src");
      await downloadToTemp(meta.audio_url, audioPath);
    } else if (meta.narration_text) {
      const { audioPath: ttsPath } = await synthesizeNarration(meta.narration_text, tmpDir, {
        lang: meta.voice_lang || "ar",
        onProgress: (r) => {
          const pct = 30 + Math.round(r * 25);
          void updateSsJob(id, { progress: pct });
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
        void updateSsJob(id, { progress: Math.min(95, pct) });
      },
    });

    // ---------- حفظ الناتج في Turso ----------
    await updateSsJob(id, { progress: 97 });
    const size = await storeSsOutputFile(id, outPath);

    const base = slideshowResultBase(req);
    const videoUrl = `${base}/api/slideshow/${id}/video`;
    await updateSsJob(id, {
      status: "done",
      progress: 100,
      error: null,
      result_url: videoUrl,
      result_size: size,
      result_duration: Number(metaOut.duration.toFixed(2)),
      result_resolution: metaOut.resolution,
    });
    const updated = await getSsJob(id);
    return Response.json(donePayload(id, updated ?? job, base));
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)) || "فشل بناء الفيديو";
    await updateSsJob(id, { status: "failed", error: msg.slice(0, 500) }).catch(() => {});
    return Response.json({ error: msg.slice(0, 500) }, { status: 500 });
  } finally {
    running.delete(id);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* تجاهل */
    }
  }
}

function donePayload(id: string, job: { result_url?: string | null; result_size?: number | null; result_duration?: number | null; result_resolution?: string | null; expires_at?: string | null }, base: string) {
  const videoUrl = job.result_url || `${base}/api/slideshow/${id}/video`;
  return {
    status: "done" as const,
    videoUrl,
    downloadUrl: `${videoUrl}?download=1`,
    size: job.result_size ?? 0,
    duration: job.result_duration ?? 0,
    resolution: job.result_resolution ?? undefined,
    expiresAt: job.expires_at ?? undefined,
  };
}
