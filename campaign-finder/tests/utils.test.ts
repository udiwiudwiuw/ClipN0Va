import { describe, expect, it } from "vitest";
import { durationFilter, buildQueries } from "@/lib/search/youtube";
import { parseFeed } from "@/lib/search/rss";
import { parseSource } from "@/lib/search/types";
import { formatTimestamp, parseIsoDuration, parseTimestamp, splitList } from "@/lib/utils";
import { toCsv } from "@/lib/export";

describe("utils", () => {
  it("parset ISO-duur en tijdstempels", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1M")).toBe(86460);
    expect(parseIsoDuration("onzin")).toBeNull();
    expect(formatTimestamp(135)).toBe("02:15");
    expect(formatTimestamp(3725)).toBe("1:02:05");
    expect(parseTimestamp("02:15")).toBe(135);
    expect(parseTimestamp("1:02:05")).toBe(3725);
    expect(parseTimestamp("ab:cd")).toBeNull();
  });

  it("splitst lijsten uniek", () => {
    expect(splitList("a, b,,A\nc")).toEqual(["a", "b", "c"]);
  });

  it("CSV beschermt tegen formule-injectie en escapet", () => {
    const csv = toCsv([{ a: "=HYPERLINK(1)", b: 'zei "hoi", toen' }]);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain('"zei ""hoi"", toen"');
  });
});

describe("bronnen", () => {
  it("herkent kanaal-, handle- en video-URL's", () => {
    expect(parseSource("https://www.youtube.com/channel/UC1234567890123456789012")).toMatchObject({ type: "channel", channelId: "UC1234567890123456789012" });
    expect(parseSource("https://www.youtube.com/@pixelpete/videos")).toMatchObject({ type: "handle", handle: "pixelpete" });
    expect(parseSource("@pixelpete")).toMatchObject({ type: "handle" });
    expect(parseSource("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ type: "video", videoId: "dQw4w9WgXcQ" });
    expect(parseSource("https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ")).toMatchObject({ type: "video", videoId: "dQw4w9WgXcQ" });
    expect(parseSource("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toMatchObject({ type: "video" });
    expect(parseSource("tiktok.com/@x/video/1")).toMatchObject({ type: "unknown" });
  });

  it("kiest de juiste YouTube-duurfilter en bouwt queries", () => {
    expect(durationFilter(20, null)).toBe("long");
    expect(durationFilter(null, 3)).toBe("short");
    expect(durationFilter(5, 15)).toBe("medium");
    expect(durationFilter(5, 60)).toBeUndefined();
    const q = buildQueries({ id: "x", name: "x", brand: "B", sources: [], keywords: ["geld", "sparen"], people: ["Sam"], topics: [], excludedTopics: [], language: "nl", minMinutes: null, maxMinutes: null });
    expect(q).toEqual(['"Sam" geld | sparen', "geld | sparen"]);
  });

  it("parset een YouTube RSS-feed", () => {
    const xml = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><yt:channelId>UCx</yt:channelId><title>Titel &amp; meer</title>
      <author><name>Kanaal</name></author><published>2026-01-02T10:00:00+00:00</published>
      <media:group><media:thumbnail url="https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg" width="480"/>
      <media:description>Beschrijving</media:description><media:community><media:starRating count="12" average="5.00"/><media:statistics views="3400"/></media:community></media:group></entry></feed>`;
    const [v] = parseFeed(xml);
    expect(v).toMatchObject({ externalId: "abcdefghijk", title: "Titel & meer", channelTitle: "Kanaal", viewCount: 3400, likeCount: 12, source: "rss", durationSec: null });
  });
});
