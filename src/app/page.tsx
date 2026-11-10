"use client";

/**
 * لوحة الإدارة العربية (RTL) — صفحة واحدة بثلاث بطاقات:
 *  أ) مدير المفاتيح   ب) لوحة المهام الحية   ج) ربط السيرفر (JSON جاهز للنسخ)
 * التحديث التلقائي: المهام كل ~5 ثوانٍ، الجهوزية كل ~30 ثانية.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/* ---------------- أنواع ---------------- */
interface SafeKey {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}
interface TaskItem {
  id: string;
  type: string;
  model: string;
  provider: string | null;
  status: string;
  progress: number;
  prompt: string;
  urls: string[];
  error_message: string | null;
  attempts_count: number;
  created_at: string;
}
interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
  models: { canonical: string; type: string; providers: string[] }[];
}

/* ---------------- أدوات مساعدة ---------------- */
const typeLabel = (t: string) => (t === "image" ? "🖼️ صورة" : t === "video" ? "🎬 فيديو" : "🎞️ دمج");
const statusLabel = (s: string) =>
  s === "completed" ? "مكتملة" : s === "failed" ? "فاشلة" : s === "pending" ? "بالانتظار" : "جارية";
const keyStatusLabel = (s: string) =>
  s === "active" ? "نشط" : s === "exhausted" ? "مستنزف" : s === "disabled" ? "معطّل" : s;

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "قبل لحظات";
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  return `منذ ${Math.floor(h / 24)} يوم`;
}

function CopyBtn({ text, small }: { text: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={`rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors ${
        small ? "px-2 py-0.5 text-xs" : "px-3 py-1.5 text-sm"
      }`}
    >
      {done ? "✓ تم النسخ" : "نسخ"}
    </button>
  );
}

/* ---------------- شارات ---------------- */
function TaskBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    failed: "bg-red-500/15 text-red-300 border-red-500/40",
    processing: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
    pending: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${map[status] ?? map.pending}`}>
      {statusLabel(status)}
    </span>
  );
}

function KeyBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    exhausted: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    disabled: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  };
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${map[status] ?? map.disabled}`}>
      {keyStatusLabel(status)}
    </span>
  );
}

/* ============================================================ */
export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<SafeKey[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tasksRef = useRef<HTMLDivElement>(null);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch {
      /* تجاهل */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=25", { cache: "no-store" });
      const j = await r.json();
      setTasks(j.tasks ?? []);
      if (j.stats) setStats(j.stats);
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    loadHealth();
    loadKeys();
    loadTasks();
    const t1 = setInterval(loadTasks, 5000); // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t2 = setInterval(loadHealth, 30000);
    const t3 = setInterval(loadKeys, 10000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
    };
  }, [loadHealth, loadKeys, loadTasks]);

  async function addKey() {
    setBusy(true);
    setKeyMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKeyInput.trim(), label: label.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        setKeyMsg({ ok: false, text: j.error || "فشل إضافة المفتاح" });
      } else {
        setKeyMsg({ ok: true, text: "تمت إضافة المفتاح — سيُجرَّب أولًا حسب ترتيب الإضافة" });
        setApiKeyInput("");
        setLabel("");
        loadKeys();
      }
    } catch {
      setKeyMsg({ ok: false, text: "خطأ شبكة" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleKey(k: SafeKey) {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }),
    });
    loadKeys();
  }

  async function deleteKey(k: SafeKey) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    loadKeys();
  }

  const mcpUrl = `${origin || "https://<نطاقك>"}/mcp`;
  const authHeaders = health?.authRequired
    ? `,\n      "headers": { "Authorization": "Bearer <ضع قيمة MCP_ACCESS_TOKEN هنا>" }`
    : "";
  const jsonChatGPT = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`;
  const jsonClaude = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`;
  const jsonCursor = jsonChatGPT;

  const tools = [
    { name: "generate_image", desc: "توليد صورة بـ gpt-image-2-6/flare-text-to-image مع توبديل تلقائي عبر كل المفاتيح" },
    { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (grok-imagine-video-1-5-preview) وصورة أولى اختيارية" },
    { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب — عبر urls أو task_ids لمهام مكتملة" },
    { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى اكتمالها وعرض روابط النتائج" },
    { name: "list_media", desc: "أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها من قاعدة البيانات" },
  ];

  const dbOk = health?.database === "turso-connected";

  return (
    <main className="min-h-screen bg-[#0b1020] text-slate-100" dir="rtl">
      {/* خلفية تدرجات سماوي/بنفسجي */}
      <div className="pointer-events-none fixed inset-0 opacity-60">
        <div className="absolute -top-32 right-1/4 h-96 w-96 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="absolute top-1/3 -left-24 h-96 w-96 rounded-full bg-violet-600/20 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 py-8">
        {/* ================= الهيدر ================= */}
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold sm:text-3xl">
              <span className="bg-gradient-to-l from-cyan-400 to-violet-400 bg-clip-text text-transparent">
                MCP Media Generator
              </span>
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              خادم MCP لتوليد الصور والفيديو ودمج المقاطع — مفاتيح بتوبديل تسلسلي تلقائي لا يتوقف
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {health === null ? (
              <span className="rounded-full border border-slate-600/60 bg-slate-500/10 px-3 py-1 text-slate-300">
                جارٍ فحص الجهوزية…
              </span>
            ) : dbOk ? (
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-emerald-300">
                ● Turso متصل
              </span>
            ) : (
              <span className="rounded-full border border-red-500/40 bg-red-500/15 px-3 py-1 text-red-300">
                ● غير متصل
              </span>
            )}
            {health && (
              <span
                className={`rounded-full border px-3 py-1 ${
                  health.merger.healthy
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/15 text-amber-300"
                }`}
              >
                خدمة الدمج: {health.merger.healthy ? "جاهزة" : "غير متاحة"}
              </span>
            )}
            {health?.authRequired && (
              <span className="rounded-full border border-violet-500/40 bg-violet-500/15 px-3 py-1 text-violet-300">
                محمي بـ Bearer Token
              </span>
            )}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* ================= أ) مدير المفاتيح ================= */}
          <section className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-6 shadow-xl backdrop-blur lg:col-span-1">
            <h2 className="mb-1 text-lg font-bold">🔑 مدير المفاتيح</h2>
            <p className="mb-4 text-xs leading-6 text-slate-400">
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع توبديل فوري
              تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
            </p>

            <div className="mb-4 grid gap-2 sm:grid-cols-[130px_1fr_auto]">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm outline-none focus:border-cyan-500"
              >
                <option value="kie">kie.ai</option>
                <option value="cometapi">CometAPI</option>
              </select>
              <input
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="الصق مفتاح API هنا"
                dir="ltr"
                className="rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm outline-none focus:border-cyan-500"
              />
              <button
                onClick={addKey}
                disabled={busy || !apiKeyInput.trim()}
                className="rounded-lg bg-gradient-to-l from-cyan-500 to-violet-500 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {busy ? "…" : "إضافة"}
              </button>
            </div>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="تسمية اختيارية (مثال: حساب رئيسي)"
              className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm outline-none focus:border-cyan-500"
            />
            {keyMsg && (
              <p className={`mb-3 text-xs ${keyMsg.ok ? "text-emerald-300" : "text-red-300"}`}>{keyMsg.text}</p>
            )}

            <div className="max-h-96 space-y-3 overflow-y-auto pl-1">
              {keys.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-500">
                  لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.
                </p>
              )}
              {keys.map((k) => (
                <div key={k.id} className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                      </span>
                      <KeyBadge status={k.status} />
                      {k.label && <span className="text-xs text-slate-400">({k.label})</span>}
                    </div>
                    <code dir="ltr" className="rounded bg-slate-900/80 px-2 py-0.5 text-xs text-cyan-300">
                      {k.masked}
                    </code>
                  </div>
                  <div className="mb-2 flex flex-wrap gap-3 text-xs text-slate-400">
                    <span>استخدام: {k.usage_count}</span>
                    <span className="text-emerald-400">نجاح: {k.success_count}</span>
                    <span className="text-red-400">فشل: {k.fail_count}</span>
                    {k.last_used_at && <span>آخر استخدام: {timeAgo(k.last_used_at)}</span>}
                  </div>
                  {k.last_error && (
                    <p className="mb-2 truncate rounded bg-red-500/10 px-2 py-1 text-xs text-red-300" title={k.last_error}>
                      آخر خطأ: {k.last_error}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => toggleKey(k)}
                      className="rounded-lg border border-slate-600 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700/50"
                    >
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </button>
                    <button
                      onClick={() => deleteKey(k)}
                      className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10"
                    >
                      حذف
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ================= ب) لوحة المهام ================= */}
          <section ref={tasksRef} className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-6 shadow-xl backdrop-blur">
            <h2 className="mb-4 text-lg font-bold">📋 لوحة المهام</h2>
            <div className="mb-4 grid grid-cols-4 gap-2 text-center">
              {[
                { label: "الإجمالي", v: stats.total, c: "text-slate-200" },
                { label: "مكتملة", v: stats.completed, c: "text-emerald-300" },
                { label: "فاشلة", v: stats.failed, c: "text-red-300" },
                { label: "جارية", v: stats.processing, c: "text-cyan-300" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-3">
                  <div className={`text-xl font-extrabold ${s.c}`}>{s.v}</div>
                  <div className="text-xs text-slate-400">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="max-h-[420px] space-y-3 overflow-y-auto pl-1">
              {tasks.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-500">
                  لا توجد مهام بعد — استدعِ generate_image أو generate_video من عميل MCP.
                </p>
              )}
              {tasks.map((t) => (
                <div key={t.id} className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-3">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-semibold">{typeLabel(t.type)}</span>
                      <TaskBadge status={t.status} />
                      <span className="text-xs text-slate-500">{t.model}</span>
                    </div>
                    <span className="text-xs text-slate-500" title={t.id}>
                      {timeAgo(t.created_at)} · محاولات: {t.attempts_count}
                    </span>
                  </div>
                  {(t.status === "processing" || t.status === "pending") && (
                    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-700/60">
                      <div
                        className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-400 transition-all duration-500"
                        style={{ width: `${Math.max(4, t.progress)}%` }}
                      />
                    </div>
                  )}
                  {t.prompt && (
                    <p className="mb-1 truncate text-xs text-slate-400" title={t.prompt}>
                      {t.prompt}
                    </p>
                  )}
                  {t.status === "failed" && t.error_message && (
                    <p className="mb-1 rounded bg-red-500/10 px-2 py-1 text-xs text-red-300">{t.error_message}</p>
                  )}
                  {t.urls.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      dir="ltr"
                      className="mb-1 block truncate rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300 hover:underline"
                    >
                      🔗 {u}
                    </a>
                  ))}
                  <code dir="ltr" className="text-[10px] text-slate-600">{t.id}</code>
                </div>
              ))}
            </div>
          </section>

          {/* ================= ج) ربط السيرفر ================= */}
          <section className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-6 shadow-xl backdrop-blur lg:col-span-2">
            <h2 className="mb-4 text-lg font-bold">🔌 ربط السيرفر</h2>

            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input
                readOnly
                dir="ltr"
                value={mcpUrl}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm text-cyan-300 outline-none"
              />
              <CopyBtn text={mcpUrl} />
            </div>

            {/* التوببات */}
            <div className="mb-3 flex gap-2 text-sm">
              {(
                [
                  ["chatgpt", "ChatGPT / GPT Agents"],
                  ["claude", "Claude Desktop"],
                  ["cursor", "Cursor / Windsurf / Cline"],
                ] as const
              ).map(([id, name]) => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={`rounded-lg px-3 py-1.5 transition-colors ${
                    tab === id
                      ? "bg-gradient-to-l from-cyan-500/30 to-violet-500/30 text-white border border-cyan-500/50"
                      : "border border-slate-700 text-slate-400 hover:bg-slate-800/60"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>

            {tab === "chatgpt" && (
              <p className="mb-2 text-xs text-slate-400">
                في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
              </p>
            )}

            <div className="relative">
              <pre dir="ltr" className="overflow-x-auto rounded-xl border border-slate-700 bg-[#0d1326] p-4 text-xs leading-6 text-cyan-200">
                {tab === "claude" ? jsonClaude : jsonChatGPT}
              </pre>
              <div className="absolute left-3 top-3">
                <CopyBtn text={tab === "claude" ? jsonClaude : jsonChatGPT} small />
              </div>
            </div>

            {/* رقائق الأدوات */}
            <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {tools.map((t) => (
                <div key={t.name} className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-3">
                  <code dir="ltr" className="text-sm font-bold text-violet-300">
                    {t.name}
                  </code>
                  <p className="mt-1 text-xs leading-5 text-slate-400">{t.desc}</p>
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs leading-6 text-amber-200">
              ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند
              اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications)
              حتى لا تنقطع العملية.
            </div>
          </section>
        </div>

        <footer className="mt-10 pb-4 text-center text-xs text-slate-600">
          MCP Media Generator · روابط فقط — لا تُنزَّل وسائط على السيرفر · المفاتيح مخفية دائمًا
        </footer>
      </div>
    </main>
  );
}
