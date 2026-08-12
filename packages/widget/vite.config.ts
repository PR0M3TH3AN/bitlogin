import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    lib: {
      // Independent entry points, each a self-contained ES module with a fixed,
      // non-hashed filename: bitlogin.js (main thread) and cryptoWorker.js (worker).
      // workerClient.ts resolves the worker's URL at runtime relative to its own
      // import.meta.url, so both files just need to be deployed side by side --
      // at any path, not necessarily the site root (see workerClient.ts comment).
      //
      // bitlogin-session.js is the lightweight, read-only identity reader
      // (session.ts): a few KB with no worker/wasm, for pages that only need to
      // show who is signed in. It is dependency-free by design so it does not
      // share a chunk with the widget.
      entry: {
        bitlogin: resolve(__dirname, "src/index.ts"),
        cryptoWorker: resolve(__dirname, "src/worker/cryptoWorker.ts"),
        "bitlogin-session": resolve(__dirname, "src/session.ts"),
        // Headless signer (restore + sign, no element/DOM). Loads cryptoWorker.js
        // at runtime like bitlogin.js, so deploy them together.
        "bitlogin-headless": resolve(__dirname, "src/headless.ts")
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
