import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

function serialize(s: { endpoint: string; apiKey: string; model: string }) {
  const hasKey = !!s.apiKey;
  return {
    endpoint: s.endpoint,
    model: s.model,
    hasKey,
    keyMasked: hasKey
      ? `${s.apiKey.slice(0, Math.min(4, s.apiKey.length))}••••${s.apiKey.length > 8 ? s.apiKey.slice(-4) : ""}`
      : null,
    usingFallback: !(s.endpoint && s.apiKey),
  };
}

export async function GET() {
  const s = await db.settings.findUnique({ where: { id: "singleton" } });
  return NextResponse.json(
    serialize({
      endpoint: s?.endpoint ?? "",
      apiKey: s?.apiKey ?? "",
      model: s?.model ?? "",
    })
  );
}

export async function PUT(req: NextRequest) {
  let body: { endpoint?: unknown; model?: unknown; apiKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: { endpoint?: string; model?: string; apiKey?: string } = {};

  if (body.endpoint !== undefined) {
    const endpoint = String(body.endpoint).trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) {
      return NextResponse.json(
        { error: "Endpoint must be an http(s) URL, e.g. https://api.openai.com/v1" },
        { status: 400 }
      );
    }
    data.endpoint = endpoint;
  }

  if (body.model !== undefined) {
    data.model = String(body.model).trim();
  }

  // apiKey: omitted => keep existing; string => set (empty string clears)
  if (typeof body.apiKey === "string") {
    data.apiKey = body.apiKey.trim();
  }

  const s = await db.settings.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...data },
  });

  return NextResponse.json(serialize({ endpoint: s.endpoint, apiKey: s.apiKey, model: s.model }));
}
