import React from 'react';
import { ConfigProvider, Card } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { appTheme } from '../theme/tokens.js';
import { ErrorRecovery } from '../components/ErrorRecovery.js';
import { ApiClientError } from '../services/client.js';

export function ErrorDemoView() {
  const staleError = new ApiClientError('STALE_VERSION', 409, 'Resource was modified; reload and retry.');
  const forbiddenError = new ApiClientError('GROUP_NOT_ALLOWED', 403, 'Group access is not allowed for this member.');

  return (
    <ConfigProvider theme={appTheme} locale={zhCN}>
      <div style={{ padding: 24, maxWidth: 900, margin: '0 auto', background: '#f8fafc', minHeight: '100vh' }}>
        <h2 style={{ marginBottom: 16 }}>错误恢复与并发冲突交互测试 (Error Recovery)</h2>
        <Card title="409 STALE_VERSION 并发冲突与预期版本防护 (Compact 模式)" style={{ marginBottom: 20 }}>
          <ErrorRecovery
            compact
            error={staleError}
            onRetry={() => alert('已重新拉取最新 Revision 并重置表单')}
            onReset={() => alert('已还原并放弃本次冲突修改')}
          />
        </Card>

        <Card title="403 GROUP_NOT_ALLOWED 权限边界与不可篡改恢复 (Result 模式)">
          <ErrorRecovery
            error={forbiddenError}
            onRetry={() => alert('已刷新权限状态')}
            onReset={() => alert('返回控制台首页')}
          />
        </Card>
      </div>
    </ConfigProvider>
  );
}
