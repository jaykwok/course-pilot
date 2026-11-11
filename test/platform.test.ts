import test from "node:test";
import assert from "node:assert/strict";
import {
  examState,
  entryProblem,
  newSubmission,
  sameAnswers,
} from "../src/platform/exam.ts";
import { sectionStates, activate } from "../src/platform/learning.ts";
import {
  ActionabilityError,
  InputActionError,
  Locator,
  TimeoutError,
  StaleElementError,
  type Tab,
  type InputReport,
} from "nodriver-ts";
import type { DiscoveryContext } from "../src/platform/discovery.ts";
import {
  decodeDocument,
  previewUrl,
  filename,
  downloadFile,
} from "../src/platform/references.ts";
import { entry } from "../src/domain/identity.ts";
import { COURSE, EXAM } from "./helpers.ts";
import { accessProblem, clickPlayerControl } from "../src/platform/dom.ts";
import type { Element as BrowserElement } from "nodriver-ts";

test("answer verification preserves ordering answers and treats multiple choice as a set", () => {
  assert.equal(
    sameAnswers("ordering", ["B", "A", "C"], ["A", "B", "C"]),
    false,
  );
  assert.equal(sameAnswers("ordering", ["B", "A", "C"], ["B", "A", "C"]), true);
  const actual = ["C", "A"],
    expected = ["A", "C"];
  assert.equal(sameAnswers("multiple", actual, expected), true);
  assert.deepEqual(actual, ["C", "A"]);
  assert.deepEqual(expected, ["A", "C"]);
});

test("player input uses the library action guard and refuses other frames", async () => {
  for (const state of ["ready", "other-frame", "expired"]) {
    let pressed = false;
    const frame = {};
    const element = {
      frame: state === "other-frame" ? {} : frame,
      async click(options: any) {
        assert.equal(options.timeout, 5000);
        await options.guard();
        pressed = true;
      },
    } as unknown as BrowserElement;
    const tab = {
      mainFrame: frame,
    } as unknown as Tab;
    const result = clickPlayerControl(
      tab,
      element,
      new AbortController().signal,
      () => {
        if (state === "expired") throw new Error("凭证已变化");
      },
    );
    if (state === "ready") {
      await result;
      assert.equal(pressed, true);
    } else {
      await assert.rejects(result, /主页面|凭证已变化/);
      assert.equal(pressed, false);
    }
  }
});

test("chapter activation reacquires replaced rows but never replays partially dispatched input", async () => {
  for (const dispatched of [0, 1]) {
    let lookups = 0,
      focused = false;
    const abort = new AbortController();
    const report: InputReport = {
      action: "click",
      status: "interrupted",
      seed: 1,
      randomState: 1,
      completedSegments: 0,
      events: 1,
      dispatched,
      trace: [],
      cleanupErrors: [],
      phase: "done",
      cleanup: "completed",
    };
    const failure = new InputActionError(
      report,
      new StaleElementError("Element was removed from its document"),
    );
    const tab = {
      async evaluate(_fn: unknown, arg: unknown) {
        return typeof arg === "string"
          ? false
          : { challenge: false, title: "课程", notices: [] };
      },
      async queryAll() {
        return [];
      },
      locator(selector: string) {
        return new Locator(() => tab as any, selector);
      },
      async waitForSelector() {
        lookups++;
        return {
          async evaluate() {
            return false;
          },
          async click() {
            if (lookups === 1) throw failure;
            focused = true;
          },
        };
      },
      async waitForFunction() {
        assert.equal(focused, true);
      },
    } as unknown as Tab;
    const ctx = {
      auth: {
        assert() {
          abort.signal.throwIfAborted();
        },
      },
      lease: { signal: abort.signal },
    } as unknown as DiscoveryContext;
    const operation = activate(
      tab,
      { id: "section", resourceId: "resource", sectionType: 6 },
      ctx,
    );
    if (dispatched) {
      await assert.rejects(operation, (e) => e === failure);
      assert.equal(lookups, 1);
    } else {
      assert.equal(await operation, 'dl.chapter-list-box[id$="section"]');
      assert.equal(lookups, 2);
    }
  }
});

test("chapter layout movement is repositioned once only before any press was dispatched", async () => {
  for (const mode of [
    "recover",
    "pressed",
    "repeat",
    "auto-active",
    "cancel",
    "timeout",
  ]) {
    const abort = new AbortController();
    let clicks = 0,
      hovers = 0,
      focused = false,
      cleaned = false;
    const report: InputReport = {
      action: "click",
      status: "interrupted",
      seed: 1,
      randomState: 1,
      completedSegments: 0,
      events: 52,
      dispatched: mode === "pressed" ? 1 : 0,
      trace: [],
      cleanupErrors: [],
      phase: "done",
      cleanup: "completed",
    };
    const failure = new InputActionError(
      report,
      mode === "timeout"
        ? new TimeoutError("timed out")
        : new ActionabilityError("target moved"),
      Promise.resolve().then(() => {
        cleaned = true;
        return { status: "completed" as const, report };
      }),
    );
    const tab = {
      async queryAll() {
        return [];
      },
      async evaluate(_fn: unknown, arg: unknown) {
        return typeof arg === "string"
          ? focused
          : { challenge: false, title: "课程", notices: [] };
      },
      locator() {
        return {
          async click() {
            clicks++;
            if (clicks === 1 || mode === "repeat") {
              if (mode === "auto-active") focused = true;
              if (mode === "cancel") abort.abort(new Error("cancelled"));
              throw failure;
            }
            focused = true;
          },
          async hover() {
            assert.equal(cleaned, true);
            hovers++;
          },
        };
      },
      async waitForFunction() {
        assert.equal(focused, true);
      },
    } as unknown as Tab;
    const ctx = {
      auth: {
        assert() {
          abort.signal.throwIfAborted();
        },
      },
      lease: { signal: abort.signal },
    } as unknown as DiscoveryContext;
    const operation = activate(
      tab,
      { id: "s", resourceId: "r", sectionType: 1 },
      ctx,
    );
    if (["recover", "auto-active"].includes(mode)) await operation;
    else await assert.rejects(operation);
    assert.equal(clicks, ["recover", "repeat"].includes(mode) ? 2 : 1, mode);
    assert.equal(hovers, ["recover", "repeat"].includes(mode) ? 1 : 0, mode);
  }
});

test("already active chapters are not clicked again during automatic startup", async () => {
  const tab = {
    async evaluate() {
      return true;
    },
    locator(selector: string) {
      return new Locator(() => tab as any, selector);
    },
    async queryAll() {
      return [];
    },
    async waitForSelector() {
      return {
        async evaluate() {
          return true;
        },
        async click() {
          assert.fail("already active");
        },
      };
    },
  } as unknown as Tab;
  const ctx = {
    auth: { assert() {} },
    lease: { signal: new AbortController().signal },
  } as unknown as DiscoveryContext;
  assert.equal(
    await activate(tab, { id: "s", resourceId: "r", sectionType: 6 }, ctx),
    'dl.chapter-list-box[id$="s"]',
  );
});

test("chapter activation never replays a click when the platform does not confirm focus", async () => {
  let clicks = 0;
  const tab = {
    async queryAll() {
      return [];
    },
    async evaluate(_fn: unknown, arg: unknown) {
      return typeof arg === "string"
        ? false
        : { challenge: false, title: "课程", notices: [] };
    },
    locator(selector: string) {
      return new Locator(() => tab as any, selector);
    },
    async waitForSelector() {
      return {
        async evaluate() {
          return false;
        },
        async click() {
          clicks++;
        },
      };
    },
    async waitForFunction() {
      throw new TimeoutError("focus not confirmed");
    },
  } as unknown as Tab;
  const ctx = {
    auth: { assert() {} },
    lease: { signal: new AbortController().signal },
  } as unknown as DiscoveryContext;
  await assert.rejects(
    activate(tab, { id: "s", resourceId: "r", sectionType: 6 }, ctx),
    /focus not confirmed/,
  );
  assert.equal(clicks, 1);
});

test("access detection distinguishes business text from explicit verification and denial notices", () => {
  assert.equal(
    accessProblem({
      title: "网络安全学习",
      challenge: false,
      notices: [
        "短信验证码是什么？",
        "如何防范人机验证攻击",
        "安全验证基础知识",
      ],
    }),
    undefined,
  );
  assert.equal(
    accessProblem({ title: "安全验证", challenge: false, notices: [] }),
    "authentication",
  );
  assert.equal(
    accessProblem({ title: "", challenge: true, notices: [] }),
    "authentication",
  );
  assert.equal(
    accessProblem({ title: "", challenge: false, notices: ["请输入验证码"] }),
    "authentication",
  );
  for (const notice of [
    "请输入短信验证码",
    "请完成安全验证",
    "安全验证",
    "人机验证失败",
  ])
    assert.equal(
      accessProblem({ title: "", challenge: false, notices: [notice] }),
      "authentication",
    );
  assert.equal(
    accessProblem({
      title: "",
      challenge: false,
      notices: ["您正在学习其他课程"],
    }),
    "concurrent",
  );
  assert.equal(
    accessProblem({
      title: "",
      challenge: false,
      notices: ["当前账号不在学习范围"],
    }),
    "denied",
  );
});
test("exam state distinguishes unknown limits, unlimited attempts, scaled scores and grading", () => {
  assert.equal(examState({}).allowed, undefined);
  assert.equal(examState({ allowExamTimes: 0 }).allowed, 0);
  assert.equal(examState({ allowExamTimes: 3, examedTimes: 2 }).remaining, 1);
  assert.equal(
    examState({
      passScore: 3,
      paperClass: { totalScore: 500 },
      examRecord: { score: 400, isFinished: 1 },
    }).passed,
    true,
  );
  assert.equal(examState({ examRecord: { isFinished: 1 } }).pending, true);
  assert.ok(entryProblem({ id: "wrong" }, EXAM.split("/").at(-1)!));
  assert.ok(
    entryProblem(
      {
        id: "x",
        type: 1,
        paperClass: { id: "paper" },
        examRecord: {},
        isSetAccessSecret: 1,
      },
      "x",
    ),
  );
});
test("server section evidence rejects wrong resource, duplicate and wrong course records", () => {
  const task = entry(COURSE, "a"),
    section = { id: "s", resourceId: "r", sectionType: 5 },
    record = {
      courseId: task.businessId,
      sectionId: "s",
      resourceId: "r",
      finishStatus: 2,
    };
  assert.equal(
    sectionStates([record], task, [section]).get("s").finishStatus,
    2,
  );
  assert.throws(() => sectionStates([record, record], task, [section]));
  assert.throws(() =>
    sectionStates([{ ...record, courseId: "other" }], task, [section]),
  );
  assert.throws(() =>
    sectionStates([{ ...record, resourceId: "other" }], task, [section]),
  );
});
test("historic submitted record cannot confirm a new submission", () => {
  const state = examState({
    examedTimes: 2,
    examRecord: { id: "old", isFinished: 1, score: 0 },
  });
  assert.equal(newSubmission(state, { recordId: "old", used: 2 }), false);
  assert.equal(
    newSubmission(state, { recordId: "old", used: 2, submitted: true }),
    false,
  );
  assert.equal(
    newSubmission(state, { recordId: "old", used: 2, submitted: false }),
    true,
  );
  assert.equal(
    newSubmission({ ...state, recordId: "new" }, { recordId: "old", used: 2 }),
    true,
  );
  assert.equal(
    newSubmission({ ...state, used: 3 }, { recordId: "old", used: 2 }),
    true,
  );
});
test("downloads reject non-documents and outside hosts; names stay within output directory", () => {
  for (const url of [
    "https://zhixueyun.com.evil.test/a",
    "https://u:p@kc.zhixueyun.com/a",
    "http://kc.zhixueyun.com/a",
  ])
    assert.throws(() => previewUrl(url));
  assert.equal(previewUrl("/api/document").origin, "https://kc.zhixueyun.com");
  assert.ok(!/[<>:/\\]/.test(filename("../CON:foo")));
  assert.throws(() => decodeDocument(Buffer.from("<html>login</html>"), "pdf"));
  assert.equal(
    decodeDocument(
      Buffer.from(Buffer.from("%PDF-1.7").toString("base64")),
      "pdf",
    ).ext,
    "pdf",
  );
});
test("redirected downloads never forward platform Authorization to CDN", async () => {
  const calls: { url: string; auth: unknown }[] = [];
  const fetcher = (async (url: any, options: any) => {
    calls.push({ url: String(url), auth: options.headers.Authorization });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.zhixueyun.com/file.pdf" },
        })
      : new Response("%PDF-1.7");
  }) as typeof fetch;
  const value = await downloadFile(
    "https://kc.zhixueyun.com/api/file",
    "secret",
    new AbortController().signal,
    fetcher,
  );
  assert.equal(value.toString(), "%PDF-1.7");
  assert.equal(calls[0].auth, "secret");
  assert.equal(calls[1].auth, undefined);
});
