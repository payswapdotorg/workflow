# TeachCast Architect E2E Suite

An independent, re-runnable end-to-end harness that drives **every product
feature** through the real UI and API of a running TeachCast instance —
built and maintained by the architect (CTRL-014) to verify each milestone
delivery with fresh hands before merge.

## What it covers (21 checks)

| Area | Checks |
|---|---|
| Home / shell | open, title, nav refs, teach CTA |
| Library (UI + API) | list, create, the created workflow actually renders in the Library view (DOM-eval assertion), condition-based wait + one bounded re-click |
| Workflow lifecycle | GET, seeded steps, install→autoLaunch two-PATCH law, DELETE |
| Managed session (M4) | live state, connect, real url+title, snapshot (text + frame), close |
| Chat tool loop | real LLM (built-in GLM) tool call: `read_file` on workspace |
| Computer use (M5) | the acceptance task: navigate → snapshot → **click-by-ref** → verify → report the real destination (iana.org) |

## Usage

```bash
# from a running dev instance (default http://127.0.0.1:3100)
python3 scripts/e2e-suite.py [--base http://127.0.0.1:3000]
```

Requires `agent-browser` on PATH (the same CLI the product's
`browser_control` tool wraps). Reports land in
`download/teachcast-e2e/report-<ts>.json` (relative to the harness
checkout) with `report-latest.json` kept current.

## Design laws (same as the product's own M5 contract)

- **Fresh refs before acting** — never reuse a snapshot ref after a state
  change; re-snapshot, then click.
- **Condition-based waits** — `wait --text` / DOM-eval assertions, never
  blind sleeps (except short settle windows).
- **One bounded recovery** — a failed UI check re-snapshots and retries
  exactly once, mirroring the product's stale-ref law.
- **Honest assertions** — the computer-use check requires the real
  destination (`iana.org`) in the final report, not just a mention of the
  attempt.
- **Memory frugality** — the suite closes its browser session before the
  API-only tests and closes the app's agent browser at the end (the
  host runs shared).

## Baseline

- Pre-M5 (main @ a5ad601): 18/21 — the two computer-use checks fail (the
  known `find css` breakage) — reproducing the operator's report.
- M5 branch @ 43320ef (clean slate): 20/21 → with the two M5 review fixes
  (spawn-EAGAIN recovery + arg type validation) the target is 21/21.
