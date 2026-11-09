import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { updateProfileSettings, type ProfilePreparation } from "nodriver-ts";
import { atomicJson } from "../storage/files.ts";

export const PASSWORD_TIME = "9223372036854775807";

/** Runs inside nodriver's profile lock, before the browser process starts. */
export async function prepareProjectProfile(
  directory: string,
  { empty, temporary, signal }: ProfilePreparation,
) {
  signal?.throwIfAborted();
  if (!temporary) {
    const marker = join(directory, "course-afk-profile.json");
    if (empty)
      await atomicJson(marker, { application: "course-afk", version: 1 });
    else {
      let owned;
      try {
        owned = JSON.parse(await readFile(marker, "utf8"));
      } catch {}
      if (owned?.application !== "course-afk" || owned.version !== 1)
        throw new Error(
          "浏览器目录不属于此项目，请使用空的 browser-profile 目录",
        );
    }
  }
  signal?.throwIfAborted();
  // nodriver merges, writes atomically and verifies these application settings.
  await updateProfileSettings(directory, {
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
  });
  signal?.throwIfAborted();
}
