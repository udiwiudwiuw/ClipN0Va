"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Dialog, Textarea } from "@/components/ui";
import type { Match } from "@/lib/types-ui";

const REJECT_REASONS = ["Off-topic", "Verkeerde taal", "Te lang / te kort", "Slechte audio/beeld", "Geen sterke momenten", "Rechten onduidelijk", "Uitgesloten onderwerp"];
const APPROVE_REASONS = ["Sterke hooks", "Precies de juiste persoon", "Goede energie", "Veel clipbare momenten"];

/** Vraagt (optioneel) waarom: die reden wordt feedback voor de AI-scoring van deze campagne. */
export function ReasonDialog({
  match,
  mode,
  onClose,
  onSubmit,
}: {
  match: Match | null;
  mode: "approved" | "rejected";
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [match]);
  if (!match) return null;
  const chips = mode === "rejected" ? REJECT_REASONS : APPROVE_REASONS;
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "rejected" ? "Afwijzen" : "Goedkeuren"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Annuleren</Button>
          <Button className={mode === "rejected" ? "bg-red-600 hover:bg-red-700" : "bg-emerald-600 hover:bg-emerald-700"} onClick={() => onSubmit(reason)}>
            {mode === "rejected" ? <ThumbsDown className="h-4 w-4" /> : <ThumbsUp className="h-4 w-4" />}
            {mode === "rejected" ? "Afwijzen" : "Goedkeuren"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm font-medium">{match.video.title}</p>
      <p className="mb-2 text-xs text-slate-500">Waarom? (optioneel) — de reden wordt opgeslagen als feedback en weegt mee bij volgende analyses.</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c}
            onClick={() => setReason((r) => (r.includes(c) ? r : r ? `${r}; ${c}` : c))}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:border-brand-500 hover:bg-brand-50"
          >
            {c}
          </button>
        ))}
      </div>
      <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bijv. host praat te weinig, vooral gasten aan het woord" />
    </Dialog>
  );
}
