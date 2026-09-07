#!/usr/bin/env python3
"""TeachCast constant E2E suite (architect's independent harness).

Drives every product feature through agent-browser against the local dev
instance (:3100) plus the HTTP API surface, exactly like a real operator.
Re-runnable after every merge; writes a JSON + text report per run.

Usage: python3 tc_e2e_suite.py [--base http://127.0.0.1:3100]
Report: /home/z/my-project/download/teachcast-e2e/report-<ts>.json
"""
import json
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

BASE = "http://127.0.0.1:3100"
SESSION = "tc-e2e"
AB = ["agent-browser", "--session", SESSION]
REPORT_DIR = Path("/home/z/my-project/download/teachcast-e2e")


def ab(*args, timeout=45):
    """Run an agent-browser command; return (ok, output)."""
    r = subprocess.run(AB + [str(a) for a in args], capture_output=True, text=True, timeout=timeout)
    out = (r.stdout + r.stderr).strip()
    return r.returncode == 0, out


def http(method, path, body=None, timeout=60):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:
        return 0, str(e)


class Suite:
    def __init__(self):
        self.results = []
        self.wf_id = None
        self.wf_name = f"e2e-{uuid.uuid4().hex[:8]}"

    def check(self, name, ok, detail=""):
        self.results.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {str(detail)[:160]}" if not ok else ""))
        return ok

    # ---------------- feature tests ----------------

    def t_home(self):
        ok, out = ab("open", BASE)
        self.check("home.open", ok and "TeachCast" in out, out)
        ab("wait", "--load", "domcontentloaded", timeout=30)
        _, title = ab("get", "title")
        self.check("home.title", "TeachCast" in title, title)
        ok, out = ab("snapshot", "--interactive", "--compact")
        self.check("home.snapshot.nav", "Session" in out and "Library" in out, out[:200])
        ok, out = ab("snapshot", "--text", "--compact")
        self.check("home.snapshot.teach_cta", "Share your screen" in out, out[:200])

    def t_library_crud(self):
        ok, out = ab("click", "@e15")  # Library nav (from home snapshot refs)
        ab("wait", "--text", "Library", "--timeout-ms", "15000")
        code, body = http("GET", "/api/workflows")
        self.check("library.list.api", code == 200, f"HTTP {code}")
        code, body = http("POST", "/api/workflows", {
            "name": self.wf_name,
            "description": "E2E-created workflow",
            "steps": [
                {"kind": "message", "payload": {"text": "Open example.com and click Learn more"}},
                {"kind": "message", "payload": {"text": "Report the resulting page title"}},
            ],
        })
        data = json.loads(body) if 200 <= code < 300 else {}
        self.wf_id = data.get("id")
        self.check("library.create.api", 200 <= code < 300 and self.wf_id, f"HTTP {code} {body[:200]}")
        # re-snapshot BEFORE acting (never reuse a stale ref — the M5 law)
        ok, out = ab("snapshot", "--interactive", "--compact")
        lib_ref = None
        for line in out.splitlines():
            if '"Library"' in line and "ref=" in line:
                lib_ref = line.split("ref=")[1].rstrip("]").strip()
        if lib_ref:
            ab("click", f"@{lib_ref}")
        # condition-based wait (never a blind sleep); ONE bounded re-click on miss
        ab("wait", "--text", self.wf_name, timeout=30)
        expr = "document.querySelector('main')?.innerText?.includes(" + json.dumps(self.wf_name) + ") ? 'LISTED' : 'MISSING'"
        ok, out = ab("eval", expr)
        if not (ok and "LISTED" in out):
            ok2, snap = ab("snapshot", "--interactive", "--compact")
            retry_ref = None
            for line in snap.splitlines():
                if '"Library"' in line and "ref=" in line:
                    retry_ref = line.split("ref=")[1].rstrip("]").strip()
            if retry_ref:
                ab("click", f"@{retry_ref}")
                ab("wait", "--text", self.wf_name, timeout=30)
                ok, out = ab("eval", expr)
        self.check("library.ui_lists_created", ok and "LISTED" in out, out[:200])

    def t_workflow_lifecycle(self):
        if not self.wf_id:
            self.check("workflow.lifecycle", False, "no workflow id (create failed)")
            return
        code, body = http("GET", f"/api/workflows/{self.wf_id}")
        self.check("workflow.get", 200 <= code < 300, f"HTTP {code}")
        steps = json.loads(body).get("steps", []) if 200 <= code < 300 else []
        self.check("workflow.steps_seeded", len(steps) == 2, f"steps={len(steps)}")
        # install must precede autoLaunch (the two-PATCH law)
        code, body = http("PATCH", f"/api/workflows/{self.wf_id}", {"installed": True})
        self.check("workflow.install", 200 <= code < 300, f"HTTP {code} {body[:200]}")
        code, body = http("PATCH", f"/api/workflows/{self.wf_id}", {"autoLaunch": True})
        self.check("workflow.autolaunch", 200 <= code < 300, f"HTTP {code} {body[:200]}")
        code, body = http("DELETE", f"/api/workflows/{self.wf_id}")
        self.check("workflow.delete", code in (200, 201, 204), f"HTTP {code} {body[:200]}")

    def t_console_managed(self):
        ok, out = ab("open", BASE)
        ab("wait", "--load", "domcontentloaded", timeout=30)
        # open the console
        ok, out = ab("snapshot", "--interactive", "--compact")
        ref = None
        for line in out.splitlines():
            if "Toggle console" in line and "ref=" in line:
                ref = line.split("ref=")[1].rstrip("]").strip()
        self.check("console.toggle_ref_found", ref is not None, out[:200])
        if ref:
            ab("click", f"@{ref}")
            time.sleep(2)
        code, body = http("GET", "/api/managed-session")
        state = json.loads(body) if 200 <= code < 300 else {}
        active = bool(state.get("active"))
        self.check("console.managed.state_api", 200 <= code < 300, f"HTTP {code} {body[:200]}")
        if not active:
            code, body = http("POST", "/api/managed-session", {"action": "open"})
            self.check("console.managed.open", 200 <= code < 300, f"HTTP {code} {body[:200]}")
        code, body = http("GET", "/api/managed-session")
        state = json.loads(body) if 200 <= code < 300 else {}
        self.check("console.managed.live_state",
                   state.get("active") and state.get("url"), body[:200])
        code, body = http("POST", "/api/managed-session", {"action": "snapshot"})
        data = json.loads(body) if 200 <= code < 300 else {}
        self.check("console.managed.snapshot",
                   200 <= code < 300 and (data.get("snapshot") or data.get("frame")),
                   f"HTTP {code} keys={list(data)[:5]}")
        code, body = http("POST", "/api/managed-session", {"action": "close"})
        self.check("console.managed.close", 200 <= code < 300, f"HTTP {code} {body[:200]}")

    def t_chat_toolloop(self):
        code, body = http("POST", "/api/chat", {
            "system": "You are a computer-use agent. Complete the task with your tools.",
            "messages": [{"role": "user", "content":
                "Use read_file to read package.json in your workspace root and report the app's name. Then stop."}],
            "enableTools": True,
        }, timeout=120)
        self.check("chat.toolloop.file_read", code == 200 and "done" in body, f"HTTP {code} {body[:200]}")

    def t_computer_use(self):
        """The acceptance task — passes once M5 lands (click-by-ref)."""
        code, body = http("POST", "/api/chat", {
            "system": "You are a computer-use agent. Complete the task with your tools.",
            "messages": [{"role": "user", "content":
                "Open https://example.com, then click the \"Learn more\" link using its ref from your snapshot. "
                "Then verify the navigation (report the new URL). Report exactly what you did and what failed if anything failed."}],
            "enableTools": True,
        }, timeout=180)
        text = body
        # example.com "Learn more" -> iana.org: the honest post-click evidence
        iana = "iana" in text.lower()
        self.check("computeruse.click_by_ref", code == 200 and iana, f"HTTP {code} {text[:300]}")
        self.check("computeruse.verify_navigation", iana, text[:300])

    # ---------------- runner ----------------

    def run(self):
        self.t_home()
        self.t_library_crud()
        self.t_workflow_lifecycle()
        self.t_console_managed()
        # UI tests done: free the tc-e2e browser before API-only tests
        # (peak memory frugality on the shared 4GB host)
        try:
            ab("close", timeout=20)
        except Exception:
            pass
        self.t_chat_toolloop()
        self.t_computer_use()
        # free the app's agent browser too (spawned by the chat tool loop)
        try:
            subprocess.run(["agent-browser", "--session", "teachcast-agent", "close"],
                           capture_output=True, timeout=20)
        except Exception:
            pass
        passed = sum(1 for r in self.results if r["ok"])
        total = len(self.results)
        print(f"\n=== {passed}/{total} passed ===")
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        report = {"base": BASE, "ts": ts, "passed": passed, "total": total, "results": self.results}
        (REPORT_DIR / f"report-{ts}.json").write_text(json.dumps(report, indent=1))
        (REPORT_DIR / "report-latest.json").write_text(json.dumps(report, indent=1))
        return 0 if passed == total else 1


if __name__ == "__main__":
    if "--base" in sys.argv:
        BASE = sys.argv[sys.argv.index("--base") + 1]
    sys.exit(Suite().run())
