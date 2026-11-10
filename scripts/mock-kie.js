/**
 * خادم kie.ai وهمي لأغراض الاختبار فقط — يحاكي Jobs API الرسمي:
 * POST /api/v1/jobs/createTask → {code:200, data:{taskId}}
 * GET  /api/v1/jobs/recordInfo?taskId= → generating ثم success مع رابط نتيجة حقيقي
 * يستخدم لاختبار اكتمال دورة التوليد/التبديل دون استهلاك الرصيد.
 */
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = process.env.MOCK_KIE_PORT || 9099;
const RESULT_URL = process.env.MOCK_RESULT_URL || "https://tempfile.aiquickdraw.com/models/gpt-image-2.6-flare/0b5c3871-495d-4827-99a5-209010135049.png";
const VIDEO_RESULT_URL = "https://tempfile.aiquickdraw.com/ggg/users/a9dfe49a-0206-4cd6-9087-9fffbd6294c7/generated/1033282e-7a9b-4dcb-9485-98017ae59ea2/generated_video.mp4";

const jobs = new Map(); // taskId → {polls, model}

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && req.url.startsWith("/api/v1/jobs/createTask")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = randomUUID();
      let model = "unknown";
      try {
        model = JSON.parse(body).model;
      } catch {}
      jobs.set(id, { polls: 0, model });
      console.log(`[mock-kie] createTask ${id} model=${model}`);
      res.end(JSON.stringify({ code: 200, msg: "success", data: { taskId: id } }));
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/v1/jobs/recordInfo")) {
    const taskId = new URL(req.url, "http://x").searchParams.get("taskId");
    const job = jobs.get(taskId) || { polls: 0, model: "" };
    job.polls++;
    jobs.set(taskId, job);
    const state = "success"; // نجاح من أول استعلام — لأن العملية قد تُعاد دورتها بين الجلسات
    const isVideo = String(job.model).includes("video");
    const resultJson =
      state === "success"
        ? JSON.stringify({ resultUrls: [isVideo ? VIDEO_RESULT_URL : RESULT_URL] })
        : "";
    console.log(`[mock-kie] recordInfo ${taskId} poll#${job.polls} → ${state}`);
    res.end(
      JSON.stringify({
        code: 200,
        msg: "success",
        data: {
          taskId,
          state,
          resultJson,
          failMsg: null,
          creditsConsumed: 0,
        },
      })
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: 404, msg: "not found" }));
});

server.listen(PORT, () => console.log(`[mock-kie] listening on :${PORT}`));
