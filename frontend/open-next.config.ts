import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default {
  ...defineCloudflareConfig(),
  // Upstream ships bun.lock, so OpenNext's packager auto-detection picks bun,
  // which this project doesn't use (npm is canonical — see package-lock.json).
  buildCommand: "npx next build",
};
