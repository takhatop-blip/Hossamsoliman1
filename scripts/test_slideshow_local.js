/* اختبار محلي: TTS عربي + بناء slideshow من صورتين */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { splitTextChunks, synthesizeNarration, audioDuration } = require("../merger/lib/tts");
const { buildSlideshow, canvasFor } = require("../merger/lib/slideshow");
const { downloadToTemp } = require("../merger/lib/ffmpeg");

const TEXT =
  "مرحبًا بكم في هذا الفيديو الرائع! اليوم سنتعرف على قصة مذهلة عن القطط البرتقالية. " +
  "فهي من ألطف الكائنات التي يمكن أن نراها في منازلنا، وتحب الجلوس على النوافذ لمشاهدة الغروب. " +
  "شكرًا لمشاهدتكم، ولا تنسوا الاشتراك في القناة لمزيد من القصص الجميلة!";

async function main() {
  // إعادة استخدام ملفات الاختبار السابق إن وجدت (توفير وقت حد المعدل)
  const reuse = "/tmp/ss-test-qukyQg";
  const dir =
    fs.existsSync(path.join(reuse, "narration.mp3")) &&
    fs.existsSync(path.join(reuse, "img-0.jpg")) &&
    fs.existsSync(path.join(reuse, "img-1.jpg"))
      ? reuse
      : fs.mkdtempSync(path.join(os.tmpdir(), "ss-test-"));
  console.log("dir:", dir, fs.existsSync(path.join(dir, "narration.mp3")) ? "(reused)" : "(fresh)");

  if (!fs.existsSync(path.join(dir, "narration.mp3"))) {
    console.log("== TTS synthesis ==");
    const t0 = Date.now();
    const r = await synthesizeNarration(TEXT, dir, { lang: "ar" });
    audioPath = r.audioPath;
    console.log(`TTS OK: ${r.chunks} chunks, ${audioDuration(audioPath).toFixed(2)}s, ${Date.now() - t0}ms`);
    console.log("== download images (45s/IP) ==");
    await downloadToTemp("https://image.pollinations.ai/prompt/a%20cute%20orange%20cat%20sitting%20on%20a%20windowsill%20at%20sunset?width=1280&height=720&seed=11&model=flux&nologo=true", path.join(dir, "img-0.jpg"));
    await new Promise((res) => setTimeout(res, 46_000));
    await downloadToTemp("https://image.pollinations.ai/prompt/sunset%20over%20the%20nile%20river%20golden%20sky?width=1280&height=720&seed=22&model=flux&nologo=true", path.join(dir, "img-1.jpg"));
  }
  audioPath = path.join(dir, "narration.mp3");
  const imageFiles = [path.join(dir, "img-0.jpg"), path.join(dir, "img-1.jpg")];
  console.log("inputs:", fs.statSync(imageFiles[0]).size, fs.statSync(imageFiles[1]).size, fs.statSync(audioPath).size);

  console.log("== buildSlideshow 720p 16:9 ==");
  const { W, H } = canvasFor("720p", "16:9");
  console.log("canvas:", W, H);
  const out = path.join(dir, "out.mp4");
  const t1 = Date.now();
  const meta = await buildSlideshow({
    imageFiles,
    audioPath,
    outPath: out,
    W,
    H,
    onProgress: (r) => process.stdout.write(`\r  encode: ${Math.round(r * 100)}%`),
  });
  console.log(`\nENCODE OK in ${((Date.now() - t1) / 1000).toFixed(1)}s:`, meta);
  console.log("output:", out, fs.statSync(out).size, "bytes");
  console.log("KEEPDIR", dir);
}

let audioPath = null;

main().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exitCode = 1; // لا exit فوري — يدع stdout يُفرّغ
});
