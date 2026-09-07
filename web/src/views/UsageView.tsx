import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Modal,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DashboardOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileTextOutlined,
  ReloadOutlined,
  StopOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { api, ApiClientError } from '../services/client.js';
import type { JobDetailDto, UsageItemDto, UsageReportDto, UserQuotaDto } from '../types/api.js';
import { ErrorRecovery } from '../components/ErrorRecovery.js';
import { readFullJobArtifact, type ReadArtifactResult } from '../utils/job-reader.js';
import dayjs from 'dayjs';

const { Text } = Typography;

export function UsageView() {
  const [loading, setLoading] = useState(false);
  const [globalError, setGlobalError] = useState<unknown>(null);
  const [quotasError, setQuotasError] = useState<unknown>(null);
  const [usageError, setUsageError] = useState<unknown>(null);

  // Quotas & Usage Data
  const [quotas, setQuotas] = useState<UserQuotaDto[]>([]);
  const [report, setReport] = useState<UsageReportDto | null>(null);

  // Frozen time window for pagination to prevent window drifting
  const [frozenWindow, setFrozenWindow] = useState<{ from: string; to: string } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Job Details Drawer
  const [jobDrawerOpen, setJobDrawerOpen] = useState(false);
  const [activeJob, setActiveJob] = useState<JobDetailDto | null>(null);
  const [jobLoading, setJobLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Text Result Viewer Modal
  const [resultModalOpen, setResultModalOpen] = useState(false);
  const [artifactResult, setArtifactResult] = useState<ReadArtifactResult | null>(null);
  const [readingText, setReadingText] = useState(false);
  const [readingError, setReadingError] = useState<string | null>(null);

  const loadData = async (resetWindow = true) => {
    setLoading(true);
    setGlobalError(null);
    setQuotasError(null);
    setUsageError(null);

    let windowToUse = frozenWindow;
    if (resetWindow || !windowToUse) {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
      windowToUse = {
        from: thirtyDaysAgo.toISOString(),
        to: now.toISOString(),
      };
      setFrozenWindow(windowToUse);
      setNextCursor(null);
    }

    try {
      // UI-05: Strict separate error handling, never swallow 401/500 into 0 usage
      const [quotasRes, usageRes] = await Promise.allSettled([
        api.quotas.me(),
        api.usage.report({
          from: windowToUse.from,
          to: windowToUse.to,
          limit: 25,
        }),
      ]);

      if (quotasRes.status === 'fulfilled') {
        setQuotas(quotasRes.value.items);
      } else {
        setQuotasError(quotasRes.reason);
      }

      if (usageRes.status === 'fulfilled') {
        setReport(usageRes.value);
        setNextCursor(usageRes.value.next_cursor || null);
      } else {
        setUsageError(usageRes.reason);
        setReport(null);
        setNextCursor(null);
      }

      // If both failed with 401 or auth required, bubble to global error
      if (
        quotasRes.status === 'rejected' &&
        usageRes.status === 'rejected'
      ) {
        setGlobalError(usageRes.reason);
      }
    } catch (err) {
      setGlobalError(err);
      setReport(null);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMoreUsage = async () => {
    if (!nextCursor || loadingMore || !frozenWindow) return;
    setLoadingMore(true);
    try {
      const res = await api.usage.report({
        from: frozenWindow.from,
        to: frozenWindow.to,
        limit: 25,
        cursor: nextCursor,
      });
      setReport((prev) => {
        if (!prev) return res;
        return {
          ...prev,
          items: [...prev.items, ...res.items],
          next_cursor: res.next_cursor,
        };
      });
      setNextCursor(res.next_cursor || null);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载更多用量失败');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void loadData(true);
  }, []);

  const openJobDetail = async (jobId: string) => {
    setJobDrawerOpen(true);
    setJobLoading(true);
    try {
      const detail = await api.jobs.get(jobId);
      setActiveJob(detail);
    } catch (err) {
      if (err instanceof ApiClientError && err.statusCode === 404) {
        message.error('该任务已过期或无权访问 (404)');
      } else {
        message.error(err instanceof Error ? err.message : '获取任务详情失败');
      }
      setJobDrawerOpen(false);
    } finally {
      setJobLoading(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    setCancelling(true);
    try {
      await api.jobs.cancel(jobId);
      message.success('已发送取消请求');
      await openJobDetail(jobId);
      await loadData(false);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '取消失败');
    } finally {
      setCancelling(false);
    }
  };

  // Consume chunk pages, check byte lengths, and decode UTF-8 across boundaries.
  const handleViewResult = async (jobId: string) => {
    setResultModalOpen(true);
    setReadingText(true);
    setReadingError(null);
    setArtifactResult(null);

    try {
      const result = await readFullJobArtifact(jobId);
      setArtifactResult(result);
    } catch (err) {
      setReadingError(err instanceof Error ? err.message : '读取产物发生错误');
    } finally {
      setReadingText(false);
    }
  };

  const handleDownloadResult = () => {
    if (!artifactResult?.text || !activeJob) return;
    const blob = new Blob([artifactResult.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-${activeJob.job_id}-result.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const usageColumns: ColumnsType<UsageItemDto> = [
    {
      title: '任务 ID (Job ID)',
      dataIndex: 'job_id',
      key: 'job_id',
      render: (id: string, record) => (
        <Space vertical size={2}>
          <a
            onClick={() => openJobDetail(id)}
            style={{ fontFamily: 'monospace', fontWeight: 500 }}
          >
            {id.slice(0, 13)}...
          </a>
          <Text type="secondary" style={{ fontSize: 12 }}>
            请求: {record.request_id.slice(0, 8)}...
          </Text>
        </Space>
      ),
    },
    {
      title: '类型 / 模式',
      key: 'type',
      render: (_, record) => (
        <Space size={4}>
          <Tag color="blue">{record.kind}</Tag>
          <Tag>{record.delivery}</Tag>
        </Space>
      ),
    },
    {
      title: '执行状态',
      dataIndex: 'state',
      key: 'state',
      render: (state: string) => {
        if (state === 'succeeded') {
          return <Tag color="success" icon={<CheckCircleOutlined />}>执行成功</Tag>;
        }
        if (state === 'failed') {
          return <Tag color="error" icon={<CloseCircleOutlined />}>失败已记账</Tag>;
        }
        if (state === 'cancelled') {
          return <Tag color="default" icon={<StopOutlined />}>已取消</Tag>;
        }
        if (state === 'running') {
          return <Tag color="processing" icon={<SyncOutlined spin />}>执行中</Tag>;
        }
        return <Tag color="warning" icon={<ClockCircleOutlined />}>排队中</Tag>;
      },
    },
    {
      title: 'Units 结算明细',
      key: 'units',
      render: (_, record) => (
        <Space vertical size={2}>
          {record.charged_units > 0 && (
            <Text style={{ color: '#0f172a', fontWeight: 600 }}>
              已实扣: {record.charged_units} units
            </Text>
          )}
          {record.reserved_units > 0 && (
            <Text type="warning" style={{ fontSize: 12 }}>
              预留中: {record.reserved_units} units
            </Text>
          )}
          {record.released_units > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              已释放: {record.released_units} units
            </Text>
          )}
          <Text type="secondary" style={{ fontSize: 11 }}>
            原因: {record.settlement_reason || '--'}
          </Text>
        </Space>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => (
        <Button size="small" icon={<EyeOutlined />} onClick={() => openJobDetail(record.job_id)}>
          查看详情
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 20, fontWeight: 600, color: '#0f172a' }}>
            用量与任务状态 (Usage & Jobs)
          </h2>
          <Text type="secondary" style={{ fontSize: 13 }}>
            透明 Execution Units 计数（非美元计费），涵盖预留、实扣与释放；支持任务取消与只读纯文本产物提取
          </Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => loadData(true)} loading={loading}>
          刷新
        </Button>
      </div>

      <ErrorRecovery error={globalError} onRetry={() => loadData(true)} compact />

      {/* Quotas & Summary Statistics Cards */}
      {usageError ? (
        <Alert
          type="error"
          showIcon
          message="用量汇总加载失败"
          description={usageError instanceof Error ? usageError.message : '服务器不可用'}
          style={{ marginBottom: 20 }}
        />
      ) : (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} sm={8}>
            <Card style={{ borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <Statistic
                title="已扣除结算 (Charged Units)"
                value={report?.totals.charged ?? 0}
                precision={0}
                valueStyle={{ color: '#0f172a', fontWeight: 600 }}
                suffix="units"
              />
              <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                任务执行成功或 post-dispatch 失败所实际消耗的 Units
              </Text>
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card style={{ borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <Statistic
                title="在途预留中 (Reserved Units)"
                value={report?.totals.reserved ?? 0}
                precision={0}
                valueStyle={{ color: '#f59e0b', fontWeight: 600 }}
                suffix="units"
              />
              <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                正在执行或排队任务预先冻结的额度，结束后结算或释放
              </Text>
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card style={{ borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <Statistic
                title="已释放返还 (Released Units)"
                value={report?.totals.released ?? 0}
                precision={0}
                valueStyle={{ color: '#10b981', fontWeight: 600 }}
                suffix="units"
              />
              <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                派发前取消或失败等安全回滚并释放给用户的额度
              </Text>
            </Card>
          </Col>
        </Row>
      )}

      {/* Current Daily Quota Progress */}
      {quotasError ? (
        <Alert
          type="warning"
          showIcon
          message="分组日配额加载失败"
          description={quotasError instanceof Error ? quotasError.message : '暂时无法读取配额'}
          style={{ marginBottom: 24 }}
        />
      ) : quotas.length > 0 ? (
        <Card
          title={
            <Space>
              <DashboardOutlined />
              <span>今日分组执行配额使用进度 (UTC 当日)</span>
            </Space>
          }
          style={{ marginBottom: 24, borderRadius: 8 }}
          styles={{ body: { padding: '16px 20px' } }}
        >
          <Row gutter={[16, 16]}>
            {quotas.map((q) => (
              <Col xs={24} sm={12} md={8} key={q.group_id}>
                <div
                  style={{
                    background: '#f8fafc',
                    padding: '12px 16px',
                    borderRadius: 6,
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text strong>分组 {q.group_id.slice(0, 8)}...</Text>
                    <Tag color={q.daily_units_per_user === 0 ? 'blue' : 'geekblue'}>
                      {q.daily_units_per_user === 0 ? '不限额' : `上限 ${q.daily_units_per_user} units`}
                    </Tag>
                  </div>
                  <div style={{ fontSize: 13, color: '#475569' }}>
                    <div>已用量: <strong>{q.used_units} units</strong></div>
                    <div>预留中: <strong>{q.reserved_units} units</strong></div>
                    <div>
                      剩余可用: <strong>{q.remaining_units !== null ? `${q.remaining_units} units` : '无上限'}</strong>
                    </div>
                  </div>
                </div>
              </Col>
            ))}
          </Row>
        </Card>
      ) : null}

      {/* Usage Table */}
      <Card
        title="任务调用与计费明细 (Usage Ledger)"
        styles={{ body: { padding: 0 } }}
        style={{ borderRadius: 8, overflow: 'hidden' }}
      >
        <Table
          rowKey="job_id"
          columns={usageColumns}
          dataSource={report?.items || []}
          loading={loading}
          scroll={{ x: 800 }}
          pagination={false}
        />
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            已加载 {report?.items.length || 0} 条任务记录
          </Text>
          {nextCursor && (
            <Button size="small" onClick={handleLoadMoreUsage} loading={loadingMore}>
              加载更多任务 (下一页)
            </Button>
          )}
        </div>
      </Card>

      {/* Job Detail Drawer (UI-02 aligned) */}
      <Drawer
        title={
          <Space>
            <FileTextOutlined />
            <span>任务详细信息: {activeJob?.job_id?.slice(0, 12)}...</span>
          </Space>
        }
        size={540}
        open={jobDrawerOpen}
        onClose={() => setJobDrawerOpen(false)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button
              icon={<EyeOutlined />}
              disabled={!activeJob?.content_access}
              onClick={() => activeJob && handleViewResult(activeJob.job_id)}
            >
              安全查看纯文本产物
            </Button>
            <Space>
              {activeJob && ['queued', 'running'].includes(activeJob.state) && (
                <Popconfirm
                  title="确认取消任务？"
                  description="若尚未实际派发将释放配额，已进入外部供应商的调用将协同中止。"
                  onConfirm={() => handleCancelJob(activeJob.job_id)}
                  okText="取消任务"
                  okButtonProps={{ danger: true }}
                  cancelText="放弃"
                >
                  <Button danger loading={cancelling} icon={<StopOutlined />}>
                    取消任务
                  </Button>
                </Popconfirm>
              )}
              <Button onClick={() => setJobDrawerOpen(false)}>关闭</Button>
            </Space>
          </div>
        }
      >
        {activeJob ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="任务 ID (UUID)">
              <Text copyable style={{ fontFamily: 'monospace' }}>
                {activeJob.job_id}
              </Text>
            </Descriptions.Item>
            {activeJob.kind && (
              <Descriptions.Item label="任务类型">
                <Tag color="blue">{activeJob.kind}</Tag>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="当前状态">
              <Tag
                color={
                  activeJob.state === 'succeeded'
                    ? 'success'
                    : activeJob.state === 'failed'
                    ? 'error'
                    : activeJob.state === 'cancelled'
                    ? 'default'
                    : 'processing'
                }
              >
                {activeJob.state}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="取消状态 (Cancel Requested)">
              {activeJob.cancel_requested ? <Tag color="warning">已请求取消</Tag> : <Tag>未请求</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="产物访问权 (Content Access)">
              {activeJob.content_access ? (
                <Tag color="success">有权读取 (本人任务)</Tag>
              ) : (
                <Tag color="warning">仅元数据 (非 Owner 或已过期)</Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {dayjs(activeJob.created_at).format('YYYY-MM-DD HH:mm:ss')}
            </Descriptions.Item>
            <Descriptions.Item label="完成时间">
              {activeJob.completed_at ? dayjs(activeJob.completed_at).format('YYYY-MM-DD HH:mm:ss') : '--'}
            </Descriptions.Item>
            {activeJob.error && (
              <Descriptions.Item label="公开错误">
                <Alert
                  type="error"
                  message={activeJob.error.code}
                  description={activeJob.error.message}
                />
              </Descriptions.Item>
            )}
          </Descriptions>
        ) : (
          <div style={{ textAlign: 'center', padding: 40 }}>加载中...</div>
        )}
      </Drawer>

      {/* Text Result Viewer Modal (Strictly text only, never execute HTML/scripts) */}
      <Modal
        title="任务纯文本产物 (安全只读预览)"
        open={resultModalOpen}
        onCancel={() => setResultModalOpen(false)}
        width={720}
        footer={[
          <Button
            key="download"
            icon={<DownloadOutlined />}
            onClick={handleDownloadResult}
            disabled={!artifactResult?.text}
          >
            下载纯文本
          </Button>,
          <Button key="close" type="primary" onClick={() => setResultModalOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="纯文本安全沙箱"
          description={
            artifactResult?.artifactMeta ? (
              <span>
                产物大小: {artifactResult.totalBytes} 字节，分块数: {artifactResult.chunkCount}
              </span>
            ) : (
              '系统严格只解析与渲染纯文本格式产物，绝不执行任何 HTML、SVG 或嵌入脚本。'
            )
          }
        />
        <div
          style={{
            maxHeight: 400,
            overflowY: 'auto',
            background: '#0f172a',
            color: '#f8fafc',
            fontFamily: 'Consolas, Monaco, "Courier New", monospace',
            fontSize: 13,
            padding: 14,
            borderRadius: 6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {readingText
            ? '正在分页遍历所有产物分块并校验 SHA256...'
            : readingError
            ? `读取产物失败: ${readingError}`
            : artifactResult?.text || '任务无产物输出内容'}
        </div>
      </Modal>
    </div>
  );
}
