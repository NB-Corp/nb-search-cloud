import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ExclamationCircleOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { api, ApiClientError } from '../services/client.js';
import type { GroupDto, KeyDto, KeyIssueResult } from '../types/api.js';
import { useAuth } from '../context/AuthContext.js';
import { ErrorRecovery } from '../components/ErrorRecovery.js';
import dayjs from 'dayjs';

const { Text, Paragraph } = Typography;

export function KeysView() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [loading, setLoading] = useState(false);
  const [keys, setKeys] = useState<KeyDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [groupsNextCursor, setGroupsNextCursor] = useState<string | null>(null);
  const [loadingMoreGroups, setLoadingMoreGroups] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Issue modal
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState<KeyIssueResult | null>(null);
  const [createForm] = Form.useForm();

  // Edit modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<KeyDto | null>(null);
  const [updating, setUpdating] = useState(false);
  const [editConflictError, setEditConflictError] = useState<unknown>(null);
  const [editForm] = Form.useForm();

  const groupsNextCursorRef = useRef<string | null>(null);
  const loadingMoreGroupsRef = useRef(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [keysRes, groupsRes] = await Promise.all([
        api.keys.list({ limit: 25 }),
        isAdmin ? api.groups.list({ limit: 100 }) : api.groups.available().then((items) => ({ items, next_cursor: null })),
      ]);
      setKeys(keysRes.items);
      setNextCursor(keysRes.next_cursor || null);
      setGroups(groupsRes.items);
      setGroupsNextCursor(groupsRes.next_cursor || null);
      groupsNextCursorRef.current = groupsRes.next_cursor || null;
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMoreGroups = async () => {
    const cursor = groupsNextCursorRef.current;
    if (!cursor || loadingMoreGroupsRef.current || !isAdmin) return;
    loadingMoreGroupsRef.current = true;
    setLoadingMoreGroups(true);
    try {
      const res = await api.groups.list({ limit: 100, cursor });
      setGroups((prev) => [...prev, ...res.items]);
      setGroupsNextCursor(res.next_cursor || null);
      groupsNextCursorRef.current = res.next_cursor || null;
    } catch (err) {
      // Non-blocking in dropdown
    } finally {
      loadingMoreGroupsRef.current = false;
      setLoadingMoreGroups(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.keys.list({ limit: 25, cursor: nextCursor });
      setKeys((prev) => [...prev, ...res.items]);
      setNextCursor(res.next_cursor || null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载更多失败');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreate = async (values: {
    name: string;
    group_id: string;
    quota_units?: number;
    expires_at?: dayjs.Dayjs | null;
  }) => {
    setIssuing(true);
    setError(null);
    try {
      const payload = {
        name: values.name.trim(),
        group_id: values.group_id,
        quota_units: values.quota_units !== undefined ? values.quota_units : 0,
        expires_at: values.expires_at ? values.expires_at.toISOString() : null,
      };
      const res = await api.keys.create(payload);
      setIssuedSecret(res);
      setIssueModalOpen(false);
      createForm.resetFields();
      await loadData();
      message.success('API Key 签发成功，请立即保存明文 Key');
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'GROUP_NOT_ALLOWED') {
        message.error('无权绑定该分组，请选择可用公开组或联系管理员授权');
      } else {
        message.error(err instanceof Error ? err.message : '创建失败');
      }
      setError(err);
    } finally {
      setIssuing(false);
    }
  };

  const openEditModal = (key: KeyDto) => {
    setEditingKey(key);
    setEditConflictError(null);
    editForm.setFieldsValue({
      name: key.name,
      group_id: key.group_id,
      status: key.status,
      quota_units: key.quota_units,
      expires_at: key.expires_at ? dayjs(key.expires_at) : null,
    });
    setEditModalOpen(true);
  };

  const handleReloadEditingKey = async () => {
    if (!editingKey) return;
    try {
      const fresh = await api.keys.get(editingKey.id);
      setEditingKey(fresh);
      editForm.setFieldsValue({
        name: fresh.name,
        group_id: fresh.group_id,
        status: fresh.status,
        quota_units: fresh.quota_units,
        expires_at: fresh.expires_at ? dayjs(fresh.expires_at) : null,
      });
      setEditConflictError(null);
      message.success('已拉取最新密钥数据，表单已重新加载');
    } catch (err) {
      message.error('获取最新数据失败');
    }
  };

  const handleUpdate = async (values: {
    name?: string;
    group_id?: string;
    status?: 'active' | 'disabled';
    quota_units?: number;
    expires_at?: dayjs.Dayjs | null;
  }) => {
    if (!editingKey) return;
    setUpdating(true);
    setEditConflictError(null);
    try {
      const payload: Parameters<typeof api.keys.patch>[1] = {
        expected_revision: editingKey.revision,
        name: values.name?.trim(),
        group_id: values.group_id,
        status: values.status,
        quota_units: values.quota_units !== undefined ? values.quota_units : undefined,
        expires_at: values.expires_at ? values.expires_at.toISOString() : null,
      };
      await api.keys.patch(editingKey.id, payload);
      message.success('API Key 更新成功');
      setEditModalOpen(false);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError && (err.code === 'STALE_VERSION' || err.code === 'CSRF_REJECTED')) {
        setEditConflictError(err);
      } else {
        message.error(err instanceof Error ? err.message : '更新失败');
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleDelete = async (key: KeyDto) => {
    try {
      await api.keys.delete(key.id);
      message.success(`API Key ${key.name} 已永久撤销`);
      await loadData();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '撤销失败');
    }
  };

  const handleResetQuota = async (key: KeyDto) => {
    try {
      await api.keys.resetQuota(key.id, key.revision);
      message.success('Key 累计配额已重置（开启新统计 Epoch）');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'ACTIVE_RESERVATIONS') {
        message.error('重置失败：当前存在在途锁定配额 (ACTIVE_RESERVATIONS)，请稍后重试');
      } else {
        message.error(err instanceof Error ? err.message : '配额重置失败');
      }
      setError(err);
    }
  };

  const columns: ColumnsType<KeyDto> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record) => (
        <Space vertical size={2}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            前缀: <Text code>{record.prefix}...</Text>
          </Text>
        </Space>
      ),
    },
    {
      title: '绑定分组',
      dataIndex: 'group_id',
      key: 'group_id',
      render: (groupId: string) => {
        const g = groups.find((item) => item.id === groupId);
        return g ? (
          <Space size={4}>
            <span>{g.name}</span>
            {g.is_exclusive && <Tag color="warning">专属组</Tag>}
          </Space>
        ) : (
          <Text type="secondary">{groupId.slice(0, 8)}...</Text>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      render: (_, record) => {
        if (record.deleted_at) {
          return <Tag color="default">已撤销</Tag>;
        }
        if (record.status === 'disabled') {
          return <Tag color="error">已停用</Tag>;
        }
        if (record.expires_at && new Date(record.expires_at) < new Date()) {
          return <Tag color="orange">已过期</Tag>;
        }
        return <Tag color="success">正常 (Active)</Tag>;
      },
    },
    {
      title: '自主配额限制 (Units)',
      dataIndex: 'quota_units',
      key: 'quota_units',
      render: (units: number) => (units === 0 ? <Tag color="blue">不限额 (0)</Tag> : <Text>{units.toLocaleString()} units</Text>),
    },
    {
      title: '过期时间',
      dataIndex: 'expires_at',
      key: 'expires_at',
      render: (date: string | null) => (date ? dayjs(date).format('YYYY-MM-DD HH:mm') : <Tag>永不过期</Tag>),
    },
    {
      title: '最后活跃',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      render: (date: string | null) => (date ? dayjs(date).format('YYYY-MM-DD HH:mm') : <Text type="secondary">从未调用</Text>),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => {
        if (record.deleted_at) {
          return <Text type="secondary">不可恢复</Text>;
        }
        return (
          <Space size={8}>
            <Button size="small" onClick={() => openEditModal(record)}>
              编辑
            </Button>
            <Popconfirm
              title="确定重置累计额度？"
              description="将开启新 Epoch 且不影响在途预留与日预算。"
              onConfirm={() => handleResetQuota(record)}
              okText="重置"
              cancelText="取消"
            >
              <Button size="small" icon={<SyncOutlined />}>
                重置额度
              </Button>
            </Popconfirm>
            <Popconfirm
              title="确定撤销此 Key？"
              description="撤销为不可恢复软删除，撤销后服务鉴权将立即拒绝此 Key。"
              onConfirm={() => handleDelete(record)}
              okText="永久撤销"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button size="small" danger>
                撤销
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div
        className="mobile-header-stack"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}
      >
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 20, fontWeight: 600, color: '#0f172a' }}>
            API 密钥管理 (Keys)
          </h2>
          <Text type="secondary" style={{ fontSize: 13 }}>
            用户自主签发与维护凭据；配额为用户自我保护限额，实际消费受组日预算硬边界约束
          </Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              createForm.resetFields();
              createForm.setFieldsValue({ quota_units: 0 });
              setIssueModalOpen(true);
            }}
          >
            新建 API Key
          </Button>
        </Space>
      </div>

      <ErrorRecovery error={error} onRetry={loadData} compact />

      {/* One-time Key Display Modal */}
      {issuedSecret ? (
        <Modal
          title={
            <Space>
              <KeyOutlined style={{ color: '#10b981' }} />
              <span>API Key 已生成 (仅此一次显示)</span>
            </Space>
          }
          open={true}
          destroyOnClose={true}
          onOk={() => setIssuedSecret(null)}
          onCancel={() => setIssuedSecret(null)}
          footer={[
            <Button key="close" type="primary" onClick={() => setIssuedSecret(null)}>
              我已妥善保存，安全关闭
            </Button>,
          ]}
        >
          <Alert
            type="warning"
            showIcon
            icon={<ExclamationCircleOutlined />}
            style={{ marginBottom: 16 }}
            title="请立即复制并妥善保管此 Key"
            description="系统采用 SHA256 单向哈希存储，数据库不存任何明文，关闭后将再也无法找回。"
          />
          <div
            style={{
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              padding: '12px 14px',
              marginBottom: 16,
            }}
          >
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
              明文 API Key:
            </Text>
            <Paragraph
              copyable={{ text: issuedSecret.access_key }}
              style={{
                fontFamily: 'monospace',
                fontSize: 14,
                color: '#0284c7',
                wordBreak: 'break-all',
                margin: 0,
              }}
            >
              {issuedSecret.access_key}
            </Paragraph>
          </div>
          <div style={{ fontSize: 13, color: '#475569' }}>
            <div>Key 名称: <strong>{issuedSecret.key.name}</strong></div>
            <div>前缀: <code>{issuedSecret.key.prefix}...</code></div>
            <div>额度: {issuedSecret.key.quota_units === 0 ? '不限额 (0)' : `${issuedSecret.key.quota_units} units`}</div>
          </div>
        </Modal>
      ) : null}

      {/* Create Key Modal */}
      <Modal
        title="新建 API Key"
        open={issueModalOpen}
        onCancel={() => setIssueModalOpen(false)}
        footer={null}
      >
        <Form layout="vertical" form={createForm} onFinish={handleCreate}>
          <Form.Item
            label="Key 名称 / 用途标识"
            name="name"
            rules={[{ required: true, message: '请输入 Key 名称' }]}
          >
            <Input placeholder="例如：开发联调测试、CLI-local 等" />
          </Form.Item>

          <Form.Item
            label="绑定分组 (Group)"
            name="group_id"
            extra="Key 的能力严格等于分组所允许的通道集合；若要收窄权限请绑定更细粒度的分组"
            rules={[{ required: true, message: '请选择绑定的分组' }]}
          >
            <Select
              placeholder="选择可用分组"
              onPopupScroll={(e) => {
                const target = e.currentTarget;
                if (target.scrollTop + target.clientHeight >= target.scrollHeight - 20) {
                  void handleLoadMoreGroups();
                }
              }}
            >
              {groups.map((g) => (
                <Select.Option key={g.id} value={g.id}>
                  {g.name} {g.is_exclusive ? '(专属组)' : '(公开组)'}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="自主额度限额 (Quota Units)"
            name="quota_units"
            extra="输入 0 表示不限额；此额度仅作为用户自我限额，受组每日预算硬约束"
          >
            <InputNumber style={{ width: '100%' }} min={0} max={1_000_000_000} />
          </Form.Item>

          <Form.Item
            label="到期时间 (可选)"
            name="expires_at"
            extra="留空表示永不过期；支持自由设置未来时间"
          >
            <DatePicker showTime style={{ width: '100%' }} placeholder="选择过期日期与时间" />
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setIssueModalOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={issuing}>
                生成并签发
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      {/* Edit Key Modal with UI-08 conflict handling */}
      <Modal
        title={`编辑 API Key: ${editingKey?.name || ''}`}
        open={editModalOpen}
        onCancel={() => {
          setEditModalOpen(false);
          setEditConflictError(null);
        }}
        footer={null}
      >
        {editConflictError ? (
          <div style={{ marginBottom: 16 }}>
            <ErrorRecovery
              compact
              error={editConflictError}
              onRetry={handleReloadEditingKey}
              onReset={() => {
                setEditModalOpen(false);
                setEditConflictError(null);
              }}
            />
          </div>
        ) : null}

        <Form layout="vertical" form={editForm} onFinish={handleUpdate}>
          <Form.Item
            label="Key 名称"
            name="name"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input />
          </Form.Item>

          <Form.Item
            label="绑定分组"
            name="group_id"
            rules={[{ required: true, message: '请选择分组' }]}
          >
            <Select
              onPopupScroll={(e) => {
                const target = e.currentTarget;
                if (target.scrollTop + target.clientHeight >= target.scrollHeight - 20) {
                  void handleLoadMoreGroups();
                }
              }}
            >
              {groups.map((g) => (
                <Select.Option key={g.id} value={g.id}>
                  {g.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item label="状态" name="status">
            <Select>
              <Select.Option value="active">正常启用 (Active)</Select.Option>
              <Select.Option value="disabled">临时停用 (Disabled, 可恢复)</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="自主额度限额 (Quota Units)"
            name="quota_units"
            extra="0 为不限额；支持随时扩限或缩限"
          >
            <InputNumber style={{ width: '100%' }} min={0} max={1_000_000_000} />
          </Form.Item>

          <Form.Item
            label="到期时间"
            name="expires_at"
            extra="清空输入框代表永不过期"
          >
            <DatePicker showTime style={{ width: '100%' }} allowClear />
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setEditModalOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={updating}>
                保存变更
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 8, overflow: 'hidden' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={keys}
          loading={loading}
          scroll={{ x: 850 }}
          pagination={false}
        />
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            已加载 {keys.length} 条记录
          </Text>
          {nextCursor && (
            <Button size="small" onClick={handleLoadMore} loading={loadingMore}>
              加载更多密钥 (下一页)
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
