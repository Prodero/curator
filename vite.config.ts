import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  define: { __PRODERO_VERSION__: JSON.stringify(packageVersion) },
  build: {
    outDir: path.resolve(process.cwd(), "dist-ui"),
    emptyOutDir: true,
  },
});
