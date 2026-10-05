import { NextRequest, NextResponse } from "next/server";
import { exportContext, loadOwnedExport } from "@/lib/dealer-exports";
import { checkPublicFtpHost } from "@/lib/ftp-host-guard";
import { testFeedConnection } from "@/lib/feed-push";

// "Test connection" — logs in with the form's details (and opens the folder)
// without uploading anything. When editing, a blank password means "use the
// stored one"; it never leaves the server.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const r = await exportContext(req);
  if ("response" in r) return r.response;
  const { ctx } = r;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const protocol = str("protocol") === "sftp" ? "sftp" : "ftp";
  const host = str("ftp_url");
  const port = Number(body.ftp_port ?? (protocol === "sftp" ? 22 : 21));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return NextResponse.json({ success: false, message: "Port must be between 1 and 65535." }, { status: 400 });
  const hostProblem = await checkPublicFtpHost(host);
  if (hostProblem) return NextResponse.json({ success: false, message: hostProblem }, { status: 400 });

  let password = typeof body.ftp_password === "string" ? body.ftp_password : "";
  if (!password && typeof body.export_id === "string") {
    const owned = await loadOwnedExport(ctx, body.export_id);
    if (!owned) return NextResponse.json({ success: false, message: "Not found" }, { status: 404 });
    password = owned.ftp_password; // still encrypted — testFeedConnection decrypts
  }
  if (!password) return NextResponse.json({ success: false, message: "Enter the FTP password." }, { status: 400 });

  const result = await testFeedConnection({
    protocol, ftp_url: host, ftp_port: port, ftp_username: str("ftp_username"), ftp_password: password, ftp_path: str("ftp_path") || null,
  });
  return NextResponse.json(result, { status: result.success ? 200 : 502 });
}
