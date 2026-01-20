import { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Grid,
  TextField,
  Switch,
  FormControlLabel,
  Alert,
  LinearProgress,
  Divider,
  Chip,
  alpha,
  useTheme,
  IconButton,
  Tooltip,
  CircularProgress,
  Link,
} from '@mui/material';
import {
  Settings as SettingsIcon,
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Security as SecurityIcon,
  Speed as SpeedIcon,
  Notifications as NotificationsIcon,
  ContentCopy as CopyIcon,
  OpenInNew as OpenInNewIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Warning as WarningIcon,
  VpnLock as VpnIcon,
  Delete as DeleteIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Send as SendIcon,
  PhoneAndroid as PhoneAndroidIcon,
  Cloud as CloudIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import { configApi, tunnelRelayApi, pushRelayApi } from '../services/api';

interface ServerConfig {
  server: {
    port: number;
    host: string;
  };
  security: {
    rateLimiting: {
      enabled: boolean;
      loginMax: number;
      apiMax: number;
    };
    twoFactorRequired: boolean;
    sessionTimeout: number;
  };
  notifications: {
    enabled: boolean;
    email: string;
    alertOnError: boolean;
  };
}

interface PushRelayStatus {
  configured: boolean;
  relayUrl: string | null;
  healthy: boolean;
  stats: {
    totalDevices?: number;
    totalSent?: number;
  } | null;
}

interface TunnelRelayStatus {
  enabled: boolean;
  configured: boolean;
  registered: boolean;
  connected: boolean;
  wireguardAvailable: boolean;
  relayUrl: string;
  clientId: string;
  hostname: string;
  hasActivationKey: boolean;
  activationKey: string | null;
  publicKey: string | null;
  subdomain?: string;
  publicUrl?: string;
  wireguard?: {
    clientIP: string;
    serverEndpoint: string;
  };
  turn?: {
    urls: string[];
    expiresAt: string;
  };
  tunnel?: {
    interface: string;
    lastHandshake: string | null;
    bytesReceived: string;
    bytesSent: string;
  };
  lastError: string | null;
  lastRefresh: number | null;
}

export default function SettingsPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [hasChanges, setHasChanges] = useState(false);

  const { data: config, isLoading } = useQuery<ServerConfig>({
    queryKey: ['config'],
    queryFn: configApi.get,
  });

  // Push Relay status query
  const { data: pushRelayStatus, refetch: refetchPushRelay } = useQuery<PushRelayStatus>({
    queryKey: ['pushRelayStatus'],
    queryFn: pushRelayApi.getStatus,
  });

  // Push Relay state
  const [relayUrl, setRelayUrl] = useState('');
  const [relayApiKey, setRelayApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [pushRelayResult, setPushRelayResult] = useState<string | null>(null);
  const [pushRelayError, setPushRelayError] = useState<string | null>(null);

  // Load existing config when status is fetched
  useEffect(() => {
    if (pushRelayStatus?.relayUrl) {
      setRelayUrl(pushRelayStatus.relayUrl);
    }
  }, [pushRelayStatus]);

  // Push Relay save config mutation
  const pushRelaySaveMutation = useMutation({
    mutationFn: (config: { relayUrl: string | null; apiKey: string | null }) =>
      pushRelayApi.updateConfig(config),
    onSuccess: (data) => {
      refetchPushRelay();
      setPushRelayResult(data.message || 'Configuration sauvegardee');
      setPushRelayError(null);
      setRelayApiKey(''); // Clear API key input after save
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setPushRelayError(error.response?.data?.error || error.message);
    },
  });

  // Push Relay delete mutation
  const pushRelayDeleteMutation = useMutation({
    mutationFn: pushRelayApi.delete,
    onSuccess: () => {
      refetchPushRelay();
      setRelayUrl('');
      setRelayApiKey('');
      setPushRelayResult('Configuration Push Relay supprimee');
    },
  });

  // Push Relay test mutation
  const pushRelayTestMutation = useMutation({
    mutationFn: pushRelayApi.test,
    onSuccess: (data) => {
      setPushRelayResult(data.message);
      setPushRelayError(data.success ? null : data.error);
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setPushRelayError(error.response?.data?.error || error.message);
    },
  });

  const handlePushRelaySave = () => {
    if (!relayUrl) {
      setPushRelayError('URL du serveur relay requise');
      return;
    }
    if (!relayApiKey && !pushRelayStatus?.configured) {
      setPushRelayError('Cle API requise');
      return;
    }
    setPushRelayError(null);
    setPushRelayResult(null);
    pushRelaySaveMutation.mutate({
      relayUrl: relayUrl || null,
      apiKey: relayApiKey || null,
    });
  };

  // Tunnel Relay status query (WireGuard + TURN - AUTO-CONFIGURED)
  const { data: tunnelRelayStatus, refetch: refetchTunnelRelay } = useQuery<TunnelRelayStatus>({
    queryKey: ['tunnelRelayStatus'],
    queryFn: tunnelRelayApi.getStatus,
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Tunnel Relay state
  const [activationKey, setActivationKey] = useState('');
  const [showActivationKey, setShowActivationKey] = useState(false);
  const [tunnelRelayError, setTunnelRelayError] = useState<string | null>(null);
  const [tunnelRelayResult, setTunnelRelayResult] = useState<string | null>(null);
  const [copyRelayUrlSuccess, setCopyRelayUrlSuccess] = useState(false);

  // Tunnel Relay configure mutation
  const tunnelRelayConfigureMutation = useMutation({
    mutationFn: (config: { enabled?: boolean; hostname?: string; activationKey?: string }) =>
      tunnelRelayApi.configure(config),
    onSuccess: () => {
      refetchTunnelRelay();
      setTunnelRelayResult('Configuration sauvegardee');
      setTunnelRelayError(null);
      setActivationKey(''); // Clear activation key input after save
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setTunnelRelayError(error.response?.data?.error || error.message);
    },
  });

  // Tunnel Relay connect mutation
  const tunnelRelayConnectMutation = useMutation({
    mutationFn: tunnelRelayApi.connect,
    onSuccess: () => {
      refetchTunnelRelay();
      setTunnelRelayResult('Connexion reussie');
      setTunnelRelayError(null);
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setTunnelRelayError(error.response?.data?.error || error.message);
    },
  });

  // Tunnel Relay disconnect mutation
  const tunnelRelayDisconnectMutation = useMutation({
    mutationFn: tunnelRelayApi.disconnect,
    onSuccess: () => {
      refetchTunnelRelay();
      setTunnelRelayResult('Deconnexion reussie');
    },
  });

  // Tunnel Relay test mutation
  const tunnelRelayTestMutation = useMutation({
    mutationFn: () => tunnelRelayApi.test(), // Uses hardcoded relay URL
    onSuccess: (data) => {
      if (data.success) {
        setTunnelRelayResult('Connexion au serveur relay reussie');
        setTunnelRelayError(null);
      } else {
        setTunnelRelayError(data.error || 'Echec du test');
      }
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setTunnelRelayError(error.response?.data?.error || error.message);
    },
  });

  const handleTunnelRelayToggle = () => {
    if (tunnelRelayStatus?.enabled) {
      tunnelRelayConfigureMutation.mutate({ enabled: false });
    } else {
      tunnelRelayConfigureMutation.mutate({ enabled: true });
    }
  };

  const handleSaveActivationKey = () => {
    if (activationKey) {
      tunnelRelayConfigureMutation.mutate({ activationKey });
    }
  };

  const handleCopyRelayUrl = async () => {
    if (tunnelRelayStatus?.publicUrl) {
      await navigator.clipboard.writeText(tunnelRelayStatus.publicUrl);
      setCopyRelayUrlSuccess(true);
      setTimeout(() => setCopyRelayUrlSuccess(false), 2000);
    }
  };

  const isTunnelRelayMutating = tunnelRelayConfigureMutation.isPending ||
    tunnelRelayConnectMutation.isPending ||
    tunnelRelayDisconnectMutation.isPending ||
    tunnelRelayTestMutation.isPending;

  const formatUptime = (ms: number | null) => {
    if (!ms) return '-';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const [localConfig, setLocalConfig] = useState<ServerConfig | null>(null);

  // Initialize local config when data loads
  useEffect(() => {
    if (config && !localConfig) {
      setLocalConfig(config);
    }
  }, [config, localConfig]);

  const saveMutation = useMutation({
    mutationFn: configApi.update,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      setHasChanges(false);
    },
  });

  const reloadMutation = useMutation({
    mutationFn: configApi.reload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });

  const handleChange = (path: string, value: unknown) => {
    if (!localConfig) return;

    const parts = path.split('.');
    const newConfig = JSON.parse(JSON.stringify(localConfig));
    let obj: Record<string, unknown> = newConfig;

    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;

    setLocalConfig(newConfig);
    setHasChanges(true);
  };

  const handleSave = () => {
    if (localConfig) {
      saveMutation.mutate(localConfig as unknown as Record<string, unknown>);
    }
  };

  if (isLoading) {
    return <LinearProgress />;
  }

  const displayConfig = localConfig || config;

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Paramètres
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Configuration du serveur Homenichat
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => reloadMutation.mutate()}
            disabled={reloadMutation.isPending}
          >
            Recharger
          </Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSave}
            disabled={!hasChanges || saveMutation.isPending}
          >
            Enregistrer
          </Button>
        </Box>
      </Box>

      {hasChanges && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          Vous avez des modifications non enregistrées.
        </Alert>
      )}

      {saveMutation.isSuccess && (
        <Alert severity="success" sx={{ mb: 3 }}>
          Configuration enregistrée avec succès.
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Server Settings */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                <SettingsIcon sx={{ mr: 1, color: 'primary.main' }} />
                <Typography variant="h6" fontWeight={600}>
                  Serveur
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TextField
                  label="Port"
                  type="number"
                  value={displayConfig?.server?.port || 3000}
                  onChange={(e) => handleChange('server.port', parseInt(e.target.value))}
                  fullWidth
                  helperText="Port sur lequel le serveur écoute"
                />

                <TextField
                  label="Hôte"
                  value={displayConfig?.server?.host || '0.0.0.0'}
                  onChange={(e) => handleChange('server.host', e.target.value)}
                  fullWidth
                  helperText="Adresse d'écoute (0.0.0.0 = toutes les interfaces)"
                />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Security Settings */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                <SecurityIcon sx={{ mr: 1, color: 'warning.main' }} />
                <Typography variant="h6" fontWeight={600}>
                  Sécurité
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={displayConfig?.security?.rateLimiting?.enabled ?? true}
                      onChange={(e) => handleChange('security.rateLimiting.enabled', e.target.checked)}
                    />
                  }
                  label="Activer le rate limiting"
                />

                {displayConfig?.security?.rateLimiting?.enabled && (
                  <>
                    <TextField
                      label="Limite login (req/min)"
                      type="number"
                      value={displayConfig?.security?.rateLimiting?.loginMax || 5}
                      onChange={(e) => handleChange('security.rateLimiting.loginMax', parseInt(e.target.value))}
                      fullWidth
                      size="small"
                    />

                    <TextField
                      label="Limite API (req/min)"
                      type="number"
                      value={displayConfig?.security?.rateLimiting?.apiMax || 100}
                      onChange={(e) => handleChange('security.rateLimiting.apiMax', parseInt(e.target.value))}
                      fullWidth
                      size="small"
                    />
                  </>
                )}

                <Divider sx={{ my: 1 }} />

                <FormControlLabel
                  control={
                    <Switch
                      checked={displayConfig?.security?.twoFactorRequired ?? false}
                      onChange={(e) => handleChange('security.twoFactorRequired', e.target.checked)}
                    />
                  }
                  label="2FA obligatoire pour les admins"
                />

                <TextField
                  label="Timeout session (heures)"
                  type="number"
                  value={Math.round((displayConfig?.security?.sessionTimeout || 604800000) / 3600000)}
                  onChange={(e) => handleChange('security.sessionTimeout', parseInt(e.target.value) * 3600000)}
                  fullWidth
                  helperText="Durée d'inactivité avant déconnexion automatique"
                />
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Notifications */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                <NotificationsIcon sx={{ mr: 1, color: 'info.main' }} />
                <Typography variant="h6" fontWeight={600}>
                  Notifications
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={displayConfig?.notifications?.enabled ?? false}
                      onChange={(e) => handleChange('notifications.enabled', e.target.checked)}
                    />
                  }
                  label="Activer les notifications email"
                />

                {displayConfig?.notifications?.enabled && (
                  <>
                    <TextField
                      label="Email admin"
                      type="email"
                      value={displayConfig?.notifications?.email || ''}
                      onChange={(e) => handleChange('notifications.email', e.target.value)}
                      fullWidth
                      placeholder="admin@example.com"
                    />

                    <FormControlLabel
                      control={
                        <Switch
                          checked={displayConfig?.notifications?.alertOnError ?? true}
                          onChange={(e) => handleChange('notifications.alertOnError', e.target.checked)}
                        />
                      }
                      label="Alerter en cas d'erreur"
                    />
                  </>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* System Info */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                <SpeedIcon sx={{ mr: 1, color: 'success.main' }} />
                <Typography variant="h6" fontWeight={600}>
                  Informations système
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    Version
                  </Typography>
                  <Chip label="1.0.0" size="small" color="primary" />
                </Box>

                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    Node.js
                  </Typography>
                  <Chip label="20.x" size="small" variant="outlined" />
                </Box>

                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    Base de données
                  </Typography>
                  <Chip label="SQLite" size="small" variant="outlined" />
                </Box>

                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    Environnement
                  </Typography>
                  <Chip
                    label={import.meta.env.MODE}
                    size="small"
                    color={import.meta.env.PROD ? 'success' : 'warning'}
                    variant="outlined"
                  />
                </Box>

                <Divider sx={{ my: 1 }} />

                <Box
                  sx={{
                    p: 2,
                    borderRadius: 1,
                    backgroundColor: alpha(theme.palette.info.main, 0.05),
                  }}
                >
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Chemins de configuration:
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                    config/providers.yaml
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                    config/security.yaml
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                    data/homenichat.db
                  </Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Tunnel Relay - WireGuard + TURN (AUTO-CONFIGURED) */}
        <Grid item xs={12}>
          <Card
            sx={{
              border: tunnelRelayStatus?.connected ? '1px solid' : 'none',
              borderColor: 'primary.main',
            }}
          >
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <VpnIcon sx={{ mr: 1, color: tunnelRelayStatus?.connected ? 'primary.main' : 'text.secondary' }} />
                  <Typography variant="h6" fontWeight={600}>
                    Tunnel Relay (WireGuard + TURN)
                  </Typography>
                  <Chip
                    label="Recommande"
                    size="small"
                    color="primary"
                    variant="outlined"
                    sx={{ ml: 1 }}
                  />
                </Box>

                {/* Toggle Switch */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  {isTunnelRelayMutating && (
                    <CircularProgress size={20} />
                  )}
                  <FormControlLabel
                    control={
                      <Switch
                        checked={tunnelRelayStatus?.enabled ?? false}
                        onChange={handleTunnelRelayToggle}
                        disabled={isTunnelRelayMutating}
                        color="primary"
                      />
                    }
                    label={tunnelRelayStatus?.enabled ? 'Active' : 'Desactive'}
                    labelPlacement="start"
                  />
                </Box>
              </Box>

              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Acces distant securise via VPN WireGuard. Inclut un serveur TURN pour les appels WebRTC
                meme derriere des NAT restrictifs. Ideal pour une configuration zero-config.
              </Typography>

              {tunnelRelayError && (
                <Alert severity="error" sx={{ mb: 2 }} onClose={() => setTunnelRelayError(null)}>
                  {tunnelRelayError}
                </Alert>
              )}

              {tunnelRelayResult && (
                <Alert severity="success" sx={{ mb: 2 }} onClose={() => setTunnelRelayResult(null)}>
                  {tunnelRelayResult}
                </Alert>
              )}

              {tunnelRelayStatus?.lastError && !tunnelRelayError && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  Derniere erreur: {tunnelRelayStatus.lastError}
                </Alert>
              )}

              {/* Activation Key (for future premium features) */}
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Cle d'activation (optionnel)
                </Typography>
                <Grid container spacing={2} alignItems="flex-end">
                  <Grid item xs={12} md={8}>
                    <TextField
                      fullWidth
                      label="Cle d'activation"
                      placeholder={tunnelRelayStatus?.hasActivationKey ? '••••••••' : 'Entrez votre cle d\'activation'}
                      value={activationKey}
                      onChange={(e) => setActivationKey(e.target.value)}
                      type={showActivationKey ? 'text' : 'password'}
                      size="small"
                      helperText={tunnelRelayStatus?.hasActivationKey ? 'Une cle est deja configuree' : 'Pour activer les fonctionnalites premium'}
                      InputProps={{
                        endAdornment: (
                          <IconButton
                            size="small"
                            onClick={() => setShowActivationKey(!showActivationKey)}
                          >
                            {showActivationKey ? <VisibilityOffIcon /> : <VisibilityIcon />}
                          </IconButton>
                        ),
                      }}
                    />
                  </Grid>
                  <Grid item xs={12} md={4}>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Button
                        variant="contained"
                        size="small"
                        onClick={handleSaveActivationKey}
                        disabled={isTunnelRelayMutating || !activationKey}
                      >
                        Enregistrer
                      </Button>
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={() => tunnelRelayTestMutation.mutate()}
                        disabled={isTunnelRelayMutating}
                      >
                        Tester
                      </Button>
                    </Box>
                  </Grid>
                </Grid>
              </Box>

              {/* Connected Status */}
              {tunnelRelayStatus?.enabled && tunnelRelayStatus?.registered && (
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 2,
                    backgroundColor: tunnelRelayStatus.connected
                      ? alpha(theme.palette.success.main, 0.08)
                      : alpha(theme.palette.warning.main, 0.08),
                    border: '1px solid',
                    borderColor: tunnelRelayStatus.connected
                      ? alpha(theme.palette.success.main, 0.3)
                      : alpha(theme.palette.warning.main, 0.3),
                    mb: 2,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                      URL publique
                    </Typography>
                    <Chip
                      label={tunnelRelayStatus.connected ? 'Connecte' : 'Enregistre'}
                      size="small"
                      color={tunnelRelayStatus.connected ? 'success' : 'warning'}
                    />
                  </Box>

                  {tunnelRelayStatus.publicUrl && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Link
                        href={tunnelRelayStatus.publicUrl}
                        target="_blank"
                        rel="noopener"
                        sx={{
                          fontFamily: 'monospace',
                          fontSize: '1.1rem',
                          fontWeight: 500,
                          color: tunnelRelayStatus.connected ? 'success.main' : 'warning.main',
                          textDecoration: 'none',
                          '&:hover': { textDecoration: 'underline' },
                        }}
                      >
                        {tunnelRelayStatus.publicUrl}
                      </Link>
                      <Tooltip title={copyRelayUrlSuccess ? 'Copie!' : "Copier l'URL"}>
                        <IconButton size="small" onClick={handleCopyRelayUrl}>
                          <CopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Ouvrir dans un nouvel onglet">
                        <IconButton
                          size="small"
                          component="a"
                          href={tunnelRelayStatus.publicUrl}
                          target="_blank"
                          rel="noopener"
                        >
                          <OpenInNewIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  )}

                  {/* WireGuard Info */}
                  {tunnelRelayStatus.wireguard && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="caption" color="text.secondary">
                        IP WireGuard: <strong>{tunnelRelayStatus.wireguard.clientIP}</strong>
                      </Typography>
                      {tunnelRelayStatus.tunnel?.lastHandshake && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          Dernier handshake: {tunnelRelayStatus.tunnel.lastHandshake}
                        </Typography>
                      )}
                    </Box>
                  )}

                  {/* TURN Info */}
                  {tunnelRelayStatus.turn && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        TURN: {tunnelRelayStatus.turn.urls.length} serveurs configures
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Credentials expirent: {new Date(tunnelRelayStatus.turn.expiresAt).toLocaleString()}
                      </Typography>
                    </Box>
                  )}
                </Box>
              )}

              {/* WireGuard availability warning */}
              {!tunnelRelayStatus?.wireguardAvailable && tunnelRelayStatus?.enabled && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  WireGuard n'est pas installe. Le service fonctionne en mode TURN uniquement.
                  Pour une latence optimale, installez WireGuard: <code>apt install wireguard</code>
                </Alert>
              )}

              <Divider sx={{ my: 2 }} />

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" color="text.secondary">
                  Propulse par Homenichat Relay - VPN WireGuard + TURN securise
                </Typography>
                {tunnelRelayStatus?.publicKey && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                    {tunnelRelayStatus.publicKey.substring(0, 12)}...
                  </Typography>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* Push Relay - Recommended method for push notifications */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
                <CloudIcon sx={{ mr: 1, color: theme.palette.primary.main }} />
                <Typography variant="h6" fontWeight={600}>
                  Push Notifications (Relay)
                </Typography>
                {pushRelayStatus?.configured ? (
                  <>
                    <Chip
                      icon={<CheckCircleIcon />}
                      label="Configure"
                      color="success"
                      size="small"
                      sx={{ ml: 2 }}
                    />
                    {pushRelayStatus?.healthy ? (
                      <Chip
                        label="Connecte"
                        color="success"
                        size="small"
                        variant="outlined"
                        sx={{ ml: 1 }}
                      />
                    ) : (
                      <Chip
                        label="Deconnecte"
                        color="warning"
                        size="small"
                        variant="outlined"
                        sx={{ ml: 1 }}
                      />
                    )}
                  </>
                ) : (
                  <Chip
                    icon={<ErrorIcon />}
                    label="Non configure"
                    color="error"
                    size="small"
                    sx={{ ml: 2 }}
                  />
                )}
              </Box>

              <Alert severity="info" sx={{ mb: 3 }}>
                <Typography variant="body2" fontWeight={500}>
                  Le serveur Push Relay centralise l'envoi des notifications push vers iOS et Android.
                </Typography>
                <Typography variant="caption">
                  Requis pour les appels entrants et les messages quand l'app est fermee ou en arriere-plan.
                  Plus simple que Firebase: une seule configuration pour iOS et Android.
                </Typography>
              </Alert>

              <Grid container spacing={3}>
                <Grid item xs={12} md={6}>
                  <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                    Configuration du serveur Relay
                  </Typography>

                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <TextField
                      fullWidth
                      size="small"
                      label="URL du serveur Relay"
                      value={relayUrl}
                      onChange={(e) => setRelayUrl(e.target.value)}
                      placeholder="https://push.homenichat.com"
                      helperText="URL du serveur Push Relay"
                    />

                    <TextField
                      fullWidth
                      size="small"
                      label="Cle API"
                      type={showApiKey ? 'text' : 'password'}
                      value={relayApiKey}
                      onChange={(e) => setRelayApiKey(e.target.value)}
                      placeholder={pushRelayStatus?.configured ? '••••••••' : 'Votre cle API'}
                      helperText={pushRelayStatus?.configured ? 'Laissez vide pour garder la cle actuelle' : 'Cle API fournie par le service relay'}
                      InputProps={{
                        endAdornment: (
                          <IconButton
                            size="small"
                            onClick={() => setShowApiKey(!showApiKey)}
                            edge="end"
                          >
                            {showApiKey ? <VisibilityOffIcon /> : <VisibilityIcon />}
                          </IconButton>
                        ),
                      }}
                    />

                    {pushRelayStatus?.configured && (
                      <Box
                        sx={{
                          p: 2,
                          borderRadius: 2,
                          backgroundColor: alpha(theme.palette.success.main, 0.08),
                          border: '1px solid',
                          borderColor: alpha(theme.palette.success.main, 0.3),
                        }}
                      >
                        <Typography variant="body2">
                          <strong>Serveur:</strong> {pushRelayStatus.relayUrl}
                        </Typography>
                        <Typography variant="body2">
                          <strong>Etat:</strong> {pushRelayStatus.healthy ? 'Connecte' : 'Deconnecte'}
                        </Typography>
                        {pushRelayStatus.stats && (
                          <>
                            <Typography variant="body2">
                              <strong>Appareils:</strong> {pushRelayStatus.stats.totalDevices || 0}
                            </Typography>
                            <Typography variant="body2">
                              <strong>Notifications envoyees:</strong> {pushRelayStatus.stats.totalSent || 0}
                            </Typography>
                          </>
                        )}
                      </Box>
                    )}

                    {pushRelayError && (
                      <Alert severity="error" onClose={() => setPushRelayError(null)}>
                        {pushRelayError}
                      </Alert>
                    )}

                    {pushRelayResult && (
                      <Alert severity="success" onClose={() => setPushRelayResult(null)}>
                        {pushRelayResult}
                      </Alert>
                    )}

                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                      <Button
                        variant="contained"
                        color="primary"
                        startIcon={pushRelaySaveMutation.isPending ? <CircularProgress size={20} color="inherit" /> : <SaveIcon />}
                        onClick={handlePushRelaySave}
                        disabled={pushRelaySaveMutation.isPending || !relayUrl}
                      >
                        Sauvegarder
                      </Button>

                      {pushRelayStatus?.configured && (
                        <>
                          <Button
                            variant="outlined"
                            color="primary"
                            startIcon={pushRelayTestMutation.isPending ? <CircularProgress size={20} /> : <SendIcon />}
                            onClick={() => pushRelayTestMutation.mutate()}
                            disabled={pushRelayTestMutation.isPending}
                          >
                            Tester
                          </Button>
                          <Button
                            variant="outlined"
                            color="error"
                            startIcon={<DeleteIcon />}
                            onClick={() => pushRelayDeleteMutation.mutate()}
                            disabled={pushRelayDeleteMutation.isPending}
                          >
                            Supprimer
                          </Button>
                        </>
                      )}
                    </Box>
                  </Box>
                </Grid>

                <Grid item xs={12} md={6}>
                  <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                    A propos du Push Relay
                  </Typography>

                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Typography variant="body2">
                      Le serveur Push Relay est un service centralise qui:
                    </Typography>
                    <Typography variant="body2" component="div">
                      <ul style={{ margin: 0, paddingLeft: 20 }}>
                        <li>Envoie les notifications push iOS (APNs)</li>
                        <li>Envoie les notifications push Android (FCM)</li>
                        <li>Gere les tokens des appareils</li>
                        <li>Simplifie la configuration (une seule cle API)</li>
                      </ul>
                    </Typography>

                    <Divider sx={{ my: 1 }} />

                    <Alert severity="info" icon={<PhoneAndroidIcon />}>
                      <Typography variant="caption">
                        <strong>App Mobile:</strong> L'application mobile doit etre configuree pour
                        utiliser le meme serveur relay. La cle API permet d'authentifier votre serveur.
                      </Typography>
                    </Alert>

                    <Alert severity="warning" icon={<WarningIcon />}>
                      <Typography variant="caption">
                        <strong>Important:</strong> La cle API est secrete.
                        Ne la partagez jamais publiquement.
                      </Typography>
                    </Alert>
                  </Box>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>

      </Grid>
    </Box>
  );
}
