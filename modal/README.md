# Self-hosted GLM on Modal — the TeachCast LLM endpoint

`glm_modal.py` deploys an **OpenAI-compatible chat-completions endpoint**
serving the open-weights **GLM-4.7-Flash** (31 GB MoE, MIT license) on
[Modal](https://modal.com), serverless with scale-to-zero.

Why this exists: with this endpoint the app's LLM calls run on **your** Modal
GPUs. No shared Z.ai balance, no shared rate limit, no account coupling —
and the model is the same family TeachCast's chat sessions already use.

## One-time setup (~10 minutes)

```bash
pip install modal
modal token new          # opens a browser; saves the CLI token locally
```

Modal accounts start with free credits; GPUs beyond that need billing
enabled on the workspace (L40S ≈ $0.6–0.8/h **while a container is up** —
idle costs nothing, see Cost shape below).

Pick a long random API key (this is the `Bearer` key your app will send):

```bash
modal secret create glm-api-key GLM_API_KEY="$(openssl rand -hex 24)"
```

Deploy from the repo root:

```bash
modal deploy modal/glm_modal.py
```

The output prints the URL:

```
https://<workspace>--glm.modal.run
```

First boot downloads the 31 GB checkpoint into the `glm-hf-cache` volume
(~2–6 min); later cold starts load from the volume (~1–2 min).

## Point TeachCast at it

Vercel / production env (the self-hosting ladder — env vars beat the
built-in fallback, the Settings UI beats env):

```
PROVIDER_ENDPOINT=https://<workspace>--glm.modal.run/v1
PROVIDER_API_KEY=<the GLM_API_KEY you generated>
PROVIDER_MODEL=glm-4.7-flash
```

…or paste the same three values into **Settings** in the app UI.

Verify (from anywhere):

```bash
curl https://<workspace>--glm.modal.run/v1/chat/completions \
  -H "Authorization: Bearer $PROVIDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-4.7-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

Wrong or missing key → `401` from vLLM. Right key → a real completion.

## Configuration

Everything is deploy-time env (redeploy to change):

| env | default | notes |
|-----|---------|-------|
| `MODAL_MODEL` | `zai-org/GLM-4.7-Flash` | 31 GB, single 48 GB GPU, MIT. Upgrade: `zai-org/GLM-5.3-Flash` (321 GB FP8 — the same generation as chat.z.ai's GLM-5.3) |
| `MODAL_GPU` | `L40S` | `A100-40GB`, `H100`, `H200`; for GLM-5.3-Flash use `H100:8` or `H200:8` |
| `MODAL_MAX_MODEL_LEN` | `32768` | raise toward 200K for long documents (KV-cache cost) |
| `MODAL_SERVED_NAME` | `glm-4.7-flash` | the `model` string clients send |
| `VLLM_EXTRA_ARGS` | — | appended verbatim to `vllm serve` |

Tool calling is native: the serve command enables
`--enable-auto-tool-choice --tool-call-parser glm47 --reasoning-parser glm47`
(parser names verified against the vLLM 0.28.0 registries), so TeachCast's
custom-provider path gets real function calling, not the JSON fallback.

## Cost shape

`min_containers=0` + `scaledown_window=15min` + `max_containers=1`:
the container exists only while requests keep arriving, plus a 15-minute
linger. An hour of continuous agent work on L40S costs roughly $0.6–0.8;
a day idle costs $0. The 15-minute window exists because the first request
after scale-down pays the model load — tune it down (shorter window, colder
but cheaper) or add `min_containers=1` (always-warm, always billed) as your
usage pattern demands.

## Operations

```bash
modal app list                    # see state / URL
modal app logs teachcast-glm      # live logs (also prints the redacted serve line)
modal app stop teachcast-glm      # scale to zero immediately
modal deploy modal/glm_modal.py   # redeploy after env changes
```
