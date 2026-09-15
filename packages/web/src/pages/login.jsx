import { useState } from "react";
import { Alert, Button, Card, Flex, Form, Input, Typography } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { useAuthStore } from "../stores/index.js";

// 登录页：只输密码（单用户 chamber）。
// antd Form 里 按 Enter / 点按钮 → authStore.login → 门控切到 Layout
export default function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const loginError = useAuthStore((s) => s.loginError);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const onFinish = async ({ password }) => {
    setLoading(true);
    setError(null);
    try {
      await login(password);
    } catch {
      /* authStore 内部已记录 loginError */
    } finally {
      setLoading(false);
    }
  };

  return (
    <Flex align="center" justify="center" style={{ height: "100%" }}>
      <Card style={{ width: "min(360px, 88vw)" }}>
        <Typography.Title level={4} style={{ marginTop: 0, textAlign: "center" }}>
          Pi Chamber
        </Typography.Title>
        <Form onFinish={onFinish} layout="vertical">
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoFocus />
          </Form.Item>
          {loginError && <Alert type="error" message={loginError} showIcon style={{ marginBottom: 12 }} />}
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </Flex>
  );
}
