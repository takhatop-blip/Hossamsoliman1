/**
 * أدوات مشتركة — الحدود من متغيرات البيئة + ردود JSON + CORS
 */
const QUERY = require("node:querystring");

const envInt = (name, def) => {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// الحدود القابلة للضبط (افتراضيات المواصفة)
const LIMITS = {
  MAX_SOURCES: envInt("MAX_SOURCES", 10),
  SOURCE_MAX_MB: envInt("SOURCE_MAX_MB", 200),
  OUTPUT_MAX_MB: envInt("OUTPUT_MAX_MB", 150),
  MAX_TOTAL_DURATION_SEC: envInt("MAX_TOTAL_DURATION_SEC", 600),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
  UPLOAD_CHUNK_BYTES: envInt("UPLOAD_CHUNK_BYTES", 4 * 1024 * 1024), // 4MB أجزاء الرفع
  CHUNK_SIZE: 2 * 1024 * 1024, // صفوف تخزين 2MB في Turso
  READ_PAGE_ROWS: 8, // قراءة البلوبات بصفحات من 8 صفوف
  RETENTION_HOURS: 24,
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");
}

function json(res, code, obj) {
  setCors(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

/** كل الأخطاء بصيغة موحدة {"error":"..."} برسائل عربية واضحة */
function fail(res, code, message) {
  json(res, code, { error: message });
}

/** قراءة جسم JSON بحد أقصى — طلبات تالفة ⇒ 400 */
function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("جسم الطلب كبير جدًا"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("JSON تالف — يلزم جسم صالح بصيغة application/json"), { code: 400 }));
      }
    });
    req.on("error", () => reject(Object.assign(new Error("تعذر قراءة الطلب"), { code: 400 })));
  });
}

/** قراءة جسم ثنائي (أجزاء الرفع) بحد أقصى صارم — يهضم الفائض ثم يرد 413 حتى لا يُقطع الاتصال */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overLimit = false;
    const chunks = [];
    req.on("data", (c) => {
      if (overLimit) return; // تجاهل الفائض (بدون تخزين) حتى يكتمل الطلب
      size += c.length;
      if (size > maxBytes) {
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overLimit) {
        reject(
          Object.assign(new Error(`حجم الجزء يتجاوز الحد (${Math.round(maxBytes / 1024)}KB)`), { code: 413 })
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => reject(Object.assign(new Error("تعذر قراءة الطلب"), { code: 400 })));
  });
}

/** معرّف قصير فريد قابل للعرض في الروابط */
function genId() {
  return require("node:crypto").randomBytes(6).toString("hex") + Date.now().toString(36);
}

function baseUrlOf(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return "؟";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${u[i]}`;
}

module.exports = { LIMITS, json, fail, readJsonBody, readRawBody, genId, baseUrlOf, humanBytes, QUERY };
