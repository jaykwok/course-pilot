import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PASSWORD_TIME,
  prepareProjectProfile,
} from "../src/browser/profile.ts";
import { application, temporary } from "./helpers.ts";
import { atomicJson } from "../src/storage/files.ts";
import { accountId } from "../src/domain/identity.ts";
import { Browser, ClearSiteDataError } from "nodriver-ts";
import { BrowserRuntime } from "../src/browser/runtime.ts";
import { Logger } from "../src/log.ts";
import type { Protocol } from "devtools-protocol";
import { NO_REPLY } from "nodriver-ts/testing";

test("project profile preserves existing state, reapplies local-only settings and refuses personal profiles", async () => {
  const temp = await temporary();
  try {
    const dir = join(temp.dir, "browser-profile");
    await mkdir(dir);
    await writeFile(join(dir, ".nodriver.lock"), "synthetic library lock");
    await prepareProjectProfile(dir, { empty: true, temporary: false });
    const prefsPath = join(dir, "Default", "Preferences");
    const prefs = JSON.parse(await readFile(prefsPath, "utf8"));
    prefs.custom = { firstRunDismissed: true };
    prefs.signin.allowed = true;
    await atomicJson(prefsPath, prefs);
    await writeFile(join(dir, "Default", "Cookies"), "synthetic cookie store");
    await prepareProjectProfile(dir, { empty: false, temporary: false });
    const restored = JSON.parse(await readFile(prefsPath, "utf8"));
    assert.deepEqual(restored.custom, { firstRunDismissed: true });
    assert.equal(restored.signin.allowed, false);
    assert.equal(
      await readFile(join(dir, "Default", "Cookies"), "utf8"),
      "synthetic cookie store",
    );
    await atomicJson(join(temp.dir, "personal", "Local State"), {
      personal: true,
    });
    await assert.rejects(
      prepareProjectProfile(join(temp.dir, "personal"), {
        empty: false,
        temporary: false,
      }),
      /不属于此项目/,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(temp.dir, "personal", "Local State"), "utf8"),
      ),
      { personal: true },
    );
  } finally {
    await temp.close();
  }
});

test("persistent browser launch stays visible, disables extensions and retains its profile after close", async (t) => {
  const f = await application();
  try {
    const dir = join(f.temp.dir, "browser-profile");
    t.mock.method(Browser, "launch", async (options: any) => {
      assert.equal(options.headless, false);
      assert.equal(options.userDataDir, dir);
      assert.ok(options.args.includes("--disable-extensions"));
      assert.ok(options.args.includes("--disable-sync"));
      assert.ok(!options.args.includes("--no-sandbox"));
      assert.deepEqual(options.inputPolicy, { mode: "human" });
      await options.prepareProfile(dir, { empty: true, temporary: false });
      return f.browser;
    });
    const runtime = await BrowserRuntime.launch(
      new Logger(join(f.temp.dir, "logs")),
      process.execPath,
      dir,
    );
    await runtime.close();
    const local = JSON.parse(await readFile(join(dir, "Local State"), "utf8"));
    assert.equal(local.password_manager.os_password_blank, false);
    assert.equal(
      local.password_manager.os_password_last_changed,
      PASSWORD_TIME,
    );
    assert.ok(await readFile(join(dir, "course-afk-profile.json"), "utf8"));
  } finally {
    await f.close();
  }
});

test("task navigation follows rapid SSO replacements without replaying the navigation", async () => {
  const f = await application();
  try {
    const tab = f.browser.tabs[0];
    const scope = f.runtime.scope(new AbortController().signal);
    const frame = (loaderId: string, url: string) =>
      ({
        id: tab.mainFrame.id,
        loaderId,
        url,
        domainAndRegistry: "",
        securityOrigin: new URL(url).origin,
        mimeType: "text/html",
        secureContextType: "Secure",
        crossOriginIsolatedContextType: "NotIsolated",
        gatedAPIFeatures: [],
      }) as Protocol.Page.Frame;
    f.chrome.handle("Page.navigate", ({ url }, command) => {
      // Both commits arrive before the command reply; only the replacement
      // document emits DOMContentLoaded, as with an immediate SSO form submit.
      for (const [loader, target] of [
        ["sso", url],
        ["final", "https://center.mylearning.cn/PC/home"],
      ])
        f.chrome.emit(
          "Page.frameNavigated",
          { frame: frame(loader, target), type: "Navigation" },
          command.sessionId,
        );
      f.chrome.emit(
        "Page.lifecycleEvent",
        {
          frameId: tab.mainFrame.id,
          loaderId: "final",
          name: "DOMContentLoaded",
          timestamp: 1,
        },
        command.sessionId,
      );
      return { frameId: tab.mainFrame.id, loaderId: "sso" };
    });
    assert.equal(
      await scope.open("https://www.mylearning.cn/login", 1500),
      tab,
    );
    assert.equal(tab.url, "https://center.mylearning.cn/PC/home");
    assert.equal(
      f.chrome.commands.filter((command) => command.method === "Page.navigate")
        .length,
      1,
    );
    await scope.close();
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});

test("navigation timeouts, cancellation and failed requests close owned tabs without touching management", async () => {
  const f = await application();
  try {
    const admin = (f.runtime.management = await f.runtime.context.newTab());
    const abort = new AbortController(),
      scope = f.runtime.scope(abort.signal);
    f.chrome.handle("Page.navigate", () => NO_REPLY);
    await assert.rejects(
      scope.open("https://www.mylearning.cn/", 100),
      /timed out|timeout/i,
    );
    await scope.close();
    assert.equal(scope.tabs.length, 0);
    const cancelled = f.runtime.scope(abort.signal);
    f.chrome.handle("Page.navigate", () => {
      abort.abort(new Error("cancelled"));
      return NO_REPLY;
    });
    await assert.rejects(
      cancelled.open("https://www.mylearning.cn/"),
      /cancelled/,
    );
    await cancelled.close();
    assert.equal(cancelled.tabs.length, 0);
    const next = f.runtime.scope(new AbortController().signal);
    f.chrome.handle("Page.navigate", () => ({
      frameId: "unused",
      errorText: "net::ERR_NAME_NOT_RESOLVED",
    }));
    await assert.rejects(
      next.open("https://www.mylearning.cn/"),
      /ERR_NAME_NOT_RESOLVED/,
    );
    await next.close();
    assert.equal(next.tabs.length, 0);
    assert.equal(admin.closed, false);
    await next.close();
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});

test("temporary profile initialization refuses corrupt JSON instead of replacing it", async () => {
  const temp = await temporary();
  const dir = temp.dir;
  try {
    await prepareProjectProfile(dir, { empty: true, temporary: true });
    const local = JSON.parse(await readFile(join(dir, "Local State"), "utf8"));
    assert.equal(local.password_manager.os_password_blank, false);
    assert.equal(
      local.password_manager.os_password_last_changed,
      PASSWORD_TIME,
    );
    await writeFile(join(dir, "Local State"), "{invalid");
    await assert.rejects(
      prepareProjectProfile(dir, { empty: false, temporary: true }),
      /not valid JSON/,
    );
    assert.equal(await readFile(join(dir, "Local State"), "utf8"), "{invalid");
  } finally {
    await temp.close();
  }
});
test("protocol tabs share one context; scope cleanup preserves management and review tabs", async () => {
  const f = await application();
  try {
    f.runtime.management = await f.runtime.context.newTab();
    const scope = f.runtime.scope(new AbortController().signal);
    const work = await scope.open(),
      review = await scope.open();
    scope.retain(review);
    assert.equal(work.context, f.runtime.management.context);
    assert.equal(work.inputBehavior.policy.mode, "human");
    await scope.close();
    assert.equal(work.closed, true);
    assert.equal(review.closed, false);
    assert.equal(f.runtime.management.closed, false);
    assert.equal(
      f.chrome.commands.some((c) =>
        [
          "Runtime.enable",
          "Runtime.addBinding",
          "Console.enable",
          "Debugger.enable",
        ].includes(c.method),
      ),
      false,
    );
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});
test("abort closes only the owned working tabs", async () => {
  const f = await application();
  try {
    f.runtime.management = await f.runtime.context.newTab();
    const abort = new AbortController(),
      scope = f.runtime.scope(abort.signal),
      work = await scope.open();
    abort.abort();
    await scope.close();
    assert.equal(work.closed, true);
    assert.equal(f.runtime.management.closed, false);
    await assert.rejects(scope.open());
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});

test("borrowed startup and review tabs survive while this round's popups close", async () => {
  const f = await application();
  try {
    const scope = f.runtime.scope(new AbortController().signal);
    const startup = await scope.open();
    const openingReview = startup.waitForPopup({ timeout: 1000 });
    f.chrome.addPage({ openerId: startup.id });
    const review = await openingReview;
    scope.retain(review);
    const openingPopup = review.waitForPopup({ timeout: 1000 });
    f.chrome.addPage({ openerId: review.id });
    const popup = await openingPopup;
    assert.ok(scope.tabs.includes(startup));
    assert.ok(scope.tabs.includes(review));
    assert.ok(scope.tabs.includes(popup));
    await scope.close();
    assert.equal(startup.closed, false);
    assert.equal(review.closed, false);
    assert.equal(popup.closed, true);
    const next = f.runtime.scope(new AbortController().signal);
    assert.equal(await next.open(), startup);
    await next.close();
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});

test("cancellation closes a tab even when creation finishes after the task stops", async () => {
  const f = await application();
  const release = Promise.withResolvers<void>();
  try {
    f.runtime.management = f.runtime.takeStartupTab();
    const abort = new AbortController();
    const scope = f.runtime.scope(abort.signal);
    const entered = Promise.withResolvers<void>();
    let target = "";
    f.chrome.replyOnce("Target.createTarget", async () => {
      entered.resolve();
      await release.promise;
      target = f.chrome.addPage();
      return { targetId: target };
    });
    const reason = new Error("cancelled by the user");
    const rejected = assert.rejects(scope.open(), (error) => error === reason);
    await entered.promise;
    abort.abort(reason);
    await rejected;
    release.resolve();
    await scope.close();
    assert.ok(target);
    assert.equal(
      f.browser.pageTargets.some((page) => page.targetId === target),
      false,
    );
    assert.equal(f.runtime.management!.closed, false);
    f.chrome.assertDone();
  } finally {
    release.resolve();
    await f.close();
  }
});
test("session clearing targets a page CDP session and preserves the management page", async () => {
  const f = await application();
  try {
    const admin = await f.runtime.context.newTab();
    f.runtime.management = admin;
    f.chrome.handle("Storage.getCookies", () => ({ cookies: [] }));
    f.chrome.handle("Page.getNavigationHistory", () => ({
      currentIndex: 1,
      entries: [
        {
          id: 1,
          url: "https://kc.zhixueyun.com/",
          userTypedURL: "",
          title: "old platform page",
          transitionType: "typed",
        },
      ],
    }));
    const origins: string[] = [];
    f.chrome.handle("Storage.clearDataForOrigin", (params, command) => {
      assert.equal(command.sessionId, admin.cdp.id);
      assert.equal(params.origin.startsWith("http://127.0.0.1"), false);
      origins.push(params.origin);
    });
    f.runtime.note("https://sso.example.test/login");
    await f.runtime.clearPlatform();
    assert.equal(admin.closed, false);
    assert.ok(origins.includes("https://sso.example.test"));
    assert.ok(origins.includes("https://www.ctexpert.cn"));
    assert.ok(origins.includes("https://ctexpert.cn"));
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});

test("cancelled platform clearing retains the completed origins and original cause", async () => {
  const f = await application();
  try {
    const admin = (f.runtime.management = f.runtime.takeStartupTab());
    const abort = new AbortController();
    const reason = new Error("cancelled platform cleanup");
    const cleared: string[] = [];
    f.chrome.handle("Storage.getCookies", () => ({ cookies: [] }));
    f.chrome.handle("Page.getNavigationHistory", () => ({
      currentIndex: 0,
      entries: [],
    }));
    f.chrome.handle("Storage.clearDataForOrigin", ({ origin }) => {
      cleared.push(origin);
      if (cleared.length === 1) return;
      abort.abort(reason);
      return NO_REPLY;
    });
    await assert.rejects(f.runtime.clearPlatform(abort.signal), (error) => {
      assert.ok(error instanceof ClearSiteDataError);
      assert.equal(error.cause, reason);
      assert.deepEqual(error.result.origins, [cleared[0]]);
      return true;
    });
    assert.equal(cleared.length, 2);
    assert.equal(admin!.closed, false);
    f.chrome.assertDone();
  } finally {
    await f.close();
  }
});
test("credential content changes invalidate the lease even when metadata is unchanged", async () => {
  const f = await application();
  try {
    const c = {
      version: 2,
      account: "center:test",
      name: "Test",
      expires: new Date(Date.now() + 86400000).toISOString(),
      cookies: [
        { name: "x", value: "one", domain: ".mylearning.cn", path: "/" },
      ],
    };
    await atomicJson(f.app.auth.path, c);
    const auth = f.app.auth as any;
    auth.current = c;
    auth.verified = true;
    auth.fingerprint = f.app.auth.fileFingerprint();
    const lease = {
      account: accountId(c.account),
      generation: 0,
      fingerprint: auth.fingerprint,
      signal: new AbortController().signal,
    };
    f.app.auth.assert(lease);
    await atomicJson(f.app.auth.path, {
      ...c,
      cookies: [{ ...c.cookies[0], value: "two" }],
    });
    assert.throws(() => f.app.auth.assert(lease), /凭证或账号/);
  } finally {
    await f.close();
  }
});
