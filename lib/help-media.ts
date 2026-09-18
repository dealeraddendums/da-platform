// Where Help Center media may live — ONE definition, deliberately dependency-free.
//
// Uploaded help media (clips, attached PDFs, screenshots) goes to the help/ key
// prefix of our public-read bucket and nowhere else. Two callers need this rule:
//   * lib/help-sanitize.ts — drops a <video>/<source> pointing anywhere else.
//   * the article write path — refuses a pdf_url pointing anywhere else, because
//     the dealer article page FRAMES that URL. A foreign host there would be an
//     arbitrary-iframe hole by another door.
// This module pulls in nothing (help-sanitize drags jsdom in via
// isomorphic-dompurify, which has no business in an API route).

export const HELP_MEDIA_BUCKET = "new-infobox-images";
export const HELP_MEDIA_PREFIX = "help/";

const HELP_MEDIA_SRC_RE = /^https:\/\/new-infobox-images\.s3\.[a-z0-9-]+\.amazonaws\.com\/help\//;

export function isHelpMediaUrl(src: string): boolean {
  return HELP_MEDIA_SRC_RE.test(src);
}
