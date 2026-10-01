import path from "node:path";
import { TOOL_OUTPUT_GLOB, WORKSPACES_ROOT } from "./paths.js";

// The agent's safety rules as DECISIONS, checked against what OpenCode actually enforces.
//
// OpenCode merges its defaults, the config and its own extras (it quietly allows its shared
// tool-output folder, for one) into one list of rules; the LAST rule that matches decides. The
// harness reads that list back at startup (client.app.agents) and refuses to run unless every
// decision below comes out right (server/harness.ts). The unit tests check the same decisions
// against our config (tests/unit.test.ts).

export type Rule = { permission: string; pattern: string; action: string };

// OpenCode's wildcard match (packages/opencode/src/util/wildcard.ts, 1.18.33): "*" is any text,
// across folders too; "?" one character; "\" counts as "/".
export function wildcard(text: string, pattern: string): boolean {
  const str = text.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(str);
}

// OpenCode's evaluate(): the last matching rule wins; none = "ask".
export function evaluate(rules: Rule[], permission: string, pattern: string): string {
  return rules.findLast((r) => wildcard(permission, r.permission) && wildcard(pattern, r.pattern))?.action ?? "ask";
}

// A config `permission` block → OpenCode's rule list (its fromConfig, minus "~" expansion).
export function rulesFrom(permission: Record<string, string | Record<string, string>>): Rule[] {
  return Object.entries(permission).flatMap(([key, value]) =>
    typeof value === "string"
      ? [{ permission: key, pattern: "*", action: value }]
      : Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern, action })),
  );
}

// Edits are asked for with paths relative to the file system root ("data/workspaces/<id>/x.md").
const inSpace = (...parts: string[]) => {
  const file = path.join(WORKSPACES_ROOT, "00000000-0000-4000-8000-000000000000", ...parts);
  return path.relative(path.parse(file).root, file);
};

export const REQUIRED: { permission: string; pattern: string; action: string; why: string }[] = [
  { permission: "edit", pattern: inSpace("notes.md"), action: "ask", why: "file changes need the user's approval" },
  { permission: "edit", pattern: inSpace(".git", "config"), action: "deny", why: "never write inside .git" },
  { permission: "edit", pattern: inSpace("sub", ".git"), action: "deny", why: "never create a .git file" },
  { permission: "bash", pattern: "ls", action: "deny", why: "no shell commands" },
  { permission: "webfetch", pattern: "https://example.com", action: "deny", why: "no web access" },
  { permission: "task", pattern: "*", action: "deny", why: "no sub-agents (their tool calls carry another session id)" },
  { permission: "external_directory", pattern: "/etc/*", action: "deny", why: "nothing outside the conversation's folder" },
  { permission: "external_directory", pattern: TOOL_OUTPUT_GLOB, action: "deny", why: "not OpenCode's shared tool-output folder" },
  { permission: "docs_search_documents", pattern: "*", action: "allow", why: "the document tools are available" },
];

// Which required decisions the rules get wrong (empty = all good).
export function violations(rules: Rule[]): string[] {
  const wrong = REQUIRED.filter((r) => evaluate(rules, r.permission, r.pattern) !== r.action).map(
    (r) => `${r.permission} "${r.pattern}" is ${evaluate(rules, r.permission, r.pattern)}, must be ${r.action} (${r.why})`,
  );
  // OpenCode adds "allow" rules of its own for folders outside (its tool-output folder, temp and
  // skill folders). Whatever their paths — even if ours were computed differently — each must lose.
  for (const rule of rules) {
    if (rule.permission === "external_directory" && rule.action === "allow" && evaluate(rules, "external_directory", rule.pattern) !== "deny") {
      wrong.push(`external_directory "${rule.pattern}" is allowed (nothing outside the conversation's folder)`);
    }
  }
  return wrong;
}
