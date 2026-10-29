import { describe, expect, it } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { nextSlots, parsePostingTimes } from "@/lib/scheduler";

const fmt = (d: Date, tz: string) => formatInTimeZone(d, tz, "yyyy-MM-dd HH:mm");

describe("parsePostingTimes", () => {
  it("normaliseert, sorteert en filtert ongeldige tijden", () => {
    expect(parsePostingTimes("19:00, 9:00;13:30 25:00 abc 09:00")).toEqual(["09:00", "13:30", "19:00"]);
  });
});

describe("nextSlots", () => {
  const cfg = { timezone: "Europe/Amsterdam", postingTimes: "09:00,13:00,19:00", dailyLimit: 3 };

  it("vult de eerstvolgende posttijden in de tijdzone van het account", () => {
    const from = new Date("2026-03-10T10:30:00Z"); // 11:30 in Amsterdam
    const slots = nextSlots(cfg, from, [], 4);
    expect(slots.map((d) => fmt(d, cfg.timezone))).toEqual([
      "2026-03-10 13:00",
      "2026-03-10 19:00",
      "2026-03-11 09:00",
      "2026-03-11 13:00",
    ]);
  });

  it("houdt rekening met zomertijd (DST)", () => {
    const from = new Date("2026-03-28T20:00:00Z");
    const slots = nextSlots({ ...cfg, postingTimes: "09:00", dailyLimit: 1 }, from, [], 2);
    // 29 maart 2026: klok gaat vooruit; 09:00 lokaal blijft 09:00 lokaal
    expect(slots.map((d) => fmt(d, cfg.timezone))).toEqual(["2026-03-29 09:00", "2026-03-30 09:00"]);
    expect(slots[0].toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(slots[1].toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });

  it("respecteert het daglimiet inclusief al geplande posts", () => {
    const from = new Date("2026-05-01T05:00:00Z"); // 07:00 lokaal
    const taken = [new Date("2026-05-01T08:15:00Z")]; // 10:15 lokaal, telt mee
    const slots = nextSlots({ ...cfg, dailyLimit: 2 }, from, taken, 3);
    expect(slots.map((d) => fmt(d, cfg.timezone))).toEqual(["2026-05-01 09:00", "2026-05-02 09:00", "2026-05-02 13:00"]);
  });

  it("slaat bezette slots over", () => {
    const from = new Date("2026-05-01T05:00:00Z");
    const taken = [new Date("2026-05-01T07:00:00Z")]; // exact 09:00 lokaal
    const slots = nextSlots(cfg, from, taken, 1);
    expect(fmt(slots[0], cfg.timezone)).toBe("2026-05-01 13:00");
  });

  it("werkt per account met verschillende tijdzones", () => {
    const from = new Date("2026-06-01T12:00:00Z");
    const ny = nextSlots({ timezone: "America/New_York", postingTimes: "09:00", dailyLimit: 1 }, from, [], 1)[0];
    const tokyo = nextSlots({ timezone: "Asia/Tokyo", postingTimes: "09:00", dailyLimit: 1 }, from, [], 1)[0];
    expect(ny.toISOString()).toBe("2026-06-01T13:00:00.000Z"); // 08:00 in NY → 09:00 dezelfde dag
    expect(tokyo.toISOString()).toBe("2026-06-02T00:00:00.000Z"); // 21:00 in Tokyo → morgen 09:00
  });
});
