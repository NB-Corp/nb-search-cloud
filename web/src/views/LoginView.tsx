import React, { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography, message } from 'antd';
import { LockOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext.js';
import { ApiClientError } from '../services/client.js';

const { Title, Text } = Typography;

export function LoginView() {
  const { login } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onFinish = async (values: { tenant: string; username: string; password: string }) => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await login(values.tenant.trim(), values.username.trim(), values.password);
      message.success('登录成功');
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.statusCode === 401 || err.code === 'AUTH_REQUIRED') {
          setErrorMessage('租户、用户名或密码不正确，或账户已被禁用');
        } else if (err.statusCode === 429 || err.code === 'RATE_LIMITED') {
          setErrorMessage('登录尝试次数过多，IP 或账户已被临时限流，请稍后再试');
        } else {
          setErrorMessage(err.message || '登录失败，请检查网络或配置');
        }
      } else {
        setErrorMessage('未知网络错误，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        padding: '12px',
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '340px',
          boxSizing: 'border-box',
        }}
      >
        <Card
          style={{
            width: '100%',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2)',
            borderRadius: 12,
            border: '1px solid #334155',
            background: '#ffffff',
            boxSizing: 'border-box',
          }}
          styles={{ body: { padding: '24px 16px' } }}
        >
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              background: '#0284c7',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
              color: '#ffffff',
              fontSize: 24,
            }}
          >
            <SafetyOutlined />
          </div>
          <Title level={3} style={{ margin: 0, color: '#0f172a', fontWeight: 600 }}>
            nb-search 云端管理台
          </Title>
          <Text type="secondary" style={{ fontSize: 13, marginTop: 4, display: 'block' }}>
            基于 sub2api 语义与 nb-search 合同的高性能统一控制台
          </Text>
        </div>

        {errorMessage && (
          <Alert
            message={errorMessage}
            type="error"
            showIcon
            style={{ marginBottom: 20 }}
            closable
            onClose={() => setErrorMessage(null)}
          />
        )}

        <Form
          layout="vertical"
          name="loginForm"
          initialValues={{ tenant: 'default' }}
          onFinish={onFinish}
          requiredMark={false}
        >
          <Form.Item
            label={<span style={{ fontWeight: 500, color: '#334155' }}>租户标识 (Tenant Slug)</span>}
            name="tenant"
            rules={[{ required: true, message: '请输入租户标识' }]}
          >
            <Input
              placeholder="例如 default"
              size="large"
              autoComplete="organization"
            />
          </Form.Item>

          <Form.Item
            label={<span style={{ fontWeight: 500, color: '#334155' }}>用户名 (Username)</span>}
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserOutlined style={{ color: '#94a3b8' }} />}
              placeholder="请输入用户名"
              size="large"
              autoComplete="username"
            />
          </Form.Item>

          <Form.Item
            label={<span style={{ fontWeight: 500, color: '#334155' }}>密码 (Password)</span>}
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
              placeholder="请输入密码"
              size="large"
              autoComplete="current-password"
            />
          </Form.Item>

          <div style={{ marginTop: 24 }}>
            <Button
              type="primary"
              htmlType="submit"
              size="large"
              block
              loading={submitting}
              style={{ fontWeight: 500 }}
            >
              登 录
            </Button>
          </div>
        </Form>

        <div style={{ marginTop: 20, textAlign: 'center' }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            安全凭据与高可用通道统一调度平台
          </Text>
        </div>
      </Card>
      </div>
    </div>
  );
}
