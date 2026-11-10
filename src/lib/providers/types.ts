/**
 * واجهة المزودات الموحدة
 * ============================================================
 * كل خطأ خارجي يُرمى كـ ProviderError بحيث يُصنَّف لاحقًا عبر classifyProviderError.
 * الأشكال هنا مأخوذة من التوثيق الرسمي للمزودين + قياسات curl حقيقية (لا اختراع).
 */
import { makeProviderError, type ProviderError } from "../keys";

export interface ProviderKeyRef {
  id: string;
  api_key: string;
  label: string;
}

export interface ProviderImageInput {
  prompt: string;
  aspect_ratio?: string; // auto يُحذف قبل الإرسال
  resolution?: string; // 1K | 2K | 4K
  background?: string; // auto | transparent | opaque
  output_format?: string; // png | jpeg | webp | gif
}

export interface ProviderVideoInput {
  prompt: string;
  image_url?: string; // إطار أول اختياري (image-to-video)
  aspect_ratio?: string;
  resolution?: string; // 480p | 720p | 1080p
  enable_audio?: boolean;
  duration?: number;
}

export interface TaskCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100 (تقديري إن لم يزوّده المزود)
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId */
  createTask(key: ProviderKeyRef, providerModel: string, input: ProviderImageInput | ProviderVideoInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI يعيد الرابط فورًا) */
  createImageSync?(key: ProviderKeyRef, providerModel: string, input: ProviderImageInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(key: ProviderKeyRef, providerTaskId: string, providerModel: string): Promise<TaskCheckResult>;
}

export type { ProviderError };

/** fetch بمهلة زمنية + تحويل الأخطاء الشبكية لأخطاء مؤقتة مصنّفة */
export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000
): Promise<{ httpStatus: number; body: unknown; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { httpStatus: res.status, body, text };
  } catch (e: unknown) {
    // انقطاع شبكة / timeout / abort ⇒ مؤقت دائمًا
    const msg = e instanceof Error ? e.message : String(e);
    throw makeProviderError(0, `network error: ${msg}`, "temporary");
  } finally {
    clearTimeout(t);
  }
}

/** استخراج رسالة خطأ إنسان الواضحة من أي شكل استجابة معروف */
export function extractErrorMessage(body: unknown, fallback = "unknown provider error"): string {
  if (!body) return fallback;
  const b = body as Record<string, unknown>;
  for (const k of ["msg", "message", "error", "detail", "failMsg"]) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  if (b.error && typeof b.error === "object") {
    const inner = b.error as Record<string, unknown>;
    if (typeof inner.message === "string") return inner.message;
  }
  if (typeof b.data === "object" && b.data) {
    const inner = b.data as Record<string, unknown>;
    for (const k of ["msg", "message", "error"]) {
      if (typeof inner[k] === "string" && (inner[k] as string).trim()) return inner[k] as string;
    }
  }
  return fallback;
}
