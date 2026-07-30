// Shared request-body validation for the feed-company API routes.

export interface FeedBody {
  name?: string;
  ftp_url?: string;
  ftp_username?: string;
  ftp_password?: string;
  ftp_port?: number;
  filename?: string;
  protocol?: string;
  include_vehicles?: string;
  push_schedule?: string;
}

const PROTOCOLS = new Set(["ftp", "sftp"]);
const INCLUDES = new Set(["printed", "all"]);
const SCHEDULES = new Set(["manual", "hourly", "daily"]);

export function validateFeedBody(b: FeedBody, partial: boolean): string | null {
  const req = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (!partial) {
    if (!req(b.name)) return "name is required";
    if (!req(b.ftp_url)) return "ftp_url is required";
    if (!req(b.ftp_username)) return "ftp_username is required";
    if (!req(b.ftp_password)) return "ftp_password is required";
    if (!req(b.filename)) return "filename is required";
  }
  if (b.ftp_port != null && (!Number.isInteger(b.ftp_port) || b.ftp_port < 1 || b.ftp_port > 65535)) return "ftp_port must be 1-65535";
  if (b.protocol != null && !PROTOCOLS.has(b.protocol)) return "protocol must be ftp or sftp";
  if (b.include_vehicles != null && !INCLUDES.has(b.include_vehicles)) return "include_vehicles must be printed or all";
  if (b.push_schedule != null && !SCHEDULES.has(b.push_schedule)) return "push_schedule must be manual, hourly, or daily";
  return null;
}
