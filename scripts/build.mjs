import { build } from "esbuild";
await build({ entryPoints: ["src/functions.ts"], outdir: "dist/lambda", bundle: true,
  platform: "node", target: "node22", format: "esm", sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
await build({ entryPoints: ["sst.config.ts"], outfile: "dist/sst.config.mjs", bundle: false,
  platform: "node", target: "node22", format: "esm" });
console.log("Lambda bundle and SST configuration transpiled.");
