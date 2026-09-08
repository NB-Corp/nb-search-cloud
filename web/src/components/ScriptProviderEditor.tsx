import React, { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select, message } from 'antd';
import { api } from '../services/client.js';
import type { ProviderDto } from '../types/api.js';
export function ScriptProviderEditor({ provider, onSaved }: { provider?: ProviderDto; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState<{ id: string; label: string }[]>([]);
  const [revision, setRevision] = useState<number>();
  const [form] = Form.useForm();
  async function show() {
    try {
      const catalog = await api.providers.catalog(); setChannels(catalog.script_channels ?? []);
      const current = provider ? await api.providers.get(provider.id) : undefined; setRevision(current?.revision);
      form.setFieldsValue({ name: current?.name ?? '', channel_id: current?.options?.channel_id, params: JSON.stringify(current?.options?.params ?? {}, null, 2), secret: '' }); setOpen(true);
    } catch { message.error('读取脚本通道失败'); }
  }
  async function save(values: { name: string; channel_id: string; params: string; secret?: string }) {
    setBusy(true);
    try {
      const input = { name: values.name, options: { channel_id: values.channel_id, params: JSON.parse(values.params) }, ...(values.secret ? { secret: values.secret } : {}) };
      if (provider) await api.providers.patch(provider.id, { ...input, expected_revision: revision! });
      else await api.providers.create({ ...input, provider_id: 'script' });
      setOpen(false); form.resetFields(); await onSaved(); message.success('脚本供应商已保存');
    } catch { message.error('保存失败，请检查参数或重新打开最新配置'); }
    finally { setBusy(false); }
  }
  return <>
    <Button size={provider ? 'small' : 'middle'} onClick={() => void show()}>{provider ? '脚本参数' : '配置脚本供应商'}</Button>
    <Modal title="部署者注册的脚本通道" open={open} onCancel={() => { setOpen(false); form.resetFields(); }} footer={null} destroyOnHidden>
      <Alert type="warning" showIcon message="脚本与 worker 同权限，不是沙箱" description="模块由部署者安装；此处只能选择已注册通道，不能上传代码或指定服务器路径。" />
      {!channels.length && <Alert type="info" message="尚无已注册通道，请部署者配置 CLOUD_SCRIPT_CHANNELS 后重启服务。" />}
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="显示名称" name="name" rules={[{ required: true, max: 100 }]}><Input /></Form.Item>
        <Form.Item label="已注册脚本" name="channel_id" rules={[{ required: true }]}><Select options={channels.map(c => ({ value: c.id, label: `${c.label} (${c.id})` }))} /></Form.Item>
        <Form.Item label="JSON 参数" name="params" rules={[{ validator: async (_, value) => { try { const parsed = JSON.parse(value); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw Error(); } catch { throw Error('请输入 JSON 对象'); } } }]}><Input.TextArea rows={5} /></Form.Item>
        <Form.Item label="可选密钥（留空保留）" name="secret"><Input.Password autoComplete="new-password" /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} disabled={!channels.length}>保存脚本供应商</Button>
      </Form>
    </Modal>
  </>;
}
