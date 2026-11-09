import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import type { Tab } from "nodriver-ts";
import { PlatformHttp } from "../src/browser/http.ts";
import type { Authentication, Lease } from "../src/browser/auth.ts";
import { AuthenticationError, ReviewRequired } from "../src/utils.ts";

function fixture(statuses: number[]) {
  const abort = new AbortController();
  let sends = 0,
    waits = 0,
    invalidations = 0,
    ready = false;
  const lease: Lease = {
    account: "a",
    generation: 0,
    fingerprint: "f",
    signal: abort.signal,
  };
  const auth = {
    assert() {
      abort.signal.throwIfAborted();
    },
    invalidate() {
      invalidations++;
    },
  } as unknown as Authentication;
  const tab = {
    async waitForFunction() {
      waits++;
      ready = true;
    },
    async evaluate() {
      assert.equal(ready, true, "requests must await SPA token readiness");
      return "synthetic-token";
    },
    async fetch(_url: string, options: any) {
      assert.equal(options.signal, lease.signal);
      assert.equal(options.timeout, 10000);
      assert.equal(options.mode, "same-origin");
      sends++;
      const status = statuses.shift()!;
      return {
        status,
        ok: status === 200,
        body: JSON.stringify({ data: "ok" }),
      };
    },
  } as unknown as Tab;
  return {
    http: new PlatformHttp(tab, auth, lease),
    tab,
    abort,
    stats: () => ({ sends, waits, invalidations }),
  };
}
test("API waits for readiness, retries reads but never retries writes", async () => {
  const read = fixture([503, 200]);
  assert.deepEqual(await read.http.json("/api/read"), { data: "ok" });
  assert.equal(read.stats().sends, 2);
  const write = fixture([503, 200]);
  await assert.rejects(
    write.http.json("/api/enroll", { method: "POST", body: {} }),
    /503/,
  );
  assert.equal(write.stats().sends, 1);
  await assert.rejects(
    write.http.json("/api/enroll", { method: "POST", readOnly: true }),
    /不可重试/,
  );
  assert.equal(write.stats().sends, 1);
});

test("API errors retain JSON business reasons and endpoint without exposing request queries", async (t) => {
  for (const [status, body, contentType, expected] of [
    [
      422,
      JSON.stringify({ errorCode: 60111, message: "Invalid input." }),
      "",
      /422.*60111.*您无权限参加该培训班/,
    ],
    [
      422,
      JSON.stringify({ errorCode: 69040, message: "培训班已关闭" }),
      "application/json",
      /422.*GET \/api\/class.*69040.*培训班已关闭/,
    ],
    [
      422,
      JSON.stringify({ code: 12, message: "参数无效" }),
      "application/problem+json",
      /422.*12.*参数无效/,
    ],
    [500, "<html>server error</html>", "text/html", /500.*GET \/api\/class/],
  ] as const) {
    const f = fixture([]);
    let requests = 0;
    t.mock.method(f.tab, "evaluate", async (fn: Function, arg: unknown) =>
      runInNewContext(`(${fn.toString()})`, {
        location: { origin: "https://kc.zhixueyun.com" },
        document: { cookie: "authorization=test-token" },
        window: {
          require(name: string) {
            assert.equal(name, "./app/util/errors");
            return {
              erorrMap: { 60111: "permission" },
              get: () => "您无权限参加该培训班",
            };
          },
        },
      })(arg),
    );
    t.mock.method(f.tab, "fetch", async (_url: string, options: any) => {
      requests++;
      assert.equal(options.headers.Authorization, "test-token");
      assert.equal(options.responseType, "text");
      return {
        status,
        ok: false,
        body,
        headers: { "content-type": contentType },
      };
    });
    await assert.rejects(
      f.http.json("/api/class?token=private-query"),
      (error: Error) => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /private-query|test-token|<html>/);
        assert.ok(error instanceof ReviewRequired);
        assert.equal(error.recovery, status === 422 ? "blocked" : "retry");
        return true;
      },
    );
    assert.equal(requests, 1, "business errors must not be retried blindly");
  }
});
test("API authentication failure invalidates lease without retry; cancellation sends nothing", async () => {
  const denied = fixture([401, 200]);
  await assert.rejects(denied.http.json("/api/read"), AuthenticationError);
  assert.deepEqual(denied.stats(), { sends: 1, waits: 1, invalidations: 1 });
  const cancelled = fixture([200]);
  cancelled.abort.abort(new Error("cancelled"));
  await assert.rejects(cancelled.http.json("/api/read"), /cancelled/);
  assert.equal(cancelled.stats().sends, 0);
  await assert.rejects(
    fixture([200]).http.json("https://outside.test/api/read"),
    /允许范围/,
  );
});

test("HTTP status handling does not depend on SPA error translation", async (t) => {
  for (const statuses of [[401], [403], [503, 200], [422]]) {
    const f = fixture([]);
    let requests = 0,
      translations = 0;
    t.mock.method(f.tab, "evaluate", async (_fn: unknown, code: unknown) => {
      if (code === undefined) return "synthetic-token";
      translations++;
      throw new Error("SPA error module unavailable");
    });
    t.mock.method(f.tab, "fetch", async () => {
      const status = statuses[requests++];
      return {
        status,
        ok: status === 200,
        body: JSON.stringify(
          status === 200
            ? { data: "ok" }
            : { errorCode: 123, message: "server diagnostic" },
        ),
      };
    });
    if (statuses[0] === 503) {
      assert.deepEqual(await f.http.json("/api/read"), { data: "ok" });
      assert.equal(requests, 2);
      assert.equal(translations, 0);
    } else if (statuses[0] === 422) {
      await assert.rejects(f.http.json("/api/read"), (error: Error) => {
        assert.ok(error instanceof ReviewRequired);
        assert.match(error.message, /422.*123.*server diagnostic/);
        assert.equal(error.recovery, "blocked");
        return true;
      });
      assert.equal(requests, 1);
      assert.equal(translations, 1);
    } else {
      await assert.rejects(f.http.json("/api/read"), AuthenticationError);
      assert.equal(f.stats().invalidations, 1);
      assert.equal(requests, 1);
      assert.equal(translations, 0);
    }
  }
});

test("browser requests preserve JSON and form bodies and check the lease again before sending", async (t) => {
  for (const [body, headers, expected] of [
    [{ courseId: "course" }, {}, '{"courseId":"course"}'],
    [
      "examId=exam",
      { "Content-Type": "application/x-www-form-urlencoded" },
      "examId=exam",
    ],
  ] as const) {
    const f = fixture([200]);
    t.mock.method(f.tab, "fetch", async (_url: string, options: any) => {
      assert.equal(options.method, "POST");
      assert.equal(options.body, expected);
      assert.equal(
        options.headers["Content-Type"],
        headers["Content-Type"] || "application/json",
      );
      assert.equal(options.signal, f.abort.signal);
      return { status: 200, ok: true, body: '{"data":"ok"}' };
    });
    await f.http.json("/api/write", { method: "POST", body, headers });
  }
  const cancelled = fixture([200]);
  t.mock.method(cancelled.tab, "evaluate", async () => {
    cancelled.abort.abort(new Error("account changed"));
    return "old-token";
  });
  await assert.rejects(
    cancelled.http.json("/api/write", { method: "POST", body: {} }),
    /account changed/,
  );
  assert.equal(cancelled.stats().sends, 0);
});
