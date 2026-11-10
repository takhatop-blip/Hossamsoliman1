/**
 * عميل خدمة دمج الفيديو — Video Merger API v2
 * ============================================================
 * - بلا مفاتيح أو توثيق؛ العنوان من MERGER_API_BASE.
 * - الأشكال الحقيقية المقاسة (بند 7.1) والتحليل دفاعي (بند 7.2).
 * - قاعدة حتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري،
 *   أما أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة وتستمر بالاستعلام.
 */
import { makeProviderError, type ProviderError } from "./keys";

const BASE = (process.env.MERGER_API_BASE?.trim() || "https://xxxxxxxx").replace(/\/+$/, "");

export function mergerBase(): string {
  return BASE;
}

const DONE_WORDS = /done|completed|complete|success|succeeded|finished/i;
const FAIL_WORDS = /error|failed|failure|cancelled|canceled/i;

async function mergerFetch(url: string, init: RequestInit, timeoutMs = 30_000): Promise<{ httpStatus: number; body: Record<string, unknown> | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // خطأ شبكتنا نحن ⇒ مؤقت (ليس فشلًا حتميًا من الخدمة)
    throw makeProviderError(0, `merger network error: ${msg}`, "temporary");
  } finally {
    clearTimeout(t);
  }
}

/** خطأ معلن من الخدمة = حتمي (class: merger_terminal) */
export function makeMergerTerminalError(message: string): ProviderError {
  const e = makeProviderError(500, message, "temporary");
  // نستخدم class مخصص عبر إضافة حقل — المنسّق يميّز الدمج بفحص provider=merger
  (e as ProviderError & { mergerTerminal?: boolean }).mergerTerminal = true;
  return e;
}

export interface MergerJobCreated {
  jobId: string;
  status: string;
  expiresAt?: string;
}

export interface MergerJobState {
  status: "queued" | "processing" | "done" | "failed";
  progress: number; // 0..100
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
}

/** تحليل دفاعي لحالة المهمة (بند 7.2) */
function analyzeJobState(body: Record<string, unknown> | null): MergerJobState {
  const b = body ?? {};
  // قد يرد الجسم فيه error بدون حقل status ⇒ فشل فوري
  const errRaw = typeof b.error === "string" ? b.error : undefined;
  let statusRaw = typeof b.status === "string" ? b.status : "";
  if (!statusRaw && errRaw) statusRaw = "failed";

  let status: MergerJobState["status"];
  if (DONE_WORDS.test(statusRaw)) status = "done";
  else if (FAIL_WORDS.test(statusRaw)) status = "failed";
  else status = statusRaw === "queued" ? "queued" : "processing";

  // progress يأتي أحيانًا كسرًا 0..1 ⇒ نضربه في 100
  let progress = 0;
  const p = b.progress;
  if (typeof p === "number") progress = p <= 1 ? Math.round(p * 100) : Math.round(p);
  else if (status === "done") progress = 100;
  else if (status === "queued") progress = 5;
  else progress = 50;

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم ابنِه من jobId
  const videoUrl = typeof b.videoUrl === "string" && b.videoUrl ? b.videoUrl : undefined;
  const downloadUrl = typeof b.downloadUrl === "string" && b.downloadUrl ? b.downloadUrl : undefined;
  const jobId = typeof b.jobId === "string" ? b.jobId : "";
  const fallbackUrl = jobId ? `${BASE}/api/jobs/${jobId}/video` : undefined;

  return {
    status,
    progress: Math.max(0, Math.min(100, progress)),
    videoUrl: videoUrl ?? fallbackUrl,
    downloadUrl,
    size: typeof b.size === "number" ? b.size : undefined,
    duration: typeof b.duration === "number" ? b.duration : undefined,
    resolution: typeof b.resolution === "string" ? b.resolution : undefined,
    error: errRaw,
  };
}

/** إنشاء مهمة دمج — POST /api/jobs */
export async function createMergerJob(videos: string[]): Promise<MergerJobCreated> {
  const { httpStatus, body } = await mergerFetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
  });
  if (httpStatus >= 400 || !body) {
    throw makeMergerTerminalError(extract(body, `merger createJob HTTP ${httpStatus}`));
  }
  const jobId = typeof body.jobId === "string" ? body.jobId : null;
  if (!jobId) throw makeMergerTerminalError("merger: createJob without jobId");
  return {
    jobId,
    status: typeof body.status === "string" ? body.status : "queued",
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
  };
}

/** تنفيذ الدمج (blocking ~10-15 ثانية) — POST /api/jobs/{id}/process */
export async function processMergerJob(jobId: string): Promise<MergerJobState> {
  const { httpStatus, body } = await mergerFetch(
    `${BASE}/api/jobs/${encodeURIComponent(jobId)}/process`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    300_000 // العملية blocking قد تستغرق حتى 5 دقائق
  );
  if (httpStatus === 202) return { status: "processing", progress: 50 };
  if (httpStatus >= 400 || !body) {
    // فشل حتمي (مثل مصدر يرفض التحميل) — إعادة المحاولة ستعطي النتيجة نفسها
    throw makeMergerTerminalError(extract(body, `merger process HTTP ${httpStatus}`));
  }
  return analyzeJobState(body);
}

/** استعلام الحالة — GET /api/jobs/{id} (404 ⇒ حذفت المهمة أو انتهت صلاحيتها) */
export async function getMergerJob(jobId: string): Promise<MergerJobState> {
  const { httpStatus, body } = await mergerFetch(
    `${BASE}/api/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET" }
  );
  if (httpStatus === 404) {
    throw makeMergerTerminalError(
      "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)"
    );
  }
  if (httpStatus >= 400 || !body) {
    throw makeMergerTerminalError(extract(body, `merger status HTTP ${httpStatus}`));
  }
  return analyzeJobState({ ...body, jobId });
}

/** فحص جهوزية الخدمة — GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  try {
    const { httpStatus } = await mergerFetch(`${BASE}/api/config`, { method: "GET" }, 4_000);
    return httpStatus < 400;
  } catch {
    return false;
  }
}

/** حذف مهمة دمج (تنظيف اختياري) */
export async function deleteMergerJob(jobId: string): Promise<void> {
  try {
    await mergerFetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10_000);
  } catch {
    // التنظيف أفضلية — لا نرمي أخطاءه
  }
}

function extract(body: Record<string, unknown> | null, fallback: string): string {
  if (body && typeof body.error === "string" && body.error) return body.error;
  if (body && typeof body.message === "string" && body.message) return body.message;
  return fallback;
}
