/**
 * توليد التعليق الصوتي (TTS) — مجاني بلا مفتاح عبر Google Translate TTS
 * ============================================================
 * القياس الحي (2026-11-12):
 *   GET https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ar&q=<نص≤200حرف>
 *   → HTTP 200 audio/mpeg (24kHz mono) — يتطلب ترويسة User-Agent لمتصفح.
 *   Streamelements أصبح 401، وPollinations الصوتية 402 (مدفوعة).
 * النص الطويل يُقسَّم على حدود الجُمل (≤180 حرفًا) وتُدمج الأجزاء بـ ffmpeg.
 */
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, audioDuration } from "./ffmpeg";

const TTS_BASE = process.env.TTS_API_BASE?.trim() || "https://translate.google.com/translate_tts";
const MAX_CHUNK = 180; // حد Google ≈ 200 حرف — هامش أمان
const CHUNK_DELAY_MS = 350; // تجنّب تسريع الطلبات
const UA =
  process.env.TTS_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** تقسيم النص على حدود الجُمل/الترقيم دون قطع كلمة */
export function splitTextChunks(text: string, maxLen = MAX_CHUNK): string[] {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  // حدود مفضلة: نهاية الجملة ثم الفواصل ثم المسافات
  const boundary = /(?<=[.!?؟۔؛;،,])\s+/;
  const pieces = clean.split(boundary);
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    let piece = p.trim();
    while (piece.length > maxLen) {
      // قطعة أطول من الحد: نقسم عند آخر مسافة داخل الحد
      let cut = piece.lastIndexOf(" ", maxLen);
      if (cut < maxLen * 0.5) cut = maxLen; // كلمة ضخمة — قطع قسري
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      chunks.push(piece.slice(0, cut).trim());
      piece = piece.slice(cut).trim();
    }
    if (!piece) continue;
    if ((cur + " " + piece).trim().length <= maxLen) {
      cur = (cur ? cur + " " : "") + piece;
    } else {
      if (cur) chunks.push(cur);
      cur = piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter(Boolean);
}

/** تنزيل جزء صوتي واحد — مع محاولة إعادة واحدة */
async function fetchTtsChunk(text: string, lang: string, dest: string): Promise<number> {
  const qs = new URLSearchParams({ ie: "UTF-8", client: "tw-ob", ttsspeed: "1", tl: lang, q: text });
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(`${TTS_BASE}?${qs.toString()}`, {
        signal: ctrl.signal,
        headers: { "User-Agent": UA, Referer: "https://translate.google.com/" },
      });
      if (res.ok) {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 500 && (ct.includes("audio") || ct === "application/octet-stream")) {
          fs.writeFileSync(dest, buf);
          return buf.length;
        }
      }
    } catch {
      /* نعيد المحاولة */
    } finally {
      clearTimeout(t);
    }
    await sleep(700);
  }
  throw new Error(`تعذر توليد الصوت لجزء من النص (${text.slice(0, 40)}…)`);
}

/**
 * توليد ملف صوتي كامل من نص (أي لغة — lang الافتراضي ar).
 * يعيد { audioPath, chunks }.
 */
export async function synthesizeNarration(
  text: string,
  dir: string,
  { lang = "ar", onProgress }: { lang?: string; onProgress?: (ratio: number) => void } = {}
): Promise<{ audioPath: string; chunks: number }> {
  const chunks = splitTextChunks(text);
  if (!chunks.length) throw new Error("نص التعليق الصوتي فارغ");
  if (chunks.length > 60) throw new Error(`نص التعليق طويل جدًا (${chunks.length} جزءًا — الحد 60)`);

  const files: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const dest = path.join(dir, `tts-${String(i).padStart(3, "0")}.mp3`);
    await fetchTtsChunk(chunks[i], lang, dest);
    files.push(dest);
    if (onProgress) onProgress((i + 1) / chunks.length);
    if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
  }

  // جزء واحد ⇒ الكفي مباشرة
  if (files.length === 1) {
    return { audioPath: files[0], chunks: chunks.length };
  }

  // دمج الأجزاء: concat demuxer مع إعادة ترميز mp3 موحدة الخصائص
  const listPath = path.join(dir, "tts-list.txt");
  fs.writeFileSync(
    listPath,
    files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")
  );
  const outPath = path.join(dir, "narration.mp3");
  await runFfmpeg(
    ["-y", "-nostats", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "libmp3lame", "-b:a", "96k", "-ar", "44100", "-ac", "2", outPath],
    { totalDurationUs: 0 }
  );
  return { audioPath: outPath, chunks: chunks.length };
}

export { audioDuration };
