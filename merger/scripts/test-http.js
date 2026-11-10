/**
 * اختبار HTTP كامل ضد خادم التطوير (server.js على 3101)
 * ============================================================
 * 1) GET /api/config → 200
 * 2) إنشاء مهمة من روابط عامة → دمج → الحالة done
 * 3) بث الناتج: 200 ثم Range → 206 + Content-Range صحيح
 * 4) مهمة مختلطة (رابط + ملف مرفوع بالأجزاء)
 * 5) حذف → GET يعطي 404
 * 6) مهمة غير موجودة → 404
 * 7) JSON تالف → 400
 * 8) قائمة فارغة (videos: []) → 400
 * 9) مقطع واحد → process يفشل برسالة عربية
 * 10) upload لجزء كبير جدًا → 413
 */
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.TEST_BASE || "http://localhost:3101";
const URL1 = "https://www.w3schools.com/html/mov_bbb.mp4";
const URL2 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";

let passed = 0;
let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`);
  }
}

async function jfetch(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, opts);
  let body = null;
  const text = await r.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 100) };
  }
  return { status: r.status, body, headers: r.headers };
}

async function main() {
  console.log(`\n=== 1) config ===`);
  const cfg = await jfetch("/api/config");
  ok("GET /api/config يعمل", cfg.status === 200 && cfg.body.version, JSON.stringify(cfg.body.limits?.maxSources ? { max: cfg.body.limits.maxSources } : cfg.body));

  console.log(`\n=== 2) مهمة من روابط → دمج ===`);
  const created = await jfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [URL1, URL2] }),
  });
  ok("إنشاء مهمة 201", created.status === 201 && created.body.jobId, created.body.jobId);
  ok("statusUrl و processUrl موجودان", Boolean(created.body.statusUrl && created.body.processUrl));
  ok("expiresAt بعد 24 ساعة تقريبًا", Boolean(created.body.expiresAt) && Date.parse(created.body.expiresAt) - Date.now() > 23 * 3600e3);

  const jobId = created.body.jobId;
  const t0 = Date.now();
  const proc = await jfetch(`/api/jobs/${jobId}/process`, { method: "POST" });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok("الدمج اكتمل 200", proc.status === 200 && proc.body.status === "done", `${secs}s`);
  ok("videoUrl على نطاق الخدمة", typeof proc.body.videoUrl === "string" && proc.body.videoUrl.startsWith(BASE), proc.body.videoUrl);
  ok("نتيجة بحجم ومدة", proc.body.size > 0 && proc.body.duration > 0, `${proc.body.resolution} ${Math.round(proc.body.size / 1024)}KB`);

  console.log(`\n=== 3) بث الناتج + Range ===`);
  const head = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  const buf = Buffer.from(await head.arrayBuffer());
  ok("بث كامل 200", head.status === 200 && buf.length === proc.body.size, `${buf.length} بايت`);
  const ranged = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-1023" } });
  const rbuf = Buffer.from(await ranged.arrayBuffer());
  ok("Range يعطي 206", ranged.status === 206 && rbuf.length === 1024);
  ok("Content-Range صحيح", ranged.headers.get("content-range") === `bytes 0-1023/${proc.body.size}`, ranged.headers.get("content-range"));
  ok("Accept-Ranges bytes", ranged.headers.get("accept-ranges") === "bytes");
  const mid = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: `bytes=100-${Math.min(999, proc.body.size - 1)}` } });
  ok("مدى داخلي 206", mid.status === 206);
  const dl = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`);
  ok("download=1 يعطي Content-Disposition", dl.headers.get("content-disposition")?.includes("attachment"), dl.headers.get("content-disposition"));
  await dl.arrayBuffer();
  // تطابق أول 1KB من البث الكامل والمدى
  ok("المدى مطابق للبث الكامل", rbuf.equals(buf.subarray(0, 1024)));

  console.log(`\n=== 4) مهمة مختلطة (رابط + ملف مرفوع) ===`);
  // ملف محلي صغير مولد بـ ffmpeg
  const os_ = require("node:os");
  const { spawnSync } = require("node:child_process");
  const { FFMPEG_BIN } = require("../lib/ffmpeg");
  const localFile = path.join(os_.tmpdir(), "http-test-local.mp4");
  spawnSync(FFMPEG_BIN, ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=1.5", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", localFile], { stdio: "pipe" });
  const fbuf = fs.readFileSync(localFile);

  const mix = await jfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [{ kind: "url", url: URL1 }, { kind: "file", name: "local.mp4", size: fbuf.length, mime: "video/mp4" }],
    }),
  });
  ok("إنشاء مهمة مختلطة 201 مع uploads[]", mix.status === 201 && Array.isArray(mix.body.uploads) && mix.body.uploads.length === 1, mix.body.status);
  ok("status=uploading عند وجود ملفات", mix.body.status === "uploading");
  const mixId = mix.body.jobId;
  const up = mix.body.uploads[0];
  const CHUNK = mix.body.uploadChunkBytes || 4 * 1024 * 1024;
  let uploadedAll = true;
  for (let k = 0; k * CHUNK < fbuf.length; k++) {
    const part = fbuf.subarray(k * CHUNK, Math.min((k + 1) * CHUNK, fbuf.length));
    const ur = await fetch(up.uploadUrl + "&chunk=" + k, { method: "POST", body: part, headers: { "Content-Type": "application/octet-stream" } });
    if (!ur.ok) uploadedAll = false;
  }
  ok("رفع الأجزاء نجح", uploadedAll);
  // جزء أكبر من الحد → 413 (قبل بدء المعالجة وحالة uploading)
  const big = await fetch(up.uploadUrl + "&chunk=99", {
    method: "POST",
    body: Buffer.alloc(5 * 1024 * 1024),
    headers: { "Content-Type": "application/octet-stream" },
  });
  ok("جزء أكبر من الحد → 413", big.status === 413, String(big.status));
  const mixProc = await jfetch(`/api/jobs/${mixId}/process`, { method: "POST" });
  ok("دمج المهمة المختلطة اكتمل", mixProc.status === 200 && mixProc.body.status === "done", `${mixProc.body.duration}s`);
  // تنظيف
  await jfetch(`/api/jobs/${mixId}`, { method: "DELETE" });
  const gone = await jfetch(`/api/jobs/${mixId}`);
  ok("حذف المهمة المختلطة ثم 404", gone.status === 404);

  console.log(`\n=== 5) الأخطاء الصحيحة ===`);
  const del = await jfetch(`/api/jobs/${jobId}`, { method: "DELETE" });
  ok("DELETE يعمل", del.status === 200 && del.body.ok);
  const afterDel = await jfetch(`/api/jobs/${jobId}`);
  ok("GET بعد الحذف 404", afterDel.status === 404 && afterDel.body.error, afterDel.body.error);
  const nf = await jfetch("/api/jobs/nonexistent123", { method: "POST" });
  ok("process لمهمة غير موجودة 404", nf.status === 404);

  const bad = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{تالف" });
  ok("JSON تالف → 400", bad.status === 400 && bad.body.error, bad.body.error);
  const empty = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [] }) });
  ok("قائمة فارغة → 400", empty.status === 400 && empty.body.error, empty.body.error);
  const one = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [URL1] }) });
  ok("مقطع واحد يُنشأ لكن process يفشل برسالة عربية", one.status === 201);
  const oneProc = await jfetch(`/api/jobs/${one.body.jobId}/process`, { method: "POST" });
  ok("process مقطع واحد → خطأ واضح", oneProc.status >= 400 && /مقطع/.test(oneProc.body.error || ""), oneProc.body.error);
  await jfetch(`/api/jobs/${one.body.jobId}`, { method: "DELETE" });


  const cron = await jfetch("/api/cron");
  ok("GET /api/cron يعمل", cron.status === 200 && typeof cron.body.deletedJobs === "number");

  console.log(`\n===== النتيجة: ${passed} نجح / ${failed} فشل =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("خطأ غير متوقع:", e);
  process.exit(1);
});
