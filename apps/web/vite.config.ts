import { defineConfig, loadEnv } from "vite";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const webHost = process.env.COVECHAT_WEB_HOST || env.COVECHAT_WEB_HOST || "127.0.0.1";
  const webPort = Number.parseInt(process.env.COVECHAT_WEB_PORT || env.COVECHAT_WEB_PORT || "5173", 10);
  const apiOrigin = process.env.COVECHAT_API_ORIGIN || env.COVECHAT_API_ORIGIN || "http://127.0.0.1:8080";
  return {
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "CoveChat",
        short_name: "CoveChat",
        description: "实验性端到端加密聊天",
        lang: "zh-CN",
        theme_color: "#08263f",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: []
      }
    })
  ],
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
    headers: {
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "X-Content-Type-Options": "nosniff"
    }
  },
  preview: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
    headers: {
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:8080 http://localhost:8080; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; trusted-types covechat#pwa; require-trusted-types-for 'script'",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "X-Content-Type-Options": "nosniff"
    }
  },
  };
});
