"use client";

import { Instagram, Music2, Youtube } from "lucide-react";
import { Badge } from "@/components/ui";
import { PLATFORM_LABELS, type Platform } from "@/lib/constants";
import { cn } from "@/lib/utils";

const POST_STYLE: Record<string, { label: string; cls: string }> = {
  draft: { label: "Concept", cls: "bg-slate-100 text-slate-700" },
  queued: { label: "In wachtrij", cls: "bg-blue-100 text-blue-700" },
  processing: { label: "Bezig", cls: "bg-amber-100 text-amber-800 animate-pulse" },
  success: { label: "Gepubliceerd", cls: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Mislukt", cls: "bg-red-100 text-red-700" },
  needs_reauth: { label: "Herautorisatie", cls: "bg-orange-100 text-orange-800" },
  cancelled: { label: "Geannuleerd", cls: "bg-slate-100 text-slate-400 line-through" },
};

const ACCOUNT_STYLE: Record<string, { label: string; cls: string }> = {
  active: { label: "Actief", cls: "bg-emerald-100 text-emerald-700" },
  needs_reauth: { label: "Opnieuw autoriseren", cls: "bg-orange-100 text-orange-800" },
  error: { label: "Fout", cls: "bg-red-100 text-red-700" },
  paused: { label: "Gepauzeerd", cls: "bg-slate-100 text-slate-600" },
};

const CLIP_STYLE: Record<string, { label: string; cls: string }> = {
  draft: { label: "Nieuw", cls: "bg-slate-100 text-slate-700" },
  ready: { label: "Klaar", cls: "bg-brand-100 text-brand-700" },
  archived: { label: "Gearchiveerd", cls: "bg-slate-100 text-slate-400" },
};

export function PostStatus({ status }: { status: string }) {
  const s = POST_STYLE[status] ?? { label: status, cls: "bg-slate-100" };
  return <Badge className={s.cls}>{s.label}</Badge>;
}

export function AccountStatus({ status }: { status: string }) {
  const s = ACCOUNT_STYLE[status] ?? { label: status, cls: "bg-slate-100" };
  return <Badge className={s.cls}>{s.label}</Badge>;
}

export function ClipStatus({ status }: { status: string }) {
  const s = CLIP_STYLE[status] ?? { label: status, cls: "bg-slate-100" };
  return <Badge className={s.cls}>{s.label}</Badge>;
}

export const PLATFORM_COLOR: Record<Platform, string> = {
  tiktok: "bg-slate-900 text-white",
  youtube: "bg-red-600 text-white",
  instagram: "bg-gradient-to-br from-fuchsia-500 via-pink-500 to-amber-400 text-white",
};

export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const Icon = platform === "youtube" ? Youtube : platform === "instagram" ? Instagram : Music2;
  return (
    <span
      title={PLATFORM_LABELS[platform as Platform] ?? platform}
      className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md", PLATFORM_COLOR[platform as Platform], className)}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export function MockBadge() {
  return <Badge className="bg-violet-100 text-violet-700">mock</Badge>;
}
