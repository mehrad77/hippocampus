import { defineConfig } from "tsup";

// One self-contained CLI: workspace packages are bundled, npm dependencies stay external.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  clean: true,
  noExternal: [/^@hippocampus\//],
  // Keep `node:` specifiers: some builtins (node:sqlite) only exist under the prefix.
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node" },
});
