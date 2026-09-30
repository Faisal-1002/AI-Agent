// Extracts Qwen3Guard's moderation prompt from the OFFICIAL model's chat template
// and saves it as server/guard-template.json.   Run: npx tsx scripts/guard-template.ts
//
// Why: the whole safety policy lives in the model's Jinja chat template, which Ollama
// can't run. So the backend renders the prompt itself (server/guard.ts) using the exact
// text the model was trained on. Copying it by script (not by hand) keeps it exact.

import { writeFileSync } from "node:fs";

const SOURCE = "https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B/raw/main/tokenizer_config.json";

const { chat_template: jinja } = (await (await fetch(SOURCE)).json()) as { chat_template: string };

// The template has two branches (last message from the user → prompt check; from the
// assistant → response check), each with an opening text and a closing text.
const openings = [...jinja.matchAll(/\{\{- "([\s\S]*?)" -\}\}/g)].map((m) => m[1]).filter((s) => s.includes("# Task:"));
const closings = [...jinja.matchAll(/\{%- set template = "([\s\S]*?)" -%\}/g)].map((m) => m[1]);
if (openings.length !== 2 || closings.length !== 2) throw new Error("Template layout changed — check it by hand");

// The chat markers (<|im_start|>user … <|im_end|><|im_start|>assistant <think></think>)
// are added by the Ollama model's TEMPLATE (ollama/qwen3guard-0.6b.Modelfile), so strip them here.
const USER_START = "<|im_start|>user\n";
const ASSISTANT_START = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";
const strip = (text: string, marker: string, atStart: boolean) => {
  if (atStart ? !text.startsWith(marker) : !text.endsWith(marker)) throw new Error(`Missing marker: ${JSON.stringify(marker)}`);
  return atStart ? text.slice(marker.length) : text.slice(0, -marker.length);
};

const template = {
  source: SOURCE,
  license: "Apache-2.0 (Qwen3Guard, Alibaba Qwen team)",
  prompt: { before: strip(openings[0], USER_START, true), after: strip(closings[0], ASSISTANT_START, false) },
  response: { before: strip(openings[1], USER_START, true), after: strip(closings[1], ASSISTANT_START, false) },
};
writeFileSync("server/guard-template.json", JSON.stringify(template, null, 2) + "\n");
console.log("Saved server/guard-template.json");
console.log(`prompt check: ${template.prompt.before.length + template.prompt.after.length} chars of policy text`);
console.log(`response check: ${template.response.before.length + template.response.after.length} chars of policy text`);
