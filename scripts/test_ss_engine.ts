/**
 * اختبار محلي لمحرك التعليق المصوّر (bun scripts/test_ss_engine.ts)
 * 1) TTS عربي عبر Google Translate (مجاني)
 * 2) تنزيل صورتين من Pollinations
 * 3) بناء MP4 بصوت الراوي + فحص الناتج بـ ffprobe
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));
  console.log("tmp:", tmp);

  // 1) صور من Pollinations (روابط مباشرة)
  const { downloadToTemp } = await import("../src/lib/slideshow/ffmpeg");
  const img1 = path.join(tmp, "img-00.jpg");
  const img2 = path.join(tmp, "img-01.jpg");
  await downloadToTemp("https://picsum.photos/id/1024/1280/720.jpg", img1);
  await downloadToTemp("https://picsum.photos/id/1074/1280/720.jpg", img2);
  console.log("images:", fs.statSync(img1).size, fs.statSync(img2).size, "bytes");

  // 2) TTS عربي
  const { synthesizeNarration, audioDuration } = await import("../src/lib/slideshow/tts");
  const narr = "في قلب الغابة الخضراء، كان الأسد الصغير يبحث عن صديق يلعب معه. وفي يوم من الأيام، وجد أرنبًا لطيفًا بين الزهور، فصارا صديقين لا يفترقان.";
  const t0 = Date.now();
  const { audioPath, chunks } = await synthesizeNarration(narr, tmp, { lang: "ar" });
  const A = audioDuration(audioPath);
  console.log(`tts: ${chunks} chunks, duration=${A.toFixed(2)}s, took ${((Date.now() - t0) / 1000).toFixed(1)}s, size=${fs.statSync(audioPath).size}`);

  // 3) بناء الفيديو
  const { buildSlideshow, canvasFor } = await import("../src/lib/slideshow/builder");
  const { W, H } = canvasFor("480p", "16:9");
  const outPath = path.join(tmp, "slideshow.mp4");
  const t1 = Date.now();
  const meta = await buildSlideshow({
    imageFiles: [img1, img2],
    audioPath,
    outPath,
    W,
    H,
    perImageSecs: 5,
    onProgress: (r) => process.stdout.write(`\rencode: ${Math.round(r * 100)}%`),
  });
  console.log(`\nbuilt: ${JSON.stringify(meta)} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // 4) فحص الناتج
  const { execFileSync } = await import("node:child_process");
  const { FFPROBE_BIN, ensureExecutable } = await import("../src/lib/slideshow/ffmpeg");
  const probeOut = execFileSync(ensureExecutable(FFPROBE_BIN), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outPath]).toString();
  const j = JSON.parse(probeOut);
  const v = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === "video");
  const a = (j.streams || []).find((s: { codec_type: string }) => s.codec_type === "audio");
  console.log("video stream:", v ? `${v.codec_name} ${v.width}x${v.height} fps=${v.r_frame_rate}` : "MISSING");
  console.log("audio stream:", a ? `${a.codec_name} ${a.sample_rate}Hz ch=${a.channels}` : "MISSING");
  console.log("format duration:", j.format?.duration, "size:", j.format?.size);

  // 5) تخزين في Turso محليًا؟ لا — نكتفي بالملف. حفظ المسار للفحص اليدوي
  fs.copyFileSync(outPath, "/home/z/my-project/scripts/ss_test_output.mp4");
  console.log("copied to scripts/ss_test_output.mp4");
  console.log("ENGINE_OK");
}

main().catch((e) => {
  console.error("ENGINE_FAIL:", e?.message || e);
  process.exit(1);
});
