/**
 * GET /api/health — جهوزية السيرفر
 * database: turso-connected | turso-error
 * merger.healthy: فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
 */
import { mergerBase, mergerHealthy } from "@/lib/merger";
import { MODELS } from "@/lib/models";
import { dbHealthy } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const db = await dbHealthy();
  const merger = await mergerHealthy();
  return Response.json(
    {
      ok: db,
      database: db ? "turso-connected" : "turso-error",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: { base: mergerBase(), healthy: merger },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN?.trim()),
    },
    { status: 200 }
  );
}
