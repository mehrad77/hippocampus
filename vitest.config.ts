import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workers-only module, stubbed so the Worker's OAuth library can run under Node.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./apps/worker/src/testing/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Bundle the library through Vite so the alias above applies to its imports too.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
