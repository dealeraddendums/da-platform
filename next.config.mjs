import { execSync } from "child_process";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

// Build number = git commit count minus offset so commit 219 → build 209.
// Increment offset by 1 each time package.json version is bumped to a new major.
const BUILD_OFFSET = 10;
let buildNumber = "0";
try {
  const count = parseInt(execSync("git rev-list --count HEAD").toString().trim(), 10);
  buildNumber = String(count - BUILD_OFFSET);
} catch {
  // Outside a git repo (e.g., CI with shallow clone) — fall back gracefully
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_NUMBER: buildNumber,
  },
};

export default nextConfig;
