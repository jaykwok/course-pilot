import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { redact, Logger } from "../src/log.ts";
import { buildDiagnosticLog } from "../src/storage/diagnostics.ts";
import { Repository } from "../src/storage/repository.ts";
import {
  normalizeBundle,
  portableUrl,
  IMPORT_INBOX,
} from "../src/storage/transfer.ts";
import { normalize, entry, resource } from "../src/domain/identity.ts";
import { defaults, prepareSettings, validateSettings } from "../src/config.ts";
import { WebServer } from "../src/web/server.ts";
import { token, until } from "../src/utils.ts";
import { AiClient, aiSettings, type Question } from "../src/ai/client.ts";
import { listModels } from "../src/ai/models.ts";
import { entryProblem } from "../src/platform/exam.ts";
import { filename, decodeDocument } from "../src/platform/references.ts";
import { ReferenceCache } from "../src/platform/reference-cache.ts";
import { learn } from "../src/platform/learning.ts";
import { playbackSnapshot } from "../src/platform/playback.ts";
import type { DiscoveryContext } from "../src/platform/discovery.ts";
import { configuration } from "../src/config.ts";
import { application, COURSE, EXAM, SUBJECT, temporary } from "./helpers.ts";

test("redact scrubs JSON secrets, URL userinfo, Base64 credentials and is strictly idempotent", () => {
  const samples = [
    '{"apiKey":"sk-123456","token":"secret-tok","authorization":"Bearer abc+def/=="}',
    "https://alice:hunter2@kc.zhixueyun.com/?token=tok123&ticket=tk456&keep=1",
    "Cookie: course_web=session-abc; x-control-client=ctrl-xyz",
    "Basic dXNlcjpwYXNz Bearer%20eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "视频加载失败 token=private-token",
  ];
  for (const sample of samples) {
    const once = redact(sample);
    const twice = redact(once);
    assert.equal(twice, once, `not idempotent: ${once} -> ${twice}`);
    assert.ok(!once.includes("sk-123456"));
    assert.ok(!once.includes("secret-tok"));
    assert.ok(!once.includes("hunter2"));
    assert.ok(!once.includes("tok123"));
    assert.ok(!once.includes("tk456"));
    assert.ok(!once.includes("session-abc"));
    assert.ok(!once.includes("ctrl-xyz"));
    assert.ok(!once.includes("dXNlcjpwYXNz"));
    assert.ok(!once.includes("eyJhbGciOiJIUzI1NiJ9"));
    assert.ok(!once.includes("private-token"));
  }
  assert.equal(redact(null), "");
  assert.equal(redact(undefined), "");
  assert.ok(
    redact("https://example.test/?token=secret&keep=ok").includes("&keep=ok"),
  );
});

test("Logger survives disk write failures and still delivers to listener", async () => {
  const temp = await temporary();
  const prevQuiet = process.env.COURSE_AFK_QUIET;
  process.env.COURSE_AFK_QUIET = "1";
  try {
    const logger = new Logger(temp.dir);
    // Block app-error.log with a directory so appendFileSync fails with EISDIR.
    await mkdir(join(temp.dir, "app-error.log"));
    const received: string[] = [];
    logger.listener = (msg) => received.push(msg);
    assert.doesNotThrow(() => logger.log("disk-failure-test", "error"));
    assert.deepEqual(received, ["disk-failure-test"]);
  } finally {
    if (prevQuiet === undefined) delete process.env.COURSE_AFK_QUIET;
    else process.env.COURSE_AFK_QUIET = prevQuiet;
    await temp.close();
  }
});

test("diagnostics recursively scrub nested run outcomes, survive corrupt settings and respect maxLines", async () => {
  const temp = await temporary();
  const repo = new Repository(temp.dir);
  try {
    const settingsPath = join(temp.dir, "settings.json");
    const logsDir = join(temp.dir, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(settingsPath, "{corrupt json");
    const older = join(logsDir, "app-error-2026-01-01.log");
    await writeFile(
      older,
      Array.from(
        { length: 50 },
        (_, i) => `2026-01-01 [error] rotated-${i}`,
      ).join("\n") + "\n",
    );
    await utimes(older, new Date(1000), new Date(1000));
    await writeFile(
      join(logsDir, "app-error.log"),
      Array.from(
        { length: 1600 },
        (_, i) => `2026-01-01 [error] line-${i}`,
      ).join("\n") + "\n",
    );

    const task = repo.upsert(COURSE, "acc");
    const run = repo.begin(task, "learn");
    repo.end(run, "NEEDS_REVIEW", {
      message: "outer token=outer-secret",
      nested: {
        answers: ["secret-answer"],
        cookies: [{ value: "secret-cookie" }],
        deep: { note: "inner ticket=inner-secret" },
      },
    });

    const report = buildDiagnosticLog({
      repo,
      logsDir,
      settingsPath,
      root: temp.dir,
      snapshot: {
        account: "acc",
        operationId: null,
        kind: null,
        view: { title: "t", status: "s" },
        dashboard: {},
        logs: [],
        droppedLogs: 0,
      },
      accountLabel: (a) => a,
    });
    assert.ok(!report.content.includes("outer-secret"));
    assert.ok(!report.content.includes("inner-secret"));
    assert.ok(!report.content.includes("secret-answer"));
    assert.ok(!report.content.includes("secret-cookie"));
    assert.match(report.content, /无法读取设置文件/);
    // Ensure slice(-0) bug never pulls all lines from an older rotated file once limit is reached.
    const rotatedMatches = report.content.match(/rotated-\d+/g) || [];
    assert.equal(rotatedMatches.length, 0);
  } finally {
    repo.close();
    await temp.close();
  }
});

test("identity rejects mismatched HTTPS port, uppercase external redirects and deep redirect chains", () => {
  assert.throws(
    () =>
      normalize(
        `https://kc.zhixueyun.com:80/#/study/course/detail/${entry(COURSE, "a").businessId}`,
      ),
    /请使用/,
  );
  assert.throws(
    () =>
      normalize(
        `https://kc.zhixueyun.com/#/login?redirectUrl=${encodeURIComponent("HTTPS://evil.test/steal")}`,
      ),
    /请使用/,
  );
  let nested = COURSE;
  for (let i = 0; i < 4; i++)
    nested = `https://www.mylearning.cn/#/login?redirectUrl=${encodeURIComponent(nested)}`;
  assert.throws(() => normalize(nested), /链接跳转层数过多/);
});

test("settings validation rejects query/hash baseURL and non-ASCII apiKey, and repairs corrupt files", async () => {
  const temp = await temporary();
  const path = join(temp.dir, "settings.json");
  try {
    const base = defaults();
    assert.throws(
      () =>
        validateSettings({
          ...base,
          openai: {
            ...base.openai,
            baseURL: "https://api.example.test/v1?x=1",
          },
        }),
      /接口地址格式无效/,
    );
    assert.throws(
      () =>
        validateSettings({
          ...base,
          openai: { ...base.openai, apiKey: "sk-中文密钥" },
        }),
      /非 ASCII/,
    );
    await writeFile(path, "{broken");
    const cleared = prepareSettings(defaults(), path, true);
    assert.equal(cleared.openai.apiKey, "");
    const replaced = prepareSettings(
      { ...defaults(), openai: { ...defaults().openai, apiKey: "sk-fresh" } },
      path,
      false,
    );
    assert.equal(replaced.openai.apiKey, "sk-fresh");
  } finally {
    await temp.close();
  }
});

test("repository initializes 0-byte DB, preserves completed exams on recovery and keeps failure details on container refresh", async () => {
  const temp = await temporary();
  await writeFile(join(temp.dir, "workbench.sqlite"), "");
  let repo = new Repository(temp.dir);
  try {
    const completedExam = repo.upsert(EXAM, "a");
    repo.enqueue(completedExam, "exam");
    const intentId = repo.intent(completedExam, "submit", { recordId: "r1" });
    repo.confirm(intentId, { passed: true });
    repo.complete(completedExam, { passed: true });
    // Even if a stale pending intent row remains on a completed exam, recovery must never revert COMPLETED.
    repo.intent(completedExam, "submit", { recordId: "stale" });

    const crashedExam = repo.upsert(
      resource("exam", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      "a",
    );
    repo.enqueue(crashedExam, "exam");
    repo.begin(crashedExam, "exam");
    repo.intent(crashedExam, "submit", { recordId: "r2" });

    const container = repo.upsert(SUBJECT, "a");
    const childA = repo.upsert(COURSE, "a");
    const childB = repo.upsert(COURSE.replaceAll("11111111", "aaaaaaaa"), "a");
    repo.link(container, childA);
    repo.link(container, childB);
    repo.review(container, "enrollment_blocked", {
      message: "报名已截止",
      recovery: "blocked",
    });

    repo.close();
    repo = new Repository(temp.dir);
    assert.equal(repo.task(completedExam.id).status, "COMPLETED");
    assert.equal(repo.queue("a", "exam").length, 0);
    assert.equal(repo.queue("a", "review").length, 1);
    assert.equal(repo.queue("a", "review")[0].id, crashedExam.id);

    // Completing one child while another remains incomplete triggers refreshContainer()
    // and must not wipe the container's failure details.
    repo.complete(childA, { source: "test" });
    assert.equal(repo.task(container.id).status, "BLOCKED");
    assert.equal(repo.task(container.id).details.reason, "enrollment_blocked");
    assert.equal(repo.task(container.id).details.message, "报名已截止");
  } finally {
    repo.close();
    await temp.close();
  }
});

test("transfer sanitizes nested query secrets and validates bundle structure", () => {
  const url = `https://kc.zhixueyun.com/#/study/course/list?token=t1&code=t3&tab=2&paasurl=${encodeURIComponent("https://kc.zhixueyun.com/?ticket=t2&keep=1")}`;
  const cleaned = portableUrl(url);
  assert.ok(!cleaned.includes("t1"));
  assert.ok(!cleaned.includes("t2"));
  assert.ok(!cleaned.includes("t3"));
  assert.ok(cleaned.includes("tab=2"));
  assert.ok(cleaned.includes("keep%3D1"));
  assert.throws(() => normalizeBundle(null as any));
  assert.throws(() =>
    normalizeBundle({
      format: "course-pilot.tasks",
      version: 1,
      tasks: [{ url: COURSE, state: "invalid" }],
      sources: [],
    } as any),
  );
});

test("web server and application validate payloads, cap imports, evict FIFO requests, support force exit and tolerate unstarted close", async () => {
  const f = await application();
  const unstarted = new WebServer(f.app);
  await unstarted.close();

  const server = new WebServer(f.app);
  const url = await server.start(0);
  const bootstrap = new URL(url).hash.slice("#bootstrap=".length);
  const origin = server.origin;
  const sockets: WebSocket[] = [];
  try {
    const exchange = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "APPLICATION/JSON; charset=utf-8",
      },
      body: JSON.stringify({ bootstrap }),
    });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0];
    const session = (await exchange.json()) as { csrf: string; client: string };

    // Shadowed cookie + query string on GET route must succeed.
    const stateRes = await fetch(`${origin}/api/state?ts=123`, {
      headers: { Cookie: `course_web=fake; ${cookie}` },
    });
    assert.equal(stateRes.status, 200);

    // Corrupt settings.json must not crash dashboard().
    await writeFile(f.app.config.settingsPath, "{bad");
    assert.equal(f.app.dashboard().ai_configured, false);

    const connect = async (client = session.client) => {
      const ws = new WebSocket(origin.replace("http:", "ws:") + "/api/events", {
        headers: { Origin: origin, Cookie: cookie },
      });
      sockets.push(ws);
      const snapshot = await new Promise<any>((resolve, reject) => {
        ws.once("error", reject);
        ws.once("open", () => ws.send(JSON.stringify({ client })));
        ws.once("message", (m) => resolve(JSON.parse(m.toString())));
      });
      return { ws, snapshot };
    };

    // Open 8 observers then confirm controller can still connect (evicts an observer).
    for (let i = 0; i < 8; i++) await connect("");
    const writer = await connect(session.client);
    assert.equal(writer.snapshot.controller, true);
    const gen = writer.snapshot.generation as string;

    const post = (path: string, body: unknown) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
          "X-Control-Client": session.client,
          "X-Connection-ID": gen,
        },
        body: JSON.stringify(body),
      });

    // Strict validation on operation payloads and control routes.
    assert.equal(
      (
        await post("/api/operations", {
          kind: "export_queues",
          account: null,
          selection: "invalid",
          request_id: token(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/api/operations", {
          kind: "retry_tasks",
          account: IMPORT_INBOX,
          recovery: "invalid",
          request_id: token(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/api/operations", {
          kind: "clear_queues",
          scope: "all",
          request_id: token(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/api/import", {
          bundle: "not-an-object",
          request_id: token(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/api/control/nonexistent", {
          request_id: token(),
        })
      ).status,
      404,
    );

    // Import body larger than 10 MiB is rejected with 413.
    const huge = await fetch(origin + "/api/import", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
        "X-Control-Client": session.client,
        "X-Connection-ID": gen,
      },
      body: "x".repeat(10 * 1024 * 1024 + 64),
    });
    assert.equal(huge.status, 413);

    // Request deduplication map uses FIFO eviction beyond 2048 entries.
    f.app.execute = async () => {};
    for (let i = 0; i < 2055; i++) {
      f.app.command(token(), "operation", {
        kind: "retry_tasks",
        account: IMPORT_INBOX,
        recovery: "retry",
      });
      await f.app.settled();
    }

    // Force exit aborts an active learn operation and emits exit once.
    let exitCount = 0;
    f.app.on("exit", () => exitCount++);
    f.app.execute = async () => {
      await new Promise<void>((_, reject) => {
        f.app.abort!.signal.addEventListener("abort", () =>
          reject(f.app.abort!.signal.reason),
        );
      });
    };
    f.app.command(token(), "operation", { kind: "learn" });
    f.app.exit(false);
    assert.equal(f.app.stopAfter, true);
    assert.equal(f.app.abort!.signal.aborted, false);
    // Second exit escalates to force abort.
    f.app.exit(false);
    assert.equal(f.app.abort!.signal.aborted, true);
    await f.app.settled();
    assert.equal(f.app.exited, true);
    assert.equal(exitCount, 1);
  } finally {
    for (const ws of sockets) ws.terminate();
    await server.close();
    await f.close();
  }
});

test("until checks pre-aborted signal before calling fn; filename enforces UTF-8 byte budget and strips exposed dots", async () => {
  const abort = new AbortController();
  abort.abort(new Error("pre-aborted"));
  let calls = 0;
  await assert.rejects(
    until(
      async () => {
        calls++;
        return true;
      },
      1000,
      abort.signal,
      10,
    ),
    /pre-aborted/,
  );
  assert.equal(calls, 0);

  const longCjk = "中文课件名称测试".repeat(20);
  const safeCjk = filename(longCjk);
  assert.ok(Buffer.byteLength(safeCjk, "utf8") <= 60);
  assert.ok(!safeCjk.includes("\ufffd"));
  const dotBoundary = filename(`${"a".repeat(59)}.pdf`);
  assert.equal(dotBoundary, "a".repeat(59));
  assert.throws(() => decodeDocument(Buffer.from("plain"), undefined as any));
});

test("entryProblem matches exam ID case-insensitively and ReferenceCache tolerates null/corrupt manifest", async () => {
  const id = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
  assert.equal(
    entryProblem(
      {
        id: id.toLowerCase(),
        type: 1,
        status: 2,
        paperClass: { id: "p" },
        examRecord: { currentTime: Date.now() },
      },
      id,
    ),
    undefined,
  );

  const temp = await temporary();
  try {
    await writeFile(join(temp.dir, "manifest.json"), "null");
    const cache = new ReferenceCache(temp.dir);
    await cache.load(decodeDocument, 1024);
    assert.deepEqual(cache.manifest.files, []);
  } finally {
    await temp.close();
  }
});

test("ended Video.js media is not replayed and times out post-end sync cleanly; exam-pending courses leave learn queue", async (t) => {
  const temp = await temporary();
  const repo = new Repository(temp.dir);
  const task = repo.upsert(COURSE, "ended-test");
  repo.enqueue(task, "learn");
  const abort = new AbortController();
  let playClicks = 0;
  const section = {
    id: "sec-ended",
    resourceId: "res-ended",
    sectionType: 6,
    name: "已播完视频",
  };
  const ctx = {
    repo,
    lease: { account: task.account, signal: abort.signal },
    report() {},
    auth: {
      assert() {
        abort.signal.throwIfAborted();
      },
      async navigate() {
        const frame = {};
        return {
          closed: false,
          mainFrame: frame,
          async bringToFront() {},
          async close() {},
          async queryAll() {
            return [];
          },
          async query(selector: string) {
            if (selector.includes("vjs-big-play-button")) {
              return {
                frame,
                async click() {
                  playClicks++;
                },
              };
            }
            return null;
          },
          async waitForFunction() {},
          locator() {
            return {
              async waitFor() {},
              async element() {
                return {
                  async evaluate() {
                    return true;
                  },
                };
              },
            };
          },
          async evaluate(fn: unknown, arg: any, options: any) {
            if (fn === playbackSnapshot)
              return {
                focused: true,
                media: {
                  time: 120,
                  duration: 120,
                  paused: true,
                  ended: true,
                  readyState: 4,
                  error: false,
                },
              };
            if (typeof arg === "string") return true;
            if (options?.world === "isolated") return "synthetic-token";
            return { title: "课程", notices: [], challenge: false };
          },
          async fetch(url: string) {
            if (url.includes("/info/"))
              return {
                status: 200,
                ok: true,
                body: JSON.stringify({
                  id: task.businessId,
                  courseChapters: [{ courseChapterSections: [section] }],
                }),
              };
            return {
              status: 200,
              ok: true,
              body: JSON.stringify([
                {
                  courseId: task.businessId,
                  sectionId: section.id,
                  resourceId: section.resourceId,
                  finishStatus: 0,
                },
              ]),
            };
          },
        };
      },
    },
  } as unknown as DiscoveryContext;

  const cfg = { ...configuration(undefined, temp.dir), watchSlice: 1 };
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let ticks = 0;
  const running = learn(task, ctx, cfg, (progress) => {
    if (progress?.state === "syncing" && ticks === 0) {
      ticks++;
      t.mock.timers.tick(Math.max(cfg.stallLimit, 60) * 1000 + 5000);
    }
  });
  try {
    await running;
    assert.equal(playClicks, 0);
    const saved = repo.task(task.id);
    assert.equal(saved.status, "NEEDS_REVIEW");
    assert.match(saved.details.sections[0].message, /未确认完成/);
  } finally {
    abort.abort();
    await running.catch(() => {});
    t.mock.timers.reset();
    repo.close();
    await temp.close();
  }
});

test("AI Responses client handles compatible gateways without object field; listModels rejects HTML 200 and deduplicates", async () => {
  let mode: "responses-compat" | "models-html" | "models-dup" =
    "responses-compat";
  const server = createServer((req, res) => {
    if (req.url === "/v1/responses") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "r1",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: '{"status":"answered","answers":["A"]}',
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    if (mode === "models-html") {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>login</html>");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          { id: "m-2" },
          { id: "m-1" },
          { id: "m-1" },
          { id: "  " },
          { id: 123 },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const base = {
    ...defaults().openai,
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    model: "test",
    protocol: "responses" as const,
  };
  const question: Question = {
    id: "q1",
    type: "single",
    text: "2+2?",
    options: [
      { label: "A", text: "4" },
      { label: "B", text: "5" },
    ],
    media: false,
    selector: "",
    optionSelector: ".options",
  };
  try {
    const client = new AiClient(aiSettings(base));
    assert.deepEqual(
      await client.answer(question, new AbortController().signal),
      ["A"],
    );
    mode = "models-html";
    await assert.rejects(
      listModels(base, new AbortController().signal),
      /有效的 JSON 模型列表/,
    );
    mode = "models-dup";
    assert.deepEqual(await listModels(base, new AbortController().signal), [
      "m-1",
      "m-2",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
