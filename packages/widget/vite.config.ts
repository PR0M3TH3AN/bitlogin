import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    lib: {
      // Two independent entry points, each a self-contained ES module with a fixed,
      // non-hashed filename: bitlogin.js (main thread) and cryptoWorker.js (worker).
      // workerClient.ts resolves the worker's URL at runtime relative to its own
      // import.meta.url, so both files just need to be deployed side by side --
      // at any path, not necessarily the site root (see workerClient.ts comment).
      entry: {
        bitlogin: resolve(__dirname, "src/index.ts"),
        cryptoWorker: resolve(__dirname, "src/worker/cryptoWorker.ts")
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      output: {
        chunkFileNames: "bitlogin-shared-[hash].js"
      }
    }
  }
});
