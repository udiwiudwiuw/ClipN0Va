"use client";

import { Ban, Check, ExternalLink, RotateCcw, Send, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { MockBadge, PlatformIcon, PostStatus } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Dialog, Field, Input, Spinner, Textarea } from "@/components/ui";
import { api, fmtDateTime, toLocalInput } from "@/lib/client";
import { CAPTION_LIMITS, PLATFORM_LABELS, type Platform } from "@/lib/constants";

export type PostRow = {
  id: string;
  platform: Platform;
  title: string;
  caption: string;
  hashtags: string;
  scheduledAt: string;
  status: string;
  approved: boolean;
  captionSource: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  externalId: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  clip: { id: string; filename: string; title: string; campaign: string | null; creator: string | null };
  account: { id: string; handle: string; displayName: string; platform: Platform; timezone: string; isMock: boolean; status: string };
};

/** Bekijken, bewerken, goedkeuren en (opnieuw) publiceren van één post. */
export function PostDialog({ post, onClose, onChanged }: { post: PostRow | null; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: "", caption: "", hashtags: "", scheduledAt: "" });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (post) setForm({ title: post.title, caption: post.caption, hashtags: post.hashtags, scheduledAt: toLocalInput(new Date(post.scheduledAt)) });
  }, [post]);
  if (!post) return null;

  const editable = !["success", "processing"].includes(post.status);
  const limit = CAPTION_LIMITS[post.platform];
  const textLen = form.caption.length + (form.hashtags ? form.hashtags.length + 2 : 0);

  async function run(name: string, fn: () => Promise<any>, ok: string, close = true) {
    setBusy(name);
    try {
      const r = await fn();
      toast(ok + (r?.outcome && r.outcome !== "success" ? ` — resultaat: ${r.outcome}` : ""), r?.outcome && !["success"].includes(r.outcome) ? "error" : "ok");
      onChanged();
      if (close) onClose();
      return r;
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  const save = (action?: string) =>
    api(`/api/posts/${post.id}`, {
      method: "PATCH",
      json: { title: form.title, caption: form.caption, hashtags: form.hashtags, scheduledAt: new Date(form.scheduledAt).toISOString(), action },
    });

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <PlatformIcon platform={post.platform} /> @{post.account.handle} {post.account.isMock && <MockBadge />} <PostStatus status={post.status} />
        </span>
      }
      footer={
        editable ? (
          <>
            <Button variant="ghost" className="mr-auto text-red-600" onClick={() => confirm("Post verwijderen?") && run("del", () => api(`/api/posts/${post.id}`, { method: "DELETE" }), "Verwijderd")}>
              <Trash2 className="h-4 w-4" />
            </Button>
            {post.status !== "cancelled" && (
              <Button variant="outline" onClick={() => run("cancel", () => save("cancel"), "Geannuleerd")}>
                <Ban className="h-4 w-4" /> Annuleren
              </Button>
            )}
            {["failed", "needs_reauth", "cancelled"].includes(post.status) && (
              <Button variant="outline" onClick={() => run("retry", async () => { await save(); return api(`/api/posts/${post.id}/retry`, { method: "POST" }); }, "Opnieuw in de wachtrij")}>
                <RotateCcw className="h-4 w-4" /> Opnieuw proberen
              </Button>
            )}
            <Button variant="outline" disabled={!!busy} onClick={() => run("now", async () => { await save(); return api(`/api/posts/${post.id}/publish-now`, { method: "POST" }); }, "Publicatie uitgevoerd")}>
              {busy === "now" ? <Spinner /> : <Send className="h-4 w-4" />} Nu publiceren
            </Button>
            {post.status === "draft" ? (
              <Button onClick={() => run("approve", () => save("approve"), "Goedgekeurd en ingepland")}>
                <Check className="h-4 w-4" /> Opslaan & goedkeuren
              </Button>
            ) : (
              <Button onClick={() => run("save", () => save(), "Opgeslagen")}>Opslaan</Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="grid gap-5 md:grid-cols-[180px_1fr]">
        <div className="aspect-[9/16] overflow-hidden rounded-lg">
          <video src={`/api/media/${post.clip.id}`} controls className="h-full w-full bg-black object-contain" />
        </div>
        <div className="grid content-start gap-3">
          <div className="text-xs text-slate-500">
            {post.clip.title || post.clip.filename}
            {post.clip.campaign && ` · ${post.clip.campaign}`} · {PLATFORM_LABELS[post.platform]} · bijschrift: {post.captionSource}
          </div>
          {post.lastError && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{post.lastError}</p>}
          {post.status === "success" && (
            <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Gepubliceerd {post.publishedAt && fmtDateTime(post.publishedAt)} · ID {post.externalId}
              {post.externalUrl && (
                <a href={post.externalUrl} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 underline">
                  Bekijk <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
          {post.platform === "youtube" && (
            <Field label="Titel">
              <Input disabled={!editable} maxLength={100} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
          )}
          <Field label="Bijschrift" hint={<span className={textLen > limit.caption ? "text-red-600" : ""}>{textLen}/{limit.caption} tekens (incl. hashtags)</span>}>
            <Textarea disabled={!editable} rows={5} value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} />
          </Field>
          <Field label="Hashtags" hint={`Aanbevolen max. ${limit.maxHashtags} voor ${PLATFORM_LABELS[post.platform]}`}>
            <Input disabled={!editable} value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Gepland (jouw lokale tijd)" hint={`Accounttijd: ${fmtDateTime(new Date(form.scheduledAt || post.scheduledAt), post.account.timezone)} (${post.account.timezone})`}>
              <Input disabled={!editable} type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
            </Field>
            {editable && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={async () => {
                  const r = await run("regen", () => api(`/api/posts/${post.id}/regenerate`, { method: "POST" }), "Nieuwe variant gegenereerd", false);
                  if (r?.post) setForm((f) => ({ ...f, title: r.post.title, caption: r.post.caption, hashtags: r.post.hashtags }));
                }}
              >
                {busy === "regen" ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3.5 w-3.5" />} Nieuwe variant
              </Button>
            )}
          </div>
          <div className="flex gap-2 text-xs text-slate-500">
            <Badge className="bg-slate-100">pogingen {post.attempts}/{post.maxAttempts}</Badge>
            {post.nextAttemptAt && post.status === "queued" && <Badge className="bg-blue-50 text-blue-700">volgende poging {fmtDateTime(post.nextAttemptAt)}</Badge>}
            {!post.approved && post.status === "draft" && <Badge className="bg-amber-50 text-amber-800">wacht op goedkeuring</Badge>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
