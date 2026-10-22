import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "react/index": "src/react/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  external: ["react"],
});
