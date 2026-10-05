// FTP/SFTP push for feed exports. Server-only.
//
// Never throws — returns { success, message } so the /admin/feeds UI can
// surface provider-side failures (bad credentials, host unreachable, …)
// verbatim without a 500.

import { Readable } from "node:stream";
import { decryptSecret } from "@/lib/secret-box";

export interface FeedPushTarget {
  protocol: "ftp" | "sftp";
  ftp_url: string;
  ftp_port: number;
  ftp_username: string;
  ftp_password: string;
  filename: string; // no extension; .csv appended
  /** Optional remote folder (migration 165). Unset = the login's starting
   *  directory, which is where every pre-165 feed has always uploaded. */
  ftp_path?: string | null;
}

export interface FeedPushResult {
  success: boolean;
  message: string;
}

/** Strip an accidental scheme/trailing slash — providers hand out bare hosts,
 *  but 4.0 configs sometimes stored "ftp://host/". */
function cleanHost(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "").trim();
}

/** Remote folder normalized for use: no trailing slash, "" when unset. */
function remoteDir(path: string | null | undefined): string {
  const p = String(path ?? "").trim().replace(/\/+$/, "");
  return p === "/" ? "/" : p;
}

export async function pushFeedCsv(target: FeedPushTarget, csv: string): Promise<FeedPushResult> {
  const host = cleanHost(target.ftp_url);
  const remoteName = `${target.filename.replace(/\.csv$/i, "")}.csv`;
  const bytes = Buffer.from(csv, "utf8");
  // Self-service exports store the password encrypted (enc:v1:…); SuperAdmin
  // feeds store it plain — decryptSecret passes those through unchanged.
  const password = decryptSecret(target.ftp_password);
  const dir = remoteDir(target.ftp_path);

  try {
    if (target.protocol === "sftp") {
      const SftpClient = (await import("ssh2-sftp-client")).default;
      const sftp = new SftpClient();
      try {
        await sftp.connect({
          host,
          port: target.ftp_port || 22,
          username: target.ftp_username,
          password,
          readyTimeout: 20_000,
        });
        await sftp.put(bytes, dir ? `${dir === "/" ? "" : dir}/${remoteName}` : remoteName);
      } finally {
        await sftp.end().catch(() => { /* connection already gone */ });
      }
    } else {
      const { Client } = await import("basic-ftp");
      const client = new Client(20_000);
      try {
        await client.access({
          host,
          port: target.ftp_port || 21,
          user: target.ftp_username,
          password,
          secure: false,
        });
        if (dir) await client.cd(dir);
        await client.uploadFrom(Readable.from(bytes), remoteName);
      } finally {
        client.close();
      }
    }
    return { success: true, message: `Pushed ${remoteName} (${bytes.length.toLocaleString("en-US")} bytes) to ${host} via ${target.protocol.toUpperCase()}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `${target.protocol.toUpperCase()} push to ${host} failed: ${message}` };
  }
}

/**
 * Log in (and change into the remote folder, when set) WITHOUT uploading — the
 * self-service "Test connection" button. Never throws.
 */
export async function testFeedConnection(target: Omit<FeedPushTarget, "filename">): Promise<FeedPushResult> {
  const host = cleanHost(target.ftp_url);
  const password = decryptSecret(target.ftp_password);
  const dir = remoteDir(target.ftp_path);
  try {
    if (target.protocol === "sftp") {
      const SftpClient = (await import("ssh2-sftp-client")).default;
      const sftp = new SftpClient();
      try {
        await sftp.connect({ host, port: target.ftp_port || 22, username: target.ftp_username, password, readyTimeout: 20_000 });
        if (dir) {
          const kind = await sftp.exists(dir);
          if (kind !== "d") return { success: false, message: `Connected to ${host}, but the folder "${dir}" doesn't exist.` };
        }
      } finally {
        await sftp.end().catch(() => { /* connection already gone */ });
      }
    } else {
      const { Client } = await import("basic-ftp");
      const client = new Client(20_000);
      try {
        await client.access({ host, port: target.ftp_port || 21, user: target.ftp_username, password, secure: false });
        if (dir) await client.cd(dir);
      } finally {
        client.close();
      }
    }
    return { success: true, message: `Connected to ${host} via ${target.protocol.toUpperCase()}${dir ? ` and opened "${dir}"` : ""}.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Couldn't connect to ${host} via ${target.protocol.toUpperCase()}: ${message}` };
  }
}
