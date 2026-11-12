/**
 * نظام المفاتيح المتسلسلة — قلب المشروع
 * ============================================================
 * قواعد جوهرية:
 * 1) الترتيب تسلسلي صارم حسب أمر الإضافة (created_at ASC, id ASC) — ليس round-robin
 *    وليس «الأقل استخدامًا أولًا».
 * 2) المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة — الاستثناء الوحيد
 *    هو التعطيل اليدوي (disabled) الذي يُستبعد من المجموعة.
 * 3) الإخفاء إلزامي: maskKey في كل استجابة/سجل يخرج للعميل.
 */
import { getAllKeys, updateApiKey, type ApiKeyRow } from "./turso";

export type ErrorClass =
  | "disabled" // مفتاح مرفوض (401/403) → تعطيل تلقائي والانتقال للتالي
  | "exhausted" // نفاد رصيد (402 أو رسائل insufficient/quota/balance) → تعليم والانتقال للتالي
  | "provider" // الموديل غير مدعوم لدى هذا المزود → الانتقال للتالي
  | "params" // خطأ في معطيات الطلب → توقف فورًا (تبديل المفاتيح لا يحلّه)
  | "temporary"; // 429/5xx/شبكة/timeout → الانتقال للتالي والمفتاح يبقى سليمًا

export interface ProviderError extends Error {
  status: number;
  message: string;
  class: ErrorClass;
}

export function makeProviderError(status: number, message: string, errorClass: ErrorClass): ProviderError {
  const e = new Error(message) as ProviderError;
  e.status = status;
  e.message = message;
  e.class = errorClass;
  return e;
}

/**
 * تصنيف موحّد لأخطاء المزودين — الترتيب داخل الدالة مقصود:
 * نفحص الرسائل النصية قبل أكواد HTTP لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400.
 */
export function classifyProviderError(status: number, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();

  // 1) نفاد الرصيد — قبل فحص 400 (بعض المزودين يرسلونه بحالة 400)
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(msg)
  ) {
    return "exhausted";
  }
  // 2) مفتاح مرفوض
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|unauthorized|forbidden|authentication/.test(msg)
  ) {
    return "disabled";
  }
  // 3) الموديل غير مدعوم لدى المزود
  if (/model not found|unsupported model/.test(msg) && [400, 404, 422].includes(status)) {
    return "provider";
  }
  // 4) معطيات تالفة — توقف فورًا
  if (status === 400 || status === 422) {
    return "params";
  }
  // 5) مؤقت: 429/5xx/غير معروف
  return "temporary";
}

/** إخفاء المفتاح إلزاميًا: أول 7 أحرف + نقاط + آخر 4 (والقصير: أول 3 + نقاط) */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 11) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

/** مرشّح آمن للواجهة — لا يُعاد المفتاح الكامل في أي استجابة إطلاقًا */
export interface SafeKey {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function toSafeKey(row: ApiKeyRow): SafeKey {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label || "",
    masked: maskKey(row.api_key),
    status: row.status,
    usage_count: row.usage_count ?? 0,
    success_count: row.success_count ?? 0,
    fail_count: row.fail_count ?? 0,
    last_used_at: row.last_used_at ?? null,
    last_checked_at: row.last_checked_at ?? null,
    last_error: row.last_error ?? null,
    created_at: row.created_at,
  };
}

export interface KeyCandidate {
  provider: string;
  key: ApiKeyRow;
  position: number;
  /** مرشّح مصطنع لمزود بلا مفتاح (مثل pollinations) — لا تُحدَّث عدّاداته في القاعدة */
  synthetic?: boolean;
}

/**
 * جلب مجموعة المفاتيح المرشحة لمزودات محددة بالترتيب التسلسلي الصارم.
 * ORDER BY created_at ASC, id ASC — أول مفتاح أُضيف يُجرَّب أولًا.
 * المستنزف يبقى في القائمة؛ فقط disabled يُستبعد.
 */
export async function getKeyPool(providers: string[]): Promise<KeyCandidate[]> {
  const all = await getAllKeys();
  const wanted = new Set(providers);
  return all
    .filter((k) => wanted.has(k.provider) && k.status !== "disabled")
    .map((k, i) => ({ provider: k.provider, key: k, position: i }));
}

/* ---------- تحديث عدّادات وحالة المفاتيح (تُحدَّث دائمًا عند كل محاولة) ---------- */

function truncate(s: string, n = 300): string {
  return s && s.length > n ? s.slice(0, n) + "…" : s;
}

export async function recordKeySuccess(key: ApiKeyRow): Promise<void> {
  await updateApiKey(key.id, {
    usage_count: (key.usage_count ?? 0) + 1,
    success_count: (key.success_count ?? 0) + 1,
    last_used_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    last_error: null,
  });
}

export async function recordKeyFailure(
  key: ApiKeyRow,
  errorClass: ErrorClass,
  message: string
): Promise<void> {
  // تصنيفان فقط يغيّران حالة المفتاح: disabled (تعطيل تلقائي) و exhausted (يبقى في القاعدة)
  const status =
    errorClass === "disabled" ? "disabled" : errorClass === "exhausted" ? "exhausted" : key.status;
  await updateApiKey(key.id, {
    usage_count: (key.usage_count ?? 0) + 1,
    fail_count: (key.fail_count ?? 0) + 1,
    status,
    last_used_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    last_error: truncate(message),
  });
}
