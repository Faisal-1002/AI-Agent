import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    // Browser calls /api/... on the same origin; Vite forwards them to the backend.
    proxy: { "/api": "http://localhost:3000" },
  },
});
