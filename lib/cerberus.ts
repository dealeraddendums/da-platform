// Server-only client for Cerberus FTP Server 12.8 SOAP API.
//
// Calls a local PHP proxy (proxy.php) co-located on the DA Platform EC2,
// served by nginx at http://localhost/cerberus-proxy/proxy.php. The proxy
// uses PHP SoapClient in WSDL-mode — the exact wire shape Cerberus
// expects, proven against the legacy hub for years.
//
// Why a proxy and not a direct Node SOAP client: PHP SoapClient handles
// the dual-namespace WSDL (ns1=common, ns2=service), the User payload
// attribute serialization, and the gSOAP server quirks with no
// hand-rolled XML. The proxy is a 60-line script — easier to keep
// correct than a Node port of the WSDL wire rules.
//
// All FTP user management requests therefore terminate at localhost; no
// network hop outside this EC2 except the SOAP call the proxy itself
// makes to Cerberus (34.193.4.78:10001).

const PROXY_URL = process.env.CERBERUS_PROXY_URL
  ?? "http://localhost/cerberus-proxy/proxy.php";

export function cerberusConfigured(): boolean {
  return Boolean(process.env.CERBERUS_PROXY_SECRET);
}

export class CerberusError extends Error {
  status: number;
  body: string;
  faultString?: string;
  constructor(status: number, message: string, body: string, faultString?: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.faultString = faultString;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProxyJson = Record<string, any>;

async function callProxy(params: Record<string, string>, timeoutMs = 20000): Promise<ProxyJson> {
  if (!cerberusConfigured()) {
    throw new Error("CERBERUS_PROXY_SECRET not set");
  }
  const body = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Proxy-Secret": process.env.CERBERUS_PROXY_SECRET ?? "",
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new CerberusError(res.status, `Cerberus proxy HTTP ${res.status}`, text);
  }
  let json: ProxyJson;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CerberusError(res.status, "Cerberus proxy returned non-JSON", text);
  }
  if (json && typeof json.error === "string") {
    throw new CerberusError(res.status, `Cerberus: ${json.error}`, text, json.error);
  }
  return json;
}

// ── Operations ───────────────────────────────────────────────────────────────

export interface CerberusOpResult {
  ok: boolean;
  message: string | null;
}

export async function getUserList(): Promise<string[]> {
  const json = await callProxy({ action: "GetUserList" });
  const list = json.UserList;
  if (Array.isArray(list)) return list as string[];
  if (typeof list === "string") return [list];
  return [];
}

export async function getUserInformation(userName: string): Promise<{
  raw: ProxyJson;
  result: boolean;
  message: string | null;
  rootPath: string | null;
  protocols: string[];
}> {
  const json = await callProxy({ action: "GetUserInformation", userName });

  // Cerberus replies with a UserInformation object (when found) plus a
  // top-level `result`/`message`. Older proxies returned them flat.
  const info = json.UserInformation ?? json;
  const result = (json.result ?? info.result) === true || (json.result ?? info.result) === "true";
  const message = (json.message ?? info.message) ?? null;

  // Pull the first root's path if available.
  let rootPath: string | null = null;
  const rootList = info.rootList;
  if (rootList) {
    const root = Array.isArray(rootList.root) ? rootList.root[0] : rootList.root;
    if (root) rootPath = root.path ?? null;
  }

  // Protocol list lives under loginRestrictions/protocols or similar — best-
  // effort extraction (gSOAP shape varies). Empty if absent.
  const protocols: string[] = [];
  const lr = info.loginRestrictions;
  if (lr && lr.protocol) {
    const arr = Array.isArray(lr.protocol) ? lr.protocol : [lr.protocol];
    for (const p of arr) protocols.push(typeof p === "string" ? p : String(p));
  }

  return { raw: json, result, message, rootPath, protocols };
}

export async function deleteUser(userName: string): Promise<CerberusOpResult> {
  const json = await callProxy({ action: "DeleteUser", name: userName });
  return {
    ok: json.result === true || json.result === "true",
    message: json.message ?? null,
  };
}

export async function changePassword(userName: string, newPassword: string): Promise<CerberusOpResult> {
  const json = await callProxy({
    action: "ChangePassword",
    userName,
    newPassword,
  });
  return {
    ok: json.result === true || json.result === "true",
    message: json.message ?? null,
  };
}

export interface AddUserInput {
  username: string;
  password: string;
  /** Folder name under C:/ftproot/. Defaults to username. */
  folderName?: string;
}

/**
 * Add an FTP user. The proxy expects `userData` as a JSON string of the
 * SOAP request payload (minus credentials, which the proxy injects).
 * Shape mirrors the legacy hub's ftp_api.php `add_user` action.
 */
export async function addUser(input: AddUserInput): Promise<CerberusOpResult> {
  const folder = (input.folderName ?? input.username).trim();
  const path = `C:/ftproot/${folder}`;
  const userData = {
    User: {
      name: input.username,
      groupList: { name: "test" },
      rootList: {
        root: {
          name: folder,
          path,
          permissions: {
            allowListFile: true,
            allowListDir: true,
            allowDownload: true,
            allowUpload: true,
            allowRename: true,
            allowDelete: true,
            allowDirectoryCreation: true,
            allowDisplayHidden: false,
            allowZip: false,
            allowUnzip: false,
            allowShare: false,
            allowShareUpload: false,
          },
        },
      },
      password: { value: input.password, type: "plain" },
      isSimpleDirectoryMode: { value: true, priority: "user" },
    },
    saveToDisk: true,
    createNonExistentDirectories: true,
  };

  const json = await callProxy({
    action: "AddUser",
    userData: JSON.stringify(userData),
  });
  return {
    ok: json.result === true || json.result === "true",
    message: json.message ?? null,
  };
}
