import { configuration } from "./config.ts";
import { Logger, redact } from "./log.ts";
import { Repository } from "./storage/repository.ts";
import { BrowserRuntime, executable } from "./browser/runtime.ts";
import { Application } from "./application/runtime.ts";
import { WebServer } from "./web/server.ts";
import { acquireInstance, reopenInstance } from "./application/instance.ts";
import { join } from "node:path";

async function main() {
  const version = process.versions.node.split(".").map(Number);
  if (version[0] < 24 || (version[0] === 24 && version[1] < 22))
    throw new Error("请安装 Node.js 24.22.0 或更高版本");
  const config = configuration();
  if (process.argv.includes("--check-startup")) {
    await executable(config.browserPath);
    console.log("Node.js 和浏览器已就绪");
    return;
  }
  const lock = await acquireInstance(config.dataDir);
  if (!lock.owned) {
    await reopenInstance(lock.instance);
    return;
  }
  let repo: Repository | undefined,
    browser: BrowserRuntime | undefined,
    server: WebServer | undefined,
    app: Application | undefined;
  try {
    const logger = new Logger(config.logsDir);
    repo = new Repository(config.dataDir);
    browser = await BrowserRuntime.launch(
      logger,
      config.browserPath,
      join(config.dataDir, "browser-profile"),
    );
    app = new Application(repo, browser, config, logger);
    server = new WebServer(app);
    const url = await server.start();
    server.reopen = async () => {
      if (browser!.management && !browser!.management.closed)
        await browser!.management.bringToFront();
      else throw new Error("管理窗口已关闭，服务正在退出");
    };
    await lock.publish(server.origin, server.reopenKey);
    const exiting = new Promise<void>((resolve) => {
      if (app!.exited) resolve();
      else app!.once("exit", resolve);
    });
    let sigints = 0;
    const onSigint = () => {
      sigints++;
      app!.exit(sigints > 1);
    };
    const onSigterm = () => app!.exit(true);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    let off = () => {};
    try {
      const management = await browser.openManagement(url);
      // A closed management page is the lifecycle boundary; business popups never own shutdown.
      off = management.onClose.on(() => app!.exit(true));
      if (management.closed || browser.browser.closed) app!.exit(true);
      await exiting;
      await app.settled();
    } finally {
      off();
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  } finally {
    try {
      await server?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          repo?.close();
        } finally {
          await lock.close();
        }
      }
    }
  }
}
main().catch((e) => {
  console.error(redact(e));
  process.exitCode = 1;
});
