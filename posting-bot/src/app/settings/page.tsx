"use client";

import { CheckCircle2, FlaskConical, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/sidebar";
import { PlatformIcon } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/client";
import { usePoll } from "@/lib/use-poll";

type Data = { values: Record<string, string>; secrets: string[]; platforms: Record<string, boolean>; ai: boolean };

function Configured({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge className="bg-emerald-100 text-emerald-700"><CheckCircle2 className="h-3 w-3" /> echte API</Badge>
  ) : (
    <Badge className="bg-violet-100 text-violet-700"><FlaskConical className="h-3 w-3" /> mock mode</Badge>
  );
}

export default function SettingsPage() {
  const { data, reload } = usePoll<Data>("/api/settings");
  const toast = useToast();
  const [v, setV] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setV(data.values);
  }, [data]);

  const bind = (key: string) => ({
    value: v[key] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [key]: e.target.value }),
    type: data?.secrets.includes(key) ? "password" : undefined,
    autoComplete: "off",
  });

  async function save() {
    try {
      await api("/api/settings", { method: "PUT", json: v });
      toast("Instellingen opgeslagen");
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const redirect = (p: string) => `${(v.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "")}/api/oauth/${p}/callback`;

  return (
    <>
      <PageHeader
        title="Instellingen"
        description="Waarden hier gaan vóór .env. Geheime sleutels worden gemaskeerd getoond; laat ze ongewijzigd om ze te behouden."
        actions={<Button onClick={save}><Save className="h-4 w-4" /> Opslaan</Button>}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Algemeen & planning" />
          <div className="grid gap-4 p-5">
            <Field label="Publiek adres (PUBLIC_BASE_URL)" hint="Voor OAuth-redirects. Instagram vereist een publiek https-adres.">
              <Input {...bind("PUBLIC_BASE_URL")} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Standaard tijdzone (nieuwe accounts)">
                <Input {...bind("DEFAULT_TIMEZONE")} placeholder="Europe/Amsterdam" />
              </Field>
              <Field label="Standaard max. per dag">
                <Input {...bind("DEFAULT_DAILY_LIMIT")} />
              </Field>
            </div>
            <Field label="Standaard posttijden" hint="Kommagescheiden, bijv. 09:00,13:00,19:00">
              <Input {...bind("DEFAULT_POSTING_TIMES")} />
            </Field>
            <Field label="Nieuwe posts automatisch goedkeuren">
              <Select className="w-full" {...bind("AUTO_APPROVE")}>
                <option value="0">Nee — eerst nakijken (concept)</option>
                <option value="1">Ja — direct in de wachtrij</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Importmap (IMPORT_DIR)">
                <Input {...bind("IMPORT_DIR")} />
              </Field>
              <Field label="ClipNova storage-map">
                <Input {...bind("CLIPNOVA_STORAGE_DIR")} placeholder="…/clipparty/backend/storage" />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="AI-bijschriften (OpenAI)" action={data && (data.ai ? <Badge className="bg-emerald-100 text-emerald-700">actief</Badge> : <Badge className="bg-slate-100">sjablonen</Badge>)} />
          <div className="grid gap-4 p-5">
            <Field label="OPENAI_API_KEY" hint="Zonder sleutel gebruikt de bot ingebouwde sjablonen (ook gevarieerd per account).">
              <Input {...bind("OPENAI_API_KEY")} placeholder="sk-…" />
            </Field>
            <Field label="Model">
              <Input {...bind("OPENAI_MODEL")} />
            </Field>
          </div>
          <CardHeader title="Mock mode" />
          <div className="grid gap-4 p-5">
            <Field label="Mock mode forceren" hint="Aan = altijd simuleren, ook als er API-sleutels zijn.">
              <Select className="w-full" {...bind("MOCK_MODE")}>
                <option value="">Automatisch (mock als sleutels ontbreken)</option>
                <option value="1">Altijd mock</option>
              </Select>
            </Field>
            <Field label="Kans op gesimuleerde tijdelijke fout (0–1)" hint="Om retries met backoff te testen. 0 = altijd succes.">
              <Input {...bind("MOCK_FAILURE_RATE")} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><PlatformIcon platform="tiktok" /> TikTok</span>} action={data && <Configured ok={data.platforms.tiktok} />} />
          <div className="grid gap-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client key"><Input {...bind("TIKTOK_CLIENT_KEY")} /></Field>
              <Field label="Client secret"><Input {...bind("TIKTOK_CLIENT_SECRET")} /></Field>
            </div>
            <Field label="Privacy van posts" hint="Niet-geauditeerde apps mogen alleen SELF_ONLY posten.">
              <Select className="w-full" {...bind("TIKTOK_PRIVACY_LEVEL")}>
                <option>SELF_ONLY</option>
                <option>MUTUAL_FOLLOW_FRIENDS</option>
                <option>FOLLOWER_OF_CREATOR</option>
                <option>PUBLIC_TO_EVERYONE</option>
              </Select>
            </Field>
            <p className="text-xs text-slate-500">Redirect URI: <code className="rounded bg-slate-100 px-1">{redirect("tiktok")}</code></p>
          </div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><PlatformIcon platform="youtube" /> YouTube Shorts</span>} action={data && <Configured ok={data.platforms.youtube} />} />
          <div className="grid gap-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Google client ID"><Input {...bind("GOOGLE_CLIENT_ID")} /></Field>
              <Field label="Google client secret"><Input {...bind("GOOGLE_CLIENT_SECRET")} /></Field>
            </div>
            <Field label="Zichtbaarheid">
              <Select className="w-full" {...bind("YOUTUBE_PRIVACY_STATUS")}>
                <option value="private">Privé</option>
                <option value="unlisted">Verborgen</option>
                <option value="public">Openbaar</option>
              </Select>
            </Field>
            <p className="text-xs text-slate-500">Redirect URI: <code className="rounded bg-slate-100 px-1">{redirect("youtube")}</code></p>
          </div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><PlatformIcon platform="instagram" /> Instagram Reels</span>} action={data && <Configured ok={data.platforms.instagram} />} />
          <div className="grid gap-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Instagram app ID"><Input {...bind("INSTAGRAM_APP_ID")} /></Field>
              <Field label="Instagram app secret"><Input {...bind("INSTAGRAM_APP_SECRET")} /></Field>
            </div>
            <p className="text-xs text-slate-500">
              Alleen professionele accounts. Redirect URI: <code className="rounded bg-slate-100 px-1">{redirect("instagram")}</code>
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
