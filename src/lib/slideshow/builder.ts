/**
 * بناء فيديو تعليق مصوّر — صور + صوت راوٍ (منقول من خدمة الدمج)
 * ============================================================
 * المدخل: ملفات صور محلية + ملف صوتي محلي (اختياري).
 * - الصوت موجود: توزيع الصور بالتساوي على مدته (الصورة الأخيرة أطول قليلًا كهامش)
 *   ثم -shortest ⇒ مدة الفيديو = مدة الصوت تمامًا.
 * - بلا صوت: مدة ثابتة لكل صورة (perImageSecs) مع مسار صامت.
 * - كل صورة: scale+pad إلى الكانفس (أبعاد زوجية)، fps=25، yuv420p، ثم concat.
 * - الترميز: libx264 CRF 20 + AAC 128k + faststart.
 */
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, LIMITS, humanBytes } from "./ffmpeg";

/** أبعاد الكانفس من الدقة + نسبة الأبعاد (أبعاد زوجية) */
export function canvasFor(resolution: string, aspect: string): { W: number; H: number } {
  const base = resolution === "1080p" ? 1080 : resolution === "480p" ? 480 : 720;
  let W: number;
  let H: number;
  if (aspect === "9:16") {
    H = base;
    W = Math.round((base * 9) / 16);
  } else if (aspect === "1:1") {
    W = base;
    H = base;
  } else {
    // 16:9 (افتراضي)
    W = Math.round((base * 16) / 9);
    H = base;
  }
  return { W: Math.round(W / 2) * 2, H: Math.round(H / 2) * 2 };
}

/**
 * بناء الفيديو النهائي.
 * imageFiles: مسارات صور بالترتيب | audioPath: ملف صوت أو null
 * perImageSecs: مدة الصورة عند غياب الصوت (افتراضي 5)
 */
export async function buildSlideshow({
  imageFiles,
  audioPath,
  outPath,
  W,
  H,
  perImageSecs = 5,
  onProgress,
}: {
  imageFiles: string[];
  audioPath: string | null;
  outPath: string;
  W: number;
  H: number;
  perImageSecs?: number;
  onProgress?: (ratio: number) => void;
}): Promise<{ size: number; duration: number; resolution: string }> {
  if (!imageFiles.length) throw new Error("لا توجد صور لبناء الفيديو");
  if (imageFiles.length > 20) throw new Error("أقصى عدد صور هو 20");

  // مدد الصور
  let durations: number[];
  let totalDuration: number;
  if (audioPath) {
    const { audioDuration } = await import("./ffmpeg");
    const A = audioDuration(audioPath);
    if (!A || A < 0.5) throw new Error("الصوت المولّد فارغ أو تالف");
    const per = A / imageFiles.length;
    durations = imageFiles.map((_, i) =>
      i === imageFiles.length - 1 ? per + 1.0 : per // هامش للأخيرة ثم -shortest يقصّ على الصوت
    );
    totalDuration = A;
  } else {
    const per = Math.min(30, Math.max(1, perImageSecs));
    durations = imageFiles.map(() => per);
    totalDuration = per * imageFiles.length;
  }
  if (totalDuration > LIMITS.MAX_TOTAL_DURATION_SEC) {
    throw new Error(`مدة الفيديو (${Math.round(totalDuration)} ث) تتجاوز الحد (${LIMITS.MAX_TOTAL_DURATION_SEC} ث)`);
  }

  const chains: string[] = [];
  const concatParts = imageFiles.map((_, i) => `[v${i}]`).join("");
  imageFiles.forEach((_, i) => {
    chains.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=25,format=yuv420p[v${i}]`
    );
  });

  const args: string[] = ["-y", "-nostats", "-progress", "pipe:1"];
  imageFiles.forEach((f, i) => {
    args.push("-loop", "1", "-t", durations[i].toFixed(3), "-i", f);
  });

  const hasAudio = Boolean(audioPath);
  if (hasAudio && audioPath) {
    const ai = imageFiles.length;
    args.push("-i", audioPath);
    chains.push(`[${ai}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  } else {
    chains.push(
      `anullsrc=channel_layout=stereo:sample_rate=44100[d0];` +
        `[d0]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`
    );
  }
  chains.push(`${concatParts}concat=n=${imageFiles.length}:v=1:a=0[vout]`);

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-crf", "20", "-preset", LIMITS.FFMPEG_PRESET, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-movflags", "+faststart"
  );
  if (hasAudio) args.push("-shortest");
  args.push(outPath); // ملف الإخراج — يجب أن يكون آخر وسيطة (بدونه يفشل ربط الغراف)

  const totalUs = Math.round(totalDuration * 1_000_000);
  try {
    await runFfmpeg(args, {
      totalDurationUs: totalUs,
      onProgress: (r) => onProgress && onProgress(r),
    });
  } catch (e) {
    // تشخيص: أعد رمي الخطأ مع الأمر كاملًا (بلا مسارات /tmp الطويلة)
    const msg = e instanceof Error ? e.message : String(e);
    const brief = args.map((a) => (String(a).startsWith("/") ? path.basename(String(a)) : a)).join(" ");
    throw new Error(`${msg}\nCMD: ffmpeg ${brief.slice(0, 1200)}`);
  }

  const stat = fs.statSync(outPath);
  if (stat.size > LIMITS.OUTPUT_MAX_MB * 1024 * 1024) {
    throw new Error(`حجم الناتج (${humanBytes(stat.size)}) يتجاوز الحد (${LIMITS.OUTPUT_MAX_MB}MB)`);
  }
  return { size: stat.size, duration: totalDuration, resolution: `${W}x${H}` };
}
