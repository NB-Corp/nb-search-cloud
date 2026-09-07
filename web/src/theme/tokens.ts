import type { ThemeConfig } from 'antd';

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#0284c7', // Professional ocean blue, calm & focused
    colorInfo: '#0284c7',
    colorSuccess: '#10b981', // Emerald green
    colorWarning: '#f59e0b', // Amber
    colorError: '#ef4444', // Red
    colorBgBase: '#ffffff',
    colorBgContainer: '#ffffff',
    colorBgLayout: '#f8fafc',
    colorTextBase: '#0f172a',
    colorTextSecondary: '#475569',
    colorBorder: '#e2e8f0',
    colorBorderSecondary: '#f1f5f9',
    borderRadius: 6,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    fontSize: 14,
  },
  components: {
    Layout: {
      headerBg: '#0f172a', // Deep slate top header
      siderBg: '#1e293b',
      headerHeight: 56,
      headerPadding: '0 20px',
    },
    Menu: {
      darkItemBg: '#1e293b',
      darkItemSelectedBg: '#0284c7',
      darkItemHoverBg: '#334155',
      darkItemColor: '#cbd5e1',
      darkItemSelectedColor: '#ffffff',
      itemBorderRadius: 6,
      itemMarginInline: 8,
    },
    Table: {
      headerBg: '#f8fafc',
      headerColor: '#334155',
      borderColor: '#e2e8f0',
      rowHoverBg: '#f1f5f9',
      padding: 12,
    },
    Card: {
      headerHeight: 48,
      paddingLG: 20,
    },
    Button: {
      borderRadius: 6,
      controlHeight: 36,
    },
    Input: {
      controlHeight: 36,
      borderRadius: 6,
    },
    Select: {
      controlHeight: 36,
      borderRadius: 6,
    },
    Tag: {
      borderRadius: 4,
    },
  },
};
