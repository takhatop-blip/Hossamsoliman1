/**
 * خادم تطوير محلي يحاكي بيئة Vercel
 * ============================================================
 * - يحمّل .env يدويًا (لا اعتماد على مكتبات خارجية).
 * - يقدّم ملفات public/ الساكنة.
 * - يحلّل المسارات الديناميكية ويضعها في req.query مثل دوال Vercel:
 *     /api/jobs/<id>            → req.query.id
 *     /api/jobs/<id>/process    → req.query.id
 *     /api/jobs/<id>/video      → req.query.id
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

/* ---------- تحميل .env يدويًا ---------- */
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3101);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function notFound(res, msg) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: msg || "غير موجود" }));
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(parsed.pathname);

    // دمج استعلام المسار مع معاملات الطلب (تحاكي سلوك Vercel في الدوال الديناميكية)
    req.query = req.query || {};
    for (const [k, v] of parsed.searchParams) req.query[k] = v;

    /* ---------- توجيه API ---------- */
    if (pathname.startsWith("/api/")) {
      // قراءة الجسم الثنائي/النصي مبكرًا تتم داخل الدوال نفسها (Vercel يمرر الدفق كما هو)
      if (pathname === "/api/jobs" && req.method === "POST") {
        return require("./api/jobs")(req, res);
      }
      if (pathname === "/api/upload") {
        return require("./api/upload")(req, res);
      }
      if (pathname === "/api/config") {
        return require("./api/config")(req, res);
      }
      if (pathname === "/api/cron") {
        return require("./api/cron")(req, res);
      }
      if (pathname === "/api/slideshow" && req.method === "POST") {
        return require("./api/slideshow")(req, res);
      }
      const sm = pathname.match(/^\/api\/slideshow\/([^/]+)(\/(process))?$/);
      if (sm) {
        req.query.id = sm[1];
        const ssub = sm[3];
        if (!ssub) return require("./api/slideshow/[id]")(req, res);
        if (ssub === "process") return require("./api/slideshow/[id]/process")(req, res);
      }
      const m = pathname.match(/^\/api\/jobs\/([^/]+)(\/(process|video))?$/);
      if (m) {
        req.query.id = m[1];
        const sub = m[3];
        if (!sub) return require("./api/jobs/[id]")(req, res);
        if (sub === "process") return require("./api/jobs/[id]/process")(req, res);
        if (sub === "video") return require("./api/jobs/[id]/video")(req, res);
      }
      return notFound(res, "نقطة API غير موجودة");
    }

    /* ---------- ملفات ساكنة ---------- */
    let rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      if (ext === ".html") res.setHeader("Cache-Control", "no-cache");
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    // SPA fallback → الواجهة
    const index = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(index)) {
      res.setHeader("Content-Type", MIME[".html"]);
      fs.createReadStream(index).pipe(res);
      return;
    }
    notFound(res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: e.message || "خطأ داخلي" }));
  }
});

server.listen(PORT, () => {
  console.log(`[video-merger] dev server: http://localhost:${PORT}`);
});
