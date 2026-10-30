# Roadmap

What's planned, in order. Each step says what "done" means. Prices, regions and model availability
were checked in autumn 2026: **check them again when the step starts.**

## Next: on AWS, so the agent works from anywhere

Goal: use Ai-Agent from the phone and any computer, signed in and safe, without this PC running.

### 0. Decide (one evening)

- **Account**: your own AWS account (new-account credits help). One root user with MFA, then
  one admin user for daily work. A **budget alarm** before anything else.
- **Region**: the Middle East regions (Bahrain, UAE) were disrupted in September 2026 (AWS Health
  Dashboard), and the **Saudi region is due in December 2026**. Until then: a nearby working region
  such as **Singapore**. Move to Saudi Arabia when it opens if data residency matters.
- **Domain**: a name for the app (e.g. `agent.<your domain>`), so HTTPS and sign-in work.

### 1. Models without a GPU (test from this PC first)

AWS GPUs are expensive; **Amazon Bedrock** runs models per request instead. The gateway already
maps model *names* to backends, so the app doesn't change:

- `gateway/config.yaml`: point `qwen3.5-9b` / `qwen3.5-0.8b` at Bedrock models (Qwen3 models are
  on Bedrock; pick by price and tool-calling quality — `npm run ask` and `guard:eval` measure it).
- Embeddings: a Bedrock embedding model with **1024 dimensions** keeps the database as it is; every
  document is indexed again once.
- The safety filter (Qwen3Guard 0.6B) is small enough for a CPU; voice (Qwen3-ASR/TTS) too, or
  Amazon Transcribe/Polly.
- **Done when**: the local stack answers through Bedrock, and `guard:eval`, `tenancy:test` and
  `approvals:test` pass.

### 2. One small server

- One **EC2** instance (ARM, e.g. `t4g.large`) running the same Kubernetes manifests with **k3s**
  (or Docker Compose). The images already build for ARM (`TARGETARCH`).
- Images built by CI and stored in **ECR**; secrets in **SSM Parameter Store** instead of `.env`.
- Data on an EBS volume with **nightly snapshots**; Postgres dumps to S3. A restore is tried once.
- **Done when**: the whole stack runs there and all live tests pass against it.

### 3. HTTPS and sign-in from anywhere

- TLS certificate (Let's Encrypt, or an AWS load balancer with ACM) for the domain; only port 443
  open; no SSH (SSM Session Manager instead).
- Keycloak and the api use the public URL (`AI_AGENT_PUBLIC_URL`, `OIDC_ISSUER`); nginx's host list
  gets the domain; **two-factor sign-in** (Keycloak OTP) for every account.
- **Done when**: you sign in from the phone over mobile data, and `auth:test` passes against it.

### 4. Hardening

- Network policies: only the api may reach the harness; only the api and harness the gateway.
- Monitoring and alarms (CloudWatch): down, disk, cost.
- The audit log copied to a separate store nobody can change.
- An update routine (pinned image versions, security advisories for LiteLLM and OpenCode).

### 5. On the phone

- The web app as an installable app on the iPhone home screen (PWA); native apps later.

**Rough cost** (personal use, before VAT 15%): server ~$50–60/month, storage ~$5, Bedrock pay per
use (light use: ~$5–30), domain ~$1. Re-check with the AWS pricing calculator at step 0.

## Later

### Ops tools (OpenSRE, Aurora, open-code-review)

Researched 2 Oct 2026. **None of them belongs inside the agent**: they're for engineers (finding
why production broke; reviewing code), and the agent is a document and workspace assistant without
shell, web or git. They'd sit **beside** the platform, using the same gateway with their own keys.

| Project | Verdict | When it makes sense |
|---|---|---|
| **OpenSRE** (Apache-2.0, alpha) | later | Ai-Agent runs real workloads with monitoring and alerts, or a client wants AI incident investigation; a large hosted model (128k context) behind the gateway. Never its gateway mode as-is: it runs shell commands without approval. |
| **Aurora** (Apache-2.0 core) | later — more a client product | A client wants a full incident-response product. Its default install includes BUSL/SSPL/BSL services (Vault, Terraform, Redis 7.4, Memgraph) to swap out, open sign-up to close, and Keycloak sign-in to add: 2–5 weeks. Pick it **or** OpenSRE, not both. |
| **open-code-review** (Apache-2.0, Go CLI) | later | Once the AWS gateway has a stronger model: AI review on pull requests (2–4 days). Not a security scanner — keep gitleaks. |

Cheap experiments meanwhile (half a day each): open-code-review on this PC against the gateway
(`max_tokens 14000`, thinking off), and OpenSRE headless (`opensre ask --json`, Kubernetes read-only,
telemetry and prompt log off).

### Teams and more apps

Shared spaces (a team sharing files and documents), a sandboxed harness per team, and desktop and
mobile apps.
