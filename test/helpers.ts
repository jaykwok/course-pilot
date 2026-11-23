import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { InputReport } from "nodriver-ts";
import { ScriptedChrome } from "nodriver-ts/testing";
import {
  BrowserRuntime,
  enforceSilentCdp,
  INPUT_POLICY,
} from "../src/browser/runtime.ts";
import { Repository } from "../src/storage/repository.ts";
import { Logger } from "../src/log.ts";
import { Application } from "../src/application/runtime.ts";
import { configuration, ROOT } from "../src/config.ts";
export function inputReport(overrides: Partial<InputReport> = {}): InputReport {
  return {
    action: "click",
    status: "interrupted",
    seed: 1,
    randomState: 1,
    completedSegments: 0,
    events: 0,
    dispatched: 0,
    sent: {
      moves: 0,
      wheels: 0,
      presses: 0,
      keys: 0,
      characters: 0,
      releases: 0,
      text: 0,
      composition: 0,
    },
    skippedMoves: 0,
    lateReplies: 0,
    presentationRecoveries: 0,
    plannedMs: 0,
    actualMs: 0,
    trace: [],
    cleanupErrors: [],
    phase: "done",
    cleanup: "completed",
    ...overrides,
  };
}
export async function temporary() {
  const parent = join(ROOT, "build", "test-tmp");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "course-test-"));
  return {
    dir,
    close: () =>
      rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  };
}
export const COURSE =
  "https://kc.zhixueyun.com/#/study/course/detail/11111111-1111-4111-8111-111111111111";
export const EXAM =
  "https://kc.zhixueyun.com/#/exam/answer-paper/22222222-2222-4222-8222-222222222222";
export const SUBJECT =
  "https://kc.zhixueyun.com/#/study/subject/detail/33333333-3333-4333-8333-333333333333";
export async function application() {
  const temp = await temporary(),
    chrome = await ScriptedChrome.start(),
    browser = await chrome.connect({
      inputPolicy: INPUT_POLICY,
      beforeSend: enforceSilentCdp,
    }),
    logger = new Logger(join(temp.dir, "logs"));
  const runtime = BrowserRuntime.fromBrowser(browser, logger),
    repo = new Repository(join(temp.dir, "data"));
  const config = {
    ...configuration(ROOT, join(temp.dir, "data")),
    dataDir: join(temp.dir, "data"),
    logsDir: join(temp.dir, "logs"),
  };
  const app = new Application(repo, runtime, config, logger);
  return {
    temp,
    chrome,
    browser,
    runtime,
    repo,
    app,
    close: async () => {
      app.connection(true);
      await runtime.close();
      repo.close();
      await chrome.close();
      await temp.close();
    },
  };
}
