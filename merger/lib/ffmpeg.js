/**
 * محرك الدمج — ffmpeg/ffprobe داخل الدالة نفسها
 * ============================================================
 * - توحيد كل المصادر: scale+pad إلى أكبر دقة بين المدخلات (حد 1920×1080، أبعاد زوجية)،
 *   fps=30، setsar=1، yuv420p ثم concat — ومصدر بلا صوت يُعطى مسارًا صامتًا anullsrc.
 * - الترميز: libx264 CRF 18 + AAC 192k/44100 + +faststart ⇒ MP4 يعمل فورًا على الويب.
 * - تقدم الترميز يُقرأ من -progress pipe:1 (out_time_us) ويُحسب من المدة الإجمالية.
 */
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { LIMITS, humanBytes } = require("./utils");

const FFMPEG_BIN = require("ffmpeg-static");
const FFPROBE_BIN = require("ffprobe-static").path;

/** ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة: نسخ إلى /tmp بصلاحية 755 */
function ensureExecutable(bin) {
  if (!bin) throw new Error("ثنائي ffmpeg/ffprobe غير موجود");
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    const tmp = path.join(os.tmpdir(), path.basename(bin));
    fs.copyFileSync(bin, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

/** ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت */
function probe(file) {
  const bin = ensureExecutable(FFPROBE_BIN);
  const out = execFileSync(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    file,
  ], { maxBuffer: 32 * 1024 * 1024 }).toString("utf8");
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("الملف لا يحتوي مسار فيديو صالح");
  const [rn, rd] = String(v.r_frame_rate || "30/1").split("/").map(Number);
  const fps = rd ? rn / rd : 30;
  const duration = Number((j.format && j.format.duration) || v.duration || 0);
  return {
    width: v.width || 0,
    height: v.height || 0,
    fps: Math.round(fps * 100) / 100,
    duration,
    hasAudio: Boolean(a),
  };
}

/** تنزيل مصدر رابط إلى /tmp مع فحص الحجم أثناء التنزيل بمعدّل بايتات */
async function downloadToTemp(url, dest, onBytes) {
  const maxBytes = LIMITS.SOURCE_MAX_MB * 1024 * 1024;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (HTTP ${res.status})`);
    }
    let received = 0;
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        out.destroy();
        throw new Error(`حجم المصدر يتجاوز الحد (${LIMITS.SOURCE_MAX_MB}MB لكل رابط)`);
      }
      if (onBytes) onBytes(received);
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once("drain", r));
      }
    }
    await new Promise((r) => out.end(r));
    if (received === 0) throw new Error("المصدر فارغ (0 بايت)");
    return received;
  } finally {
    clearTimeout(timeout);
  }
}

/** تشغيل ffmpeg مع قراءة التقدم من stdout */
function runFfmpeg(args, { totalDurationUs, onProgress }) {
  return new Promise((resolve, reject) => {
    const bin = ensureExecutable(FFMPEG_BIN);
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    let stdoutBuf = "";
    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && totalDurationUs > 0 && onProgress) {
          const ratio = Math.min(1, Number(m[1]) / totalDurationUs);
          onProgress(ratio);
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on("error", (e) => reject(new Error(`ffmpeg: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg فشل (رمز ${code}): ${stderrTail.split("\n").slice(-3).join(" | ")}`));
    });
  });
}

/**
 * دمج ملفات محلية إلى MP4 عالي الجودة.
 * onProgress(ratio 0..1) خاص بمرحلة الترميز فقط (40–90 في الخريطة العامة).
 */
async function mergeVideos(files, outPath, onProgress) {
  if (!files.length) throw new Error("لا توجد ملفات للدمج");
  const probes = [];
  for (const f of files) probes.push(probe(f));

  // أكبر دقة بين المدخلات مع حد 1920×1080 وأبعاد زوجية
  const maxW = Math.min(1920, Math.max(...probes.map((p) => p.width)));
  const maxH = Math.min(1080, Math.max(...probes.map((p) => p.height)));
  const W = maxW % 2 ? maxW - 1 : maxW;
  const H = maxH % 2 ? maxH - 1 : maxH;

  const totalDuration = probes.reduce((s, p) => s + p.duration, 0);
  if (totalDuration > LIMITS.MAX_TOTAL_DURATION_SEC) {
    throw new Error(
      `مجموع مدد المقاطع (${Math.round(totalDuration)} ث) يتجاوز الحد (${LIMITS.MAX_TOTAL_DURATION_SEC} ثانية)`
    );
  }

  const chains = [];
  const concatParts = [];
  probes.forEach((p, i) => {
    chains.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    concatParts.push(`[v${i}]`, `[a${i}]`);
    if (p.hasAudio) {
      chains.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت ⇒ مسار صامت بنفس مدته بدل أن يفشل الدمج
      chains.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100[d${i}];` +
          `[d${i}]atrim=0:${p.duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
      );
    }
  });
  chains.push(`${concatParts.join("")}concat=n=${probes.length}:v=1:a=1[vout][aout]`);

  const args = ["-y", "-nostats", "-progress", "pipe:1"];
  for (const f of files) args.push("-i", f);
  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-crf", "18", "-preset", LIMITS.FFMPEG_PRESET, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-movflags", "+faststart",
    outPath
  );

  const totalUs = Math.round(totalDuration * 1_000_000);
  await runFfmpeg(args, {
    totalDurationUs: totalUs,
    onProgress: (r) => onProgress && onProgress(r),
  });

  const stat = fs.statSync(outPath);
  if (stat.size > LIMITS.OUTPUT_MAX_MB * 1024 * 1024) {
    throw new Error(`حجم الناتج (${humanBytes(stat.size)}) يتجاوز الحد (${LIMITS.OUTPUT_MAX_MB}MB)`);
  }
  return {
    size: stat.size,
    duration: totalDuration,
    resolution: `${W}x${H}`,
  };
}

module.exports = { ensureExecutable, probe, downloadToTemp, mergeVideos, FFMPEG_BIN, FFPROBE_BIN };
