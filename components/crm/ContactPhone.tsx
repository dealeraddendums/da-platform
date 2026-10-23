// A contact's phone: E.164 → click-to-call; otherwise the as-typed phone_raw (migration 190) as plain
// text — shown, never dialled.
import ClickToCall from "./ClickToCall";

export default function ContactPhone({ phone, phoneRaw, canDial }: { phone: string | null; phoneRaw?: string | null; canDial: boolean }) {
  if (phone || !phoneRaw) return <ClickToCall phone={phone} canDial={canDial} />;
  return <span title="Not a dialable number — as entered on the platform" style={{ color: "var(--text-secondary)" }}>{phoneRaw}</span>;
}
