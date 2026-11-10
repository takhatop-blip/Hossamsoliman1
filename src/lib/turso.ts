/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP
 * ------------------------------------------------
 * - عميل واحد مشترك، ومخطط يُنشأ عند أول وصول (بلا أداة migrations).
 * - كل التواريخ تُكتب بصيغة ISO مع مللي ثانية لضمان «الترتيب التسلسلي الصارم»
 *   للمفاتيح حسب أمر الإضافة (created_at ASC, id ASC) دون تعارض ثوانٍ متطابقة.
 * - لا نلمس أي ملف محلي إطلاقًا — متوافق تمامًا مع بيئة Vercel الـ serverless.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

/** عميل Turso واحد للعملية كلها (يُعاد استخدام الاتصال بين الطلبات) */
export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error(
        "متغيرات Turso غير مضبوطة: أضف TURSO_DATABASE_URL و TURSO_AUTH_TOKEN"
      );
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

/** إنشاء الجداول عند أول وصول فقط (CREATE TABLE IF NOT EXISTS) */
export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const c = getTurso();
      await c.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )`);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`);
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_keys_provider_order ON api_keys(provider, created_at, id)`
      );
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`
      );
    })().catch((e) => {
      // نسمح بإعادة المحاولة لاحقًا إن فشل الإنشاء الأول
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

/** فحص جهوزية قاعدة البيانات بـ SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ============================================================
 *                     عمليات المفاتيح
 * ============================================================ */

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** إضافة مفتاح جديد — created_at بصيغة ISO-مللي لضمان ترتيب الإضافة الصارم */
export async function insertApiKey(input: {
  provider: string;
  api_key: string;
  label?: string;
}): Promise<ApiKeyRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const created = nowIso();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status, created_at)
          VALUES (?, ?, ?, ?, 'active', ?)`,
    args: [id, input.provider, input.label ?? "", input.api_key, created],
  });
  const row = await getApiKey(id);
  if (!row) throw new Error("فشل إدراج المفتاح");
  return row;
}

export async function getApiKey(id: string): Promise<ApiKeyRow | null> {
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys WHERE id = ?`,
    args: [id],
  });
  return (r.rows[0] as unknown as ApiKeyRow) ?? null;
}

/** جلب كل المفاتيح (كاملة — للأداء الداخلي فقط، لا تُعاد أبدًا للواجهة بدون إخفاء) */
export async function getAllKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute(`SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`);
  return r.rows as unknown as ApiKeyRow[];
}

/** كشف التكرار: نفس المفتاح لنفس المزود مرفوض */
export async function keyExists(provider: string, apiKey: string): Promise<boolean> {
  const r = await getTurso().execute({
    sql: `SELECT 1 FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
  });
  return r.rows.length > 0;
}

export async function updateApiKey(
  id: string,
  patch: Partial<Pick<ApiKeyRow, "status" | "usage_count" | "success_count" | "fail_count" | "last_used_at" | "last_checked_at" | "last_error">>
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    args.push(v as InValue);
  }
  if (!sets.length) return;
  args.push(id);
  await getTurso().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function deleteApiKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
}

/* ============================================================
 *                     عمليات المهام
 * ============================================================ */

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskAttempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** إضافة مهمة جديدة قبل أي نداء خارجي (حتى تبقى قابلة للتتبع عند الانقطاع) */
export async function insertTask(task: {
  id: string;
  model: string;
  type: TaskType;
  prompt?: string;
  params?: Record<string, unknown>;
  provider?: string;
  status?: TaskStatus;
}): Promise<TaskRow> {
  await ensureSchema();
  const created = nowIso();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress, attempts_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?)`,
    args: [
      task.id,
      task.provider ?? null,
      task.model,
      task.type,
      task.prompt ?? "",
      JSON.stringify(task.params ?? {}),
      task.status ?? "pending",
      created,
      created,
    ],
  });
  const row = await getTask(task.id);
  if (!row) throw new Error("فشل إدراج المهمة");
  return row;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const r = await getTurso().execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  return (r.rows[0] as unknown as TaskRow) ?? null;
}

/**
 * تحديث جزئي للمهمة:
 * - attempts: مصفوفة تُلحق بسجل المحاولات (بحد أقصى 50 عنصرًا لتفادي النمو اللانهائي)
 * - status completed ⇒ يُضبط completed_at تلقائيًا
 * - أي تحديث يضبط updated_at
 */
export async function updateTask(
  id: string,
  patch: {
    status?: TaskStatus;
    progress?: number;
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    result_urls?: string[] | null;
    error_message?: string | null;
    attempts?: TaskAttempt[];
    params_merge?: Record<string, unknown>;
  }
): Promise<void> {
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return;

  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") {
      sets.push("completed_at = COALESCE(completed_at, ?)");
      args.push(nowIso());
    }
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.provider_task_id !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.provider_task_id);
  }
  if (patch.key_id !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.key_id);
  }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls ? JSON.stringify(patch.result_urls) : null);
  }
  if (patch.error_message !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.error_message);
  }
  if (patch.attempts !== undefined && patch.attempts.length) {
    let existing: TaskAttempt[] = [];
    try {
      existing = JSON.parse(current.attempts_json || "[]");
    } catch {
      existing = [];
    }
    const merged = [...existing, ...patch.attempts].slice(-50);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(merged));
  }
  if (patch.params_merge !== undefined) {
    let obj: Record<string, unknown> = {};
    try {
      obj = JSON.parse(current.params_json || "{}");
    } catch {
      obj = {};
    }
    sets.push("params_json = ?");
    args.push(JSON.stringify({ ...obj, ...patch.params_merge }));
  }

  if (!sets.length) return;
  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);
  await getTurso().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function listRecentTasks(
  limit = 20,
  filter?: { type?: TaskType; status?: TaskStatus }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter?.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter?.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const r = await getTurso().execute({ sql, args });
  return r.rows as unknown as TaskRow[];
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await getTurso().execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
    FROM tasks`);
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

/** حذف مهام اختبار (تنظيف) — يُستخدم من سكربتات الاختبار فقط */
export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] });
}
