import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/app/",
  plugins: [
    react(),
    {
      name: "impo-app-redirect",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] === "/app") {
            res.writeHead(308, { Location: req.url.replace("/app", "/app/") });
            res.end();
          } else next();
        });
      },
    },
  ],
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      "/api/v1": {
        target: process.env.IMPO_WEB_API_ORIGIN || "https://mcp.xyznot.com",
        changeOrigin: true,
        rewrite: (path) =>
          process.env.IMPO_WEB_API_ORIGIN ? path : `/instant${path}`,
      },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 1100 },
});
