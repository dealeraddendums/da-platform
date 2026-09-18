"use client";

import { useEffect, useRef } from "react";
import { sanitizeHelpHtml } from "@/lib/help-sanitize";
import { mountJwPlayers } from "@/lib/jw-embed";

export type JwConfig = { siteId: string; playerId: string; configured: boolean };

/**
 * Renders a Help article body: the authored HTML, re-sanitized against the
 * strict allowlist, with any JW video placeholders turned into players.
 *
 * ONE component for both the dealer view and the CMS "Preview as dealer", so
 * what the support team proofreads is literally what a dealer gets — including
 * anything the sanitizer drops.
 */
export default function HelpArticleBody({
  html,
  jw,
  style,
}: {
  html: string;
  jw: JwConfig;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Stored verbatim, sanitized here, rendered as HTML — never escaped text.
  const clean = sanitizeHelpHtml(html);

  useEffect(() => {
    const root = ref.current;
    if (!root || !jw.configured) return;
    void mountJwPlayers(root, { siteId: jw.siteId, playerId: jw.playerId });
  }, [clean, jw.configured, jw.siteId, jw.playerId]);

  return (
    <div
      ref={ref}
      className="help-article-body"
      style={style}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
