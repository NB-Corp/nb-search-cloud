import React from 'react';
import { Alert, Button, Result, Space } from 'antd';
import { ReloadOutlined, RollbackOutlined, SyncOutlined, LoginOutlined } from '@ant-design/icons';
import { ApiClientError } from '../services/client.js';
import { useAuth } from '../context/AuthContext.js';

interface ErrorRecoveryProps {
  error: unknown;
  onRetry?: () => void;
  onReset?: () => void;
  compact?: boolean;
}

export function ErrorRecovery({ error, onRetry, onReset, compact }: ErrorRecoveryProps) {
  const { refreshSession, logout } = useAuth();
  if (!error) return null;

  const isStale = error instanceof ApiClientError && error.code === 'STALE_VERSION';
  const isConflict = error instanceof ApiClientError && error.statusCode === 409;
  const isCsrf = error instanceof ApiClientError && error.code === 'CSRF_REJECTED';
  const isForbidden = error instanceof ApiClientError && error.statusCode === 403 && !isCsrf;
  const isAuth = error instanceof ApiClientError && (error.statusCode === 401 || error.code === 'AUTH_REQUIRED');

  let title = '操作未完成';
  let message = error instanceof Error ? error.message : '发生了未知错误，请重试';
  let recoveryTip = '建议刷新最新数据后再进行操作。对于不幂等的非安全写入操作，系统不会盲目自动重试。';

  if (isStale || (isConflict && (error as ApiClientError).code === 'STALE_VERSION')) {
    title = '数据版本冲突 (409 STALE_VERSION)';
    message = '当前记录已被其他管理员或并发操作修改，当前提交的版本已失效。';
    recoveryTip = '为防止意外覆盖他人更新，系统未自动覆盖。请点击“放弃旧输入并加载最新”获取新版本后再重新提交。';
  } else if (isCsrf) {
    title = '安全验证已过期 (CSRF_REJECTED)';
    message = '您的会话安全令牌可能已在其他页面或窗口轮换更新，当前操作已被拦截。';
    recoveryTip = '请点击“刷新安全令牌”，确认表单内容无误后手动重新提交。系统不会自动重放不安全的写入请求。';
  } else if (isForbidden) {
    title = '权限不足或分组受限 (403)';
    message = error instanceof ApiClientError ? error.message : '无权执行该操作或该分组访问已被限制。';
    recoveryTip = '请确认您的角色是否具备管理员权限，或您当前绑定的分组是否已被授权。';
  } else if (isAuth) {
    title = '登录会话已过期 (401)';
    message = '您的登录凭据或会话已超时失效，旧敏感数据已被安全清理。';
    recoveryTip = '请重新登录，登录后将自动建立全新安全会话。';
  }

  const renderActionButtons = (size: 'small' | 'middle') => (
    <Space size={8}>
      {isAuth ? (
        <Button size={size} type="primary" icon={<LoginOutlined />} onClick={() => logout()}>
          前往重新登录
        </Button>
      ) : isCsrf ? (
        <Button
          size={size}
          type="primary"
          icon={<SyncOutlined />}
          onClick={async () => {
            await refreshSession();
            if (onRetry) onRetry();
          }}
        >
          刷新安全令牌并重新核对
        </Button>
      ) : (
        <>
          {onRetry && (
            <Button size={size} type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
              {isStale ? '放弃旧输入并加载最新' : '重新加载最新数据'}
            </Button>
          )}
          {onReset && (
            <Button size={size} icon={<RollbackOutlined />} onClick={onReset}>
              放弃变更
            </Button>
          )}
        </>
      )}
    </Space>
  );

  if (compact) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 16 }}
        title={title}
        description={
          <Space vertical size={6} style={{ width: '100%', marginTop: 4 }}>
            <div>{message}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>{recoveryTip}</div>
            <div style={{ marginTop: 6 }}>
              {renderActionButtons('small')}
            </div>
          </Space>
        }
      />
    );
  }

  return (
    <Result
      status={isForbidden ? '403' : isStale || isCsrf ? 'warning' : 'error'}
      title={title}
      subTitle={
        <div
          style={{
            maxWidth: 500,
            margin: '0 auto',
            textAlign: 'left',
            background: '#ffffff',
            padding: 16,
            borderRadius: 8,
            border: '1px solid #e2e8f0',
          }}
        >
          <p style={{ marginBottom: 8, color: '#0f172a', fontWeight: 500 }}>{message}</p>
          <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>{recoveryTip}</p>
        </div>
      }
      extra={renderActionButtons('middle')}
    />
  );
}
