import React, { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space, Switch, Typography, message } from 'antd';
import { api } from '../services/client.js';
import type { ProviderDto, ProviderPoolKey } from '../types/api.js';
export function ProviderKeyPoolEditor({ provider, onSaved }: { provider: ProviderDto; onSaved: () => Promise<void> }) {
  const [current, setCurrent] = useState<ProviderDto>();
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<{ keys: ProviderPoolKey[] }>();
  async function open() {
    try {
      const fresh = await api.providers.get(provider.id); setCurrent(fresh);
      form.setFieldsValue({ keys: fresh.key_pool ?? [] });
    } catch { message.error('读取上游 Key 池失败，请刷新后重试'); }
  }
  async function save(values: { keys: ProviderPoolKey[] }) {
    if (!current) return; setBusy(true);
    try {
      await api.providers.patch(current.id, { expected_revision: current.revision, key_pool: values.keys.map(key => ({ ...key, secret: key.secret || undefined })) });
      setCurrent(undefined); form.resetFields(); await onSaved(); message.success('上游 Key 池已更新');
    } catch { message.error('保存失败；配置可能已变更，请关闭后重新打开'); }
    finally { setBusy(false); }
  }
  return <>
    <Button size="small" onClick={() => void open()}>上游 Key 池</Button>
    <Modal title={`上游 Key 池：${provider.name}`} open={!!current} onCancel={() => { setCurrent(undefined); form.resetFields(); }} footer={null} destroyOnHidden>
      <Alert type="info" showIcon message="按启用项轮询，不自动重试或切换计费请求" description="保存生成新配置；已排队任务仍使用旧快照。已有密钥留空即保留，明文不会回显。空列表会清除凭据。" />
      {current?.credential_configured && !current.key_pool?.length && <Alert style={{ marginTop: 12 }} type="warning" message="当前使用旧单密钥。保存 Key 池将替换它，请填入要使用的密钥。" />}
      <Typography.Paragraph>当前配置累计选择次数：{current?.key_pool_selections ?? '0'}（非计费次数）</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.List name="keys">{(fields, { add, remove }) => <>
          {fields.map(field => <div key={field.key} style={{ borderBottom: '1px solid #ddd', marginBottom: 12 }}>
            <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
            <Form.Item label="名称" name={[field.name, 'label']} rules={[{ required: true, max: 100 }]}><Input autoComplete="off" /></Form.Item>
            <Form.Item label="密钥（已有项留空保留）" name={[field.name, 'secret']} rules={[{ validator: async (_, value) => { if (!form.getFieldValue(['keys', field.name, 'id']) && !value) throw new Error('新项需要密钥'); } }]}><Input.Password autoComplete="new-password" /></Form.Item>
            <Space><Form.Item label="启用" name={[field.name, 'enabled']} valuePropName="checked"><Switch /></Form.Item><Button danger onClick={() => remove(field.name)}>移除</Button></Space>
          </div>)}
          <Button disabled={fields.length >= 32} onClick={() => add({ label: `Key ${fields.length + 1}`, enabled: true })}>添加上游 Key</Button>
        </>}</Form.List>
        <Button type="primary" htmlType="submit" loading={busy} style={{ margin: 12 }}>保存 Key 池</Button>
      </Form>
    </Modal>
  </>;
}
