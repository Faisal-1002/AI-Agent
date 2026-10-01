import { audit } from "./audit.js";
import { sql } from "./db.js";
import { HARNESS_ADMIN_URL, HARNESS_AUTHORIZATION } from "./opencode.js";
import { spaceDir } from "./paths.js";

// Spaces: where a user's files and documents live. Today every user has one personal space; a
// company space (shared by a team, B2B) is the same thing with members — documents and
// conversations already point at a space, not at a user.
//
// A space's folder lives on the harness's volume, which the api doesn't mount: the harness
// creates it (PUT /spaces/:id on its small admin port, server/harness.ts).

export type Space = { id: string; dir: string };

// The single owner of the conversations from before spaces, if there was exactly one (recorded
// once by the first migration, server/db.ts). They get the old library and the old folder's files.
async function legacyOwner(): Promise<string | undefined> {
  const [row] = await sql<{ legacy_owner: string | null }[]>`SELECT legacy_owner FROM spaces_upgrade WHERE id = 1`;
  return row?.legacy_owner ?? undefined;
}

// The user's personal space, created on first use. `folder: false` when only the library is
// needed (documents, devices) — then the harness doesn't have to be up.
export async function personalSpace(sub: string, { folder = true } = {}): Promise<Space> {
  const find = () => sql<{ id: string }[]>`SELECT id FROM spaces WHERE kind = 'personal' AND owner_sub = ${sub}`;
  let [row] = await find();
  if (!row) {
    const legacy = (await legacyOwner()) === sub;
    // One transaction: the space and (upgrading) the old library together, or neither.
    const created = await sql.begin(async (tx) => {
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO spaces (kind, owner_sub) VALUES ('personal', ${sub})
        ON CONFLICT (owner_sub) WHERE kind = 'personal' DO NOTHING
        RETURNING id`;
      if (inserted && legacy) await tx`UPDATE documents SET space_id = ${inserted.id} WHERE space_id IS NULL`;
      return inserted;
    });
    if (created) await audit(sub, "space.create", created.id, legacy ? { from: "legacy" } : undefined);
    [row] = created ? [created] : await find(); // else: another api pod created it at the same moment
  }
  const space = { id: row.id, dir: spaceDir(row.id) };
  if (folder) await prepareFolder(space, sub);
  return space;
}

// Make sure the space's folder exists. A NEW folder gets the starter files — or, for the single
// owner from before spaces, the old shared folder's files. Cheap and safe to repeat (the harness
// never touches a folder that already exists), so it isn't cached: a folder lost with the
// harness's volume comes back on the next request.
async function prepareFolder(space: Space, sub: string) {
  const seed = (await legacyOwner()) === sub ? "legacy" : "starter";
  const res = await fetch(`${HARNESS_ADMIN_URL}/spaces/${space.id}?seed=${seed}`, {
    method: "PUT",
    headers: HARNESS_AUTHORIZATION ? { Authorization: HARNESS_AUTHORIZATION } : {},
  });
  if (!res.ok) throw new Error(`Couldn't prepare the workspace folder (harness: HTTP ${res.status})`);
}
