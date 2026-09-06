"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, PlugZap, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useAppStore } from "@/lib/store";
import { toast } from "sonner";

export function SettingsView() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);

  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (res.ok) setSettings(await res.json());
  }, [setSettings]);

  const view = useAppStore((s) => s.view);

  /* reload whenever Settings becomes the active view (views stay mounted) */
  useEffect(() => {
    if (view === "settings") load();
  }, [view, load]);

  useEffect(() => {
    if (settings) {
      setEndpoint(settings.endpoint);
      setModel(settings.model);
    }
  }, [settings]);

  const save = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const body: Record<string, string> = { endpoint, model };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSettings(data);
      setApiKey("");
      toast.success("Provider settings saved", {
        description: data.usingFallback
          ? "No key stored — the built-in provider will be used."
          : `Calls will go to ${data.endpoint} (${data.model || "default model"}).`,
      });
    } catch (err) {
      toast.error("Saving failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSettings(data);
      toast.info("Stored API key removed");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: "Reply with the single word: OK",
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      const lines = text.split("\n").filter((l) => l.startsWith("data:"));
      let out = "";
      for (const line of lines) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break;
        try {
          const j = JSON.parse(payload);
          out += j?.choices?.[0]?.delta?.content ?? "";
        } catch {
          /* skip */
        }
      }
      setTestResult({ ok: true, text: out.trim() || "(empty reply)" });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const usingFallback = settings?.usingFallback ?? true;

  return (
    <div className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-4 py-6 sm:px-6 teachcast-scroll">
      <h1 className="text-xl font-bold text-zinc-100">LLM Provider Settings</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Connect any OpenAI-compatible chat-completions API. The endpoint and key are stored server-side and never
        exposed to the browser.
      </p>

      {/* active provider status */}
      <Card className="mt-5 border-zinc-800/80 bg-zinc-900/60 p-0">
        <CardContent className="flex items-start gap-3 p-4">
          {usingFallback ? (
            <>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950">
                <PlugZap className="h-4.5 w-4.5 text-zinc-300" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-100">Built-in provider active</p>
                  <Badge variant="outline" className="h-4.5 border-zinc-700 text-[10px] text-zinc-400">
                    text-only
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                  No custom provider is configured, so TeachCast uses the built-in sandbox LLM (real model, no mocks).
                  Screenshots are analyzed as text descriptions only. Configure an OpenAI-compatible endpoint below to
                  enable true vision on live frames.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10">
                <CheckCircle2 className="h-4.5 w-4.5 text-emerald-400" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-100">Custom provider connected</p>
                <p className="mt-0.5 break-all text-xs text-zinc-400">
                  {settings?.endpoint} · model <span className="font-medium text-zinc-300">{settings?.model || "provider default"}</span>
                </p>
                {settings?.keyMasked && <p className="mt-0.5 text-xs text-zinc-500">Key {settings.keyMasked}</p>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* form */}
      <div className="mt-5 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="endpoint" className="text-xs text-zinc-400">
            Provider endpoint (OpenAI-compatible base URL)
          </Label>
          <Input
            id="endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          <p className="text-[11px] text-zinc-600">
            The route appends <code className="text-zinc-500">/chat/completions</code> automatically. Works with
            OpenAI, Azure gateways, OpenRouter, Ollama (http://localhost:11434/v1), vLLM, LM Studio, etc.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="model" className="text-xs text-zinc-400">
            Model
          </Label>
          <Input
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            className="border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          <p className="text-[11px] text-zinc-600">
            For screen understanding pick a vision-capable model (e.g. gpt-4o-mini, gpt-4o, claude-sonnet via gateway).
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="apikey" className="flex items-center gap-1.5 text-xs text-zinc-400">
            <KeyRound className="h-3 w-3" />
            API key {settings?.hasKey && <span className="text-zinc-600">(stored — leave blank to keep {settings.keyMasked})</span>}
          </Label>
          <Input
            id="apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings?.hasKey ? "••••••••••••••••" : "sk-…"}
            autoComplete="off"
            className="border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={saving} className="gap-1.5 bg-amber-500 text-black hover:bg-amber-400">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Save settings
          </Button>
          <Button
            onClick={test}
            disabled={testing}
            variant="outline"
            className="gap-1.5 border-zinc-700 text-zinc-200 hover:bg-zinc-800"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            Test connection
          </Button>
          {settings?.hasKey && (
            <Button
              onClick={clearKey}
              disabled={saving}
              variant="ghost"
              className="gap-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              Remove stored key
            </Button>
          )}
        </div>

        {testResult && (
          <div
            className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
              testResult.ok
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span className="break-all">
              {testResult.ok ? "Provider replied: " : "Test failed: "}
              {testResult.text}
            </span>
          </div>
        )}

        <p className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-500">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" />
          The API key is saved in the server-side SQLite database and used only by the server route that proxies chat
          and replay narration to your provider. It is never sent to the browser — the UI only ever sees a masked
          preview.
        </p>
      </div>
    </div>
  );
}
