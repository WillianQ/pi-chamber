import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev 联调：5173 同源代理到后端 3001（/api + /ws，dev 后端在 3001；生产 pnpm start 在 3000），无 CORS 负担；
// 生产把 dist/ 交给后端/nginx 托管同一域名即可，同样无需 CORS。
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 0.0.0.0：默认只绑 ::1 在 Windows 上会导致浏览器/代理连不上
    port: 5173,
    allowedHosts: true, // 放行所有 Host：局域网 IP / qymtest.shnxzc.cn 等域名都能访问，不再只限 localhost
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
