import React, { useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  Dropdown,
  Layout,
  Menu,
  Result,
  Space,
  Tag,
  Typography,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  ApiOutlined,
  AppstoreOutlined,
  BarsOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  KeyOutlined,
  LogoutOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../context/AuthContext.js';
import { KeysView } from '../views/KeysView.js';
import { GroupsView } from '../views/GroupsView.js';
import { ProvidersView } from '../views/ProvidersView.js';
import { UsersView } from '../views/UsersView.js';
import { UsageView } from '../views/UsageView.js';
import { AuditView } from '../views/AuditView.js';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export type NavKey = 'keys' | 'groups' | 'providers' | 'users' | 'usage' | 'audit';

export function AppLayout() {
  const { session, user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  const urlParams = new URLSearchParams(window.location.search);
  const rawNav = (urlParams.get('tab') as NavKey) || 'keys';
  // UI-07: Strictly guard against admin tabs for member users
  const adminOnlyTabs: NavKey[] = ['providers', 'users', 'audit'];
  const isDenied = !isAdmin && adminOnlyTabs.includes(rawNav);
  const safeInitialNav: NavKey = isDenied ? 'keys' : rawNav;

  const [currentNav, setCurrentNav] = useState<NavKey>(safeInitialNav);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  // Define navigation items filtered by role
  const menuItems: MenuProps['items'] = [
    {
      key: 'keys',
      icon: <KeyOutlined />,
      label: 'API 密钥 (Keys)',
    },
    {
      key: 'groups',
      icon: <AppstoreOutlined />,
      label: '分组与策略 (Groups)',
    },
    ...(isAdmin
      ? [
          {
            key: 'providers',
            icon: <ApiOutlined />,
            label: '供应商与通道',
          },
          {
            key: 'users',
            icon: <TeamOutlined />,
            label: '用户管理 (Users)',
          },
        ]
      : []),
    {
      key: 'usage',
      icon: <FileSearchOutlined />,
      label: '用量与任务 (Usage)',
    },
    ...(isAdmin
      ? [
          {
            key: 'audit',
            icon: <HistoryOutlined />,
            label: '审计日志 (Audit)',
          },
        ]
      : []),
  ];

  const handleMenuClick: MenuProps['onClick'] = (e) => {
    const target = e.key as NavKey;
    if (!isAdmin && adminOnlyTabs.includes(target)) {
      setCurrentNav('keys');
    } else {
      setCurrentNav(target);
    }
    setMobileDrawerOpen(false);
  };

  const userMenuItems: MenuProps['items'] = [
    {
      key: 'user-info',
      disabled: true,
      label: (
        <div style={{ padding: '4px 0' }}>
          <Text strong style={{ display: 'block' }}>{user?.display_name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>@{user?.username}</Text>
        </div>
      ),
    },
    {
      type: 'divider',
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      danger: true,
      label: '退出登录',
      onClick: () => logout(),
    },
  ];

  // UI-07: Double check role authorization before rendering view content to ensure ZERO admin API requests are triggered by member deep links
  const renderContent = () => {
    if (!isAdmin && adminOnlyTabs.includes(currentNav)) {
      return (
        <Result
          status="403"
          title="访问权限不足 (403)"
          subTitle="当前页面为系统管理专区，普通成员账号无权查看与发起请求。"
          extra={
            <Button type="primary" onClick={() => setCurrentNav('keys')}>
              返回 API 密钥管理
            </Button>
          }
        />
      );
    }

    switch (currentNav) {
      case 'keys':
        return <KeysView />;
      case 'groups':
        return <GroupsView />;
      case 'providers':
        return <ProvidersView />;
      case 'users':
        return <UsersView />;
      case 'usage':
        return <UsageView />;
      case 'audit':
        return <AuditView />;
      default:
        return <KeysView />;
    }
  };

  return (
    <Layout style={{ minHeight: '100vh', background: '#f8fafc' }}>
      {/* Desktop Sider */}
      <Sider
        width={220}
        breakpoint="lg"
        collapsedWidth="0"
        onBreakpoint={(broken) => {
          if (broken) setCollapsed(true);
        }}
        trigger={null}
        collapsible
        collapsed={collapsed}
        style={{
          background: '#0f172a',
          boxShadow: '2px 0 8px 0 rgba(0,0,0,0.1)',
        }}
      >
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            background: '#0b1120',
            borderBottom: '1px solid #1e293b',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: '#0284c7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 10,
              color: '#ffffff',
            }}
          >
            <SearchOutlined />
          </div>
          <Text strong style={{ color: '#ffffff', fontSize: 15, letterSpacing: 0.5 }}>
            nb-search 云端
          </Text>
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[currentNav]}
          onClick={handleMenuClick}
          items={menuItems}
          style={{ background: 'transparent', marginTop: 12 }}
        />
      </Sider>

      {/* Mobile Drawer Navigation */}
      <Drawer
        placement="left"
        onClose={() => setMobileDrawerOpen(false)}
        open={mobileDrawerOpen}
        styles={{ body: { padding: 0, background: '#0f172a' } }}
        size={240}
      >
        <div
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            background: '#0b1120',
            borderBottom: '1px solid #1e293b',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: '#0284c7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginRight: 10,
              color: '#ffffff',
            }}
          >
            <SearchOutlined />
          </div>
          <Text strong style={{ color: '#ffffff', fontSize: 15 }}>
            nb-search 控制台
          </Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[currentNav]}
          onClick={handleMenuClick}
          items={menuItems}
          style={{ background: 'transparent', marginTop: 12 }}
        />
      </Drawer>

      <Layout style={{ background: '#f8fafc' }}>
        {/* Top Header Bar */}
        <Header
          style={{
            background: '#ffffff',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 20px',
            height: 56,
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <Space size={12}>
            <Button
              className="mobile-menu-btn"
              type="text"
              icon={<BarsOutlined />}
              onClick={() => setMobileDrawerOpen(true)}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text strong style={{ fontSize: 15, color: '#0f172a' }}>
                {(menuItems?.find((i) => i && 'key' in i && i.key === currentNav) as any)?.label || '控制台'}
              </Text>
              <Tag color="default" style={{ margin: 0, fontSize: 11, background: '#f1f5f9' }}>
                租户: {session?.tenant.slug || 'default'}
              </Tag>
            </div>
          </Space>

          <Space size={16}>
            <Tag
              className="hide-on-mobile"
              icon={<Badge status="success" style={{ marginRight: 4 }} />}
              color="blue"
              style={{ margin: 0, alignItems: 'center' }}
            >
              在线会话正常
            </Tag>

            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Space
                style={{
                  cursor: 'pointer',
                  padding: '4px 6px',
                  borderRadius: 6,
                  transition: 'background 0.2s',
                }}
              >
                <Avatar
                  style={{
                    backgroundColor: isAdmin ? '#7c3aed' : '#0284c7',
                    verticalAlign: 'middle',
                  }}
                  size="small"
                  icon={<UserOutlined />}
                />
                <Text className="hide-on-mobile" style={{ fontSize: 13, fontWeight: 500 }}>
                  {user?.display_name || user?.username}
                </Text>
                {isAdmin ? (
                  <Tag color="purple" style={{ margin: 0 }}>管理员</Tag>
                ) : (
                  <Tag color="cyan" style={{ margin: 0 }}>成员</Tag>
                )}
              </Space>
            </Dropdown>
          </Space>
        </Header>

        {/* Main Work Surface */}
        <Content style={{ padding: '24px 20px', maxWidth: 1280, width: '100%', margin: '0 auto' }}>
          {renderContent()}
        </Content>
      </Layout>
    </Layout>
  );
}
