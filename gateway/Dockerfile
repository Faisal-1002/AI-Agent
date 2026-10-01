# seyl-ai gateway image: LiteLLM + our model list, baked in — MIT code only.
# Config ships inside the image (like code), so every environment runs exactly what was built.
# Secrets are NOT in here — they arrive as environment variables at runtime.
#
# Pinned by digest (LiteLLM 1.103.1, built 2026-09-29), not "main-stable", so a rebuild never
# silently picks up a new version. To upgrade: pick a release, update the digest, run the checks.
FROM docker.litellm.ai/berriai/litellm:main-stable@sha256:df15400b5b80925c45d3fd53f8f7a6c0eaa8a25a86833e1b358002e129018943

# The official image also ships LiteLLM's PROPRIETARY enterprise code — the litellm-enterprise
# package and the /app/enterprise folder (BerriAI Enterprise License) — and the proxy loads it
# automatically whenever it can be imported. Seyl runs only the MIT parts: delete both, then
# fail the build if either could still be imported.
RUN rm -rf /app/enterprise \
           /app/.venv/lib/python3.13/site-packages/litellm_enterprise \
           /app/.venv/lib/python3.13/site-packages/litellm_enterprise-*.dist-info \
 && cd /app \
 && ! python -c "import litellm_enterprise" 2>/dev/null \
 && ! python -c "import enterprise" 2>/dev/null \
 && python -c "import litellm.proxy.proxy_server as p; assert p.enterprise_proxy_config is None, 'enterprise code still loaded'"

COPY config.yaml /app/config.yaml
CMD ["--config", "/app/config.yaml", "--port", "4000"]
