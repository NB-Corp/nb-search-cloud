import React from 'react';
import { ConfigProvider, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { appTheme } from './theme/tokens.js';
import { AuthProvider, useAuth } from './context/AuthContext.js';
import { LoginView } from './views/LoginView.js';
import { AppLayout } from './components/AppLayout.js';

function MainRouter() {
  const { session, loading } = useAuth();
  const urlParams = new URLSearchParams(window.location.search);
  const showLogin = urlParams.get('view') === 'login';

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f8fafc',
        }}
      >
        <Spin size="large" description="正在加载控制台会话..." />
      </div>
    );
  }

  if (!session || showLogin) {
    return <LoginView />;
  }

  return <AppLayout />;
}

export function App() {
  return (
    <ConfigProvider theme={appTheme} locale={zhCN}>
      <AuthProvider>
        <MainRouter />
      </AuthProvider>
    </ConfigProvider>
  );
}
export default App;
