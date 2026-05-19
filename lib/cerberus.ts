// Server-only client for Cerberus FTP Server 12.8 SOAP API.
//
// Uses raw SOAP 1.1 envelopes — same wire shape as the legacy
// hub.dealeraddendums.com/ftp.php PHP SoapClient. No `soap` npm package
// required: we avoid runtime WSDL fetches (which fail because Cerberus's
// /wsdl/Cerberus.wsdl returns an HTML notice in 12.8+).
//
// The PHP code uses:
//   - SOAP 1.1 envelope (`http://schemas.xmlsoap.org/soap/envelope/`)
//   - Content-Type: text/xml
//   - Body element <GetUserListRequest> etc (the WSDL <xsd:element> name,
//     not the operation name)
//   - Credentials wrapped in <credentials><user/><password/></credentials>
//     inside the request body
//   - No HTTP Basic Auth header — credentials are body-only
//
// Endpoint: http://34.193.4.78:10001/service/cerberusftpservice
// (Could also POST to /wsdl/Cerberus.wsdl?wsdl — the PHP uses that path
//  via the `location` option but the actual SOAP service handler responds
//  on either path.)

const ENDPOINT = process.env.CERBERUS_SOAP_ENDPOINT
  ?? "http://34.193.4.78:10001/service/cerberusftpservice";
const TNS = "http://cerberusllc.com/service/cerberusftpservice";

export function cerberusConfigured(): boolean {
  return Boolean(
    process.env.CERBERUS_SOAP_ENDPOINT
      && process.env.CERBERUS_ADMIN_USER
      && process.env.CERBERUS_ADMIN_PASSWORD,
  );
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

function xmlEscape(s: string | number | boolean | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function credentialsXml(): string {
  const user = xmlEscape(process.env.CERBERUS_ADMIN_USER ?? "");
  const password = xmlEscape(process.env.CERBERUS_ADMIN_PASSWORD ?? "");
  return `<tns:credentials><tns:user>${user}</tns:user><tns:password>${password}</tns:password></tns:credentials>`;
}

function basicAuthHeader(): string {
  const user = process.env.CERBERUS_ADMIN_USER ?? "";
  const password = process.env.CERBERUS_ADMIN_PASSWORD ?? "";
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

/**
 * Send a SOAP envelope to the Cerberus endpoint with the **two-step
 * Basic-auth handshake** PHP's SoapClient uses:
 *
 *   1. POST without Authorization header.
 *   2. If the server returns 401 with `WWW-Authenticate: Basic …`, retry
 *      the exact same request with `Authorization: Basic <base64>`.
 *
 * Cerberus 12.8's gSOAP server requires the challenge-response sequence
 * — preemptively sending the Authorization header on the first request
 * fails with 401, but waiting for the challenge first and replaying with
 * credentials succeeds. (Verified by comparing PHP SoapClient traffic on
 * the legacy hub.)
 *
 * Returns the raw response body. Throws CerberusError on HTTP non-2xx or
 * SOAP Fault.
 */
async function soapCall(operation: string, innerXml: string, timeoutMs = 15000): Promise<string> {
  if (!cerberusConfigured()) {
    throw new Error("CERBERUS_* env vars not set");
  }
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${TNS}">
  <soap:Body>
    <tns:${operation}Request>${credentialsXml()}${innerXml}</tns:${operation}Request>
  </soap:Body>
</soap:Envelope>`;

  const baseHeaders: Record<string, string> = {
    "Content-Type": "text/xml; charset=utf-8",
    SOAPAction: `"${TNS}/${operation}"`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    // Step 1: unauthenticated request — server replies with the
    // WWW-Authenticate challenge.
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: baseHeaders,
      body: envelope,
      signal: controller.signal,
    });

    // Step 2: replay with Basic credentials on 401. We don't gate on the
    // WWW-Authenticate header content — Cerberus consistently challenges
    // Basic, and a single retry matches PHP SoapClient's behavior.
    if (res.status === 401) {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { ...baseHeaders, Authorization: basicAuthHeader() },
        body: envelope,
        signal: controller.signal,
      });
    }
  } finally {
    clearTimeout(timeout);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new CerberusError(res.status, `Cerberus HTTP ${res.status}`, body);
  }
  const faultMatch = body.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i)
    ?? body.match(/<SOAP-ENV:Text[^>]*>([\s\S]*?)<\/SOAP-ENV:Text>/i);
  if (faultMatch) {
    throw new CerberusError(res.status, `Cerberus SOAP fault: ${faultMatch[1]}`, body, faultMatch[1]);
  }
  return body;
}

// ── XML-to-value helpers (Cerberus uses simple tagged XML in responses) ─────

function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(unxml(m[1]));
  }
  return out;
}

function extractFirst(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`));
  return m ? unxml(m[1]) : null;
}

function unxml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// ── Operations ───────────────────────────────────────────────────────────────

export interface CerberusOpResult {
  ok: boolean;
  message: string | null;
}

export async function getUserList(): Promise<string[]> {
  const body = await soapCall("GetUserList", "");
  return extractAll(body, "UserList");
}

export async function getUserInformation(userName: string): Promise<{
  raw: string;
  result: boolean;
  message: string | null;
  rootPath: string | null;
  protocols: string[];
}> {
  const inner = `<tns:userName>${xmlEscape(userName)}</tns:userName>`;
  const body = await soapCall("GetUserInformation", inner);
  return {
    raw: body,
    result: extractFirst(body, "result") === "true",
    message: extractFirst(body, "message"),
    rootPath: extractFirst(body, "path"),
    protocols: extractAll(body, "protocol"),
  };
}

export async function deleteUser(userName: string): Promise<CerberusOpResult> {
  const body = await soapCall("DeleteUser", `<tns:name>${xmlEscape(userName)}</tns:name>`);
  return {
    ok: extractFirst(body, "result") === "true",
    message: extractFirst(body, "message"),
  };
}

export async function changePassword(userName: string, newPassword: string): Promise<CerberusOpResult> {
  const inner =
    `<tns:userName>${xmlEscape(userName)}</tns:userName>` +
    `<tns:oldPassword></tns:oldPassword>` +
    `<tns:newPassword>${xmlEscape(newPassword)}</tns:newPassword>` +
    `<tns:adminPasswordReset>true</tns:adminPasswordReset>` +
    `<tns:sendEmailNotification>false</tns:sendEmailNotification>`;
  const body = await soapCall("ChangePassword", inner);
  return {
    ok: extractFirst(body, "result") === "true",
    message: extractFirst(body, "message"),
  };
}

export interface AddUserInput {
  username: string;
  password: string;
  /** Folder name under C:/ftproot/. Defaults to username. */
  folderName?: string;
}

/**
 * Add (or overwrite — Cerberus AddUser is upsert-style) an FTP user.
 * Mirrors the EXACT payload shape from the legacy PHP code:
 *   - <User><name/>, <groupList><name>test</name></groupList>
 *   - <rootList><root><name/><path/><permissions>...</permissions></root></rootList>
 *   - <password><value/><type>plain</type></password>
 *   - <isSimpleDirectoryMode><value>true</value><priority>user</priority></isSimpleDirectoryMode>
 *   - saveToDisk=true, createNonExistentDirectories=true
 */
export async function addUser(input: AddUserInput): Promise<CerberusOpResult> {
  const folder = (input.folderName ?? input.username).trim();
  const path = `C:/ftproot/${folder}`;
  const inner =
    `<tns:User>` +
      `<tns:name>${xmlEscape(input.username)}</tns:name>` +
      `<tns:groupList><tns:name>test</tns:name></tns:groupList>` +
      `<tns:rootList>` +
        `<tns:root>` +
          `<tns:name>${xmlEscape(folder)}</tns:name>` +
          `<tns:path>${xmlEscape(path)}</tns:path>` +
          `<tns:permissions>` +
            `<tns:allowListFile>true</tns:allowListFile>` +
            `<tns:allowListDir>true</tns:allowListDir>` +
            `<tns:allowDownload>true</tns:allowDownload>` +
            `<tns:allowUpload>true</tns:allowUpload>` +
            `<tns:allowRename>true</tns:allowRename>` +
            `<tns:allowDelete>true</tns:allowDelete>` +
            `<tns:allowDirectoryCreation>true</tns:allowDirectoryCreation>` +
            `<tns:allowDisplayHidden>false</tns:allowDisplayHidden>` +
            `<tns:allowZip>false</tns:allowZip>` +
            `<tns:allowUnzip>false</tns:allowUnzip>` +
            `<tns:allowShare>false</tns:allowShare>` +
            `<tns:allowShareUpload>false</tns:allowShareUpload>` +
          `</tns:permissions>` +
        `</tns:root>` +
      `</tns:rootList>` +
      `<tns:password>` +
        `<tns:value>${xmlEscape(input.password)}</tns:value>` +
        `<tns:type>plain</tns:type>` +
      `</tns:password>` +
      `<tns:isSimpleDirectoryMode>` +
        `<tns:value>true</tns:value>` +
        `<tns:priority>user</tns:priority>` +
      `</tns:isSimpleDirectoryMode>` +
    `</tns:User>` +
    `<tns:saveToDisk>true</tns:saveToDisk>` +
    `<tns:createNonExistentDirectories>true</tns:createNonExistentDirectories>`;
  const body = await soapCall("AddUser", inner);
  return {
    ok: extractFirst(body, "result") === "true",
    message: extractFirst(body, "message"),
  };
}
