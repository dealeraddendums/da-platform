// Server-only client for Cerberus FTP Server 12.8 SOAP API.
//
// Wire shape matched byte-for-byte against PHP SoapClient (WSDL-mode)
// running on the legacy hub at hub.dealeraddendums.com/request/ftp_api.php,
// which has been talking to this Cerberus instance in production for years.
//
// Key wire rules (do not deviate without re-checking the WSDL):
//
//   • POST to /wsdl/Cerberus.wsdl?wsdl (NOT /service/cerberusftpservice).
//   • NO HTTP Basic auth header. Credentials are body-only.
//   • SOAP 1.1 envelope (text/xml).
//   • Two namespaces:
//       ns1 = http://cerberusllc.com/common
//             (credentials, User payload, root, permissions — all shared types)
//       ns2 = http://cerberusllc.com/service/cerberusftpservice
//             (the *Request element + operation-specific top-level params)
//   • SOAPAction: "<service-ns>/<OpName>"
//   • Wrapper element is <ns2:{OpName}Request> (matches the WSDL xsd:element
//     name, not the wsdl:operation name).

const ENDPOINT = process.env.CERBERUS_SOAP_ENDPOINT
  ?? "http://34.193.4.78:10001/wsdl/Cerberus.wsdl?wsdl";
const NS_SVC = "http://cerberusllc.com/service/cerberusftpservice";
const NS_COMMON = "http://cerberusllc.com/common";

export function cerberusConfigured(): boolean {
  return Boolean(
    process.env.CERBERUS_ADMIN_USER && process.env.CERBERUS_ADMIN_PASSWORD,
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
  return `<ns1:credentials><ns1:user>${user}</ns1:user><ns1:password>${password}</ns1:password></ns1:credentials>`;
}

async function soapCall(operation: string, innerXml: string, timeoutMs = 15000): Promise<string> {
  if (!cerberusConfigured()) {
    throw new Error("CERBERUS_ADMIN_USER / CERBERUS_ADMIN_PASSWORD not set");
  }
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SOAP-ENV:Envelope` +
      ` xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"` +
      ` xmlns:ns1="${NS_COMMON}"` +
      ` xmlns:ns2="${NS_SVC}">` +
      `<SOAP-ENV:Body>` +
        `<ns2:${operation}Request>${credentialsXml()}${innerXml}</ns2:${operation}Request>` +
      `</SOAP-ENV:Body>` +
    `</SOAP-ENV:Envelope>`;

  const headers: Record<string, string> = {
    "Content-Type": "text/xml; charset=utf-8",
    SOAPAction: `"${NS_SVC}/${operation}"`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: envelope,
      signal: controller.signal,
    });
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
  const inner = `<ns2:userName>${xmlEscape(userName)}</ns2:userName>`;
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
  const body = await soapCall("DeleteUser", `<ns2:name>${xmlEscape(userName)}</ns2:name>`);
  return {
    ok: extractFirst(body, "result") === "true",
    message: extractFirst(body, "message"),
  };
}

export async function changePassword(userName: string, newPassword: string): Promise<CerberusOpResult> {
  // Matches PHP wire — no sendEmailNotification element.
  const inner =
    `<ns2:userName>${xmlEscape(userName)}</ns2:userName>` +
    `<ns2:oldPassword></ns2:oldPassword>` +
    `<ns2:newPassword>${xmlEscape(newPassword)}</ns2:newPassword>` +
    `<ns2:adminPasswordReset>true</ns2:adminPasswordReset>`;
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
 * AddUser. Wire shape mirrors PHP SoapClient's serialization exactly:
 * the User name and the password/isSimpleDirectoryMode children are emitted
 * as XML attributes (not child elements), the User payload sits in ns1
 * (common), and saveToDisk / createNonExistentDirectories sit at the top
 * level in ns2.
 */
export async function addUser(input: AddUserInput): Promise<CerberusOpResult> {
  const folder = (input.folderName ?? input.username).trim();
  const path = `C:/ftproot/${folder}`;
  const inner =
    `<ns2:User ns1:name="${xmlEscape(input.username)}">` +
      `<ns1:password ns1:value="${xmlEscape(input.password)}" ns1:type="plain"/>` +
      `<ns1:isSimpleDirectoryMode ns1:value="true" ns1:priority="user"/>` +
      `<ns1:groupList/>` +
      `<ns1:rootList>` +
        `<ns1:root>` +
          `<ns1:name>${xmlEscape(folder)}</ns1:name>` +
          `<ns1:path>${xmlEscape(path)}</ns1:path>` +
          `<ns1:permissions>` +
            `<ns1:allowListFile>true</ns1:allowListFile>` +
            `<ns1:allowListDir>true</ns1:allowListDir>` +
            `<ns1:allowDownload>true</ns1:allowDownload>` +
            `<ns1:allowUpload>true</ns1:allowUpload>` +
            `<ns1:allowRename>true</ns1:allowRename>` +
            `<ns1:allowDelete>true</ns1:allowDelete>` +
            `<ns1:allowDirectoryCreation>true</ns1:allowDirectoryCreation>` +
            `<ns1:allowDisplayHidden>false</ns1:allowDisplayHidden>` +
            `<ns1:allowZip>false</ns1:allowZip>` +
            `<ns1:allowUnzip>false</ns1:allowUnzip>` +
            `<ns1:allowShare>false</ns1:allowShare>` +
            `<ns1:allowShareUpload>false</ns1:allowShareUpload>` +
          `</ns1:permissions>` +
        `</ns1:root>` +
      `</ns1:rootList>` +
    `</ns2:User>` +
    `<ns2:saveToDisk>true</ns2:saveToDisk>` +
    `<ns2:createNonExistentDirectories>true</ns2:createNonExistentDirectories>`;
  const body = await soapCall("AddUser", inner);
  return {
    ok: extractFirst(body, "result") === "true",
    message: extractFirst(body, "message"),
  };
}
