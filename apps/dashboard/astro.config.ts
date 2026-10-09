import { writeFile } from "node:fs/promises";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import type { AstroIntegration } from "astro";
import { defineConfig, passthroughImageService } from "astro/config";

const BASE = "/dashboard";

/**
 * Serve the dashboard API inside `astro dev`: the demo campaign, or a real vault with HIPPO_VAULT
 * (private data: never commit screenshots of it). Production serves the same API from the CLI or Worker.
 */
function hippoDevApi(): AstroIntegration {
  return {
    name: "hippo-dev-api",
    hooks: {
      "astro:server:setup": async ({ server }) => {
        const { devMiddleware } = (await server.ssrLoadModule("@hippocampus/dashboard/dev")) as typeof import("@hippocampus/dashboard/dev");
        // First in line, before Astro strips the base and answers unknown routes with its 404 page.
        server.middlewares.stack.unshift({ route: "", handle: devMiddleware({ basePath: `${BASE}/api`, vaultDir: process.env.HIPPO_VAULT || undefined }) as never });
      },
    },
  };
}

/**
 * Workers Static Assets serve `/dashboard/_astro/*` without running the Worker, so their headers
 * come from a `_headers` file at the assets root (`dist/`, one level above the site).
 */
function workerHeaders(): AstroIntegration {
  return {
    name: "hippo-worker-headers",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const root = new URL("../", dir);
        const rules = [`${BASE}/_astro/*`, "  Cache-Control: public, max-age=31536000, immutable", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer", ""];
        await writeFile(new URL("_headers", root), rules.join("\n"));
      },
    },
  };
}

export default defineConfig({
  base: BASE,
  // Built into dist/dashboard so `/dashboard/...` URLs map 1:1 onto files (Worker assets, CLI static server).
  outDir: "./dist/dashboard",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory", inlineStylesheets: "never" },
  integrations: [react(), mdx(), hippoDevApi(), workerHeaders()],
  image: { service: passthroughImageService() },
  markdown: { syntaxHighlight: "prism" },
  devToolbar: { enabled: false },
  security: {
    // Hash-based CSP in a <meta> on every page. The servers add only frame-ancestors and friends.
    csp: {
      directives: ["default-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"],
      scriptDirective: { resources: ["'self'"] },
      styleDirective: { resources: ["'self'"] },
    },
  },
  vite: {
    // Workspace packages ship TypeScript source; let Vite compile them instead of Node's type stripping.
    ssr: { noExternal: [/^@hippocampus\//] },
    // Pre-bundle every client dependency up front: a mid-session re-optimization in `astro dev`
    // otherwise leaves islands holding two copies of React.
    optimizeDeps: { include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-markdown", "remark-gfm", "d3-force"] },
  },
});
