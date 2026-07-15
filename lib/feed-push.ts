// FTP/SFTP push for feed exports. Server-only.
//
// Never throws — returns { success, message } so the /admin/feeds UI can
// surface provider-side failures (bad credentials, host unreachable, …)
// verbatim without a 500.

import { Readable } from "node:stream";

export interface FeedPushTarget {
  protocol: "ftp" | "sftp";
  ftp_url: string;
  ftp_port: number;
  ftp_username: string;
  ftp_password: string;
  filename: string; // no extension; .csv appended
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

export async function pushFeedCsv(target: FeedPushTarget, csv: string): Promise<FeedPushResult> {
  const host = cleanHost(target.ftp_url);
  const remoteName = `${target.filename.replace(/\.csv$/i, "")}.csv`;
  const bytes = Buffer.from(csv, "utf8");

  try {
    if (target.protocol === "sftp") {
      const SftpClient = (await import("ssh2-sftp-client")).default;
      const sftp = new SftpClient();
      try {
        await sftp.connect({
          host,
          port: target.ftp_port || 22,
          username: target.ftp_username,
          password: target.ftp_password,
          readyTimeout: 20_000,
        });
        await sftp.put(bytes, remoteName);
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
          password: target.ftp_password,
          secure: false,
        });
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
