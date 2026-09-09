# TeachCast browser sandbox (E2B custom template) — M8.
#
# Purpose: bake `agent-browser` + its Chromium + system libraries into a
# sandbox template so E2B-mode browser_control starts in ~1 command round-trip
# instead of a ~2-5 min runtime bootstrap on the stock `base` template.
#
# Build (from this directory, needs E2B_API_KEY in the environment):
#
#   npx @e2b/cli template create teachcast-browser \
#     -d Dockerfile --cpu-count 2 --memory-mb 4096
#
# Then in the TeachCast environment:
#
#   E2B_TEMPLATE=teachcast-browser
#
# The runtime bootstrap in src/lib/e2b-browser.ts is skipped by its marker
# file — this image creates it at build time so the skip is the fast path.

FROM ghcr.io/e2b-dev/base:latest

# Chromium system libraries (headless Chrome on Ubuntu).
# Keep in sync with the apt list in src/lib/e2b-browser.ts (runtime fallback).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libcairo2 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# agent-browser CLI + its Chrome for Testing download.
RUN npm install -g agent-browser && agent-browser install

# The workspace browser_control screenshots resolve against (E2B mode) and
# the bootstrap marker: the runtime sees a ready sandbox.
RUN mkdir -p /root/workspace && touch /root/.teachcast-agent-browser
