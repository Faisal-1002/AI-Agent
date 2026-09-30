# Keycloak with seyl-ai's login theme baked in (keycloak/themes/seyl — the app's look).
# The realm uses it via `loginTheme: "seyl"` (scripts/auth-setup.ts).
FROM quay.io/keycloak/keycloak:26.7.5
COPY keycloak/themes/seyl /opt/keycloak/themes/seyl
