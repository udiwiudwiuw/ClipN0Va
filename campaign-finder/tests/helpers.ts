import { prisma } from "@/lib/db";

export async function resetDb() {
  await prisma.feedback.deleteMany();
  await prisma.campaignVideo.deleteMany();
  await prisma.searchRun.deleteMany();
  await prisma.video.deleteMany();
  await prisma.campaign.deleteMany();
}

export function makeCampaign(overrides: Record<string, unknown> = {}) {
  return prisma.campaign.create({
    data: {
      name: "Testcampagne",
      brand: "Testpodcast",
      keywords: "ondernemen, geld, sparen",
      people: "Sam de Vries",
      topics: "startup",
      language: "nl",
      minMinutes: 5,
      maxMinutes: 120,
      excludedTopics: "crypto",
      ...overrides,
    },
  });
}
