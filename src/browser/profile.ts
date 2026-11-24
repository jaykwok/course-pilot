import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { updateProfileSettings, type ProfilePreparation } from "nodriver-ts";
import { atomicJson, renameWithRetry } from "../storage/files.ts";
import { sleep } from "../utils.ts";

export const PASSWORD_TIME = "9223372036854775807";

const IGNORABLE_PROFILE_ENTRY =
  /^(?:\.nodriver\.lock(?:\.reclaim)?|course-afk-profile\.json\.[0-9a-f]+\.tmp|desktop\.ini|thumbs\.db|\.ds_store)$/i;
const TRANSIENT_FS = new Set(["EPERM", "EBUSY", "EACCES"]);

async function backupCorruptJson(path: string) {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return;
  } catch {}
  await renameWithRetry(path, `${path}.corrupt-${Date.now()}`);
}

/** Runs inside nodriver's profile lock, before the browser process starts. */
export async function prepareProjectProfile(
  directory: string,
  { empty, temporary, signal }: ProfilePreparation,
) {
  signal?.throwIfAborted();
  if (!temporary) {
    const marker = join(directory, "course-afk-profile.json");
    let effectivelyEmpty = empty;
    if (!effectivelyEmpty) {
      let raw: string | undefined;
      try {
        raw = await readFile(marker, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          const entries = await readdir(directory).catch(() => [] as string[]);
          if (entries.every((name) => IGNORABLE_PROFILE_ENTRY.test(name))) {
            effectivelyEmpty = true;
            for (const name of entries)
              if (/^course-afk-profile\.json\.[0-9a-f]+\.tmp$/i.test(name))
                await rm(join(directory, name), { force: true }).catch(
                  () => {},
                );
          }
        } else throw error;
      }
      if (!effectivelyEmpty) {
        let owned: any;
        try {
          owned = raw === undefined ? undefined : JSON.parse(raw);
        } catch {
          throw new Error(
            "浏览器目录标记文件损坏，请检查或清空 browser-profile 目录",
          );
        }
        if (owned?.application !== "course-afk" || owned.version !== 1)
          throw new Error(
            "浏览器目录不属于此项目，请使用空的 browser-profile 目录",
          );
      }
    }
    if (effectivelyEmpty)
      await atomicJson(marker, { application: "course-afk", version: 1 });
    else {
      // Recover owned persistent profiles if a hard crash truncated Chromium JSON files.
      await backupCorruptJson(join(directory, "Local State"));
      await backupCorruptJson(join(directory, "Default", "Preferences"));
    }
  }
  signal?.throwIfAborted();
  const patch = {
    localState: {
      password_manager: {
        os_password_blank: false,
        os_password_last_changed: PASSWORD_TIME,
      },
      signin: { allowed_on_device: false },
    },
    preferences: {
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false },
      signin: { allowed: false, allowed_on_next_startup: false },
      session: { restore_on_startup: 5, startup_urls: [] },
    },
  };
  // nodriver merges, writes atomically and verifies these application settings.
  for (let attempt = 0; ; attempt++) {
    try {
      await updateProfileSettings(directory, patch);
      break;
    } catch (error) {
      const code =
        (error as NodeJS.ErrnoException).code ||
        ((error as { cause?: NodeJS.ErrnoException }).cause?.code ?? "");
      if (!TRANSIENT_FS.has(code) || attempt >= 4) throw error;
      await sleep(Math.min(30 * 2 ** attempt, 250), signal);
    }
  }
  signal?.throwIfAborted();
}
