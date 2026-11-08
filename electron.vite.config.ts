import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {
    build: {
      // A sandboxed preload cannot be an ES module.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
