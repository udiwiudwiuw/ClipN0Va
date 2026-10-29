import { prisma } from "./db";

type Level = "debug" | "info" | "warn" | "error";

export async function log(
  level: Level,
  message: string,
  opts: { postId?: string; accountId?: string; meta?: unknown } = {},
) {
  const line = `[bot] ${level.toUpperCase()} ${message}`;
  if (level === "error") console.error(line);
  else if (process.env.NODE_ENV !== "test") console.log(line);
  try {
    await prisma.log.create({
      data: {
        level,
        message,
        postId: opts.postId,
        accountId: opts.accountId,
        meta: opts.meta === undefined ? null : JSON.stringify(opts.meta),
      },
    });
  } catch (err) {
    console.error("[bot] kon log niet opslaan", err);
  }
}
