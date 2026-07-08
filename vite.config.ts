import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "src/overlay/index.html"),
        consent: resolve(__dirname, "src/consent-overlay/index.html"),
        "meeting-hud": resolve(__dirname, "src/meeting-hud/index.html"),
        "screenrec-setup": resolve(__dirname, "src/screenrec-setup/index.html"),
        "camera-preview": resolve(__dirname, "src/camera-preview/index.html"),
      },
    },
  },
});
