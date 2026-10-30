"""Ai-Agent's safety filter inside the gateway — so EVERY app is screened, not just the web app.

Connected devices (the OpenCode CLI, OpenWork desktop) talk to the gateway directly, so the
check that the api does for the web app (server/guard.ts) has to happen here too. Same model
(Qwen3Guard), same official prompt template (server/guard-template.json), same policy:

  block when the verdict is Unsafe, or tagged Jailbreak (the guard often rates jailbreaks only
  "Controversial"), or Controversial when GUARD_STRICT=true. Fail CLOSED: no verdict, no call.

A LiteLLM custom guardrail on its MIT code path (litellm.integrations.custom_guardrail), run
before every call ("pre_call", default_on). Skipped for:
  - the internal keys (harness, api): the api already screened what the web app sends;
  - the guard and other non-chat models;
  - agent steps whose last message isn't the user's (tool results): already screened.
"""

import json
import os
import re
from typing import Any, Optional

from fastapi import HTTPException
from litellm.integrations.custom_guardrail import CustomGuardrail

GUARD_MODEL = "qwen3-guard"
SCREENED_MODELS = {"qwen3.5-9b", "qwen3.5-0.8b"}  # every chat model a device may use
INTERNAL_KEYS = {"harness", "api"}  # key aliases from scripts/gateway-keys.ts
STRICT = os.environ.get("GUARD_STRICT") == "true"

with open(os.path.join(os.path.dirname(__file__), "guard-template.json"), encoding="utf-8") as f:
    TEMPLATE = json.load(f)["prompt"]


def last_user_text(messages: list) -> Optional[str]:
    """The text of the last message if the user wrote it; None for tool/assistant steps."""
    if not messages or messages[-1].get("role") != "user":
        return None
    content = messages[-1].get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # [{type: text, text}, {type: image_url, ...}]
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return None


def parse(output: str) -> dict:
    safety = re.search(r"Safety: (Safe|Unsafe|Controversial)", output)
    if not safety:
        raise ValueError(f"unexpected guard output: {output[:120]!r}")
    found = re.search(r"Categories: (.*)", output)
    categories = [c.strip() for c in (found.group(1) if found else "").split(",") if c.strip() and c.strip() != "None"]
    return {"safety": safety.group(1), "categories": categories}


def blocked(verdict: dict) -> bool:
    return (
        verdict["safety"] == "Unsafe"
        or "Jailbreak" in verdict["categories"]
        or (STRICT and verdict["safety"] == "Controversial")
    )


class AiAgentGuard(CustomGuardrail):
    async def async_pre_call_hook(self, user_api_key_dict: Any, cache: Any, data: dict, call_type: Any) -> Optional[dict]:
        if data.get("model") not in SCREENED_MODELS:
            return data
        if getattr(user_api_key_dict, "key_alias", None) in INTERNAL_KEYS:
            return data
        text = last_user_text(data.get("messages") or [])
        if not text or not text.strip():
            return data

        from litellm.proxy.proxy_server import llm_router  # the proxy's own router (no hooks → no loop)

        try:
            response = await llm_router.acompletion(
                model=GUARD_MODEL,
                messages=[{"role": "user", "content": TEMPLATE["before"] + "USER: " + text + TEMPLATE["after"]}],
                max_tokens=64,
                temperature=0,
                timeout=60,
            )
            verdict = parse(response.choices[0].message.content or "")
        except Exception as err:  # fail closed
            print(f"[ai-agent-guard] check failed: {err}", flush=True)
            raise HTTPException(status_code=503, detail="The Ai-Agent safety filter is unavailable right now, so this message can't be checked. Try again in a minute.")

        if verdict["safety"] != "Safe":
            print(f"[ai-agent-guard] {verdict['safety']}: {', '.join(verdict['categories']) or '-'} (key {getattr(user_api_key_dict, 'key_alias', None)})", flush=True)
        if blocked(verdict):
            why = ", ".join(verdict["categories"]) or verdict["safety"]
            raise HTTPException(status_code=400, detail=f"Ai-Agent can't help with that: the safety filter flagged it ({why}).")
        return data
