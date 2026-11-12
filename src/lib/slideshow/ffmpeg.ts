/**
 * محرك ffmpeg داخل تطبيق MCP (منقول من خدمة الدمج — نفس المنطق والقياسات)
 * ============================================================
 * - الثنائيات من ffmpeg-static / ffprobe-static مع ضمان صلاحية التنفيذ عبر /tmp.
 * - downloadToTemp: تنزيل مصدر رابط إلى /tmp مع فحص الحجم أثناء التنزيل.
 * - runFfmpeg: قراءة التقدم من -progress pipe:1 (out_time_us).
 * يعمل داخل دالة serverless على Vercel — لا ملفات دائمة، /tmp فقط.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const LIMITS = {
  SOURCE_MAX_MB: 200,
  OUTPUT_MAX_MB: 150,
  MAX_TOTAL_DURATION_SEC: 600,
  FFMPEG_PRESET: process.env.FFMPEG_PRESET?.trim() || "medium",
  CHUNK_SIZE: 2 * 1024 * 1024, // صفوف تخزين 2MB في Turso (حد HTTP)
  RETENTION_HOURS: 24,
};

export const FFMPEG_BIN = require("ffmpeg-static") as string;
export const FFPROBE_BIN = (require("ffprobe-static") as { path: string }).path;

/** ثنائي قد يفقد صلاحية التنفيذ في الاستضافة: نسخ إلى /tmp بصلاحية 755 */
export function ensureExecutable(bin: string): string {
  if (!bin) throw new Error("ثنائي ffmpeg/ffprobe غير موجود");
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    const tmp = path.join(os.tmpdir(), path.basename(bin));
    fs.copyFileSync(bin, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

/** مدة ملف صوتي عبر ffprobe (ثوانٍ) */
export function audioDuration(file: string): number {
  const bin = ensureExecutable(FFPROBE_BIN);
  const out = execFileSync(bin, ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], {
    maxBuffer: 8 * 1024 * 1024,
  }).toString("utf8");
  const j = JSON.parse(out) as { format?: { duration?: string } };
  return Number(j.format?.duration || 0);
}

/** تنزيل مصدر رابط إلى /tmp مع فحص الحجم أثناء التنزيل */
export async function downloadToTemp(url: string, dest: string, onBytes?: (received: number) => void): Promise<number> {
  const maxBytes = LIMITS.SOURCE_MAX_MB * 1024 * 1024;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`تعذر تنزيل المصدر (HTTP ${res.status})`);
    }
    let received = 0;
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        out.destroy();
        throw new Error(`حجم المصدر يتجاوز الحد (${LIMITS.SOURCE_MAX_MB}MB لكل رابط)`);
      }
      if (onBytes) onBytes(received);
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once("drain", r));
      }
    }
    await new Promise((r) => out.end(r));
    if (received === 0) throw new Error("المصدر فارغ (0 بايت)");
    return received;
  } finally {
    clearTimeout(timeout);
  }
}

/** تشغيل ffmpeg مع قراءة التقدم من stdout */
export function runFfmpeg(
  args: string[],
  { totalDurationUs, onProgress }: { totalDurationUs: number; onProgress?: (ratio: number) => void }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = ensureExecutable(FFMPEG_BIN);
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    let stdoutBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && totalDurationUs > 0 && onProgress) {
          const ratio = Math.min(1, Number(m[1]) / totalDurationUs);
          onProgress(ratio);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on("error", (e: Error) => reject(new Error(`ffmpeg: ${e.message}`)));
    child.on("close", (code: number) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg فشل (رمز ${code}): ${stderrTail.split("\n").filter(Boolean).slice(-25).join(" | ")}`
          )
        );
    });
  });
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}
