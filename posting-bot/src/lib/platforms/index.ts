import type { Account } from "@prisma/client";
import type { Platform } from "../constants";
import { platformConfigured, type Settings } from "../settings";
import { instagramClient } from "./instagram";
import { createMockClient } from "./mock";
import { tiktokClient } from "./tiktok";
import type { PlatformClient } from "./types";
import { youtubeClient } from "./youtube";

const REAL: Record<Platform, PlatformClient> = {
  tiktok: tiktokClient,
  youtube: youtubeClient,
  instagram: instagramClient,
};

const MOCK: Record<Platform, PlatformClient> = {
  tiktok: createMockClient("tiktok"),
  youtube: createMockClient("youtube"),
  instagram: createMockClient("instagram"),
};

/** Client voor nieuwe koppelingen: echt als er sleutels zijn, anders mock. */
export function clientForConnect(platform: Platform, settings: Settings): { client: PlatformClient; mock: boolean } {
  const mock = !platformConfigured(settings, platform);
  return { client: mock ? MOCK[platform] : REAL[platform], mock };
}

/** Client voor een bestaand account: mock-accounts blijven altijd mock. */
export function clientForAccount(account: Pick<Account, "platform" | "isMock">): PlatformClient {
  const platform = account.platform as Platform;
  return account.isMock ? MOCK[platform] : REAL[platform];
}

export { PublishError } from "./types";
