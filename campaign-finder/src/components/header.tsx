"use client";

import { Bot, Database, FlaskConical, Radar } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui";
import { usePoll } from "@/lib/use-poll";
import { cn } from "@/lib/utils";

type Status = { searchMode: string; youtubeApi: boolean; demoData: boolean; aiProvider: string; aiModel: string };

export function Header() {
  const path = usePathname();
  const { data } = usePoll<Status>("/api/status", 30000);
  const nav = [
    { href: "/", label: "Dashboard", active: path === "/" || /^\/campaigns\/[^/]+$/.test(path) && !path.endsWith("/new") },
    { href: "/campaigns", label: "Campagnes", active: path === "/campaigns" || path.endsWith("/edit") || path.endsWith("/new") },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-8">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Radar className="h-4 w-4" />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-bold">ClipNova</span>
            <span className="block text-xs text-slate-500">Campaign Video Finder</span>
          </span>
        </Link>
        <nav className="flex gap-1">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", n.active ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50")}>
              {n.label}
            </Link>
          ))}
        </nav>
        {data && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Badge className={data.youtubeApi ? "bg-emerald-100 text-emerald-700" : "bg-violet-100 text-violet-700"} title={`SEARCH_MODE=${data.searchMode}`}>
              {data.youtubeApi ? <Database className="h-3 w-3" /> : <FlaskConical className="h-3 w-3" />}
              {data.youtubeApi ? "YouTube API" : data.searchMode === "rss" ? "RSS-feeds" : data.demoData ? "Demo-data" : data.searchMode}
            </Badge>
            <Badge className={data.aiProvider === "heuristic" ? "bg-slate-100 text-slate-700" : "bg-brand-100 text-brand-700"} title="AI_PROVIDER">
              <Bot className="h-3 w-3" /> {data.aiProvider === "heuristic" ? "Heuristische analyse" : data.aiModel}
            </Badge>
          </div>
        )}
      </div>
    </header>
  );
}

export function PageHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-sm text-slate-500">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
