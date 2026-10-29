import cron from "node-cron";
import { prisma } from "./db";
import { enqueueSearch } from "./queue";

const g = globalThis as unknown as { __finderScheduler?: boolean };

/** Campagnes waarvan de volgende automatische zoekronde aan de beurt is. */
export async function dueCampaigns(now = new Date()) {
  const campaigns = await prisma.campaign.findMany({ where: { active: true, searchIntervalHours: { gt: 0 } } });
  return campaigns.filter((c) => !c.lastSearchedAt || now.getTime() - c.lastSearchedAt.getTime() >= c.searchIntervalHours * 3600_000);
}

/** Elke 5 minuten: zet zoekrondes in de wachtrij voor campagnes die aan de beurt zijn. */
export function startScheduler() {
  if (g.__finderScheduler) return;
  g.__finderScheduler = true;
  cron.schedule("*/5 * * * *", async () => {
    try {
      for (const c of await dueCampaigns()) await enqueueSearch(c.id, "schedule");
    } catch (err) {
      console.error("[finder] planner fout", err);
    }
  });
  console.log("[finder] planner gestart (elke 5 min)");
}
