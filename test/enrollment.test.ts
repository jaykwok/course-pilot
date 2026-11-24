import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/storage/repository.ts";
import { discover, type DiscoveryContext } from "../src/platform/discovery.ts";
import { entry, normalize, resource } from "../src/domain/identity.ts";
import { temporary, COURSE, SUBJECT } from "./helpers.ts";

const classId = "75c755b8-a236-45e3-b599-fdb54db0ccea";
const classUrl = resource("class", classId);
const classCourse = `${COURSE}/5/1/${classId}`;
const paas = `https://kc.zhixueyun.com/#/paas-container?paasurl=${encodeURIComponent(`website/1645614858578771970/default?screen=desktop&type=4&isPreview=0&classId=${classId}`)}`;
const root = "https://cms.mylearning.cn/topic/project/pc.html";

async function fixture(
  options: {
    status?: number;
    after?: number;
    fields?: Record<string, unknown>;
    lostResponse?: boolean;
    wrongClass?: boolean;
    info?: Record<string, unknown>;
    detailCode?: number;
    chapters?: { id: string; name: string }[];
    activities?: (url: URL) => { status: number; value: unknown };
    paasActivities?: (url: URL) => { status: number; value: unknown };
    subjectChapters?: (url: URL) => { status: number; value: unknown };
  } = {},
) {
  const temp = await temporary(),
    repo = new Repository(temp.dir);
  let status = options.status ?? 0,
    posts = 0,
    chapterReads = 0,
    confirmations = 0;
  const ctx = {
    repo,
    lease: {
      account: "a",
      generation: 0,
      fingerprint: "f",
      signal: new AbortController().signal,
    },
    report() {},
    async confirm() {
      confirmations++;
      throw new Error("Unexpected enrollment confirmation");
    },
    auth: {
      assert() {},
      async navigate(_scope: unknown, url: string) {
        return {
          url,
          async close() {},
          async queryAll() {
            return [];
          },
          async waitForFunction() {},
          async evaluate(_fn: unknown, code?: unknown) {
            if (code !== undefined) return undefined;
            if (url !== root) return "synthetic-token";
            return {
              url,
              values: [paas],
              title: "专题",
              text: "",
              ready: true,
              status: 200,
              article: false,
              busy: false,
              interactive: false,
            };
          },
          async fetch(requestUrl: string, request: any) {
            const path = new URL(requestUrl).pathname;
            let value: unknown;
            if (path.endsWith("/registrationProgress"))
              value = {
                code: 0,
                data: {
                  classInfoId: options.wrongClass ? "wrong" : classId,
                  registerStatus: status,
                  classInfoVo: {
                    payType: 0,
                    isRegister: 2,
                    isRegisterReason: 2,
                    signupFile: 0,
                    ...options.fields,
                  },
                },
              };
            else if (path.includes("/class-info/safe/front/basic/")) {
              value = {
                ...(options.detailCode !== undefined
                  ? { code: options.detailCode }
                  : {}),
                id: classId,
                registerStartTime: null,
                registerEndTime: null,
                currentTime: Date.now(),
                ...options.info,
              };
            } else if (path.endsWith("/register")) {
              assert.equal(request.method, "POST");
              assert.deepEqual(JSON.parse(request.body), { classId });
              assert.equal(request.headers.permitenable, "false");
              posts++;
              status = options.after ?? 5;
              if (options.lostResponse) throw new Error("response lost");
              value = { code: 0 };
            } else {
              assert.equal(
                status,
                5,
                "chapters must only be read after verified enrollment",
              );
              chapterReads++;
              if (
                path.includes("/subject/chapter-progress") &&
                options.subjectChapters
              ) {
                const result = options.subjectChapters(new URL(requestUrl));
                return {
                  status: result.status,
                  ok: result.status === 200,
                  body: JSON.stringify(result.value),
                };
              }
              if (
                (path.endsWith("/chapter-activity-list/paas") ||
                  path.endsWith("/chapter-activity-list/paas/more")) &&
                options.paasActivities
              ) {
                const result = options.paasActivities(new URL(requestUrl));
                return {
                  status: result.status,
                  ok: result.status === 200,
                  body: JSON.stringify(result.value),
                };
              }
              if (
                path.endsWith("/chapter-activity-list") &&
                options.activities
              ) {
                const result = options.activities(new URL(requestUrl));
                return {
                  status: result.status,
                  ok: result.status === 200,
                  body: JSON.stringify(result.value),
                };
              }
              value = path.endsWith("/chapter")
                ? options.chapters || [
                    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
                  ]
                : {
                    items: [
                      {
                        id: "activity",
                        businessType: 8,
                        businessId: entry(COURSE, "a").businessId,
                        required: 1,
                      },
                    ],
                    recordCount: 1,
                  };
            }
            return { status: 200, ok: true, body: JSON.stringify(value) };
          },
        };
      },
    },
  } as unknown as DiscoveryContext;
  return {
    repo,
    ctx,
    stats: () => ({ posts, chapterReads, confirmations }),
    close: async () => {
      repo.close();
      await temp.close();
    },
  };
}

test("PAAS and recursively linked classes enroll automatically once, then collect courses", async () => {
  assert.equal(normalize(paas), classUrl);
  for (const url of [paas, root]) {
    const f = await fixture({ fields: { isRegister: 2, isRegisterReason: 1 } });
    try {
      const result = await discover([url], f.ctx);
      assert.equal(result.complete, true);
      assert.equal(result.found[0].url, classCourse);
      assert.equal(f.stats().posts, 1);
      assert.equal(f.stats().confirmations, 0);
      assert.equal(
        f.repo.pending(f.repo.upsert(classUrl, "a"), "enroll").length,
        0,
      );
      await discover([url], f.ctx);
      assert.equal(f.stats().posts, 1);
    } finally {
      await f.close();
    }
  }
});

test("class discovery preserves courses and the exact chapter failure instead of hiding the cause", async () => {
  const chapters = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "第一章" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "第二章" },
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "第三章" },
  ];
  const f = await fixture({
    status: 5,
    chapters,
    activities(url) {
      const id = url.searchParams.get("chapterId");
      if (id === chapters[0].id)
        return {
          status: 200,
          value: {
            items: [
              {
                id: "course",
                businessType: 8,
                businessId: entry(COURSE, "a").businessId,
                required: 1,
              },
            ],
            recordCount: 1,
          },
        };
      if (id === chapters[1].id)
        return {
          status: 422,
          value: { errorCode: 17, message: "章节不可访问" },
        };
      return {
        status: 200,
        value: {
          items: [{ id: "broken-link", businessValue: "not a url" }],
          recordCount: 1,
        },
      };
    },
  });
  try {
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.found.map((task) => task.url),
      [classCourse],
    );
    assert.equal(result.issues.length, 1);
    assert.match(
      result.issues[0].message,
      /第二章.*第 1 页.*422.*chapter-activity-list.*17.*章节不可访问/,
    );
    assert.match(result.issues[0].message, /第三章.*broken-link.*Invalid URL/);
    const task = f.repo.upsert(classUrl, "a");
    assert.equal(task.details.message, result.issues[0].message);
    assert.equal(f.stats().posts, 0);
  } finally {
    await f.close();
  }
});

test("already enrolled classes reconcile an old intent without submitting again", async () => {
  const f = await fixture({ status: 5 });
  try {
    const task = f.repo.upsert(classUrl, "a");
    f.repo.intent(task, "enroll", { registerStatus: 0 });
    assert.equal((await discover([paas], f.ctx)).complete, true);
    assert.equal(f.stats().posts, 0);
    assert.equal(f.repo.pending(task, "enroll").length, 0);
  } finally {
    await f.close();
  }
});

const activity = (n: number) => ({
  id: `activity-${n}`,
  businessType: 8,
  businessId: `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`,
  required: n % 2,
});

test("class pagination follows the declared total across short pages and retains class source identity", async () => {
  const items = Array.from({ length: 26 }, (_, n) => activity(n));
  const pages = [
    items.slice(0, 5),
    items.slice(5, 15),
    items.slice(15, 25),
    items.slice(25),
  ];
  const requested: number[] = [];
  const f = await fixture({
    status: 5,
    activities(url) {
      assert.ok(url.pathname.endsWith("/chapter-activity-list"));
      assert.equal(url.searchParams.get("pageSize"), "10");
      const page = Number(url.searchParams.get("page"));
      requested.push(page);
      return {
        status: 200,
        value: { items: pages[page - 1], recordCount: 26 },
      };
    },
  });
  try {
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, true);
    assert.deepEqual(requested, [1, 2, 3, 4]);
    assert.equal(result.found.length, 26);
    assert.equal(f.repo.queue("a", "learn").length, 26);
    for (const [n, task] of result.found.entries()) {
      assert.equal(task.sourceId, classId);
      assert.equal(task.sourceType, "5");
      assert.equal(task.required, String(n % 2));
    }
  } finally {
    await f.close();
  }
});

test("incomplete or changing page counts preserve discovered courses and remain retryable", async () => {
  for (const mode of ["repeated", "empty", "changed", "missing-total"]) {
    let reads = 0;
    const f = await fixture({
      status: 5,
      activities(url) {
        const page = Number(url.searchParams.get("page"));
        reads++;
        return {
          status: 200,
          value: {
            items:
              page === 1 || mode === "repeated"
                ? [activity(0)]
                : mode === "changed"
                  ? [activity(1)]
                  : [],
            recordCount:
              mode === "missing-total"
                ? undefined
                : mode === "changed" && page > 1
                  ? 3
                  : 2,
          },
        };
      },
    });
    try {
      const result = await discover([classUrl], f.ctx);
      assert.equal(result.complete, false);
      assert.equal(result.found.length, mode === "changed" ? 2 : 1);
      assert.equal(result.issues[0].recovery, "retry");
      assert.match(result.issues[0].message, /活动总数|未返回新的活动/);
      assert.equal(reads, mode === "missing-total" ? 1 : 2);
    } finally {
      await f.close();
    }
  }
});

test("class exams are not courses and manual activities do not erase usable tasks", async () => {
  const f = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            activity(0),
            { ...activity(1), businessType: 1 },
            { ...activity(2), businessType: 2 },
          ],
          recordCount: 3,
        },
      };
    },
  });
  try {
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.found.map((task) => task.kind),
      ["course", "exam"],
    );
    assert.equal(f.repo.queue("a", "learn").length, 1);
    assert.equal(f.repo.queue("a", "exam").length, 1);
    assert.equal(result.issues[0].recovery, "blocked");
    assert.match(result.issues[0].message, /活动类型 2 需要在平台处理/);
  } finally {
    await f.close();
  }
});

test("pending, rejected, paid and additional-form enrollment states remain explicit and do not submit", async () => {
  for (const [options, message] of [
    [{ status: 1 }, /待审核/],
    [{ status: 3 }, /待审核/],
    [{ status: 2 }, /未通过/],
    [{ status: 4 }, /待缴费/],
    [{ fields: { payType: 1 } }, /资料或付费/],
    [{ fields: { signupFile: 1 } }, /资料或付费/],
    [{ fields: { isRegister: 1, isRegisterReason: 1 } }, /资料或付费/],
    [{ wrongClass: true }, /状态不完整/],
  ] as const) {
    const f = await fixture(options);
    try {
      const result = await discover([paas], f.ctx);
      assert.equal(result.complete, false);
      assert.match(result.issues[0].message, message);
      assert.deepEqual(f.stats(), {
        posts: 0,
        chapterReads: 0,
        confirmations: 0,
      });
    } finally {
      await f.close();
    }
  }
});

test("lost enrollment responses are reconciled by status and never blindly resubmitted", async () => {
  for (const after of [0, 5]) {
    const f = await fixture({ lostResponse: true, after });
    try {
      assert.equal((await discover([paas], f.ctx)).complete, false);
      const result = await discover([paas], f.ctx);
      assert.equal(result.complete, after === 5);
      assert.equal(f.stats().posts, 1);
      if (after === 0) {
        assert.equal(f.stats().chapterReads, 0);
        assert.match(result.issues[0].message, /上次报名/);
      }
    } finally {
      await f.close();
    }
  }
});

test("accepted applications awaiting review are not mistaken for successful enrollment", async () => {
  const f = await fixture({ after: 1 });
  try {
    for (let n = 0; n < 2; n++)
      assert.match((await discover([paas], f.ctx)).issues[0].message, /待审核/);
    assert.equal(f.stats().posts, 1);
    assert.equal(f.stats().chapterReads, 0);
  } finally {
    await f.close();
  }
});

test("expired and future signup windows explain the block before any enrollment write", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-11-06T14:00:00Z"),
  });
  for (const [options, reason, message] of [
    [
      { info: { registerEndTime: "2026-03-31T23:59:00" } },
      "enrollment_closed",
      /报名已结束.*2026-03-31 23:59/,
    ],
    [
      { info: { registerStartTime: "2026-11-06T23:00:00" } },
      "enrollment_not_open",
      /报名尚未开始.*2026-11-06 23:00/,
    ],
    [
      { info: { registerEndTime: "2026-11-06T13:00:00Z" } },
      "enrollment_closed",
      /报名已结束.*2026-11-06 21:00/,
    ],
    [
      { info: { registerEndTime: "invalid" } },
      "enrollment_blocked",
      /时间格式/,
    ],
    [{ info: { id: "wrong" } }, "enrollment_blocked", /期限尚未确认/],
    [{ detailCode: 500 }, "enrollment_blocked", /期限尚未确认/],
    [{ info: { currentTime: null } }, "enrollment_blocked", /当前时间尚未确认/],
    [
      {
        info: {
          currentTime: Date.parse("2026-11-07T00:00:00Z"),
          registerEndTime: Date.parse("2026-11-06T23:00:00Z"),
        },
      },
      "enrollment_closed",
      /报名已结束/,
    ],
  ] as const) {
    for (const pending of [false, true]) {
      const f = await fixture(options);
      try {
        const task = f.repo.upsert(classUrl, "a");
        if (pending) f.repo.intent(task, "enroll", { registerStatus: 0 });
        const result = await discover([paas], f.ctx);
        assert.equal(result.complete, false);
        assert.match(result.issues[0].message, message);
        assert.equal(f.repo.task(task.id).details.reason, reason);
        assert.deepEqual(f.stats(), {
          posts: 0,
          chapterReads: 0,
          confirmations: 0,
        });
      } finally {
        await f.close();
      }
    }
  }
});

test("open signup windows enroll while enrolled students can read classes after the deadline", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-11-06T14:00:00Z"),
  });
  for (const options of [
    {
      info: {
        currentTime: Date.parse("2026-03-01T00:00:00Z"),
        registerEndTime: Date.parse("2026-03-31T15:59:00Z"),
      },
    },
    {
      info: {
        registerStartTime: "2026-11-06T21:59:59",
        registerEndTime: "2026-11-06T22:00:01",
      },
    },
    { status: 5, info: { registerEndTime: "2026-03-31T23:59:00" } },
  ]) {
    const f = await fixture(options);
    try {
      const result = await discover([paas], f.ctx);
      assert.equal(result.complete, true);
      assert.equal(result.found[0].url, classCourse);
      assert.equal(f.stats().posts, options.status === 5 ? 0 : 1);
    } finally {
      await f.close();
    }
  }
});

test("class external URL activities (type 11) resolve businessValue via PAAS and expand linked subjects", async () => {
  const subjectId = entry(SUBJECT, "a").businessId;
  const linkedCourseId = "99999999-9999-4999-8999-999999999999";
  const qrSubject = `https://kc.zhixueyun.com/app/wechat/#/qrScan?businessType=2&businessId=${subjectId}&isThirdUrl=1`;
  const paasRequests: string[] = [];
  const f = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            {
              id: "ext-1",
              businessType: 11,
              businessId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              required: 0,
              classStudentActivityProgress: { finishStatus: 1, status: 4 },
            },
            {
              id: "course-1",
              businessType: 8,
              businessId: entry(COURSE, "a").businessId,
              required: 1,
            },
            ...Array.from({ length: 4 }, (_, i) => activity(i + 10)),
            {
              id: "ext-2",
              businessType: 11,
              businessId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              required: 0,
              classStudentActivityProgress: { finishStatus: 0, status: 0 },
            },
          ],
          recordCount: 7,
        },
      };
    },
    paasActivities(url) {
      paasRequests.push(`${url.pathname}?page=${url.searchParams.get("page")}`);
      const page = Number(url.searchParams.get("page"));
      if (page === 1)
        return {
          status: 200,
          value: {
            items: [
              { id: "ext-1", businessType: 11, businessValue: qrSubject },
              { id: "course-1", businessType: 8, businessValue: "" },
              ...Array.from({ length: 3 }, (_, i) => activity(i + 10)),
            ],
            recordCount: 5,
          },
        };
      return {
        status: 200,
        value: {
          items: [
            activity(13),
            {
              id: "ext-2",
              businessType: 11,
              businessValue: "https://outside.example/notice",
            },
          ],
          recordCount: 0,
        },
      };
    },
    subjectChapters(url) {
      assert.equal(url.searchParams.get("courseId"), subjectId);
      return {
        status: 200,
        value: [
          {
            courseChapterSections: [
              { sectionType: 10, attachmentId: linkedCourseId, required: 1 },
            ],
          },
        ],
      };
    },
  });
  try {
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, true);
    assert.deepEqual(paasRequests, [
      "/api/v1/training/student/class-info/safe/chapter-activity-list/paas?page=1",
      "/api/v1/training/student/class-info/safe/chapter-activity-list/paas/more?page=2",
    ]);
    const urls = result.found.map((t) => t.url);
    assert.ok(urls.includes(classCourse));
    assert.ok(
      urls.includes(`${resource("course", linkedCourseId, subjectId, 1)}`),
    );
    const edge = f.repo.db
      .prepare("SELECT required FROM edges WHERE parent=? AND child=?")
      .get(f.repo.upsert(classUrl, "a").id, f.repo.upsert(SUBJECT, "a").id);
    assert.equal(edge?.required, 0);
  } finally {
    await f.close();
  }
});

test("unfinished required class external URL activities still queue linked courses and stay blocked, while PAAS failures remain retryable", async () => {
  const subjectId = entry(SUBJECT, "a").businessId;
  const linkedCourseId = "88888888-8888-4888-8888-888888888888";
  for (const paasDown of [false, true]) {
    const f = await fixture({
      status: 5,
      activities() {
        return {
          status: 200,
          value: {
            items: [
              {
                id: "ext-req",
                businessType: 11,
                required: 1,
                classStudentActivityProgress: { finishStatus: 0, status: 0 },
              },
              {
                id: "course-1",
                businessType: 8,
                businessId: entry(COURSE, "a").businessId,
                required: 1,
              },
            ],
            recordCount: 2,
          },
        };
      },
      paasActivities() {
        if (paasDown)
          return { status: 500, value: { message: "server error" } };
        return {
          status: 200,
          value: {
            items: [
              { id: "ext-req", businessType: 11, businessValue: SUBJECT },
            ],
            recordCount: 2,
          },
        };
      },
      subjectChapters() {
        return {
          status: 200,
          value: [
            {
              courseChapterSections: [
                { sectionType: 10, attachmentId: linkedCourseId, required: 1 },
              ],
            },
          ],
        };
      },
    });
    try {
      const result = await discover([classUrl], f.ctx);
      assert.equal(result.complete, false);
      assert.equal(result.issues[0].recovery, paasDown ? "retry" : "blocked");
      assert.ok(result.found.some((t) => t.url === classCourse));
      assert.equal(
        result.found.some(
          (t) => t.url === resource("course", linkedCourseId, subjectId, 1),
        ),
        !paasDown,
      );
      if (!paasDown)
        assert.match(
          result.issues[0].message,
          /必修外链活动尚未在平台确认完成/,
        );
    } finally {
      await f.close();
    }
  }
});

test("re-discovering an upgraded class downgrades legacy required external-URL edges so completed classes finish", async () => {
  const f = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            {
              id: "ext-done",
              businessType: 11,
              businessValue: COURSE,
              required: 1,
              classStudentActivityProgress: { finishStatus: 1, status: 4 },
            },
          ],
          recordCount: 1,
        },
      };
    },
  });
  try {
    const classTask = f.repo.upsert(classUrl, "a");
    const targetCourse = f.repo.upsert(COURSE, "a");
    // Simulate a pre-upgrade DB where the URL destination was linked as required=1.
    f.repo.link(classTask, targetCourse, true);
    f.repo.outcome(classTask.id, "WAITING_CHILDREN", {
      discoveryComplete: true,
      ownDiscoveryComplete: true,
    });
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, true);
    const edge = f.repo.db
      .prepare("SELECT required FROM edges WHERE parent=? AND child=?")
      .get(classTask.id, targetCourse.id);
    assert.equal(edge?.required, 0);
    assert.equal(f.repo.task(classTask.id).status, "COMPLETED");
    assert.equal(f.repo.task(targetCourse.id).status, "READY");
    assert.ok(f.repo.queue("a", "learn").some((t) => t.id === targetCourse.id));
  } finally {
    await f.close();
  }
});

test("incomplete class discovery preserves existing required edges", async () => {
  const f = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            {
              id: "ext-done",
              businessType: 11,
              businessValue: COURSE,
              required: 0,
              classStudentActivityProgress: { finishStatus: 1, status: 4 },
            },
            {
              id: "manual",
              businessType: 2,
              required: 1,
            },
          ],
          recordCount: 2,
        },
      };
    },
  });
  try {
    const classTask = f.repo.upsert(classUrl, "a");
    const targetCourse = f.repo.upsert(COURSE, "a");
    f.repo.link(classTask, targetCourse, true);
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, false);
    const edge = f.repo.db
      .prepare("SELECT required FROM edges WHERE parent=? AND child=?")
      .get(classTask.id, targetCourse.id);
    assert.equal(edge?.required, 1);
  } finally {
    await f.close();
  }
});

test("class businessValue with percent-encoded %26 entrance prefix, encoded hash query, encoded query values and nested redirects still enqueues courses", async () => {
  const c1 = "11111111-1111-4111-8111-111111111111";
  const c2 = "22222222-2222-4222-8222-222222222222";
  const c3 = "33333333-3333-4333-8333-333333333333";
  const c4 = "44444444-4444-4444-8444-444444444444";
  const c5 = "55555555-5555-4555-8555-555555555555";
  const c6 = "66666666-6666-4666-8666-666666666666";
  const c7 = "77777777-7777-4777-8777-777777777777";
  const c8 = "88888888-8888-4888-8888-888888888888";
  const f = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            {
              id: "encoded-amp",
              businessType: 8,
              required: 1,
              businessValue: `https://kc.zhixueyun.com/#/study/course/detail/11%26${c1}/5/1/${classId}`,
            },
            {
              id: "fully-encoded",
              businessType: 8,
              required: 1,
              businessValue: encodeURIComponent(
                `https://kc.zhixueyun.com/#/study/course/detail/11&${c2}/5/1/${classId}`,
              ),
            },
            {
              id: "nested-redirect",
              businessType: 8,
              required: 1,
              businessValue: `https://center.mylearning.cn/sso?redirectUrl=${encodeURIComponent(`https://kc.zhixueyun.com/#/study/course/detail/11%26${c3}/5/1/${classId}`)}`,
            },
            {
              id: "encoded-query-value",
              businessType: 8,
              required: 1,
              businessValue: `https://kc.zhixueyun.com/#/study/course/detail/11%26${c4}/5/1/${classId}?title=foo%20%26required%3D0`,
            },
            {
              id: "encoded-hash-route-and-query",
              businessType: 8,
              required: 1,
              businessValue: `https://kc.zhixueyun.com/#${encodeURIComponent(`/study/course/detail/11&${c5}?type=5&required=1&sourceId=${classId}&title=foo%20%26required%3D0`)}`,
            },
            {
              id: "encoded-hash-prefix-and-query",
              businessType: 8,
              required: 1,
              businessValue: `https://kc.zhixueyun.com/%23${encodeURIComponent(`/study/course/detail/11&${c6}?type=5&required=1&sourceId=${classId}`)}`,
            },
            {
              id: "encoded-hash-query-separator",
              businessType: 8,
              required: 1,
              businessValue: `https://kc.zhixueyun.com/#/study/course/detail/11%26${c7}%3Ftype%3D5%26required%3D1%26sourceId%3D${classId}`,
            },
            {
              id: "encoded-qmark-in-query-value",
              businessType: 8,
              required: 1,
              businessValue: `https://kc.zhixueyun.com/#/study/course/detail/11%26${c8}?type=5&required=1&sourceId=${classId}&title=foo%3Fbar%26required%3D0`,
            },
          ],
          recordCount: 8,
        },
      };
    },
  });
  try {
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.found.map((task) => task.url),
      [c1, c2, c3, c4, c5, c6, c7, c8].map(
        (id) =>
          `https://kc.zhixueyun.com/#/study/course/detail/${id}/5/1/${classId}`,
      ),
    );
  } finally {
    await f.close();
  }
});

test("class activity URLs with embedded credentials remain rejected even with encoded /%23 paths", async () => {
  const c1 = "11111111-1111-4111-8111-111111111111";
  const f = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            {
              id: "cred-course",
              businessType: 8,
              required: 1,
              businessValue: `https://user:pass@kc.zhixueyun.com/%23/study/course/detail/${c1}`,
            },
            {
              id: "cred-ext",
              businessType: 11,
              required: 0,
              businessValue: `https://user:pass@kc.zhixueyun.com/%23/study/course/detail/${c1}`,
              classStudentActivityProgress: { finishStatus: 1, status: 4 },
            },
          ],
          recordCount: 2,
        },
      };
    },
  });
  try {
    const result = await discover([classUrl], f.ctx);
    assert.equal(result.complete, false);
    assert.deepEqual(result.found, []);
    assert.match(result.issues[0].message, /cred-course/);
    assert.match(result.issues[0].message, /cred-ext.*培训班外链地址无效/);
  } finally {
    await f.close();
  }
});

test("HTTP and HTTPS aliases merge by task identity so required edges win and upgraded optional edges downgrade", async () => {
  const httpClassCourse = classCourse.replace("https://", "http://");
  const httpCourse = COURSE.replace("https://", "http://");
  const both = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            {
              id: "ext-http",
              businessType: 11,
              businessValue: httpClassCourse,
              required: 0,
              classStudentActivityProgress: { finishStatus: 1, status: 4 },
            },
            {
              id: "req-https",
              businessType: 8,
              businessId: entry(COURSE, "a").businessId,
              required: 1,
            },
          ],
          recordCount: 2,
        },
      };
    },
  });
  try {
    const classTask = both.repo.upsert(classUrl, "a");
    // Pre-store the task with HTTP URL so child.url differs in scheme from HTTPS.
    const child = both.repo.upsert(httpClassCourse, "a");
    both.repo.link(classTask, child, true);
    const result = await discover([classUrl], both.ctx);
    assert.equal(result.complete, true);
    const edge = both.repo.db
      .prepare("SELECT required FROM edges WHERE parent=? AND child=?")
      .get(classTask.id, child.id);
    assert.equal(edge?.required, 1);
    assert.equal(both.repo.task(classTask.id).status, "WAITING_CHILDREN");
    assert.equal(both.repo.task(child.id).status, "READY");
  } finally {
    await both.close();
  }

  const upgraded = await fixture({
    status: 5,
    activities() {
      return {
        status: 200,
        value: {
          items: [
            {
              id: "ext-https",
              businessType: 11,
              businessValue: COURSE,
              required: 1,
              classStudentActivityProgress: { finishStatus: 1, status: 4 },
            },
          ],
          recordCount: 1,
        },
      };
    },
  });
  try {
    const classTask = upgraded.repo.upsert(classUrl, "a");
    // Old DB stored HTTP URL with required=1; new manifest returns HTTPS optional URL.
    const child = upgraded.repo.upsert(httpCourse, "a");
    upgraded.repo.link(classTask, child, true);
    upgraded.repo.outcome(classTask.id, "WAITING_CHILDREN", {
      discoveryComplete: true,
      ownDiscoveryComplete: true,
    });
    const result = await discover([classUrl], upgraded.ctx);
    assert.equal(result.complete, true);
    const edge = upgraded.repo.db
      .prepare("SELECT required FROM edges WHERE parent=? AND child=?")
      .get(classTask.id, child.id);
    assert.equal(edge?.required, 0);
    assert.equal(upgraded.repo.task(classTask.id).status, "COMPLETED");
  } finally {
    await upgraded.close();
  }
});

test("class discovery warms up the class page once on cold 422/60111 and still blocks genuine permission denials", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runCase = async (succeedAfterWarmup: boolean) => {
    const temp = await temporary(),
      repo = new Repository(temp.dir);
    let navigations = 0,
      chapterCalls = 0;
    const ctx = {
      repo,
      lease: {
        account: "a",
        generation: 0,
        fingerprint: "f",
        signal: new AbortController().signal,
      },
      report() {},
      auth: {
        assert() {},
        async navigate(_scope: unknown, url: string) {
          navigations++;
          return {
            url,
            closed: false,
            async close() {},
            async waitForFunction() {},
            async evaluate(_fn: unknown, code?: unknown) {
              if (code === 60111) return "您无权限参加该培训班";
              if (code !== undefined) return undefined;
              return "synthetic-token";
            },
            async fetch(requestUrl: string) {
              const path = new URL(requestUrl).pathname;
              if (path.endsWith("/registrationProgress"))
                return {
                  status: 200,
                  ok: true,
                  body: JSON.stringify({
                    code: 0,
                    data: {
                      classInfoId: classId,
                      registerStatus: 5,
                      classInfoVo: {
                        payType: 0,
                        isRegister: 2,
                        isRegisterReason: 2,
                        signupFile: 0,
                      },
                    },
                  }),
                };
              if (path.endsWith("/chapter")) {
                chapterCalls++;
                if (chapterCalls === 1 || !succeedAfterWarmup)
                  return {
                    status: 422,
                    ok: false,
                    body: JSON.stringify({
                      errorCode: 60111,
                      message: "Invalid input.",
                    }),
                  };
                return {
                  status: 200,
                  ok: true,
                  body: JSON.stringify([
                    {
                      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                      name: "阶段",
                    },
                  ]),
                };
              }
              return {
                status: 200,
                ok: true,
                body: JSON.stringify({
                  items: [
                    {
                      id: "act-1",
                      businessType: 8,
                      businessId: entry(COURSE, "a").businessId,
                      required: 1,
                    },
                  ],
                  recordCount: 1,
                }),
              };
            },
          };
        },
      },
    } as unknown as DiscoveryContext;
    try {
      const pending = discover([classUrl], ctx);
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(500);
      }
      const result = await pending;
      return { result, navigations, chapterCalls };
    } finally {
      repo.close();
      await temp.close();
    }
  };
  try {
    const recovered = await runCase(true);
    assert.equal(recovered.result.complete, true);
    assert.equal(recovered.navigations, 2);
    assert.equal(recovered.chapterCalls, 2);
    assert.deepEqual(
      recovered.result.found.map((task) => task.url),
      [classCourse],
    );

    const denied = await runCase(false);
    assert.equal(denied.result.complete, false);
    assert.equal(denied.navigations, 2);
    assert.equal(denied.chapterCalls, 2);
    assert.equal(denied.result.issues[0].recovery, "blocked");
    assert.match(
      denied.result.issues[0].message,
      /60111.*您无权限参加该培训班/,
    );
  } finally {
    t.mock.timers.reset();
  }
});
