/**
 * طبقة تخزين مهام التعليق المصوّر في Turso — نفس قاعدة بيانات التطبيق
 * ============================================================
 * - ss_jobs: حالة المهمة + معطياتها (JSON) + نتائجها.
 * - ss_output_chunks: الفيديو الناتج مقسّمًا صفوفًا من 2MB (حد HTTP في Turso).
 * - بث الناتج مع دعم Range 206 عبر streamSsOutput.
 * بادئة ss_ تفصل جداول التعليق عن جداول الدمج إن شاركت الخدمتان قاعدة واحدة.
 */
import { getTurso } from "../turso";
import { LIMITS } from "./ffmpeg";

let _ssSchema: Promise<void> | null = null;

export function ensureSsSchema(): Promise<void> {
  if (!_ssSchema) {
    _ssSchema = (async () => {
      const c = getTurso();
      await c.execute(`
        CREATE TABLE IF NOT EXISTS ss_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          error TEXT,
          params_json TEXT NOT NULL DEFAULT '{}',
          result_url TEXT,
          result_size INTEGER,
          result_duration REAL,
          result_resolution TEXT,
          created_at TEXT,
          expires_at TEXT
        )`);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS ss_output_chunks (
          job_id TEXT NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk)
        )`);
    })().catch((e) => {
      _ssSchema = null;
      throw e;
    });
  }
  return _ssSchema;
}

const nowIso = () => new Date().toISOString();

export interface SsJobRow {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  error: string | null;
  params_json: string;
  result_url: string | null;
  result_size: number | null;
  result_duration: number | null;
  result_resolution: string | null;
  created_at: string | null;
  expires_at: string | null;
}

export async function insertSsJob(id: string, params: Record<string, unknown>): Promise<void> {
  await ensureSsSchema();
  const created = nowIso();
  const expires = new Date(Date.now() + LIMITS.RETENTION_HOURS * 3600 * 1000).toISOString();
  await getTurso().execute({
    sql: `INSERT INTO ss_jobs (id, status, progress, params_json, created_at, expires_at) VALUES (?, 'queued', 0, ?, ?, ?)`,
    args: [id, JSON.stringify(params), created, expires],
  });
}

export async function getSsJob(id: string): Promise<SsJobRow | null> {
  await ensureSsSchema();
  const r = await getTurso().execute({ sql: `SELECT * FROM ss_jobs WHERE id = ?`, args: [id] });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: String(row.id),
    status: String(row.status) as SsJobRow["status"],
    progress: Number(row.progress || 0),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    params_json: String(row.params_json || "{}"),
    result_url: row.result_url === null || row.result_url === undefined ? null : String(row.result_url),
    result_size: row.result_size === null || row.result_size === undefined ? null : Number(row.result_size),
    result_duration:
      row.result_duration === null || row.result_duration === undefined ? null : Number(row.result_duration),
    result_resolution: row.result_resolution === null || row.result_resolution === undefined ? null : String(row.result_resolution),
    created_at: row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    expires_at: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
  };
}

export async function updateSsJob(id: string, patch: Partial<Omit<SsJobRow, "id" | "params_json">>): Promise<void> {
  await ensureSsSchema();
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  args.push(id);
  await getTurso().execute({ sql: `UPDATE ss_jobs SET ${sets.join(", ")} WHERE id = ?`, args: args as never[] });
}

/** تقسيم ملف ناتج إلى صفوف 2MB وتخزينها — يعيد الحجم */
export async function storeSsOutputFile(jobId: string, filePath: string): Promise<number> {
  await ensureSsSchema();
  const fs = await import("node:fs");
  const c = getTurso();
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const totalChunks = Math.ceil(stat.size / LIMITS.CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const len = Math.min(LIMITS.CHUNK_SIZE, stat.size - i * LIMITS.CHUNK_SIZE);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, i * LIMITS.CHUNK_SIZE);
      await c.execute({
        sql: `INSERT OR REPLACE INTO ss_output_chunks (job_id, chunk, data) VALUES (?, ?, ?)`,
        args: [jobId, i, buf] as never[],
      });
    }
    return stat.size;
  } finally {
    fs.closeSync(fd);
  }
}

/** حذف شامل لمهمة منتهية */
export async function deleteSsJobAll(id: string): Promise<void> {
  await ensureSsSchema();
  const c = getTurso();
  await c.batch([
    { sql: `DELETE FROM ss_output_chunks WHERE job_id = ?`, args: [id] },
    { sql: `DELETE FROM ss_jobs WHERE id = ?`, args: [id] },
  ]);
}

/** التنظيف الكسول: حذف المهام المنتهية صلاحيتها */
export async function cleanupExpiredSs(): Promise<number> {
  await ensureSsSchema();
  const c = getTurso();
  const r = await c.execute({ sql: `SELECT id FROM ss_jobs WHERE expires_at < ?`, args: [nowIso()] });
  let deleted = 0;
  for (const row of r.rows) {
    await deleteSsJobAll(String(row.id));
    deleted++;
  }
  return deleted;
}

export const SS_CHUNK_SIZE = LIMITS.CHUNK_SIZE;
