// A tool's title as people should see it: relative to the user's own folder. OpenCode reports
// paths absolute or relative to the file system root ("data/workspaces/<space id>/notes.md");
// conversations from before spaces used one shared folder at the root ("/workspace/notes.md").
// (Approval cards don't need this: the server already sends their paths relative.)
const SPACE = /^.*?workspaces[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[\\/]|$)/i;
const LEGACY = /^\/?workspace[\\/]/;

export function shortPath(file: string): string {
  if (SPACE.test(file)) return file.replace(SPACE, "") || ".";
  return file.replace(LEGACY, "");
}
