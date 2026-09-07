import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApartmentOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { api, ApiClientError } from '../services/client.js';
import type { GroupCapabilitiesDto, GroupDto, LaneDto } from '../types/api.js';
import { useAuth } from '../context/AuthContext.js';
import { ErrorRecovery } from '../components/ErrorRecovery.js';
import dayjs from 'dayjs';

const { Text } = Typography;

export function GroupsView() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Create Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm();

  // Edit Modal
  const [editOpen, setEditOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<GroupDto | null>(null);
  const [updating, setUpdating] = useState(false);
  const [editConflictError, setEditConflictError] = useState<unknown>(null);
  const [editForm] = Form.useForm();

  // Capabilities Drawer
  const [capDrawerOpen, setCapDrawerOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<GroupDto | null>(null);
  const [capabilities, setCapabilities] = useState<GroupCapabilitiesDto | null>(null);
  const [capError, setCapError] = useState<unknown>(null);
  const [lanesCatalog, setLanesCatalog] = useState<LaneDto[]>([]);
  const [capLoading, setCapLoading] = useState(false);
  const [savingCap, setSavingCap] = useState(false);
  const [capForm] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (isAdmin) {
        const res = await api.groups.list({ limit: 25 });
        setGroups(res.items);
        setNextCursor(res.next_cursor || null);
      } else {
        const res = await api.groups.available();
        setGroups(res);
        setNextCursor(null);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore || !isAdmin) return;
    setLoadingMore(true);
    try {
      const res = await api.groups.list({ limit: 25, cursor: nextCursor });
      setGroups((prev) => [...prev, ...res.items]);
      setNextCursor(res.next_cursor || null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载更多分组失败');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreate = async (values: {
    name: string;
    description?: string;
    is_exclusive?: boolean;
    daily_units_per_user?: number;
  }) => {
    setCreating(true);
    setError(null);
    try {
      await api.groups.create({
        name: values.name.trim(),
        description: values.description?.trim(),
        is_exclusive: values.is_exclusive,
        daily_units_per_user: values.daily_units_per_user ?? 0,
      });
      message.success(`分组 ${values.name} 创建成功`);
      setCreateOpen(false);
      createForm.resetFields();
      await loadData();
    } catch (err) {
      setError(err);
      if (err instanceof ApiClientError && err.code === 'ALREADY_EXISTS') {
        message.error('该分组名称已存在');
      } else {
        message.error(err instanceof Error ? err.message : '创建分组失败');
      }
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (group: GroupDto) => {
    setEditingGroup(group);
    setEditConflictError(null);
    editForm.setFieldsValue({
      name: group.name,
      description: group.description,
      status: group.status,
      is_exclusive: group.is_exclusive,
      daily_units_per_user: group.daily_units_per_user,
    });
    setEditOpen(true);
  };

  const handleReloadEditingGroup = async () => {
    if (!editingGroup) return;
    try {
      const fresh = await api.groups.get(editingGroup.id);
      setEditingGroup(fresh);
      editForm.setFieldsValue({
        name: fresh.name,
        description: fresh.description,
        status: fresh.status,
        is_exclusive: fresh.is_exclusive,
        daily_units_per_user: fresh.daily_units_per_user,
      });
      setEditConflictError(null);
      message.success('已拉取最新分组数据，表单已重新加载');
    } catch (err) {
      message.error('获取最新分组失败');
    }
  };

  const handleUpdate = async (values: {
    name?: string;
    description?: string;
    status?: 'active' | 'disabled';
    is_exclusive?: boolean;
    daily_units_per_user?: number;
  }) => {
    if (!editingGroup) return;
    setUpdating(true);
    setEditConflictError(null);
    try {
      await api.groups.patch(editingGroup.id, {
        expected_revision: editingGroup.revision,
        name: values.name?.trim(),
        description: values.description?.trim(),
        status: values.status,
        is_exclusive: values.is_exclusive,
        daily_units_per_user: values.daily_units_per_user,
      });
      message.success('分组配置已更新');
      setEditOpen(false);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError && (err.code === 'STALE_VERSION' || err.code === 'CSRF_REJECTED')) {
        setEditConflictError(err);
      } else {
        message.error(err instanceof Error ? err.message : '更新分组失败');
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleDelete = async (group: GroupDto) => {
    try {
      await api.groups.delete(group.id);
      message.success(`分组 ${group.name} 已软撤销`);
      await loadData();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '删除分组失败');
    }
  };

  // UI-01: Switching target immediately resets state, disables save if capabilities GET failed
  const openCapabilities = async (group: GroupDto) => {
    setSelectedGroup(group);
    setCapabilities(null);
    setCapError(null);
    capForm.resetFields();
    setCapDrawerOpen(true);
    setCapLoading(true);

    try {
      const [capRes, lanesRes] = await Promise.all([
        api.groups.getCapabilities(group.id),
        api.lanes.list().then((r) => r.items).catch(() => []),
      ]);
      setCapabilities(capRes);
      setLanesCatalog(lanesRes);
      capForm.setFieldsValue({
        default_search_lane: capRes.default_search_lane,
        default_fetch_pipeline: capRes.default_fetch_pipeline,
        lanes: capRes.lanes.map((l) => ({
          lane_id: l.lane_id,
          units_per_query: l.units_per_query,
        })),
      });
    } catch (err) {
      setCapabilities(null);
      setCapError(err);
    } finally {
      setCapLoading(false);
    }
  };

  const handleSaveCapabilities = async (values: {
    default_search_lane?: string | null;
    default_fetch_pipeline?: string | null;
    lanes?: Array<{ lane_id: string; units_per_query: number }>;
  }) => {
    if (!selectedGroup) return;
    // UI-01: Strictly require valid capabilities loaded for currently selected group ID
    if (!capabilities || capabilities.group_id !== selectedGroup.id) {
      message.error('未获取到当前分组的有效能力配置，禁止提交');
      return;
    }

    setSavingCap(true);
    try {
      // Must use capabilities.revision, not fallback to selectedGroup.revision
      await api.groups.putCapabilities(selectedGroup.id, {
        expected_revision: capabilities.revision,
        lanes: values.lanes || [],
        default_search_lane: values.default_search_lane || null,
        default_fetch_pipeline: values.default_fetch_pipeline || null,
        presets: capabilities.presets || {},
      });
      message.success('通道与路由能力设置保存成功');
      setCapDrawerOpen(false);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'STALE_VERSION') {
        message.error('版本冲突 (409 STALE_VERSION)：请重新加载最新通道配置');
      } else {
        message.error(err instanceof Error ? err.message : '通道能力更新失败');
      }
    } finally {
      setSavingCap(false);
    }
  };

  const columns: ColumnsType<GroupDto> = [
    {
      title: '分组名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record) => (
        <Space vertical size={2}>
          <Space size={6}>
            <Text strong>{name}</Text>
            {record.is_exclusive ? (
              <Tag color="warning" icon={<LockOutlined />}>
                专属组 (Exclusive)
              </Tag>
            ) : (
              <Tag color="blue" icon={<UnlockOutlined />}>
                公开组 (Public)
              </Tag>
            )}
          </Space>
          {record.description && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.description}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string, record) => {
        if (record.deleted_at) {
          return <Tag color="default">已撤销</Tag>;
        }
        return status === 'active' ? (
          <Tag color="success">正常启用</Tag>
        ) : (
          <Tag color="error">已停用</Tag>
        );
      },
    },
    {
      title: '每日每用户预算上限 (Daily Budget)',
      dataIndex: 'daily_units_per_user',
      key: 'daily_units_per_user',
      render: (units: number) =>
        units === 0 ? (
          <Tag color="cyan">不限额 (0 units)</Tag>
        ) : (
          <Text strong>{units.toLocaleString()} units / 日 / 人</Text>
        ),
    },
    {
      title: '版本号 (Revision)',
      dataIndex: 'revision',
      key: 'revision',
      render: (rev: number) => <Text code>v{rev}</Text>,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => {
        if (!isAdmin) {
          return <Tag color="geekblue">可用组</Tag>;
        }
        if (record.deleted_at) {
          return <Text type="secondary">不可恢复</Text>;
        }
        return (
          <Space size={8}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => openCapabilities(record)}
            >
              通道与路由能力
            </Button>
            <Popconfirm
              title="确定撤销此分组？"
              description="撤销为不可恢复软删除，已有 Key 仍保留不可再发起新任务。"
              onConfirm={() => handleDelete(record)}
              okText="软撤销"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 20, fontWeight: 600, color: '#0f172a' }}>
            分组与策略管理 (Groups)
          </h2>
          <Text type="secondary" style={{ fontSize: 13 }}>
            分组即权限集合；设定每用户每日执行预算，作为 API Key 消费的硬性安全边界
          </Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
            刷新
          </Button>
          {isAdmin && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                createForm.resetFields();
                createForm.setFieldsValue({
                  is_exclusive: false,
                  daily_units_per_user: 0,
                });
                setCreateOpen(true);
              }}
            >
              新建分组
            </Button>
          )}
        </Space>
      </div>

      <ErrorRecovery error={error} onRetry={loadData} compact />

      {/* Create Group Modal */}
      <Modal
        title="新建分组"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
      >
        <Form layout="vertical" form={createForm} onFinish={handleCreate}>
          <Form.Item
            label="分组名称"
            name="name"
            rules={[{ required: true, message: '请输入分组名称' }]}
          >
            <Input placeholder="例如：默认搜索组、研发高优先级组" />
          </Form.Item>

          <Form.Item label="描述说明 (可选)" name="description">
            <Input.TextArea rows={3} placeholder="描述此分组的应用场景或权限说明" />
          </Form.Item>

          <Form.Item
            label="设为专属组 (Exclusive Group)"
            name="is_exclusive"
            valuePropName="checked"
            extra="专属组需要管理员显式授权用户白名单；公开组对未受限用户默认直接开放"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label="单用户每日执行预算 (Daily Units Limit)"
            name="daily_units_per_user"
            extra="输入 0 代表不限额；不同 Key 共享用户在该组下的每日预算硬限额"
          >
            <InputNumber style={{ width: '100%' }} min={0} max={1_000_000_000} />
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setCreateOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={creating}>
                创建分组
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      {/* Edit Group Modal with UI-08 409 conflict handling */}
      <Modal
        title={`编辑分组: ${editingGroup?.name || ''}`}
        open={editOpen}
        onCancel={() => {
          setEditOpen(false);
          setEditConflictError(null);
        }}
        footer={null}
      >
        {editConflictError ? (
          <div style={{ marginBottom: 16 }}>
            <ErrorRecovery
              compact
              error={editConflictError}
              onRetry={handleReloadEditingGroup}
              onReset={() => {
                setEditOpen(false);
                setEditConflictError(null);
              }}
            />
          </div>
        ) : null}

        <Form layout="vertical" form={editForm} onFinish={handleUpdate}>
          <Form.Item
            label="分组名称"
            name="name"
            rules={[{ required: true, message: '请输入分组名称' }]}
          >
            <Input />
          </Form.Item>

          <Form.Item label="描述说明" name="description">
            <Input.TextArea rows={3} />
          </Form.Item>

          <Form.Item label="状态" name="status" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="active">正常启用 (Active)</Select.Option>
              <Select.Option value="disabled">停用 (Disabled)</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="专属组属性"
            name="is_exclusive"
            valuePropName="checked"
            extra="变为专属组后，未获显式白名单授权的用户将无法再签发或绑定此组 Key"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label="单用户每日执行预算 (Units)"
            name="daily_units_per_user"
            extra="0 代表不限额"
          >
            <InputNumber style={{ width: '100%' }} min={0} max={1_000_000_000} />
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setEditOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={updating}>
                保存变更
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      {/* Group Capabilities Drawer (UI-01 verified) */}
      <Drawer
        title={
          <Space>
            <ApartmentOutlined />
            <span>分组通道与路由能力: {selectedGroup?.name}</span>
          </Space>
        }
        size={560}
        open={capDrawerOpen}
        onClose={() => setCapDrawerOpen(false)}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setCapDrawerOpen(false)}>取消</Button>
              <Button
                type="primary"
                onClick={() => capForm.submit()}
                loading={savingCap}
                disabled={!capabilities || capabilities.group_id !== selectedGroup?.id}
              >
                保存通道能力
              </Button>
            </Space>
          </div>
        }
      >
        {capError ? (
          <div style={{ marginBottom: 20 }}>
            <ErrorRecovery
              compact
              error={capError}
              onRetry={() => selectedGroup && openCapabilities(selectedGroup)}
            />
            <Alert
              type="error"
              message="通道能力加载失败"
              description="由于无法安全获取当前分组的真实通道能力与版本快照，保存功能已被安全禁用。请点击重试以重新获取。"
            />
          </div>
        ) : (
          <Form
            layout="vertical"
            form={capForm}
            onFinish={handleSaveCapabilities}
            disabled={capLoading || !capabilities}
          >
            <Form.Item
              label="默认搜索通道 (Default Search Lane)"
              name="default_search_lane"
              extra="当搜索请求未指定具体通道时使用的默认通道"
            >
              <Select placeholder="选择默认搜索通道" allowClear>
                {lanesCatalog
                  .filter((l) => l.kind === 'search')
                  .map((l) => (
                    <Select.Option key={l.id} value={l.id}>
                      {l.id} ({l.latency}/{l.cost})
                    </Select.Option>
                  ))}
              </Select>
            </Form.Item>

            <Form.Item
              label="默认网页抓取管道 (Default Fetch Pipeline)"
              name="default_fetch_pipeline"
              extra="执行 /v1/fetch 时的默认处理管道"
            >
              <Select placeholder="选择默认 Fetch 通道" allowClear>
                {lanesCatalog
                  .filter((l) => l.kind === 'fetch')
                  .map((l) => (
                    <Select.Option key={l.id} value={l.id}>
                      {l.id} ({l.latency}/{l.cost})
                    </Select.Option>
                  ))}
              </Select>
            </Form.Item>

            <h4 style={{ margin: '20px 0 12px 0' }}>已授权通道列表 (Group Lanes)</h4>

            <Form.List name="lanes">
              {(fields, { add, remove }) => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {fields.map(({ key, name, ...restField }) => (
                    <Card
                      key={key}
                      size="small"
                      style={{ background: '#f8fafc' }}
                      extra={
                        <Button
                          size="small"
                          type="text"
                          danger
                          onClick={() => remove(name)}
                        >
                          移除
                        </Button>
                      }
                    >
                      <Space vertical style={{ width: '100%' }}>
                        <Form.Item
                          {...restField}
                          label="选择可用通道"
                          name={[name, 'lane_id']}
                          rules={[{ required: true, message: '请选择通道' }]}
                          style={{ marginBottom: 8 }}
                        >
                          <Select placeholder="选择通道">
                            {lanesCatalog.map((l) => (
                              <Select.Option key={l.id} value={l.id}>
                                {l.id} [{l.kind}]
                              </Select.Option>
                            ))}
                          </Select>
                        </Form.Item>

                        <Form.Item
                          {...restField}
                          label="单次请求消耗 Units (Units Per Query)"
                          name={[name, 'units_per_query']}
                          rules={[{ required: true, message: '请输入消耗数' }]}
                          style={{ marginBottom: 0 }}
                        >
                          <InputNumber min={1} max={1_000_000} style={{ width: '100%' }} />
                        </Form.Item>
                      </Space>
                    </Card>
                  ))}

                  <Button
                    type="dashed"
                    onClick={() => add({ units_per_query: 1 })}
                    block
                    icon={<PlusOutlined />}
                  >
                    添加通道映射
                  </Button>
                </div>
              )}
            </Form.List>
          </Form>
        )}
      </Drawer>

      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 8, overflow: 'hidden' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={groups}
          loading={loading}
          scroll={{ x: 800 }}
          pagination={false}
        />
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            已加载 {groups.length} 条记录
          </Text>
          {nextCursor && (
            <Button size="small" onClick={handleLoadMore} loading={loadingMore}>
              加载更多分组 (下一页)
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
