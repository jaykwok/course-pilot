import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TimeoutError, type Tab } from "nodriver-ts";
import { application } from "./helpers.ts";
import { atomicJson } from "../src/storage/files.ts";
import { CENTER, HOME } from "../src/config.ts";

async function fixture(t: TestContext) {
  const f = await application();
  const admin = (f.runtime.management = await f.runtime.context.newTab());
  const abort = new AbortController(),
    scope = f.runtime.scope(abort.signal);
  const urls: string[] = [],
    navigations: string[] = [];
  const cookie = {
    name: "session",
    value: "synthetic",
    domain: ".mylearning.cn",
    path: "/",
  };
  const credential = {
    version: 2,
    account: "center:old",
    name: "Old",
    expires: new Date(Date.now() + 86400000).toISOString(),
    cookies: [cookie],
  };
  await atomicJson(f.app.auth.path, credential);
  const original = await readFile(f.app.auth.path, "utf8");
  t.mock.method(f.runtime, "clearPlatform", async () => {});
  t.mock.method(f.runtime.context, "cookies", async () => [
    cookie,
    { ...cookie, name: "course_web", domain: "127.0.0.1" },
  ]);
  t.mock.method(f.runtime.context, "setCookies", async () => {});
  const open = scope.open.bind(scope);
  let tab: Tab;
  let ready = async () => true;
  let profile = async () => ({ account: "center:new", name: "New" });
  t.mock.method(scope, "open", async (url?: string) => {
    urls.push(url || "about:blank");
    tab = await open();
    t.mock.method(tab, "bringToFront", async () => {});
    t.mock.method(tab.mainFrame, "queryAll", async () => []);
    t.mock.method(tab, "goto", async (url: string) => {
      navigations.push(url);
      return url;
    });
    t.mock.method(tab, "waitForFunction", async (_fn: unknown, arg: unknown) =>
      arg === HOME ? ready() : true,
    );
    t.mock.method(tab, "evaluate", async () => "synthetic-token");
    t.mock.method(tab, "fetch", async (url: string, options: any) => {
      assert.equal(url, `${CENTER}/api/personal/user/info`);
      assert.equal(options.signal, abort.signal);
      assert.equal(options.mode, "same-origin");
      assert.equal(options.headers["x-token"], "synthetic-token");
      const result = await profile();
      return {
        ok: true,
        body: JSON.stringify({
          code: 0,
          data: {
            id: result.account.replace(/^center:/, ""),
            name: result.name,
          },
        }),
      };
    });
    return tab;
  });
  return {
    ...f,
    admin,
    abort,
    scope,
    urls,
    navigations,
    original,
    get tab() {
      return tab;
    },
    ready(fn: typeof ready) {
      ready = fn;
    },
    profile(fn: typeof profile) {
      profile = fn;
    },
    close: async () => {
      await scope.close();
      await f.close();
    },
  };
}

test("login ignores pre-login cookies and verifies the account in the same tab only after return", async (t) => {
  const f = await fixture(t);
  try {
    let waits = 0;
    f.ready(async () => {
      assert.deepEqual(f.navigations, []);
      assert.deepEqual(f.urls, [HOME]);
      if (++waits < 3) throw new TimeoutError("still awaiting human login");
      return true;
    });
    await f.app.auth.login(f.scope, () => {});
    assert.equal(waits, 3);
    assert.deepEqual(f.navigations, [`${CENTER}/PC/home`]);
    assert.deepEqual(f.urls, [HOME]);
    assert.equal(f.app.auth.read()?.account, "center:new");
    assert.deepEqual(
      f.app.auth.read()?.cookies.map((c) => c.name),
      ["session"],
    );
    assert.equal(f.admin.closed, false);
    assert.equal(f.tab.closed, true);
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});

test("cancelled or closed login leaves the original credentials and management page intact", async (t) => {
  for (const mode of ["cancel", "close"]) {
    const f = await fixture(t);
    try {
      f.ready(async () => {
        if (mode === "cancel") f.abort.abort(new Error("cancelled"));
        else await f.tab.close();
        throw new TimeoutError("waiting");
      });
      await assert.rejects(
        f.app.auth.login(f.scope, () => {}),
        /cancelled|登录窗口已关闭/,
      );
      assert.equal(await readFile(f.app.auth.path, "utf8"), f.original);
      assert.deepEqual(f.navigations, []);
      assert.equal(f.admin.closed, false);
      f.chrome.assertDone();
    } finally {
      await f.close();
    }
  }
});

test("failed account verification preserves the original credential without repeated login tabs", async (t) => {
  const f = await fixture(t);
  try {
    f.profile(async () => {
      throw new Error("account unavailable");
    });
    await assert.rejects(
      f.app.auth.login(f.scope, () => {}),
      /account unavailable/,
    );
    assert.equal(await readFile(f.app.auth.path, "utf8"), f.original);
    assert.deepEqual(f.urls, [HOME]);
    assert.deepEqual(f.navigations, [`${CENTER}/PC/home`]);
    assert.equal(f.admin.closed, false);
  } finally {
    await f.close();
  }
});

test("credential verification reuses the bootstrap tab and rejects a different account", async (t) => {
  const f = await fixture(t);
  try {
    await assert.rejects(f.app.auth.lease(f.scope), /账号与凭证不一致/);
    assert.equal(f.app.dashboard().credential.status, "invalid");
    assert.deepEqual(f.app.dashboard().recommended, {
      kind: "login",
      label: "更新登录凭证",
    });
    assert.deepEqual(f.urls, [HOME]);
    assert.deepEqual(f.navigations, [`${CENTER}/PC/home`]);
    assert.equal(f.tab.closed, true);
    assert.equal(f.admin.closed, false);
    assert.equal(await readFile(f.app.auth.path, "utf8"), f.original);
  } finally {
    await f.close();
  }
});

test("revoked credentials update the dashboard until verified again", async (t) => {
  const f = await fixture(t);
  try {
    assert.equal(f.app.dashboard().credential.status, "valid");
    f.app.auth.invalidate();
    assert.equal(f.app.dashboard().credential.status, "invalid");
    assert.equal(f.app.dashboard().recommended.kind, "login");
    f.profile(async () => ({ account: "center:old", name: "Old" }));
    await f.app.auth.lease(f.scope);
    assert.equal(f.app.dashboard().credential.status, "valid");
  } finally {
    await f.close();
  }
});
