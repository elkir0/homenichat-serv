import {
  Box,
  Grid,
  Card,
  CardContent,
  Typography,
  LinearProgress,
  Chip,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  alpha,
  useTheme,
} from '@mui/material';
import {
  WhatsApp as WhatsAppIcon,
  Sms as SmsIcon,
  Security as SecurityIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Schedule as ScheduleIcon,
  Memory as MemoryIcon,
  AccessTime as AccessTimeIcon,
} from '@mui/icons-material';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi, tunnelRelayApi } from '../services/api';
import type { DashboardStats } from '../services/api';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ title, value, subtitle, icon, color }: StatCardProps) {
  return (
    <Card
      sx={{
        height: '100%',
        backgroundColor: alpha(color, 0.08),
        border: `1px solid ${alpha(color, 0.2)}`,
      }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 500 }}>
              {title}
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 700, color, my: 0.5 }}>
              {value}
            </Typography>
            {subtitle && (
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            )}
          </Box>
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: 2,
              backgroundColor: alpha(color, 0.15),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color,
            }}
          >
            {icon}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

interface ServiceStatusProps {
  name: string;
  status: 'online' | 'offline' | 'warning';
  details?: string;
}

function ServiceStatus({ name, status, details }: ServiceStatusProps) {
  const statusConfig = {
    online: { color: 'success', icon: <CheckCircleIcon />, label: 'En ligne' },
    offline: { color: 'error', icon: <ErrorIcon />, label: 'Hors ligne' },
    warning: { color: 'warning', icon: <ScheduleIcon />, label: 'Attention' },
  };

  const config = statusConfig[status];

  return (
    <ListItem>
      <ListItemIcon sx={{ color: `${config.color}.main`, minWidth: 40 }}>
        {config.icon}
      </ListItemIcon>
      <ListItemText
        primary={name}
        secondary={details}
        primaryTypographyProps={{ fontWeight: 500 }}
      />
      <Chip
        label={config.label}
        size="small"
        color={config.color as 'success' | 'error' | 'warning'}
        variant="outlined"
      />
    </ListItem>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}j ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export default function DashboardPage() {
  const theme = useTheme();

  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: dashboardApi.getStats,
    refetchInterval: 30000,
  });

  // Tunnel Relay status
  const { data: tunnelStatus } = useQuery({
    queryKey: ['tunnel-relay-status'],
    queryFn: tunnelRelayApi.getStatus,
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Box sx={{ width: '100%', mt: 4 }}>
        <LinearProgress />
      </Box>
    );
  }

  // Valeurs par défaut si pas de données
  const data: DashboardStats = stats || {
    timestamp: Date.now(),
    uptime: 0,
    memory: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
    providers: { whatsapp: [], sms: [], voip: [] },
    security: {
      activeSessions: 0,
      activeTokens: 0,
      failedLogins24h: 0,
      rateLimitHits24h: 0,
      auditEventsLastWeek: 0,
      blockedIps: 0,
      users2FAEnabled: 0,
    },
    messages: { sent: 0, received: 0, failed: 0 },
    whatsappSessions: [],
  };

  // Comptage des providers actifs
  const whatsappConnected = data.whatsappSessions?.filter((s: { status?: string }) => s.status === 'connected').length || 0;
  const smsProviders = data.providers?.sms?.length || 0;
  const voipProviders = data.providers?.voip?.length || 0;

  return (
    <Box>
      {/* Header */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          Dashboard
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Vue d'ensemble de votre serveur Homenichat
        </Typography>
      </Box>

      {/* Stats Cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Sessions WhatsApp"
            value={whatsappConnected}
            subtitle={`${data.whatsappSessions?.length || 0} sessions totales`}
            icon={<WhatsAppIcon />}
            color={theme.palette.success.main}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Messages"
            value={data.messages?.sent || 0}
            subtitle={`${data.messages?.received || 0} reçus, ${data.messages?.failed || 0} échoués`}
            icon={<SmsIcon />}
            color={theme.palette.info.main}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Uptime"
            value={formatUptime(data.uptime || 0)}
            subtitle={`Mémoire: ${formatBytes(data.memory?.heapUsed || 0)}`}
            icon={<AccessTimeIcon />}
            color={theme.palette.warning.main}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Sécurité"
            value={data.security?.failedLogins24h || 0}
            subtitle={`échecs login (24h), ${data.security?.blockedIps || 0} IPs bloquées`}
            icon={<SecurityIcon />}
            color={theme.palette.error.main}
          />
        </Grid>
      </Grid>

      {/* Services Status */}
      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
                État des Services
              </Typography>
              <List disablePadding>
                <ServiceStatus
                  name="WhatsApp Baileys"
                  status={whatsappConnected > 0 ? 'online' : 'offline'}
                  details={`${whatsappConnected} session(s) active(s)`}
                />
                <ServiceStatus
                  name="SMS Providers"
                  status={smsProviders > 0 ? 'online' : 'warning'}
                  details={`${smsProviders} provider(s) configuré(s)`}
                />
                <ServiceStatus
                  name="VoIP / FreePBX"
                  status={voipProviders > 0 ? 'online' : 'offline'}
                  details={`${voipProviders} trunk(s) configuré(s)`}
                />
                <ServiceStatus
                  name="Modems GSM"
                  status="warning"
                  details="Non configuré"
                />
                <ServiceStatus
                  name="Tunnel Relay"
                  status={
                    tunnelStatus?.connected ? 'online' :
                    tunnelStatus?.configured ? 'warning' : 'offline'
                  }
                  details={
                    tunnelStatus?.connected
                      ? `VPN IP: ${tunnelStatus?.wireguard?.clientIP || 'N/A'}`
                      : tunnelStatus?.configured
                        ? 'Configuré mais non connecté'
                        : 'Non configuré'
                  }
                />
              </List>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>
                Informations Système
              </Typography>
              <List disablePadding>
                <ListItem>
                  <ListItemIcon>
                    <MemoryIcon color="primary" />
                  </ListItemIcon>
                  <ListItemText
                    primary="Mémoire Heap"
                    secondary={`${formatBytes(data.memory?.heapUsed || 0)} / ${formatBytes(data.memory?.heapTotal || 0)}`}
                  />
                </ListItem>
                <ListItem>
                  <ListItemIcon>
                    <MemoryIcon color="secondary" />
                  </ListItemIcon>
                  <ListItemText
                    primary="Mémoire RSS"
                    secondary={formatBytes(data.memory?.rss || 0)}
                  />
                </ListItem>
                <ListItem>
                  <ListItemIcon>
                    <AccessTimeIcon color="success" />
                  </ListItemIcon>
                  <ListItemText
                    primary="Uptime Serveur"
                    secondary={formatUptime(data.uptime || 0)}
                  />
                </ListItem>
                <ListItem>
                  <ListItemIcon>
                    <SecurityIcon color="warning" />
                  </ListItemIcon>
                  <ListItemText
                    primary="Sessions Actives"
                    secondary={`${data.security?.activeSessions || 0} utilisateur(s)`}
                  />
                </ListItem>
              </List>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
