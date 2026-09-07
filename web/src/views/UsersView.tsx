import React, { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
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
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api, ApiClientError } from '../services/client.js';
import type { GroupDto, UserDto } from '../types/api.js';
import { ErrorRecovery } from '../components/ErrorRecovery.js';
import dayjs from 'dayjs';

const { Text } = Typography;

export function UsersView() {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [error, setError] = useState<unknown>(null);

  // Create Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm();

  // Edit Modal
  const [editOpen, setEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserDto | null>(null);
  const [updating, setUpdating] = useState(false);
  const [editForm] = Form.useForm();

  // Allowed Groups Modal
  const [groupsModalOpen, setGroupsModalOpen] = useState(false);
  const [managingUser, setManagingUser] = useState<UserDto | null>(null);
  const [savingGroups, setSavingGroups] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);

  // Password Reset Modal
  const [pwdModalOpen, setPwdModalOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserDto | null>(null);
  const [resettingPwd, setResettingPwd] = useState(false);
  const [pwdForm] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, groupsRes] = await Promise.all([
        api.users.list({ limit: 25 }),
        api.groups.list({ limit: 100 }),
      ]);
      setUsers(usersRes.items);
      setNextCursor(usersRes.next_cursor || null);
      setGroups(groupsRes.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.users.list({ limit: 25, cursor: nextCursor });
      setUsers((prev) => [...prev, ...res.items]);
      setNextCursor(res.next_cursor || null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载更多用户失败');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCreate = async (values: {
    username: string;
    display_name: string;
    password: string;
    role: 'admin' | 'user';
    restrict_public_groups: boolean;
    allowed_group_ids?: string[];
  }) => {
    setCreating(true);
    setError(null);
    try {
      await api.users.create({
        username: values.username.trim().toLowerCase(),
        display_name: values.display_name.trim(),
        password: values.password,
        role: values.role,
        restrict_public_groups: values.restrict_public_groups,
        allowed_group_ids: values.allowed_group_ids,
      });
      message.success(`用户 ${values.username} 创建成功`);
      setCreateOpen(false);
      createForm.resetFields();
      await loadData();
    } catch (err) {
      setError(err);
      if (err instanceof ApiClientError && err.code === 'ALREADY_EXISTS') {
        message.error('该用户名已被占用');
      } else {
        message.error(err instanceof Error ? err.message : '创建失败');
      }
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (user: UserDto) => {
    setEditingUser(user);
    editForm.setFieldsValue({
      display_name: user.display_name,
      role: user.role,
      status: user.status,
      restrict_public_groups: user.restrict_public_groups,
    });
    setEditOpen(true);
  };

  const handleUpdate = async (values: {
    display_name?: string;
    role?: 'admin' | 'user';
    status?: 'active' | 'disabled';
    restrict_public_groups?: boolean;
  }) => {
    if (!editingUser) return;
    setUpdating(true);
    setError(null);
    try {
      await api.users.patch(editingUser.id, values);
      message.success('用户资料已更新');
      setEditOpen(false);
      await loadData();
    } catch (err) {
      setError(err);
      if (err instanceof ApiClientError && err.code === 'LAST_ADMIN') {
        message.error('无法停用或降级租户内最后一名活跃管理员');
      } else {
        message.error(err instanceof Error ? err.message : '更新失败');
      }
    } finally {
      setUpdating(false);
    }
  };

  const openGroupsModal = (user: UserDto) => {
    setManagingUser(user);
    setSelectedGroups(user.allowed_group_ids || []);
    setGroupsModalOpen(true);
  };

  const handleSaveGroups = async () => {
    if (!managingUser) return;
    setSavingGroups(true);
    setError(null);
    try {
      await api.users.replaceGroups(managingUser.id, selectedGroups);
      message.success('用户可用分组授权已更新');
      setGroupsModalOpen(false);
      await loadData();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingGroups(false);
    }
  };

  const openPasswordModal = (user: UserDto) => {
    setPwdUser(user);
    pwdForm.resetFields();
    setPwdModalOpen(true);
  };

  const handleResetPassword = async (values: { password: string }) => {
    if (!pwdUser) return;
    setResettingPwd(true);
    setError(null);
    try {
      const res = await api.users.resetPassword(pwdUser.id, values.password);
      message.success(`密码已重置，已强制撤销该用户的所有活跃会话 (${res.sessions_revoked ? '已注销' : '完成'})`);
      setPwdModalOpen(false);
      pwdForm.resetFields();
    } catch (err) {
      setError(err);
      message.error(err instanceof Error ? err.message : '重置密码失败');
    } finally {
      setResettingPwd(false);
    }
  };

  const columns: ColumnsType<UserDto> = [
    {
      title: '用户名 (账号)',
      dataIndex: 'username',
      key: 'username',
      render: (username: string, record) => (
        <Space vertical size={2}>
          <Text strong>{username}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            显示名: {record.display_name}
          </Text>
        </Space>
      ),
    },
    {
      title: '角色权限',
      dataIndex: 'role',
      key: 'role',
      render: (role: string) =>
        role === 'admin' ? (
          <Tag color="purple" icon={<SafetyCertificateOutlined />}>
            管理员 (Admin)
          </Tag>
        ) : (
          <Tag color="cyan" icon={<UserOutlined />}>
            普通成员 (Member)
          </Tag>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) =>
        status === 'active' ? (
          <Tag color="success">正常启用</Tag>
        ) : (
          <Tag color="error">已禁用 (Disabled)</Tag>
        ),
    },
    {
      title: '公开组策略',
      dataIndex: 'restrict_public_groups',
      key: 'restrict_public_groups',
      render: (restrict: boolean) =>
        restrict ? (
          <Tag color="volcano">受限白名单模式</Tag>
        ) : (
          <Tag color="blue">自由公开组访问</Tag>
        ),
    },
    {
      title: '明确授权组数',
      dataIndex: 'allowed_group_ids',
      key: 'allowed_group_ids',
      render: (ids: string[]) => (
        <Tag color="geekblue">{ids?.length || 0} 个白名单组</Tag>
      ),
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
      render: (_, record) => (
        <Space size={8}>
          <Button size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button size="small" icon={<TeamOutlined />} onClick={() => openGroupsModal(record)}>
            分组权限
          </Button>
          <Button size="small" icon={<LockOutlined />} onClick={() => openPasswordModal(record)}>
            重置密码
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 20, fontWeight: 600, color: '#0f172a' }}>
            用户与账号管理 (Users)
          </h2>
          <Text type="secondary" style={{ fontSize: 13 }}>
            维护租户内成员账号、管理员权限边界与分组访问许可（仅管理员可见）
          </Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              createForm.resetFields();
              createForm.setFieldsValue({
                role: 'user',
                restrict_public_groups: false,
              });
              setCreateOpen(true);
            }}
          >
            添加新用户
          </Button>
        </Space>
      </div>

      <ErrorRecovery error={error} onRetry={loadData} compact />

      {/* Create User Modal */}
      <Modal
        title="添加新用户"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
      >
        <Form layout="vertical" form={createForm} onFinish={handleCreate}>
          <Form.Item
            label="用户名 (ASCII小写字母、数字与 ._-)"
            name="username"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[a-z0-9._-]+$/, message: '仅支持小写英文、数字与 ._-' },
            ]}
          >
            <Input placeholder="例如：alice, dev_01" />
          </Form.Item>

          <Form.Item
            label="显示名 (Display Name)"
            name="display_name"
            rules={[{ required: true, message: '请输入显示名' }]}
          >
            <Input placeholder="例如：Alice Zhang" />
          </Form.Item>

          <Form.Item
            label="初始登录密码 (至少 12 位)"
            name="password"
            rules={[
              { required: true, message: '请输入初始密码' },
              { min: 12, message: '密码长度至少为 12 位字符' },
            ]}
          >
            <Input.Password placeholder="输入安全的强密码" />
          </Form.Item>

          <Form.Item label="角色" name="role" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="user">普通成员 (User) - 自主管理 Key 与可用组</Select.Option>
              <Select.Option value="admin">系统管理员 (Admin) - 管理全部用户、分组与凭据</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="公开组限制模式 (Restrict Public Groups)"
            name="restrict_public_groups"
            valuePropName="checked"
            extra="启用后该用户即使对公开组也必须显式授权方可访问；默认关闭（自由使用公开组）"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label="初始授权分组 (可选)"
            name="allowed_group_ids"
            extra="可直接赋予特定公开组或专属组白名单"
          >
            <Select mode="multiple" placeholder="选择授权分组" allowClear>
              {groups.map((g) => (
                <Select.Option key={g.id} value={g.id}>
                  {g.name} {g.is_exclusive ? '(专属组)' : '(公开组)'}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setCreateOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={creating}>
                创建用户
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        title={`编辑用户资料: ${editingUser?.username || ''}`}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        footer={null}
      >
        <Form layout="vertical" form={editForm} onFinish={handleUpdate}>
          <Form.Item
            label="显示名"
            name="display_name"
            rules={[{ required: true, message: '请输入显示名' }]}
          >
            <Input />
          </Form.Item>

          <Form.Item label="角色权限" name="role" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="user">普通成员 (User)</Select.Option>
              <Select.Option value="admin">系统管理员 (Admin)</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item label="账号状态" name="status" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="active">正常启用 (Active)</Select.Option>
              <Select.Option value="disabled">禁用账号 (Disabled - 将立即强制注销其活跃会话)</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            label="受限公开组模式"
            name="restrict_public_groups"
            valuePropName="checked"
            extra="开启时只允许该用户绑定其白名单列表内的组"
          >
            <Switch />
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setEditOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit" loading={updating}>
                保存
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      {/* Allowed Groups Membership Modal */}
      <Modal
        title={`配置分组授权: ${managingUser?.username || ''}`}
        open={groupsModalOpen}
        onCancel={() => setGroupsModalOpen(false)}
        onOk={handleSaveGroups}
        confirmLoading={savingGroups}
        okText="保存授权"
      >
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            勾选该用户有权访问的分组。专属组必须在此授权；若开启了公开组限制模式，公开组也在此统一控制。
          </Text>
        </div>
        <Select
          mode="multiple"
          style={{ width: '100%' }}
          placeholder="请选择授权的分组"
          value={selectedGroups}
          onChange={setSelectedGroups}
          allowClear
        >
          {groups.map((g) => (
            <Select.Option key={g.id} value={g.id}>
              {g.name} {g.is_exclusive ? '(专属组)' : '(公开组)'}
            </Select.Option>
          ))}
        </Select>
      </Modal>

      {/* Reset Password Modal */}
      <Modal
        title={`重置登录密码: ${pwdUser?.username || ''}`}
        open={pwdModalOpen}
        onCancel={() => setPwdModalOpen(false)}
        footer={null}
      >
        <Form layout="vertical" form={pwdForm} onFinish={handleResetPassword}>
          <Form.Item
            label="新密码 (至少 12 位)"
            name="password"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 12, message: '新密码至少 12 位字符' },
            ]}
          >
            <Input.Password placeholder="输入新密码" />
          </Form.Item>

          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <Space>
              <Button onClick={() => setPwdModalOpen(false)}>取消</Button>
              <Button type="primary" danger htmlType="submit" loading={resettingPwd}>
                确认重置
              </Button>
            </Space>
          </div>
        </Form>
      </Modal>

      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 8, overflow: 'hidden' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={users}
          loading={loading}
          scroll={{ x: 800 }}
          pagination={false}
        />
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            已加载 {users.length} 条用户记录
          </Text>
          {nextCursor && (
            <Button size="small" onClick={handleLoadMore} loading={loadingMore}>
              加载更多用户 (下一页)
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
