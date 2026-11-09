import type { Tab } from "nodriver-ts";
import { PLATFORM } from "../config.ts";
import { AuthenticationError, ReviewRequired, sleep } from "../utils.ts";
import type { Authentication, Lease } from "./auth.ts";

export class PlatformHttp {
  readonly tab: Tab;
  readonly auth: Authentication;
  readonly lease: Lease;
  constructor(tab: Tab, auth: Authentication, lease: Lease) {
    this.tab = tab;
    this.auth = auth;
    this.lease = lease;
  }
  async json(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      readOnly?: boolean;
      headers?: Record<string, string>;
    } = {},
  ): Promise<any> {
    const url = new URL(path, PLATFORM);
    if (url.origin !== PLATFORM || url.username || url.password)
      throw new Error("API 地址不在允许范围");
    const method = options.method || "GET";
    if (
      options.readOnly &&
      method === "POST" &&
      !url.pathname.endsWith("/course-section-progress")
    )
      throw new Error("该写入接口不可重试");
    const attempts = method === "GET" || options.readOnly ? 3 : 1;
    this.auth.assert(this.lease);
    // Navigation finishes before the SPA has restored its access token. Wait before
    // sending any request, including writes; missing readiness is not an HTTP 401.
    await this.tab.waitForFunction(
      () => {
        if (location.origin !== "https://kc.zhixueyun.com") return false;
        if (/(?:^|; )authorization=([^;]+)/.test(document.cookie)) return true;
        if (
          /(?:^|;\s*)authorization=([^;]+)/.test(
            localStorage.getItem("save_cookie") || "",
          )
        )
          return true;
        if (localStorage.getItem("saas-token")) return true;
        try {
          return !!JSON.parse(localStorage.getItem("token") || "{}")
            .access_token;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 30000, signal: this.lease.signal },
    );
    for (let attempt = 0; attempt < attempts; attempt++) {
      const authorization = await this.authorization();
      // nodriver uses the browser's cookie jar and aborts its fetch on timeout or cancellation.
      const response = await this.tab.fetch<string>(url.href, {
        method,
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        timeout: 10000,
        signal: this.lease.signal,
        responseType: "text",
        headers: {
          Accept: "application/json",
          Version: "12.1.1",
          Authorization: authorization,
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        body:
          options.body === undefined
            ? undefined
            : typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body),
      });
      this.auth.assert(this.lease);
      if (response.status === 401 || response.status === 403) {
        this.auth.invalidate();
        throw new AuthenticationError(
          "平台登录状态失效或访问被拒绝，请重新登录",
        );
      }
      if (
        [429, 502, 503, 504].includes(response.status) &&
        attempt + 1 < attempts
      ) {
        await sleep(250 * 2 ** attempt, this.lease.signal);
        continue;
      }
      // Error JSON may omit Content-Type; non-JSON errors still retain their HTTP status.
      let value: any = null;
      try {
        value = JSON.parse(response.body);
      } catch (error) {
        if (response.ok) throw error;
      }
      if (!response.ok && value?.errorCode !== undefined) {
        // Translation is supplementary; a missing SPA module must not replace
        // the HTTP error, its status or the server's diagnostic.
        try {
          const message = await this.tab.evaluate(
            (code) => {
              if (location.origin !== "https://kc.zhixueyun.com")
                throw new Error("平台页面已变化");
              const errors = (
                window as unknown as {
                  require: (name: string) => {
                    erorrMap: Record<string, string>;
                    get: (code: string | number) => string;
                  };
                }
              ).require("./app/util/errors");
              return Object.hasOwn(errors.erorrMap, code)
                ? errors.get(code)
                : undefined;
            },
            value.errorCode,
            { timeout: 5000, signal: this.lease.signal, world: "main" },
          );
          if (message !== undefined) value.message = message;
        } catch {
          this.auth.assert(this.lease);
        }
      }
      this.auth.assert(this.lease);
      const r = { status: response.status, value };
      if (r.status < 200 || r.status >= 300) {
        const code = r.value?.errorCode ?? r.value?.code;
        const platformMessage = r.value?.message;
        const reason =
          typeof platformMessage === "string" ? platformMessage.trim() : "";
        const message =
          `平台接口响应 ${r.status}（${method} ${url.pathname}）` +
          (code === undefined ? "" : `，错误码 ${code}`) +
          (reason ? `：${reason}` : "");
        throw new ReviewRequired(
          "platform_rejected",
          message,
          r.status >= 400 && r.status < 500 && ![408, 429].includes(r.status)
            ? "blocked"
            : "retry",
        );
      }
      if (!r.value || typeof r.value !== "object")
        throw new Error("平台接口未返回有效对象");
      return r.value;
    }
    throw new Error("平台接口请求未完成");
  }
  async authorization(): Promise<string> {
    this.auth.assert(this.lease);
    const authorization = await this.tab.evaluate(
      () => {
        if (location.origin !== "https://kc.zhixueyun.com")
          throw new Error("平台页面未就绪");
        const cookie = document.cookie.match(
          /(?:^|; )authorization=([^;]+)/,
        )?.[1];
        let auth = cookie ? decodeURIComponent(cookie) : "";
        if (!auth)
          auth = decodeURIComponent(
            localStorage
              .getItem("save_cookie")
              ?.match(/(?:^|;\s*)authorization=([^;]+)/)?.[1] || "",
          );
        if (!auth) {
          try {
            const t = JSON.parse(
              localStorage.getItem("token") || "{}",
            ).access_token;
            if (t) auth = `Bearer__${t}`;
          } catch {}
        }
        if (!auth && localStorage.getItem("saas-token"))
          auth = `Bearer__${localStorage.getItem("saas-token")}`;
        return auth;
      },
      undefined,
      { timeout: 5000, signal: this.lease.signal, world: "isolated" },
    );
    this.auth.assert(this.lease);
    if (!authorization) {
      this.auth.invalidate();
      throw new AuthenticationError("平台登录状态失效，请重新登录");
    }
    return authorization;
  }
}
