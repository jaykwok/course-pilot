import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireInstance } from "../src/application/instance.ts";
import { temporary } from "./helpers.ts";

test(
  "instance ownership survives process boundaries and releases after a crash",
  { timeout: 15000 },
  async () => {
    const temp = await temporary();
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { acquireInstance } from ${JSON.stringify(new URL("../src/application/instance.ts", import.meta.url).href)};
    const lock = await acquireInstance(process.argv[1]);
    if (!lock.owned) throw new Error("unexpected owner");
    await lock.publish("http://127.0.0.1:12345", "child-key");
    process.send("ready");
    setInterval(() => {}, 1000);
  `,
        temp.dir,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    try {
      await Promise.race([
        once(child, "message"),
        exited.then(() => {
          throw new Error(`Instance child exited: ${stderr}`);
        }),
      ]);
      const other = await acquireInstance(temp.dir);
      assert.equal(other.owned, false);
      if (!other.owned) assert.equal(other.instance.key, "child-key");
      child.kill("SIGKILL");
      await exited;
      // The stale JSON left by the crashed process must not prevent a new owner.
      const replacement = await acquireInstance(temp.dir);
      assert.equal(replacement.owned, true);
      if (replacement.owned) await replacement.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      await temp.close();
    }
  },
);

test("different data directories can each own an instance", async () => {
  const a = await temporary(),
    b = await temporary();
  const first = await acquireInstance(a.dir),
    second = await acquireInstance(b.dir);
  try {
    assert.equal(first.owned, true);
    assert.equal(second.owned, true);
  } finally {
    if (first.owned) await first.close();
    if (second.owned) await second.close();
    await a.close();
    await b.close();
  }
});
