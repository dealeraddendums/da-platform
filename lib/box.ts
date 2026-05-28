// Server-only Box.com SDK wrapper. Used by dealer/group POST handlers
// to provision a flat folder per entity:
//
//   /Dealers/{dealer_name}
//   /Groups/{group_name}
//
// Auth: JWT app authentication. The full Box app config (clientID,
// clientSecret, publicKeyID, encrypted private key + passphrase,
// enterpriseID) lives in a JSON file outside the repo at the path
// BOX_CONFIG_PATH. The file is mode 600 and gitignored.
//
// Failure mode: callers wrap us in fireAndForget() from lib/billing-sync.ts
// with event "box.folder.create", so any thrown error lands in
// billing_sync_errors for retry.
//
// SDK version: this module is written against box-node-sdk v10.x. The pre-v10
// API (BoxSDK.getPreconfiguredInstance / sdk.getAppAuthClient / folders.create
// / folders.getItems) was replaced by class-based imports (BoxClient,
// BoxJwtAuth, JwtConfig) and renamed methods (createFolder, getFolderItems).

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from "node:fs";

const DEALERS_PARENT_NAME = "Dealers";
const GROUPS_PARENT_NAME  = "Groups";
// Allan's "DealerAddendums Platform" folder in his personal Box drive. The
// JWT service account ("DA Platform", AutomationUser_2577618_…) has been
// added as a co-owner so it can read/write here. We anchor under this id
// instead of "0" (the service account's own root) so every dealer/group
// folder we create shows up in Allan's Drive sidebar without an extra
// collaboration step.
const BOX_ROOT_FOLDER_ID  = "384943909938";

interface BoxFolder {
  id: string;
  name: string;
  type: "folder";
}

let cachedClient: any | null = null;
let cachedClientErrored: boolean = false;

// Module-level cache of the top-level parent folders so we don't search
// for them on every dealer / group create.
const parentCache = new Map<string, string>();

export function boxConfigured(): boolean {
  const path = process.env.BOX_CONFIG_PATH;
  if (!path) return false;
  try { return fs.existsSync(path); } catch { return false; }
}

/**
 * Build the JWT-auth BoxClient once. Returns null if BOX_CONFIG_PATH is
 * unset, the file is missing, or the SDK throws during init — callers
 * treat null as "Box not configured; skip".
 *
 * v10: `JwtConfig.fromConfigJsonString(raw)` parses the legacy nested
 * boxAppSettings/appAuth/enterpriseID config JSON verbatim, so the
 * config file on disk (same shape used by v3) is reused without edits.
 */
function getClient(): any | null {
  if (cachedClient) return cachedClient;
  if (cachedClientErrored) return null;
  const path = process.env.BOX_CONFIG_PATH;
  if (!path) return null;
  try {
    const raw = fs.readFileSync(path, "utf8");
    // box-node-sdk v10 is published as ESM-with-CJS-fallback. Require keeps
    // bundler compatibility without an extra dynamic-import dance.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require("box-node-sdk");
    const config = sdk.JwtConfig.fromConfigJsonString(raw);
    const auth = new sdk.BoxJwtAuth({ config });
    cachedClient = new sdk.BoxClient({ auth });
    return cachedClient;
  } catch (err) {
    cachedClientErrored = true;
    console.error("[box] init failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Find a folder by exact name under parentId. Uses /folders/:id/items
 * with a small page size — fine for our use case where each parent
 * holds an enumerable number of children. Returns null if not found.
 */
async function findChildFolderByName(client: any, parentId: string, name: string): Promise<BoxFolder | null> {
  let offset = 0;
  const limit = 1000;
  while (true) {
    const page = await client.folders.getFolderItems(parentId, {
      queryParams: { fields: ["id", "name", "type"], limit, offset },
    });
    const items: BoxFolder[] = page?.entries ?? [];
    const match = items.find(it => it.type === "folder" && it.name === name);
    if (match) return match;
    if (items.length < limit) return null;
    offset += limit;
  }
}

/**
 * Pull the conflicting folder id out of a Box v10 createFolder error.
 * Box returns 409 item_name_in_use with the existing folder embedded
 * under responseInfo.body.context_info.conflicts[]. Returns null if the
 * error isn't a name-conflict (caller will rethrow).
 */
function extractConflictId(err: unknown): string | null {
  const e = err as { responseInfo?: { statusCode?: number; body?: any } };
  const status = e?.responseInfo?.statusCode;
  const conflicts = e?.responseInfo?.body?.context_info?.conflicts;
  if (status === 409 && Array.isArray(conflicts) && conflicts[0]?.id) {
    return String(conflicts[0].id);
  }
  return null;
}

async function ensureParentFolder(parentName: string): Promise<string> {
  const cached = parentCache.get(parentName);
  if (cached) return cached;

  const client = getClient();
  if (!client) throw new Error("Box client not initialised");

  const existing = await findChildFolderByName(client, BOX_ROOT_FOLDER_ID, parentName);
  if (existing) {
    parentCache.set(parentName, existing.id);
    return existing.id;
  }
  try {
    const created = await client.folders.createFolder({
      name: parentName,
      parent: { id: BOX_ROOT_FOLDER_ID },
    });
    parentCache.set(parentName, created.id);
    return created.id;
  } catch (err) {
    // Race condition guard — if another caller created it between our
    // search and the create, Box returns 409 with the existing id.
    const conflictId = extractConflictId(err);
    if (conflictId) {
      parentCache.set(parentName, conflictId);
      return conflictId;
    }
    throw err;
  }
}

/**
 * Create a child folder, returning its id. If a folder with the same
 * name already exists under the same parent, reuse it (Box returns 409
 * with conflicts[0].id pointing at the existing folder).
 */
async function createOrReuseChild(client: any, parentId: string, name: string): Promise<string> {
  try {
    const created = await client.folders.createFolder({
      name,
      parent: { id: parentId },
    });
    return created.id;
  } catch (err) {
    const conflictId = extractConflictId(err);
    if (conflictId) return conflictId;
    throw err;
  }
}

/**
 * Sanitise a folder name. Box itself accepts a wide range of characters
 * but rejects names containing forward slashes, leading/trailing dots,
 * NULL bytes, or empty strings. Normalise here so wonky dealer names
 * don't surface SDK errors. Spaces ARE allowed and are preserved.
 */
function safeFolderName(name: string): string {
  return name
    .replace(/[/\\]/g, "")   // disallowed characters (slash, backslash)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

/**
 * Create /Dealers/{name} and return the folder id. Idempotent on
 * duplicate name (returns existing id via createOrReuseChild).
 */
export async function createDealerFolder(dealerName: string): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("Box client not initialised");
  const name = safeFolderName(dealerName);
  if (!name) throw new Error("Dealer name empty after sanitisation");
  const parentId = await ensureParentFolder(DEALERS_PARENT_NAME);
  return createOrReuseChild(client, parentId, name);
}

/**
 * Create /Groups/{name} and return the folder id. Idempotent.
 */
export async function createGroupFolder(groupName: string): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("Box client not initialised");
  const name = safeFolderName(groupName);
  if (!name) throw new Error("Group name empty after sanitisation");
  const parentId = await ensureParentFolder(GROUPS_PARENT_NAME);
  return createOrReuseChild(client, parentId, name);
}
