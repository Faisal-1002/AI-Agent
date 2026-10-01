import "./env.js";
import os from "node:os";
import path from "node:path";

// Where the agent's files live. Every user has a "space" (server/spaces.ts) and each space its
// own folder; a conversation's agent works only in its space's folder. What OpenCode 1.18.33
// needs for that to hold (README, "Workspaces"):
//  - no folder inside a git repository: OpenCode would treat the whole repository as the project
//    and let the agent read all of it (with npm run dev, that was the seyl-ai repo, .env included);
//  - folders side by side, never one inside another: OpenCode lets the agent read anything inside
//    its own folder, other people's folders included;
//  - opaque ids as folder names (OpenCode URL-decodes the folder name twice).
const env = process.env;

// Containers: /data/workspaces (the harness's persistent volume). npm run dev: in your home folder.
export const WORKSPACES_ROOT = path.resolve(env.SEYL_WORKSPACES_ROOT ?? path.join(os.homedir(), ".seyl-ai", "workspaces"));

// Before spaces there was ONE folder for everyone. Old conversations still point there: they stay
// readable, but the api no longer lets the agent work in them.
export const LEGACY_WORKSPACE = path.resolve(env.SEYL_WORKSPACE ?? "workspace");

// The starter files a new space gets (the image's /workspace-seed; the repo's workspace/ in dev).
export const WORKSPACE_SEED = path.resolve(env.SEYL_WORKSPACE_SEED ?? "workspace");

// An empty folder for the harness calls that aren't about anyone's conversation (health check,
// startup policy check). A call that forgot its folder lands here: no one's files, not /app.
export const CONTROL_DIR = path.join(WORKSPACES_ROOT, "_control");

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function spaceDir(spaceId: string): string {
  if (!UUID.test(spaceId)) throw new Error(`invalid space id: ${JSON.stringify(spaceId)}`);
  return path.join(WORKSPACES_ROOT, spaceId.toLowerCase());
}

// OpenCode saves long tool output (a big file, a long document page) to ONE folder shared by every
// user, and quietly lets every agent read it — unless exactly this pattern is denied, as
// server/opencode.ts does. Same formula as OpenCode's (xdg-basedir + "opencode/tool-output/*").
export const TOOL_OUTPUT_GLOB = path.join(
  env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), // || like xdg-basedir: "" means unset
  "opencode",
  "tool-output",
  "*",
);

// A path as people should see it: relative to the conversation's folder. OpenCode reports paths
// absolute (/data/workspaces/<id>/notes.md) or relative to the file system root
// (data/workspaces/<id>/notes.md); anything outside the folder is shown unchanged.
export function displayPath(file: string, directory: string): string {
  const strip = (p: string) => p.replaceAll("\\", "/").replace(/^([A-Za-z]:)?\/+/, "");
  const dir = strip(directory).replace(/\/+$/, "");
  const rel = strip(file);
  if (rel === dir) return ".";
  return rel.startsWith(`${dir}/`) ? rel.slice(dir.length + 1) : file;
}
