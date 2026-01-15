import axios from 'axios';
import type { AxiosInstance, AxiosError } from 'axios';

// Configuration API
// En production, utiliser des URLs relatives (même origine)
// En dev, peut être configuré via VITE_API_URL
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Client axios avec configuration
const api: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Intercepteur pour ajouter le token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // CSRF token pour les mutations
  const csrfToken = document.cookie
    .split('; ')
    .find(row => row.startsWith('csrf_token='))
    ?.split('=')[1];

  if (csrfToken && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(config.method?.toUpperCase() || '')) {
    config.headers['X-CSRF-Token'] = csrfToken;
  }

  return config;
});

// Intercepteur pour gérer les erreurs
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      // Token expiré, rediriger vers login admin
      localStorage.removeItem('auth_token');
      window.location.href = '/admin/login';
    }
    return Promise.reject(error);
  }
);

// Types
export interface LoginCredentials {
  username: string;
  password: string;
  twoFactorCode?: string;
}

export interface User {
  id: number;
  username: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;
  lastLogin?: string;
  twoFactorEnabled: boolean;
}

export interface Provider {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'initializing';
  config: Record<string, unknown>;
  lastActivity?: string;
}

export interface WhatsAppSession {
  id: string;
  name: string;
  phone?: string;
  status: 'connected' | 'disconnected' | 'qr_pending' | 'initializing';
  lastSeen?: string;
  messageCount?: number;
}

export interface Modem {
  id: string;
  device: string;
  type: string;
  status: 'connected' | 'disconnected' | 'error';
  signal?: number;
  operator?: string;
  phone?: string;
}

export interface AuditLogEntry {
  id: number;
  userId?: number;
  username?: string;
  action: string;
  category: string;
  details: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  success: boolean;
  createdAt: string;
}

export interface DashboardStats {
  timestamp: number;
  uptime: number;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  providers: {
    whatsapp: Array<{ id: string; status: string }>;
    sms: Array<{ id: string; status: string }>;
    voip: Array<{ id: string; status: string }>;
  };
  security: {
    activeSessions: number;
    activeTokens: number;
    failedLogins24h: number;
    rateLimitHits24h: number;
    auditEventsLastWeek: number;
    blockedIps: number;
    users2FAEnabled: number;
  };
  messages: {
    sent: number;
    received: number;
    failed: number;
  };
  whatsappSessions: Array<{ id: string; status: string }>;
}

// API Auth
export const authApi = {
  login: async (credentials: LoginCredentials) => {
    const response = await api.post('/api/auth/login', credentials);
    if (response.data.token) {
      localStorage.setItem('auth_token', response.data.token);
    }
    return response.data;
  },

  logout: async () => {
    await api.post('/api/auth/logout');
    localStorage.removeItem('auth_token');
  },

  verify: async () => {
    const response = await api.get('/api/auth/verify');
    return response.data;
  },

  refresh: async () => {
    const response = await api.post('/api/auth/refresh');
    if (response.data.token) {
      localStorage.setItem('auth_token', response.data.token);
    }
    return response.data;
  },
};

// API Admin - Dashboard
export const dashboardApi = {
  getStats: async (): Promise<DashboardStats> => {
    const response = await api.get('/api/admin/dashboard');
    return response.data;
  },
};

// API Admin - Providers
export const providersApi = {
  getAll: async (): Promise<Provider[]> => {
    const response = await api.get('/api/admin/providers');
    return response.data.providers || response.data || [];
  },

  get: async (id: string): Promise<Provider> => {
    const response = await api.get(`/api/admin/providers/${id}`);
    return response.data;
  },

  create: async (provider: Partial<Provider>): Promise<Provider> => {
    const response = await api.post('/api/admin/providers', provider);
    return response.data;
  },

  update: async (id: string, provider: Partial<Provider>): Promise<Provider> => {
    const response = await api.put(`/api/admin/providers/${id}`, provider);
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/api/admin/providers/${id}`);
  },

  test: async (id: string): Promise<{ success: boolean; message: string }> => {
    const response = await api.post(`/api/admin/providers/${id}/test`);
    return response.data;
  },

  toggle: async (id: string, enabled: boolean): Promise<Provider> => {
    const response = await api.patch(`/api/admin/providers/${id}`, { enabled });
    return response.data;
  },
};

// API Admin - WhatsApp
export const whatsappApi = {
  getSessions: async (): Promise<WhatsAppSession[]> => {
    const response = await api.get('/api/admin/whatsapp/sessions');
    return response.data.sessions || response.data || [];
  },

  createSession: async (name: string): Promise<WhatsAppSession> => {
    const response = await api.post('/api/admin/whatsapp/sessions', { name });
    return response.data;
  },

  deleteSession: async (id: string): Promise<void> => {
    await api.delete(`/api/admin/whatsapp/sessions/${id}`);
  },

  getQrCode: async (id: string): Promise<{ qr: string; status: string }> => {
    const response = await api.get(`/api/admin/whatsapp/qr/${id}`);
    return response.data;
  },

  logout: async (id: string): Promise<void> => {
    await api.post(`/api/admin/whatsapp/sessions/${id}/logout`);
  },
};

// API Admin - Modems
export const modemsApi = {
  getAll: async (): Promise<Modem[]> => {
    const response = await api.get('/api/admin/modems');
    return response.data.modems || response.data || [];
  },

  getStatus: async (id: string): Promise<Modem> => {
    const response = await api.get(`/api/admin/modems/${id}/status`);
    return response.data;
  },

  sendTestSms: async (id: string, to: string, message: string): Promise<{ success: boolean }> => {
    const response = await api.post(`/api/admin/modems/${id}/sms`, { to, message });
    return response.data;
  },

  scan: async (): Promise<Modem[]> => {
    const response = await api.post('/api/admin/modems/scan');
    return response.data;
  },
};

// API Admin - VoIP
export const voipApi = {
  getTrunks: async () => {
    const response = await api.get('/api/admin/voip/trunks');
    return response.data.trunks || response.data || [];
  },

  getExtensions: async () => {
    const response = await api.get('/api/admin/voip/extensions');
    return response.data.extensions || response.data || [];
  },

  testCall: async (extension: string) => {
    const response = await api.post('/api/admin/voip/test-call', { extension });
    return response.data;
  },
};

// API Admin - Users
export const usersApi = {
  getAll: async (): Promise<User[]> => {
    const response = await api.get('/api/admin/users');
    return response.data.users || response.data || [];
  },

  get: async (id: number): Promise<User> => {
    const response = await api.get(`/api/admin/users/${id}`);
    return response.data;
  },

  create: async (user: { username: string; email: string; password: string; role: string }): Promise<User> => {
    const response = await api.post('/api/admin/users', user);
    return response.data;
  },

  update: async (id: number, user: Partial<User>): Promise<User> => {
    const response = await api.put(`/api/admin/users/${id}`, user);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await api.delete(`/api/admin/users/${id}`);
  },

  resetPassword: async (id: number, password: string): Promise<void> => {
    await api.post(`/api/admin/users/${id}/reset-password`, { password });
  },
};

// API Admin - Security
export const securityApi = {
  getAuditLog: async (params?: { limit?: number; offset?: number; action?: string }): Promise<{ logs: AuditLogEntry[]; total: number }> => {
    const response = await api.get('/api/admin/audit-log', { params });
    return response.data;
  },

  getActiveSessions: async () => {
    const response = await api.get('/api/admin/active-sessions');
    return response.data.sessions || response.data || [];
  },

  revokeSession: async (sessionId: string): Promise<void> => {
    await api.delete(`/api/admin/sessions/${sessionId}`);
  },

  getApiTokens: async () => {
    const response = await api.get('/api/admin/api-tokens');
    return response.data.tokens || response.data || [];
  },

  createApiToken: async (name: string, permissions: string[]): Promise<{ token: string }> => {
    const response = await api.post('/api/admin/api-tokens', { name, permissions });
    return response.data;
  },

  revokeApiToken: async (tokenId: number): Promise<void> => {
    await api.delete(`/api/admin/api-tokens/${tokenId}`);
  },

  getStats: async () => {
    const response = await api.get('/api/admin/security/stats');
    return response.data;
  },

  getBlockedIps: async () => {
    const response = await api.get('/api/admin/security/blocked-ips');
    return response.data.blockedIps || response.data.ips || response.data || [];
  },

  unblockIp: async (ip: string): Promise<void> => {
    await api.delete(`/api/admin/security/blocked-ips/${encodeURIComponent(ip)}`);
  },
};

// API Admin - Config
export const configApi = {
  get: async () => {
    const response = await api.get('/api/admin/config');
    return response.data;
  },

  update: async (config: Record<string, unknown>) => {
    const response = await api.put('/api/admin/config', config);
    return response.data;
  },

  reload: async () => {
    const response = await api.post('/api/admin/config/reload');
    return response.data;
  },
};

// API Admin - Tunnel (tunnl.gg)
export const tunnelApi = {
  getStatus: async () => {
    const response = await api.get('/api/admin/tunnel/status');
    return response.data;
  },

  start: async () => {
    const response = await api.post('/api/admin/tunnel/start');
    return response.data;
  },

  stop: async () => {
    const response = await api.post('/api/admin/tunnel/stop');
    return response.data;
  },

  toggle: async () => {
    const response = await api.post('/api/admin/tunnel/toggle');
    return response.data;
  },
};

export default api;
