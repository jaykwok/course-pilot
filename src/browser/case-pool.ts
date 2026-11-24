import {
  ActionabilityError,
  InputActionError,
  isContextGone,
  SessionEndedError,
  StaleElementError,
  TimeoutError,
  type Tab,
} from "nodriver-ts";
import { CASE_POOL, platformHost } from "../domain/identity.ts";
import { ReviewRequired } from "../utils.ts";

/** Wait through the site's own SSO flow; never read its token out of the page. */
export async function waitForCasePoolSession(
  tab: Tab,
  signal: AbortSignal,
  guard: () => void,
  timeout = 60000,
) {
  const deadline = Date.now() + timeout;
  const remaining = (cap: number) =>
    Math.max(1, Math.min(cap, deadline - Date.now()));
  let clicked = false;
  const isTransient = (error: unknown) =>
    error instanceof TimeoutError ||
    error instanceof StaleElementError ||
    error instanceof ActionabilityError ||
    isContextGone(error) ||
    (error instanceof SessionEndedError && !tab.closed);
  while (Date.now() < deadline) {
    guard();
    signal.throwIfAborted();
    if (tab.closed) throw new Error("案例库页面已关闭");
    try {
      await tab.waitForFunction(
        (target) => {
          const expected = new URL(target);
          return (
            location.origin === expected.origin &&
            location.pathname.replace(/\/$/, "") === expected.pathname &&
            document.readyState !== "loading" &&
            !!localStorage.getItem("userID")
          );
        },
        CASE_POOL,
        {
          timeout: remaining(500),
          signal,
          world: "isolated",
        },
      );
      guard();
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (!isTransient(error)) throw error;
    }
    signal.throwIfAborted();
    if (Date.now() >= deadline) break;
    if (!clicked) {
      for (const frame of tab.frames) {
        if (Date.now() >= deadline) break;
        if (frame.detached) continue;
        let host: string;
        try {
          host = new URL(frame.url).hostname;
        } catch {
          continue;
        }
        if (
          !["ctexpert.cn", "www.ctexpert.cn"].includes(host) &&
          !platformHost(host)
        )
          continue;
        try {
          // A password form needs human input; only follow an explicit SSO entry.
          if (
            await frame.query('input[type="password"]', {
              visible: true,
              timeout: remaining(1000),
              signal,
            })
          )
            continue;
          for (const button of await frame.queryAll(
            'button,a,[role="button"],input[type="button"],input[type="submit"]',
            {
              visible: true,
              timeout: remaining(1000),
              signal,
            },
          )) {
            if (Date.now() >= deadline) break;
            const eligible = await button.evaluate(
              (e) =>
                [
                  "登录",
                  "立即登录",
                  "去登录",
                  "重新登录",
                  "统一认证登录",
                  "单点登录",
                  "授权登录",
                  "登录并继续",
                  "同意并登录",
                ].includes(
                  (
                    e.innerText ||
                    e.textContent ||
                    (e as HTMLInputElement).value ||
                    ""
                  ).replace(/\s/g, ""),
                ) &&
                !e.matches(":disabled") &&
                e.getAttribute("aria-disabled") !== "true",
              undefined,
              { timeout: remaining(1000), signal },
            );
            if (!eligible) continue;
            await button.click({ timeout: remaining(3000), signal, guard });
            clicked = true;
            break;
          }
          if (clicked) break;
        } catch (error) {
          if (error instanceof InputActionError) {
            const cleanup = await error.cleanup;
            if (error.report.dispatched > 0 || cleanup.report.dispatched > 0)
              clicked = true;
            signal.throwIfAborted();
            if (cleanup.status !== "completed") throw error;
            error = error.cause;
          }
          signal.throwIfAborted();
          if (frame.detached || isTransient(error)) continue;
          throw error;
        }
      }
    }
  }
  throw new ReviewRequired(
    "discovery_incomplete",
    "案例库认证回跳尚未完成，请检查平台登录提示后重新解析",
  );
}
