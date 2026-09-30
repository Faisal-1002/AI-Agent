# seyl-ai gateway image: LiteLLM + our model list, baked in.
# Config ships inside the image (like code), so every environment runs exactly what was built.
# Secrets are NOT in here — they arrive as environment variables at runtime.
FROM docker.litellm.ai/berriai/litellm:main-stable
COPY config.yaml /app/config.yaml
CMD ["--config", "/app/config.yaml", "--port", "4000"]
