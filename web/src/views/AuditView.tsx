import React, { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Input,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { api } from '../services/client.js';
import type { AuditEventDto } from '../types/api.js';
import { ErrorRecovery } from '../components/ErrorRecovery.js';
import dayjs from 'dayjs';

const { Text } = Typography;

export function AuditView() {
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [filterText, setFilterText] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.audit.list({ limit: 25 });
      setEvents(res.items);
      setNextCursor(res.next_cursor || null);
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
      const res = await api.audit.list({ limit: 25, cursor: nextCursor });
      setEvents((prev) => [...prev, ...res.items]);
      setNextCursor(res.next_cursor || null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filteredEvents = events.filter((e) => {
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return (
      e.action.toLowerCase().includes(q) ||
      e.target_type.toLowerCase().includes(q) ||
      (e.target_id && e.target_id.toLowerCase().includes(q)) ||
      e.request_id.toLowerCase().includes(q)
    );
  });

  const columns: ColumnsType<AuditEventDto> = [
    {
      title: '操作动作 (Action)',
      dataIndex: 'action',
      key: 'action',
      render: (action: string) => {
        let color = 'blue';
        if (action.includes('delete')) color = 'red';
        else if (action.includes('create')) color = 'green';
        else if (action.includes('update') || action.includes('replace')) color = 'orange';
        return <Tag color={color}>{action}</Tag>;
      },
    },
    {
      title: '目标实体',
      key: 'target',
      render: (_, record) => (
        <Space vertical size={2}>
          <Text strong>{record.target_type}</Text>
          {record.target_id && (
            <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
              {record.target_id.slice(0, 16)}...
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '操作人 / 系统',
      dataIndex: 'actor_user_id',
      key: 'actor_user_id',
      render: (id: string | null) =>
        id ? (
          <Text style={{ fontFamily: 'monospace' }}>{id.slice(0, 8)}...</Text>
        ) : (
          <Tag color="purple">CLI / 初始化</Tag>
        ),
    },
    {
      title: '请求 ID (Request ID)',
      dataIndex: 'request_id',
      key: 'request_id',
      render: (reqId: string) => (
        <Text type="secondary" style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {reqId.slice(0, 12)}...
        </Text>
      ),
    },
    {
      title: '非敏感元数据 (Metadata)',
      dataIndex: 'metadata',
      key: 'metadata',
      render: (meta: Record<string, unknown>) => (
        <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {JSON.stringify(meta)}
        </Text>
      ),
    },
    {
      title: '发生时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm:ss'),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 20, fontWeight: 600, color: '#0f172a' }}>
            审计日志 (Audit Log)
          </h2>
          <Text type="secondary" style={{ fontSize: 13 }}>
            记录全部关键身份、凭据、分组及供应商变动审计事件；绝不记录任何敏感密钥明文或密码
          </Text>
        </div>
        <Space>
          <Input
            placeholder="搜索操作或实体"
            prefix={<SearchOutlined />}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            style={{ width: 220 }}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <ErrorRecovery error={error} onRetry={loadData} compact />

      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 8, overflow: 'hidden' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filteredEvents}
          loading={loading}
          scroll={{ x: 800 }}
          pagination={false}
        />
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            已加载 {events.length} 条审计记录
          </Text>
          {nextCursor && (
            <Button size="small" onClick={handleLoadMore} loading={loadingMore}>
              加载更多审计记录 (下一页)
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
