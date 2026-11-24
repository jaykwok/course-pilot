import {
  Browser,
  ClearSiteDataError,
  findExecutable,
  getStartupDiagnostics,
  ProfileInUseError,
  type BrowserContext,
  type InputPolicy,
  type Tab,
  type TabScope as BrowserTabScope,
} from "nodriver-ts";
import { prepareProjectProfile } from "./profile.ts";
import type { Logger } from "../log.ts";
const loopback = (host: string) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.replace(/^\./, ""));

export const FORBIDDEN_CDP = new Set([
  "Runtime.enable",
  "Runtime.addBinding",
  "Console.enable",
  "Debugger.enable",
]);
export function enforceSilentCdp(method: string) {
  if (FORBIDDEN_CDP.has(method))
    throw new Error(`拒绝发送静默模式禁用的 CDP 命令：${method}`);
}
export const INPUT_POLICY: InputPolicy = {
  mode: "human",
  lateMoves: "skip",
};

export async function executable(override?: string): Promise<string> {
  if (override) {
    try {
      return await findExecutable(override);
    } catch {
      throw new Error(
        "设置中的浏览器路径不存在，请检查 data/settings.json 的 browser.executable",
      );
    }
  }
  try {
    return await findExecutable(
      !process.env.CHROME_PATH && process.platform === "win32"
        ? { prefer: ["edge", "chrome", "chromium"] }
        : undefined,
    );
  } catch {
    throw new Error("未找到浏览器，请安装 Microsoft Edge 或 Google Chrome");
  }
}
export class BrowserRuntime {
  readonly browser: Browser;
  readonly context: BrowserContext;
  private readonly logger: Logger;
  private startupTab?: Tab;
  management?: Tab;
  readonly retained = new Set<Tab>();
  private origins = new Set([
    "https://www.mylearning.cn",
    "https://center.mylearning.cn",
    "https://kc.zhixueyun.com",
    "https://cms.mylearning.cn",
    "https://www.ctexpert.cn",
    "https://ctexpert.cn",
  ]);
  private unsubscribe: () => void;
  private constructor(browser: Browser, logger: Logger) {
    this.browser = browser;
    this.context = browser.defaultContext;
    this.logger = logger;
    // Capture only the launch tab, before any business scopes create their tabs.
    this.startupTab = this.context.tabs.find(
      (tab) =>
        !tab.closed &&
        tab.url === "about:blank" &&
        !browser.targetInfo.get(tab.id)?.openerId,
    );
    this.unsubscribe = browser.cdp.on(
      "Target.targetInfoChanged",
      ({ targetInfo }) => this.note(targetInfo.url),
    );
    browser.errors.on((error) => logger.log(error, "warn"));
  }
  static async launch(
    logger: Logger,
    path?: string,
    profileDirectory?: string,
  ) {
    try {
      const browser = await Browser.launch({
        executablePath: await executable(path),
        userDataDir: profileDirectory,
        prepareProfile: prepareProjectProfile,
        inputPolicy: INPUT_POLICY,
        beforeSend: enforceSilentCdp,
        headless: false,
        detached: true,
        supervised: true,
        timeout: 30000,
        preset: "agent",
        windowSize: { width: 1366, height: 900 },
        args: [
          "--disable-background-timer-throttling",
          "--disable-extensions",
          "--disable-sync",
          "--profile-directory=Default",
          "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC,msForceBrowserSignIn,msImplicitSignin,msEdgeOnRampFRE",
        ],
        onError: (e) => logger.log(e, "warn"),
      });
      return new BrowserRuntime(browser, logger);
    } catch (error) {
      const diagnostics = getStartupDiagnostics(error);
      if (diagnostics) {
        const proc = diagnostics.process;
        logger.log(
          `浏览器启动失败（阶段：${diagnostics.stage}，耗时 ${Math.round(diagnostics.elapsedMs)}ms` +
            (proc
              ? `，进程 ${proc.pid ?? "未知"}${proc.exited ? ` 已退出 code=${proc.exitCode} signal=${proc.signal}` : ""}`
              : "") +
            "）",
          "error",
        );
      }
      if (error instanceof ProfileInUseError)
        logger.log(
          `浏览器配置目录正被占用：${error.profile}，请先关闭已打开的项目浏览器窗口`,
          "error",
        );
      throw error;
    }
  }
  static fromBrowser(browser: Browser, logger: Logger) {
    return new BrowserRuntime(browser, logger);
  }
  note(url: string) {
    try {
      const u = new URL(url);
      if (["http:", "https:"].includes(u.protocol) && !loopback(u.hostname))
        this.origins.add(u.origin);
    } catch {}
  }
  takeStartupTab() {
    const startup = this.startupTab;
    this.startupTab = undefined;
    return startup && !startup.closed ? startup : undefined;
  }
  returnStartupTab(tab: Tab) {
    // Sequential work before the workbench opens reuses the launch tab.
    if (!this.management && !this.retained.has(tab) && !tab.closed)
      this.startupTab = tab;
  }
  async openManagement(url: string) {
    this.management = this.takeStartupTab() || (await this.context.newTab());
    await this.management.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await this.management.bringToFront();
    return this.management;
  }
  scope(signal: AbortSignal) {
    return new TabScope(this, signal);
  }
  async clearPlatform(signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Close platform pages first; they must not repopulate storage during invalidation.
    const closing = this.context.tabScope();
    for (const tab of this.context.tabs)
      if (tab !== this.management && !tab.url.startsWith("http://127.0.0.1:")) {
        this.note(tab.url);
        for (const origin of tab.origins) this.note(origin);
        closing.adopt(tab);
      }
    await closing.close();
    this.retained.clear();
    signal?.throwIfAborted();
    const domains = new Set(
      [...this.origins].map((origin) => new URL(origin).hostname),
    );
    for (const cookie of await this.context.cookies()) {
      if (!loopback(cookie.domain))
        domains.add(cookie.domain.replace(/^\./, ""));
    }
    try {
      return await this.context.clearSiteData({
        domains: [...domains],
        origins: [...this.origins],
        // Closing business tabs discarded their sessionStorage. Do not use its
        // history-based matching on the reused local management page.
        types: [
          "cookies",
          "localStorage",
          "indexedDB",
          "cacheStorage",
          "serviceWorkers",
        ],
        openTabs: "close",
        timeout: 30000,
        signal,
      });
    } catch (error) {
      if (error instanceof ClearSiteDataError)
        this.logger.log(
          `平台会话清理未完成：已处理 ${error.result.tabs.length} 个页面、${error.result.origins.length} 个站点、${error.result.cookies.length} 条 Cookie`,
          "warn",
        );
      throw error;
    }
  }
  async close() {
    this.unsubscribe();
    await this.browser.close();
  }
}
export class TabScope {
  readonly runtime: BrowserRuntime;
  readonly signal: AbortSignal;
  private readonly pages: BrowserTabScope;
  private readonly borrowed = new Set<Tab>();
  private startup?: Tab;
  private closing?: Promise<void>;
  private readonly abortListener: () => void;
  constructor(runtime: BrowserRuntime, signal: AbortSignal) {
    this.runtime = runtime;
    this.signal = signal;
    this.pages = runtime.context.tabScope();
    this.abortListener = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", this.abortListener, { once: true });
  }
  get tabs(): Tab[] {
    return [...this.pages.tabs, ...this.borrowed].filter((tab) => !tab.closed);
  }
  async open(url?: string, timeout = 30000) {
    this.signal.throwIfAborted();
    if (this.pages.closed) throw new Error("任务页面作用域已关闭");
    if (url) this.runtime.note(url);
    const options = {
      timeout,
      signal: this.signal,
      waitUntil: "domcontentloaded" as const,
    };
    try {
      const tab = this.runtime.management
        ? undefined
        : this.runtime.takeStartupTab();
      if (!tab) return await this.pages.newTab(url, options);
      this.pages.borrow(tab);
      this.borrowed.add(tab);
      this.startup = tab;
      if (url) await tab.goto(url, options);
      return tab;
    } catch (error) {
      this.signal.throwIfAborted();
      throw error;
    }
  }
  retain(tab: Tab) {
    if (!this.tabs.includes(tab)) throw new Error("标签不属于当前任务");
    // Preserve the review page while still owning any popups it opens this round.
    this.pages.borrow(tab);
    this.borrowed.add(tab);
    this.runtime.retained.add(tab);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.signal.removeEventListener("abort", this.abortListener);
      try {
        await this.pages.close();
      } finally {
        if (this.startup) this.runtime.returnStartupTab(this.startup);
        this.borrowed.clear();
      }
    })());
  }
}
