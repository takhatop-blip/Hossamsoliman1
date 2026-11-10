/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP
 * كل شيء يُخزَّن هنا: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs).
 * لا S3 ولا خدمات خارجية — ولا أي ملف محلي في الإنتاج.
 * كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات.
 */
const { createClient } = require("@libsql/client");
const { LIMITS } = require("./utils");

let _db = null;
let _schema = null;

function getDb() {
  if (!_db) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw Object.assign(new Error("متغيرات Turso غير مضبوطة: TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان"), { code: 500 });
    }
    _db = createClient({ url, authToken: token });
  }
  return _db;
}

function ensureSchema() {
  if (!_schema) {
    _schema = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          error TEXT,
          result_size INTEGER,
          result_duration REAL,
          result_resolution TEXT,
          created_at TEXT,
          expires_at TEXT
        )`);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          uploaded_bytes INTEGER DEFAULT 0,
          PRIMARY KEY (job_id, seq)
        )`);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, chunk)
        )`);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk)
        )`);
    })().catch((e) => {
      _schema = null;
      throw e;
    });
  }
  return _schema;
}

const nowIso = () => new Date().toISOString();

/* ---------------- jobs ---------------- */

async function insertJob({ id, status }) {
  await ensureSchema();
  const created = nowIso();
  const expires = new Date(Date.now() + LIMITS.RETENTION_HOURS * 3600 * 1000).toISOString();
  await getDb().execute({
    sql: `INSERT INTO jobs (id, status, progress, created_at, expires_at) VALUES (?, ?, 0, ?, ?)`,
    args: [id, status, created, expires],
  });
  return { id, status, created_at: created, expires_at: expires };
}

async function getJob(id) {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM jobs WHERE id = ?`, args: [id] });
  return r.rows[0] || null;
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

/** حذف شامل: مهمة + مصادر + أجزاء المصادر + أجزاء الناتج في batch واحد */
async function deleteJobAll(id) {
  await ensureSchema();
  const db = getDb();
  await db.batch([
    { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [id] },
    { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] },
    { sql: `DELETE FROM sources WHERE job_id = ?`, args: [id] },
    { sql: `DELETE FROM jobs WHERE id = ?`, args: [id] },
  ]);
}

/* ---------------- sources ---------------- */

async function insertSources(jobId, sources) {
  await ensureSchema();
  const db = getDb();
  const stmts = sources.map((s, i) => ({
    sql: `INSERT INTO sources (job_id, seq, kind, url, name, size, mime, uploaded_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [jobId, i, s.kind, s.url || null, s.name || null, s.size ?? null, s.mime || null],
  }));
  await db.batch(stmts);
}

async function getSources(jobId) {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC`, args: [jobId] });
  return r.rows.map((row) => ({
    job_id: row.job_id,
    seq: Number(row.seq),
    kind: row.kind,
    url: row.url,
    name: row.name,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
    mime: row.mime,
    uploaded_bytes: Number(row.uploaded_bytes || 0),
  }));
}

async function addUploadedBytes(jobId, seq, n) {
  await getDb().execute({
    sql: `UPDATE sources SET uploaded_bytes = uploaded_bytes + ? WHERE job_id = ? AND seq = ?`,
    args: [n, jobId, seq],
  });
}

/* ---------------- أجزاء المصادر ---------------- */

async function insertSourceChunk(jobId, seq, chunk, data) {
  await getDb().execute({
    sql: `INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)`,
    args: [jobId, seq, chunk, data],
  });
}

/** حذف أجزاء مصادر مهمة بعد نجاح الدمج — الناتج فقط هو المطلوب */
async function deleteSourceChunks(jobId) {
  await getDb().execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });
}

/** تجميع مصدر مرفوع إلى ملف مؤقت — قراءة بصفحات من 8 صفوف */
async function writeSourceChunksToFile(jobId, seq, filePath, fs) {
  const db = getDb();
  const out = require("node:fs").createWriteStream(filePath);
  let lastChunk = -1;
  for (;;) {
    const r = await db.execute({
      sql: `SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk > ? ORDER BY chunk ASC LIMIT ?`,
      args: [jobId, seq, lastChunk, LIMITS.READ_PAGE_ROWS],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      if (!out.write(buf)) {
        await new Promise((res) => out.once("drain", res));
      }
      lastChunk = Number(row.chunk);
    }
  }
  await new Promise((res) => out.end(res));
}

/* ---------------- أجزاء الناتج ---------------- */

/** تقسيم ملف ناتج إلى صفوف 2MB وتخزينها */
async function storeOutputFile(jobId, filePath, fs) {
  const db = getDb();
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const totalChunks = Math.ceil(stat.size / LIMITS.CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const len = Math.min(LIMITS.CHUNK_SIZE, stat.size - i * LIMITS.CHUNK_SIZE);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, i * LIMITS.CHUNK_SIZE);
      await db.execute({
        sql: `INSERT OR REPLACE INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)`,
        args: [jobId, i, buf],
      });
    }
    return stat.size;
  } finally {
    fs.closeSync(fd);
  }
}

/** حجم الناتج المخزّن (مجموع الأطوال) */
async function getOutputSize(jobId) {
  const r = await getDb().execute({
    sql: `SELECT SUM(length(data)) AS total, COUNT(*) AS n FROM output_chunks WHERE job_id = ?`,
    args: [jobId],
  });
  const row = r.rows[0] || {};
  return { total: Number(row.total || 0), chunks: Number(row.n || 0) };
}

/**
 * بث الناتج مع دعم Range: يمر على صفوف البلوب بالترتيب ويحدد الجزاءات المتقاطعة
 * مع المدى المطلوب (منطق التقليم أول/آخر جزء حسب المدى).
 */
async function streamOutput(res, jobId, { start, end, totalSize, download }) {
  const db = getDb();
  const chunkSize = LIMITS.CHUNK_SIZE;
  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.floor(end / chunkSize);

  res.statusCode = start > 0 || end < totalSize - 1 ? 206 : 200;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", String(end - start + 1));
  res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
  if (download) {
    res.setHeader("Content-Disposition", `attachment; filename="merged-${jobId}.mp4"`);
  }

  let pos = firstChunk * chunkSize;
  for (let c = firstChunk; c <= lastChunk; c++) {
    const r = await db.execute({
      sql: `SELECT data FROM output_chunks WHERE job_id = ? AND chunk = ?`,
      args: [jobId, c],
    });
    if (!r.rows.length) break; // صف مفقود — نتوقف بأمان
    let buf = Buffer.isBuffer(r.rows[0].data) ? r.rows[0].data : Buffer.from(r.rows[0].data);
    const chunkEnd = pos + buf.length - 1;
    // تقليم أول/آخر جزء حسب المدى المطلوب
    let sliceStart = 0;
    let sliceEnd = buf.length - 1;
    if (start > pos) sliceStart = start - pos;
    if (end < chunkEnd) sliceEnd = end - pos;
    if (sliceStart <= sliceEnd) {
      buf = buf.subarray(sliceStart, sliceEnd + 1);
      if (!res.write(buf)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    pos = chunkEnd + 1;
  }
  res.end();
}

/** التنظيف الكسول: حذف المهام المنتهية صلاحيتها (يُستدعى عند الإنشاء/الدمج + كرون يومي) */
async function cleanupExpired() {
  await ensureSchema();
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT id FROM jobs WHERE expires_at < ?`,
    args: [nowIso()],
  });
  let deleted = 0;
  for (const row of r.rows) {
    await deleteJobAll(String(row.id));
    deleted++;
  }
  return deleted;
}

module.exports = {
  getDb,
  ensureSchema,
  insertJob,
  getJob,
  updateJob,
  deleteJobAll,
  insertSources,
  getSources,
  addUploadedBytes,
  insertSourceChunk,
  deleteSourceChunks,
  writeSourceChunksToFile,
  storeOutputFile,
  getOutputSize,
  streamOutput,
  cleanupExpired,
  nowIso,
};
