import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api, ApiClientError } from '../services/client.js';
import type { LaneDto, ProviderCatalogDto, ProviderDto } from '../types/api.js';
import { ErrorRecovery } from '../components/ErrorRecovery.js';
import dayjs from 'dayjs';

const { Text } = Typography;

export function ProvidersView() {
  const [activeTab, setActiveTab] = useState<'providers' | 'lanes'>('providers');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Providers state
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [nextProvCursor, setNextProvCursor] = useState<string | null>(null);
  const [loadingMoreProv, setLoadingMoreProv] = useState(false);

  const [, setCatalog] = useState<ProviderCatalogDto | null>(null);
  const [createProvOpen, setCreateProvOpen] = useState(false);
  const [creatingProv, setCreatingProv] = useState(false);
  const [createProvForm] = Form.useForm();
  const selectedProviderId = Form.useWatch('provider_id', createProvForm);

  // Edit Provider state
  const [editProvOpen, setEditProvOpen] = useState(false);
  const [editingProv, setEditingProv] = useState<ProviderDto | null>(null);
  const [updatingProv, setUpdatingProv] = useState(false);
  const [provConflictError, setProvConflictError] = useState<unknown>(null);
  const [editProvForm] = Form.useForm();
  const editEndpointMode = Form.useWatch('endpoint_mode', editProvForm);

  // Lanes state
  const [lanes, setLanes] = useState<LaneDto[]>([]);
  const [createLaneOpen, setCreateLaneOpen] = useState(false);
  const [creatingLane, setCreatingLane] = useState(false);
  const [createLaneForm] = Form.useForm();

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [provRes, catRes, lanesRes] = await Promise.all([
        api.providers.list({ limit: 25 }),
        api.providers.catalog().catch(() => null),
        api.lanes.list().catch(() => ({ items: [] })),
      ]);
      setProviders(provRes.items);
      setNextProvCursor(provRes.next_cursor || null);
      setCatalog(catRes);
      setLanes(lanesRes.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMoreProviders = async () => {
    if (!nextProvCursor || loadingMoreProv) return;
    setLoadingMoreProv(true);
    try {
      const res = await api.providers.list({ limit: 25, cursor: nextProvCursor });
      setProviders((prev) => [...prev, ...res.items]);
      setNextProvCursor(res.next_cursor || null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载更多供应商失败');
    } finally {
      setLoadingMoreProv(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleCreateProvider = async (values: {
    name: string;
    provider_id: 'exa' | 'grok-multi-agent';
    base_url?: string;
    secret?: string;
    model?: string;
    api_mode?: string;
  }) => {
    setCreatingProv(true);
    setError(null);
    try {
      const options: Record<string, unknown> = {};
      if (values.model) options.model = values.model;
      if (values.api_mode) options.api_mode = values.api_mode;

      await api.providers.create({
        name: values.name.trim(),
        provider_id: values.provider_id,
        base_url: values.base_url?.trim() || undefined,
        options: Object.keys(options).length > 0 ? options : undefined,
        secret: values.secret?.trim() || undefined,
      });

      message.success(`供应商 ${values.name} 配置成功`);
      setCreateProvOpen(false);
      createProvForm.resetFields();
      await loadAll();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '创建供应商失败');
    } finally {
      setCreatingProv(false);
    }
  };

  const openEditProvider = (prov: ProviderDto) => {
    setEditingProv(prov);
    setProvConflictError(null);
    editProvForm.setFieldsValue({
      name: prov.name,
      status: prov.status,
      endpoint_mode: prov.base_url ? 'custom' : 'default',
      base_url: prov.base_url || (prov.provider_id === 'exa' ? 'https://api.exa.ai' : ''),
      secret: '',
      clear_secret: false,
    });
    setEditProvOpen(true);
  };

  const handleReloadEditingProv = async () => {
    if (!editingProv) return;
    try {
      const fresh = await api.providers.get(editingProv.id);
      setEditingProv(fresh);
      editProvForm.setFieldsValue({
        name: fresh.name,
        status: fresh.status,
        endpoint_mode: fresh.base_url ? 'custom' : 'default',
        base_url: fresh.base_url || (fresh.provider_id === 'exa' ? 'https://api.exa.ai' : ''),
        secret: '',
        clear_secret: false,
      });
      setProvConflictError(null);
      message.success('已拉取最新供应商配置，表单已重新加载');
    } catch (err) {
      message.error('获取最新供应商数据失败');
    }
  };

  const handleUpdateProvider = async (values: {
    name?: string;
    status?: 'active' | 'disabled';
    endpoint_mode?: 'default' | 'custom' | 'preserve';
    base_url?: string;
    secret?: string;
    clear_secret?: boolean;
  }) => {
    if (!editingProv) return;
    setUpdatingProv(true);
    setProvConflictError(null);
    try {
      // Determine final base_url according to provider catalog rules
      let finalBaseUrl: string | undefined = undefined;
      if (values.endpoint_mode === 'default') {
        if (editingProv.provider_id === 'exa') {
          finalBaseUrl = 'https://api.exa.ai';
        }
      } else if (values.endpoint_mode === 'custom') {
        finalBaseUrl = values.base_url?.trim() || undefined;
      }

      // UI-09: secret and clear_secret are mutually exclusive; clear_secret takes precedence if checked
      const hasSecret = Boolean(values.secret && values.secret.trim());
      const isClear = Boolean(values.clear_secret);

      await api.providers.patch(editingProv.id, {
        expected_revision: editingProv.revision,
        name: values.name?.trim(),
        status: values.status,
        base_url: finalBaseUrl,
        secret: !isClear && hasSecret ? values.secret!.trim() : undefined,
        clear_secret: isClear ? true : undefined,
      });

      message.success('供应商配置已安全更新');
      setEditProvOpen(false);
      await loadAll();
    } catch (err) {
      if (err instanceof ApiClientError && (err.code === 'STALE_VERSION' || err.code === 'CSRF_REJECTED')) {
        setProvConflictError(err);
      } else {
        message.error(err instanceof Error ? err.message : '更新失败');
      }
    } finally {
      setUpdatingProv(false);
    }
  };

  const handleDeleteProvider = async (prov: ProviderDto) => {
    try {
      await api.providers.delete(prov.id);
      message.success(`供应商 ${prov.name} 已停用`);
      await loadAll();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleCreateLane = async (values: {
    id: string;
    provider_id: string;
    operation_id: 'search' | 'contents' | 'research';
    latency: 'fast' | 'medium' | 'slow';
    cost: 'free' | 'cheap' | 'expensive';
  }) => {
    setCreatingLane(true);
    setError(null);
    try {
      await api.lanes.create({
        id: values.id.trim(),
        provider_id: values.provider_id,
        operation_id: values.operation_id,
        latency: values.latency,
        cost: values.cost,
      });
      message.success(`通道 ${values.id} 注册成功`);
      setCreateLaneOpen(false);
      createLaneForm.resetFields();
      await loadAll();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '创建通道失败');
    } finally {
      setCreatingLane(false);
    }
  };

  const handleToggleLaneStatus = async (lane: LaneDto) => {
    try {
      const nextStatus = lane.status === 'active' ? 'disabled' : 'active';
      await api.lanes.patch(lane.id, { status: nextStatus });
      message.success(`通道 ${lane.id} 状态已变更为 ${nextStatus}`);
      await loadAll();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '切换失败');
    }
  };

  const providerColumns: ColumnsType<ProviderDto> = [
    {
      title: '供应商名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record) => (
        <Space vertical size={2}>
          <Text strong>{name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            驱动标识: <Text code>{record.provider_id}</Text>
          </Text>
        </Space>
      ),
    },
    {
      title: '凭证状态',
      key: 'credential',
      render: (_, record) =>
        record.credential_configured ? (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            凭据已就绪
          </Tag>
        ) : (
          <Tag color="warning" icon={<CloseCircleOutlined />}>
            未配置凭据
          </Tag>
        ),
    },
    {
      title: '服务状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) =>
        status === 'active' ? (
          <Tag color="success">正常启用</Tag>
        ) : (
          <Tag color="error">已停用</Tag>
        ),
    },
    {
      title: '服务端点 (Base URL)',
      dataIndex: 'base_url',
      key: 'base_url',
      render: (url: string | null) => (url ? <Text code>{url}</Text> : <Text type="secondary">官方默认地址</Text>),
    },
    {
      title: '版本号',
      dataIndex: 'revision',
      key: 'revision',
      render: (rev: number) => <Text code>v{rev}</Text>,
    },
    {
      title: '凭证最后更新',
      dataIndex: 'credential_updated_at',
      key: 'credential_updated_at',
      render: (date: string | null) => (date ? dayjs(date).format('YYYY-MM-DD HH:mm') : <Text type="secondary">--</Text>),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => (
        <Space size={8}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditProvider(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确定停用此供应商？"
            description="停用后关联的所有执行通道将不可调度。"
            onConfirm={() => handleDeleteProvider(record)}
            okText="停用"
            cancelText="取消"
          >
            <Button size="small" danger>
              停用
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const laneColumns: ColumnsType<LaneDto> = [
    {
      title: '通道 ID (Lane ID)',
      dataIndex: 'id',
      key: 'id',
      render: (id: string, record) => (
        <Space vertical size={2}>
          <Text strong style={{ fontFamily: 'monospace' }}>
            {id}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            操作: <Tag color="blue">{record.operation_id}</Tag> 类型: <Tag>{record.kind}</Tag>
          </Text>
        </Space>
      ),
    },
    {
      title: '所属供应商',
      dataIndex: 'provider_id',
      key: 'provider_id',
      render: (provId: string) => {
        const p = providers.find((item) => item.id === provId);
        return p ? (
          <Space size={4}>
            <span>{p.name}</span>
            <Tag>{p.provider_id}</Tag>
          </Space>
        ) : (
          <Text type="secondary">{provId.slice(0, 8)}...</Text>
        );
      },
    },
    {
      title: '通道状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) =>
        status === 'active' ? (
          <Tag color="success">启用</Tag>
        ) : (
          <Tag color="error">已停用</Tag>
        ),
    },
    {
      title: '时延预估',
      dataIndex: 'latency',
      key: 'latency',
      render: (lat: string) => {
        const color = lat === 'fast' ? 'green' : lat === 'medium' ? 'orange' : 'red';
        return <Tag color={color}>{lat}</Tag>;
      },
    },
    {
      title: '成本级别',
      dataIndex: 'cost',
      key: 'cost',
      render: (cost: string) => {
        const color = cost === 'free' ? 'cyan' : cost === 'cheap' ? 'blue' : 'purple';
        return <Tag color={color}>{cost}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => (
        <Button
          size="small"
          onClick={() => handleToggleLaneStatus(record)}
        >
          {record.status === 'active' ? '停用通道' : '启用通道'}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 20, fontWeight: 600, color: '#0f172a' }}>
            供应商与执行通道 (Providers & Lanes)
          </h2>
          <Text type="secondary" style={{ fontSize: 13 }}>
            集中管理真实上游 API 凭证与搜索执行通道；API Key 秘钥 write-only 严密保密，绝不回显
          </Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadAll} loading={loading}>
            刷新
          </Button>
          {activeTab === 'providers' ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                createProvForm.resetFields();
                createProvForm.setFieldsValue({ provider_id: 'exa' });
                setCreateProvOpen(true);
              }}
            >
              配置新供应商
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                createLaneForm.resetFields();
                createLaneForm.setFieldsValue({
                  latency: 'medium',
                  cost: 'cheap',
                });
                setCreateLaneOpen(true);
              }}
            >
              注册新通道
            </Button>
          )}
        </Space>
      </div>

      <ErrorRecovery error={error} onRetry={loadAll} compact />

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'providers' | 'lanes')}
        items={[
          {
            key: 'providers',
            label: (
              <span>
                <ApiOutlined /> 供应商凭证管理 ({providers.length})
              </span>
            ),
            children: (
              <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 8, overflow: 'hidden' }}>
                <Table
                  rowKey="id"
                  columns={providerColumns}
                  dataSource={providers}
                  loading={loading}
                  scroll={{ x: 800 }}
                  pagination={false}
                />
                <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    已加载 {providers.length} 条供应商记录
                  </Text>
                  {nextProvCursor && (
                    <Button size="small" onClick={handleLoadMoreProviders} loading={loadingMoreProv}>
                      加载更多供应商 (下一页)
                    </Button>
                  )}
                </div>
              </Card>
            ),
          },
          {
            key: 'lanes',
            label: (
              <span>
                <ThunderboltOutlined /> 执行通道 (Lanes) ({lanes.length})
              </span>
            ),
            children: (
              <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 8, overflow: 'hidden' }}>
                <Table
                  rowKey="id"
                  columns={laneColumns}
                  dataSource={lanes}
                  loading={loading}
                  scroll={{ x: 800 }}
                  pagination={false}
                />
              </Card>
            ),
          },
        ]}
      />

      {/* Create Provider Modal (UI-09: Grok requires base_url) */}
      <Modal
        title="配置新搜索 / 抓取供应商"
        open={createProvOpen}
        onCancel={() => setCreateProvOpen(false)}
        footer={null}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="凭证仅供写入与加密存储"
          description="输入的 API Secret 将在服务端通过 AES-256-GCM 立即单向加密持久化，前端与 API 任何路径均绝不回显。"
        />
        <Form layout="vertical" form={createProvForm} onFinish={handleCreateProvider}>
          <Form.Item
            label="供应商显示名称"
            name="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="例如：Exa 官方引擎、Grok 主通道" />
          </Form.Item>

          <Form.Item label="驱动类型 (Provider ID)" name="provider_id" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="exa">Exa (Neural Web Search & Contents)</Select.Option>
              <Select.Option value="grok-multi-agent">Grok Multi-Agent (Research & Reasoning)</Select.Option>
            </Select>
          </Form.Item>

          {selectedProviderId === 'grok-multi-agent' ? (
            <Form.Item
              label="服务端点 (Base URL) - 必填"
              name="base_url"
              rules={[
                { required: true, message: 'Grok 引擎无官方默认 Base URL，必须显式指定' },
                { pattern: /^https:\/\//, message: '必须使用安全 HTTPS 协议地址' },
              ]}
              extra="Grok 驱动无默认 endpoint，必须提供 HTTPS 根端点"
            >
              <Input placeholder="例如：https://api.x.ai" />
            </Form.Item>
          ) : (
            <Form.Item
              label="自定义 Base URL (可选)"
              name="base_url"
              extra="留空则使用 SDK 官方默认地址 (https://api.exa.ai)"
            >
              <Input placeholder="留空使用 https://api.exa.ai" />
            </Form.Item>
          )}

          <Form.Item
            label="API 访问密钥 (Secret / API Key)"
            name="secret"
            extra="直接粘贴上游 API Key；明文仅在保存时临时加密传输，永不入库明文"
          >
            <Input.Password placeholder="输入上游 API 凭证" />
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setCreateProvOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={creatingProv}>
                保存并加密存储
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      {/* Edit Provider Modal (UI-08 conflict handling & UI-09 preserve vs default) */}
      <Modal
        title={`更新供应商配置: ${editingProv?.name || ''}`}
        open={editProvOpen}
        onCancel={() => {
          setEditProvOpen(false);
          setProvConflictError(null);
        }}
        footer={null}
      >
        {provConflictError ? (
          <div style={{ marginBottom: 16 }}>
            <ErrorRecovery
              compact
              error={provConflictError}
              onRetry={handleReloadEditingProv}
              onReset={() => {
                setEditProvOpen(false);
                setProvConflictError(null);
              }}
            />
          </div>
        ) : null}

        <Form layout="vertical" form={editProvForm} onFinish={handleUpdateProvider}>
          <Form.Item
            label="供应商名称"
            name="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input />
          </Form.Item>

          <Form.Item label="服务状态" name="status" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="active">正常启用 (Active)</Select.Option>
              <Select.Option value="disabled">停用 (Disabled)</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item label="服务端点 (Endpoint) 设置" name="endpoint_mode">
            <Radio.Group>
              <Radio value="preserve">保留现有配置不变</Radio>
              {editingProv?.provider_id === 'exa' && <Radio value="default">恢复官方默认地址</Radio>}
              <Radio value="custom">指定自定义地址</Radio>
            </Radio.Group>
          </Form.Item>

          {editEndpointMode === 'custom' && (
            <Form.Item
              label="自定义 Base URL (HTTPS)"
              name="base_url"
              rules={[
                { required: true, message: '请输入自定义 Base URL' },
                { pattern: /^https:\/\//, message: '必须使用 HTTPS 协议' },
              ]}
            >
              <Input placeholder="输入 HTTPS 地址" />
            </Form.Item>
          )}

          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: 12,
              marginBottom: 16,
            }}
          >
            <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
              秘钥凭据管理 (Write-Only Preserve / Replace / Clear):
            </Text>
            <Form.Item
              label="更新 API Key 秘钥 (留空则保留现有凭证不变)"
              name="secret"
              style={{ marginBottom: 8 }}
            >
              <Input.Password placeholder="留空代表保留 (Preserve) 现有已存加密凭证" />
            </Form.Item>

            <Form.Item
              name="clear_secret"
              valuePropName="checked"
              style={{ marginBottom: 0 }}
            >
              <Checkbox>清除现有加密凭据 (Clear Secret)</Checkbox>
            </Form.Item>
          </div>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setEditProvOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={updatingProv}>
                保存配置
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      {/* Create Lane Modal */}
      <Modal
        title="注册新执行通道 (Lane)"
        open={createLaneOpen}
        onCancel={() => setCreateLaneOpen(false)}
        footer={null}
      >
        <Form layout="vertical" form={createLaneForm} onFinish={handleCreateLane}>
          <Form.Item
            label="通道标识 (Lane ID，字母数字及 ._:-)"
            name="id"
            rules={[
              { required: true, message: '请输入通道 ID' },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, message: '格式不合规' },
            ]}
          >
            <Input placeholder="例如：exa-fast-search, grok-research" />
          </Form.Item>

          <Form.Item
            label="关联供应商"
            name="provider_id"
            rules={[{ required: true, message: '请选择供应商' }]}
          >
            <Select placeholder="选择关联的供应商">
              {providers.map((p) => (
                <Select.Option key={p.id} value={p.id}>
                  {p.name} [{p.provider_id}] {p.credential_configured ? '✓已配凭据' : '✗未配凭据'}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="操作能力 (Operation ID)"
            name="operation_id"
            rules={[{ required: true, message: '请选择操作能力' }]}
          >
            <Select placeholder="选择操作类型">
              <Select.Option value="search">search (网络搜索查询)</Select.Option>
              <Select.Option value="contents">contents (网页内容与抽取)</Select.Option>
              <Select.Option value="research">research (深度推理研究)</Select.Option>
            </Select>
          </Form.Item>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="时延等级" name="latency" rules={[{ required: true }]}>
                <Select>
                  <Select.Option value="fast">fast (低时延)</Select.Option>
                  <Select.Option value="medium">medium (中等)</Select.Option>
                  <Select.Option value="slow">slow (长任务)</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="成本等级" name="cost" rules={[{ required: true }]}>
                <Select>
                  <Select.Option value="free">free</Select.Option>
                  <Select.Option value="cheap">cheap</Select.Option>
                  <Select.Option value="expensive">expensive</Select.Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setCreateLaneOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={creatingLane}>
                注册通道
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
