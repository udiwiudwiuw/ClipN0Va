"use client";

import { MessageSquarePlus, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, Input, Select } from "@/components/ui";
import { api, fmtRelative } from "@/lib/client";
import type { FeedbackItem } from "@/lib/types-ui";
import { usePoll } from "@/lib/use-poll";
import { cn } from "@/lib/utils";

const KIND: Record<FeedbackItem["kind"], { label: string; cls: string }> = {
  prefer: { label: "Meer van", cls: "bg-emerald-100 text-emerald-800" },
  avoid: { label: "Vermijden", cls: "bg-red-100 text-red-700" },
  note: { label: "Instructie", cls: "bg-blue-100 text-blue-700" },
  approve: { label: "Goedgekeurd", cls: "bg-emerald-50 text-emerald-700" },
  reject: { label: "Afgewezen", cls: "bg-red-50 text-red-700" },
};

/**
 * Feedback-loop: voorkeuren, te vermijden onderwerpen, instructies en de
 * redenen bij goedkeuren/afwijzen gaan mee in elke volgende analyse.
 */
export function FeedbackPanel({ campaignId, onReanalyze, version }: { campaignId: string; onReanalyze: () => void; version: number }) {
  const toast = useToast();
  const { data, reload } = usePoll<{ feedback: FeedbackItem[] }>(`/api/campaigns/${campaignId}/feedback?v=${version}`);
  const [kind, setKind] = useState<"prefer" | "avoid" | "note">("prefer");
  const [text, setText] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await api(`/api/campaigns/${campaignId}/feedback`, { method: "POST", json: { kind, text } });
      setText("");
      reload();
      toast("Feedback opgeslagen — telt mee bij de volgende analyse");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const rules = data?.feedback.filter((f) => ["prefer", "avoid", "note"].includes(f.kind)) ?? [];
  const decisions = data?.feedback.filter((f) => ["approve", "reject"].includes(f.kind)) ?? [];

  return (
    <Card>
      <CardHeader
        title="Feedback & scoringsregels"
        description="Stuurt de AI-beoordeling van deze campagne"
        action={<Button size="sm" variant="outline" onClick={onReanalyze}>Herbeoordelen</Button>}
      />
      <form onSubmit={add} className="flex flex-col gap-2 border-b p-4">
        <div className="flex gap-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="prefer">Meer van</option>
            <option value="avoid">Vermijden</option>
            <option value="note">Instructie</option>
          </Select>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "note" ? "Bijv. liever solo-momenten van de host" : "Kommagescheiden termen"} />
        </div>
        <Button size="sm" type="submit" disabled={!text.trim()}>
          <MessageSquarePlus className="h-3.5 w-3.5" /> Feedback toevoegen
        </Button>
      </form>
      <div className="scrollbar-thin max-h-[480px] overflow-y-auto">
        {rules.map((f) => (
          <FeedbackRow key={f.id} f={f} reload={reload} />
        ))}
        {decisions.length > 0 && <div className="bg-slate-50 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Beoordelingen ({decisions.length})</div>}
        {decisions.slice(0, 30).map((f) => (
          <FeedbackRow key={f.id} f={f} reload={reload} />
        ))}
        {data && !data.feedback.length && <p className="px-4 py-6 text-sm text-slate-400">Nog geen feedback. Keur video&apos;s goed of af, of voeg regels toe.</p>}
      </div>
    </Card>
  );
}

function FeedbackRow({ f, reload }: { f: FeedbackItem; reload: () => void }) {
  const toast = useToast();
  const k = KIND[f.kind];
  const act = async (p: Promise<unknown>) => {
    try {
      await p;
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className={cn("group flex items-start gap-2 border-b border-slate-100 px-4 py-2 text-sm", !f.active && "opacity-50")}>
      <Badge className={cn("mt-0.5 shrink-0", k.cls)}>
        {f.kind === "approve" ? <ThumbsUp className="h-3 w-3" /> : f.kind === "reject" ? <ThumbsDown className="h-3 w-3" /> : null}
        {k.label}
      </Badge>
      <div className="min-w-0 flex-1">
        {f.match && <div className="truncate text-xs font-medium" title={f.match.video.title}>{f.match.video.title}</div>}
        <div className={cn("break-words", f.match && "text-xs text-slate-500")}>{f.text || (f.match ? "geen reden opgegeven" : "")}</div>
        <div className="text-[11px] text-slate-400">{fmtRelative(f.createdAt)}</div>
      </div>
      <input
        type="checkbox"
        title={f.active ? "Actief (telt mee)" : "Uit (telt niet mee)"}
        checked={f.active}
        onChange={(e) => act(api(`/api/feedback/${f.id}`, { method: "PATCH", json: { active: e.target.checked } }))}
        className="mt-1"
      />
      {!f.match && (
        <button className="opacity-0 transition-opacity group-hover:opacity-100" onClick={() => act(api(`/api/feedback/${f.id}`, { method: "DELETE" }))} aria-label="Verwijderen">
          <Trash2 className="h-3.5 w-3.5 text-slate-400 hover:text-red-600" />
        </button>
      )}
    </div>
  );
}
