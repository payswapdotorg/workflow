"""
TeachCast self-hosted GLM endpoint — Modal + vLLM (M8).

WHAT THIS IS
------------
An OpenAI-compatible chat-completions endpoint serving the open-weights
GLM-4.7-Flash model on Modal, serverless (scale-to-zero). It exists so
TeachCast (and anything else that speaks OpenAI) no longer depends on the
shared Z.ai API for its LLM — no shared balance, no shared rate limit, no
account coupling: your GPUs, your quota, your key.

Point the app at it with three env vars (or the Settings UI):

    PROVIDER_ENDPOINT=https://<workspace>--glm.modal.run/v1
    PROVIDER_API_KEY=<the GLM_API_KEY you chose below>
    PROVIDER_MODEL=glm-4.7-flash

DEPLOY (one-time, needs a Modal account + CLI token)

    pip install modal
    modal token new                       # browser flow; saves the token
    modal secret create glm-api-key GLM_API_KEY=<choose-a-long-random-key>
    modal deploy modal/glm_modal.py       # prints the endpoint URL

The URL is secret-by-obscurity (unguessable workspace-scoped subdomain) and
vLLM enforces the Bearer key on every request — two independent layers.
TeachCast sends `Authorization: Bearer <key>` natively (OpenAI-compatible
provider), so no extra auth plumbing.

CONFIGURATION (env at deploy time — redeploy to change)
    MODAL_MODEL        default zai-org/GLM-4.7-Flash (31 GB, MIT license,
                       ~30B MoE, 200K context — fits ONE 48GB GPU)
                       upgrade: zai-org/GLM-5.3-Flash (321 GB FP8 MoE —
                       the same generation TeachCast's chat.z.ai sessions
                       run; needs 8x H100: MODAL_GPU="H100:8")
    MODAL_GPU          default "L40S" (48 GB, FP8-capable, cheapest that
                       fits). Alternatives: "A100-40GB", "H100", "H200",
                       "H100:8" / "H200:8" for GLM-5.3-Flash.
    MODAL_MAX_MODEL_LEN default 32768 (the agent loop needs headroom for
                       tool snapshots; raise toward 200K if you serve long
                       documents, at KV-cache memory cost)
    VLLM_EXTRA_ARGS    appended verbatim to the serve command (escape hatch
                       for engine flags without code edits)

COST SHAPE: min_containers=0 + scaledown_window=15min — you pay only while
a container is up (~$0.6-0.8/h on L40S while active). The first request
after a cold start pays the model-load (~2-6 min from the volume cache);
later cold starts reuse the HF cache volume and load in ~1-2 min.
"""

import os
import subprocess

import modal

MINUTES = 60

# ---------------------------------------------------------------------------
# Model / hardware profile (all overridable at deploy time via env)
# ---------------------------------------------------------------------------

MODEL_ID = os.environ.get("MODAL_MODEL", "zai-org/GLM-4.7-Flash")
GPU_CONFIG = os.environ.get("MODAL_GPU", "L40S")
MAX_MODEL_LEN = os.environ.get("MODAL_MAX_MODEL_LEN", "32768")
VLLM_EXTRA_ARGS = os.environ.get("VLLM_EXTRA_ARGS", "")
# The name clients put in the `model` field; kept short and version-pinned.
SERVED_NAME = os.environ.get("MODAL_SERVED_NAME", "glm-4.7-flash")

# Parser names verified against vLLM 0.28.0 registries:
#   vllm/tool_parsers/__init__.py     -> "glm47"  (Glm47MoeModelToolParser)
#   vllm/reasoning/__init__.py        -> "glm47"  (Glm47MoeReasoningParser)
# Native tool calling is what TeachCast's custom-provider path uses best.
TOOL_PARSER_ARGS = [
    "--enable-auto-tool-choice",
    "--tool-call-parser", "glm47",
    "--reasoning-parser", "glm47",
]

app = modal.App("teachcast-glm")

# vLLM brings its own CUDA userland via pip (torch + nvidia wheels); the
# slim Debian base is the documented Modal pattern for pip-installed vLLM.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("vllm==0.28.0", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
    .entrypoint([])
)

# HF cache volume: the 31 GB checkpoint is downloaded ONCE, then every cold
# start loads from the volume instead of the internet.
hf_cache = modal.Volume.from_name("glm-hf-cache", create_if_missing=True)


@app.function(
    image=image,
    gpu=GPU_CONFIG,
    volumes={"/root/.cache/huggingface": hf_cache},
    secrets=[modal.Secret.from_name("glm-api-key")],
    scaledown_window=15 * MINUTES,
    timeout=60 * MINUTES,
    max_containers=1,
)
@modal.web_server(8000, startup_timeout=20 * MINUTES, label="glm")
def serve():
    """Run `vllm serve` in-container; Modal exposes port 8000 as the
    https://<workspace>--glm.modal.run web endpoint (OpenAI-compatible,
    including /v1/chat/completions, /v1/models)."""
    api_key = os.environ["GLM_API_KEY"]  # from the Modal secret

    cmd = [
        "vllm", "serve", MODEL_ID,
        "--host", "0.0.0.0",
        "--port", "8000",
        "--served-model-name", SERVED_NAME,
        "--api-key", api_key,
        "--max-model-len", MAX_MODEL_LEN,
        "--gpu-memory-utilization", "0.92",
        *TOOL_PARSER_ARGS,
    ]
    if VLLM_EXTRA_ARGS.strip():
        cmd.extend(VLLM_EXTRA_ARGS.split())

    print("Starting vLLM:", " ".join(c for c in cmd if c != api_key))
    subprocess.Popen(cmd)
