// The UI is a React app in ui/, built into ui/dist, which the studio's server serves. `npm run dev` serves it with hot reload and sends /api to a studio on :8090.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: { proxy: { "/api": { target: process.env.STUDIO_URL ?? "http://localhost:8090", changeOrigin: true } } },
});
