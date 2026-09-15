import { useEffect } from "react";
import { ConfigProvider, Flex, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import { antdTheme } from "./theme/antd.js";
import { useAuthStore } from "./stores/index.js";
import LoginPage from "./pages/login.jsx";
import Layout from "./layout/index.jsx";

// 门控：authed=null（探活中）→ Spin；false → 登录页；true → 主框架（登录成功才连 WS）
export default function App() {
  const authed = useAuthStore((s) => s.authed);
  const bootstrap = useAuthStore((s) => s.bootstrap);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      {authed === null ? (
        <Flex align="center" justify="center" style={{ height: "100%" }}>
          <Spin size="large" />
        </Flex>
      ) : authed ? (
        <Layout />
      ) : (
        <LoginPage />
      )}
    </ConfigProvider>
  );
}
