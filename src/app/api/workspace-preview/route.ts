import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORKSPACE_PORT = 3171;

interface PreviewState {
  phase: string | null;
  detail: string;
  progress: number;
  slug: string | null;
}

const STEP_ORDER = ["analyzing", "scaffolding", "building", "verifying", "ready"];
const STEP_LABELS: Record<string, string> = {
  analyzing: "Analyze the request",
  scaffolding: "Scaffold the project",
  building: "Write the application",
  verifying: "Verify the build",
  ready: "Workspace ready",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(request: Request) {
  const chatId = new URL(request.url).searchParams.get("chatId");
  let state: PreviewState = { phase: null, detail: "", progress: 0, slug: null };
  try {
    if (chatId) {
      const chat = await db.chat.findUnique({ where: { id: chatId } });
      if (chat?.buildPhase) {
        state = {
          phase: chat.buildPhase,
          detail: chat.buildDetail ?? "",
          progress: chat.buildProgress ?? 0,
          slug: chat.buildSlug ?? null,
        };
      }
    }
  } catch (error) {
    console.error("GET /api/workspace-preview failed", error);
    state = { phase: "error", detail: "Preview unavailable", progress: 0, slug: null };
  }

  return new Response(renderPreview(state), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderPreview({ phase, detail, progress, slug }: PreviewState): string {
  const name = slug ?? "workspace";
  const ready = phase === "ready";
  const failed = phase === "error";
  const active = phase !== null && !ready && !failed;
  const dotClass = ready
    ? "dot dot-ready"
    : failed
      ? "dot dot-error"
      : active
        ? "dot dot-active"
        : "dot dot-idle";
  const heading =
    phase === null
      ? "No workspace yet"
      : ready
        ? "Dev server ready"
        : failed
          ? "Build failed"
          : (STEP_LABELS[phase] ?? "Building");
  const sub =
    phase === null
      ? "Describe an app in the chat — the build will appear here."
      : failed
        ? detail || "The build agent hit an error. Send another message in the chat to retry."
        : detail;

  const stepsHtml = STEP_ORDER.map((key) => {
    const current = phase === key;
    const done = phase !== null && STEP_ORDER.indexOf(key) < STEP_ORDER.indexOf(phase);
    const cls = ["step", done ? "step-done" : "", current ? "step-current" : ""]
      .filter(Boolean)
      .join(" ");
    return `<li class="${cls}"><span class="step-dot"></span>${STEP_LABELS[key]}</li>`;
  }).join("");

  const fillWidth = Math.max(4, Math.min(100, progress));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Workspace preview</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0f11; color: #e9eaec; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; display: flex; flex-direction: column; min-height: 100vh; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 44px; padding: 0 14px; border-bottom: 1px solid #24262a; font-size: 12px; color: #a7abb1; }
  .bar strong { color: #e9eaec; font-weight: 600; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 28px 20px; text-align: center; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .sub { max-width: 420px; font-size: 12.5px; line-height: 1.6; color: #8b9097; }
  .track { width: min(320px, 78%); height: 4px; border-radius: 999px; background: #24262a; overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; background: #fbbf24; transition: width 0.35s ease; }
  ol.steps { list-style: none; display: flex; flex-direction: column; gap: 7px; margin: 4px 0 0; padding: 0; text-align: left; font-size: 12.5px; color: #858a91; }
  .step { display: flex; align-items: center; gap: 9px; }
  .step-dot { width: 7px; height: 7px; border-radius: 50%; background: #36393e; flex: none; }
  .step-done { color: #a7abb1; }
  .step-done .step-dot { background: #34d399; }
  .step-current { color: #e9eaec; }
  .step-current .step-dot { background: #fbbf24; box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.18); }
  .port { font-size: 11.5px; color: #6f747b; }
  .foot { border-top: 1px solid #24262a; padding: 9px 14px; font-size: 10.5px; color: #5c6167; text-align: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot-ready { background: #34d399; }
  .dot-error { background: #f87171; }
  .dot-active { background: #fbbf24; animation: pulse 1.4s ease-in-out infinite; }
  .dot-idle { background: #4b5057; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
</head>
<body>
  <header class="bar">
    <span style="display:flex;align-items:center;gap:9px;">
      <span class="${dotClass}"></span>
      <strong class="mono">${escapeHtml(name)}</strong>
    </span>
    <span class="mono port">port ${WORKSPACE_PORT}</span>
  </header>
  <main class="main">
    <h1>${heading}</h1>
    ${active ? `<div class="track"><div class="fill" style="width:${fillWidth}%"></div></div>` : ""}
    ${ready ? `<div class="mono port">${escapeHtml(name)} · dev server running on port ${WORKSPACE_PORT}</div>` : ""}
    <p class="sub">${escapeHtml(sub)}</p>
    ${phase !== null ? `<ol class="steps">${stepsHtml}</ol>` : ""}
  </main>
  <footer class="foot">Workspace preview · TeachCast build agent</footer>
</body>
</html>`;
}
