# Keycloak with Ai-Agent's login theme baked in (keycloak/themes/ai-agent — the app's look).
# The realm uses it via `loginTheme: "ai-agent"` (scripts/auth-setup.ts).
FROM quay.io/keycloak/keycloak:26.7.5
COPY keycloak/themes/ai-agent /opt/keycloak/themes/ai-agent
