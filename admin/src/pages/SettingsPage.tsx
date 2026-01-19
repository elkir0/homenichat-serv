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
  Public as PublicIcon,
  ContentCopy as CopyIcon,
  OpenInNew as OpenInNewIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Router as RouterIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { configApi, tunnelApi, upnpApi, firebaseApi, pushRelayApi } from '../services/api';
import {
  CloudUpload as CloudUploadIcon,
  Delete as DeleteIcon,
  Android as AndroidIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Send as SendIcon,
  PhoneAndroid as PhoneAndroidIcon,
  Cloud as CloudIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';

interface TunnelStatus {
  available: boolean;
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  url: string | null;
  connectedAt: number | null;
  uptime: number | null;
  lastError: string | null;
  totalConnections: number;
}

interface UpnpStatus {
  installed: boolean;
  enabled: boolean;
  available: boolean;
  externalIp?: string;
  router?: string;
  localIp?: string;
  mappings?: {
    sip: boolean;
    sipPort: number;
    rtpCount: number;
    rtpTotal: number;
    rtpStart: number;
    rtpEnd: number;
  };
  error?: string | null;
  hint?: string;
}

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

interface FirebaseStatus {
  configured: boolean;
  configPath: string | null;
  initialized: boolean;
  projectId: string | null;
  registeredDevices: number;
  registeredUsers: number;
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

export default function SettingsPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [hasChanges, setHasChanges] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const { data: config, isLoading } = useQuery<ServerConfig>({
    queryKey: ['config'],
    queryFn: configApi.get,
  });

  // Firebase status query
  const { data: firebaseStatus, refetch: refetchFirebase } = useQuery<FirebaseStatus>({
    queryKey: ['firebaseStatus'],
    queryFn: firebaseApi.getStatus,
  });

  // Firebase state
  const [firebaseFile, setFirebaseFile] = useState<File | null>(null);
  const [firebaseUploadError, setFirebaseUploadError] = useState<string | null>(null);
  const [firebaseTestResult, setFirebaseTestResult] = useState<string | null>(null);

  // Firebase upload mutation
  const firebaseUploadMutation = useMutation({
    mutationFn: async (fileContent: string) => {
      return firebaseApi.upload(fileContent);
    },
    onSuccess: (data) => {
      refetchFirebase();
      setFirebaseFile(null);
      setFirebaseUploadError(null);
      setFirebaseTestResult(`Configuration sauvegardee! Projet: ${data.projectId}`);
    },
    onError: (error: Error & { response?: { data?: { error?: string; hint?: string } } }) => {
      setFirebaseUploadError(error.response?.data?.error || error.message);
    },
  });

  // Firebase delete mutation
  const firebaseDeleteMutation = useMutation({
    mutationFn: firebaseApi.delete,
    onSuccess: () => {
      refetchFirebase();
      setFirebaseTestResult('Configuration Firebase supprimee');
    },
  });

  // Firebase test mutation
  const firebaseTestMutation = useMutation({
    mutationFn: firebaseApi.test,
    onSuccess: (data) => {
      setFirebaseTestResult(data.message);
    },
    onError: (error: Error & { response?: { data?: { error?: string; hint?: string } } }) => {
      setFirebaseTestResult(error.response?.data?.error || error.message);
    },
  });

  const handleFirebaseFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setFirebaseFile(file);
      setFirebaseUploadError(null);
      setFirebaseTestResult(null);
    }
  };

  const handleFirebaseUpload = async () => {
    if (!firebaseFile) return;

    try {
      const content = await firebaseFile.text();
      // Validate JSON
      JSON.parse(content);
      firebaseUploadMutation.mutate(content);
    } catch {
      setFirebaseUploadError('Fichier JSON invalide');
    }
  };

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

  // Tunnel status query
  const { data: tunnelStatus } = useQuery<TunnelStatus>({
    queryKey: ['tunnelStatus'],
    queryFn: tunnelApi.getStatus,
    refetchInterval: 5000, // Poll every 5 seconds when tunnel is connecting
  });

  // Tunnel toggle mutation
  const tunnelToggleMutation = useMutation({
    mutationFn: tunnelApi.toggle,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tunnelStatus'] });
    },
  });

  // UPnP status query
  const { data: upnpStatus } = useQuery<UpnpStatus>({
    queryKey: ['upnpStatus'],
    queryFn: upnpApi.getStatus,
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // UPnP enable mutation
  const upnpEnableMutation = useMutation({
    mutationFn: upnpApi.enable,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['upnpStatus'] });
    },
  });

  // UPnP disable mutation
  const upnpDisableMutation = useMutation({
    mutationFn: upnpApi.disable,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['upnpStatus'] });
    },
  });

  // UPnP refresh mutation
  const upnpRefreshMutation = useMutation({
    mutationFn: upnpApi.refresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['upnpStatus'] });
    },
  });

  const handleUpnpToggle = () => {
    if (upnpStatus?.enabled) {
      upnpDisableMutation.mutate();
    } else {
      upnpEnableMutation.mutate();
    }
  };

  const isUpnpMutating = upnpEnableMutation.isPending || upnpDisableMutation.isPending || upnpRefreshMutation.isPending;

  const handleCopyUrl = async () => {
    if (tunnelStatus?.url) {
      await navigator.clipboard.writeText(tunnelStatus.url);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

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

        {/* Remote Access / Tunnel */}
        <Grid item xs={12}>
          <Card
            sx={{
              border: tunnelStatus?.status === 'connected' ? '1px solid' : 'none',
              borderColor: 'success.main',
            }}
          >
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <PublicIcon sx={{ mr: 1, color: tunnelStatus?.status === 'connected' ? 'success.main' : 'text.secondary' }} />
                  <Typography variant="h6" fontWeight={600}>
                    Acces distant (tunnl.gg)
                  </Typography>
                  <Chip
                    label="Gratuit"
                    size="small"
                    color="success"
                    variant="outlined"
                    sx={{ ml: 1 }}
                  />
                </Box>

                {/* Toggle Switch */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  {tunnelToggleMutation.isPending && (
                    <CircularProgress size={20} />
                  )}
                  <FormControlLabel
                    control={
                      <Switch
                        checked={tunnelStatus?.enabled ?? false}
                        onChange={() => tunnelToggleMutation.mutate()}
                        disabled={!tunnelStatus?.available || tunnelToggleMutation.isPending}
                      />
                    }
                    label={tunnelStatus?.enabled ? 'Active' : 'Desactive'}
                    labelPlacement="start"
                  />
                </Box>
              </Box>

              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Exposez votre serveur Homenichat sur Internet sans configuration reseau.
                Ideal pour connecter l'application mobile depuis n'importe ou.
              </Typography>

              {!tunnelStatus?.available && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  SSH n'est pas disponible sur ce systeme. Installez OpenSSH pour utiliser le tunnel.
                </Alert>
              )}

              {tunnelStatus?.lastError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {tunnelStatus.lastError}
                </Alert>
              )}

              {tunnelStatus?.status === 'connecting' && (
                <Box sx={{ mb: 2 }}>
                  <Alert severity="info" icon={<CircularProgress size={16} />}>
                    Connexion au tunnel en cours...
                  </Alert>
                </Box>
              )}

              {tunnelStatus?.status === 'connected' && tunnelStatus?.url && (
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 2,
                    backgroundColor: alpha(theme.palette.success.main, 0.08),
                    border: '1px solid',
                    borderColor: alpha(theme.palette.success.main, 0.3),
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                      URL publique
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Chip
                        label="Connecte"
                        size="small"
                        color="success"
                      />
                      <Typography variant="caption" color="text.secondary">
                        Uptime: {formatUptime(tunnelStatus.uptime)}
                      </Typography>
                    </Box>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Link
                      href={tunnelStatus.url}
                      target="_blank"
                      rel="noopener"
                      sx={{
                        fontFamily: 'monospace',
                        fontSize: '1.1rem',
                        fontWeight: 500,
                        color: 'success.main',
                        textDecoration: 'none',
                        '&:hover': { textDecoration: 'underline' },
                      }}
                    >
                      {tunnelStatus.url}
                    </Link>
                    <Tooltip title={copySuccess ? 'Copie!' : 'Copier l\'URL'}>
                      <IconButton size="small" onClick={handleCopyUrl}>
                        <CopyIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Ouvrir dans un nouvel onglet">
                      <IconButton
                        size="small"
                        component="a"
                        href={tunnelStatus.url}
                        target="_blank"
                        rel="noopener"
                      >
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>

                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Utilisez cette URL dans l'application mobile pour vous connecter depuis Internet.
                  </Typography>
                </Box>
              )}

              {tunnelStatus?.enabled && tunnelStatus?.status === 'disconnected' && (
                <Alert severity="warning">
                  Le tunnel est active mais deconnecte. Une reconnexion automatique est en cours...
                </Alert>
              )}

              <Divider sx={{ my: 2 }} />

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" color="text.secondary">
                  Propulse par tunnl.gg - Tunnel SSH gratuit et securise
                </Typography>
                {tunnelStatus && (
                  <Typography variant="caption" color="text.secondary">
                    Total connexions: {tunnelStatus.totalConnections}
                  </Typography>
                )}
              </Box>
            </CardContent>
          </Card>
        </Grid>

        {/* UPnP Port Forwarding */}
        <Grid item xs={12}>
          <Card
            sx={{
              border: upnpStatus?.enabled && upnpStatus?.mappings?.sip ? '1px solid' : 'none',
              borderColor: 'warning.main',
            }}
          >
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <RouterIcon sx={{ mr: 1, color: upnpStatus?.enabled ? 'warning.main' : 'text.secondary' }} />
                  <Typography variant="h6" fontWeight={600}>
                    UPnP Port Forwarding
                  </Typography>
                  <Chip
                    label="Desactive par defaut"
                    size="small"
                    color="default"
                    variant="outlined"
                    sx={{ ml: 1 }}
                  />
                </Box>

                {/* Toggle Switch */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  {isUpnpMutating && (
                    <CircularProgress size={20} />
                  )}
                  <FormControlLabel
                    control={
                      <Switch
                        checked={upnpStatus?.enabled ?? false}
                        onChange={handleUpnpToggle}
                        disabled={!upnpStatus?.installed || !upnpStatus?.available || isUpnpMutating}
                        color="warning"
                      />
                    }
                    label={upnpStatus?.enabled ? 'Active' : 'Desactive'}
                    labelPlacement="start"
                  />
                </Box>
              </Box>

              {/* Warning Banner */}
              <Alert
                severity="warning"
                icon={<WarningIcon />}
                sx={{ mb: 3 }}
              >
                <Typography variant="body2" fontWeight={500}>
                  Attention: Cette fonctionnalite expose votre serveur VoIP a Internet.
                </Typography>
                <Typography variant="caption">
                  N'activez que si vous avez besoin d'appels depuis l'exterieur de votre reseau local.
                  Assurez-vous d'utiliser des mots de passe forts pour les extensions SIP.
                </Typography>
              </Alert>

              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Ouvre automatiquement les ports necessaires sur votre routeur via UPnP:
                <br />
                • <strong>5061/TCP</strong> - SIP TLS (signalisation chiffree)
                <br />
                • <strong>10000-10100/UDP</strong> - RTP (flux audio/video)
              </Typography>

              {!upnpStatus?.installed && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  UPnP n'est pas installe. Executez le script d'installation ou installez miniupnpc manuellement.
                </Alert>
              )}

              {upnpStatus?.installed && !upnpStatus?.available && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {upnpStatus?.error || 'Aucun routeur UPnP detecte. Verifiez que UPnP est active sur votre routeur.'}
                  {upnpStatus?.hint && (
                    <Typography variant="caption" display="block" sx={{ mt: 1 }}>
                      Conseil: {upnpStatus.hint}
                    </Typography>
                  )}
                </Alert>
              )}

              {upnpStatus?.enabled && upnpStatus?.available && (
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 2,
                    backgroundColor: alpha(theme.palette.warning.main, 0.08),
                    border: '1px solid',
                    borderColor: alpha(theme.palette.warning.main, 0.3),
                    mb: 2,
                  }}
                >
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                        Informations Reseau
                      </Typography>
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="body2">
                          <strong>IP Externe:</strong> {upnpStatus.externalIp || 'N/A'}
                        </Typography>
                        <Typography variant="body2">
                          <strong>IP Locale:</strong> {upnpStatus.localIp || 'N/A'}
                        </Typography>
                        <Typography variant="body2">
                          <strong>Routeur:</strong> {upnpStatus.router || 'N/A'}
                        </Typography>
                      </Box>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                        Ports Mappes
                      </Typography>
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="body2">
                          <strong>SIP ({upnpStatus.mappings?.sipPort || 5160}):</strong>{' '}
                          {upnpStatus.mappings?.sip ? (
                            <Chip label="OK" size="small" color="success" sx={{ ml: 1 }} />
                          ) : (
                            <Chip label="Non mappe" size="small" color="error" sx={{ ml: 1 }} />
                          )}
                        </Typography>
                        <Typography variant="body2">
                          <strong>RTP ({upnpStatus.mappings?.rtpStart || 10000}-{upnpStatus.mappings?.rtpEnd || 10100}):</strong>{' '}
                          {upnpStatus.mappings?.rtpCount === upnpStatus.mappings?.rtpTotal ? (
                            <Chip label={`OK (${upnpStatus.mappings?.rtpCount}/${upnpStatus.mappings?.rtpTotal})`} size="small" color="success" sx={{ ml: 1 }} />
                          ) : (
                            <Chip label={`${upnpStatus.mappings?.rtpCount || 0}/${upnpStatus.mappings?.rtpTotal || 101}`} size="small" color="warning" sx={{ ml: 1 }} />
                          )}
                        </Typography>
                      </Box>
                    </Grid>
                  </Grid>

                  <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      size="small"
                      startIcon={<RefreshIcon />}
                      onClick={() => upnpRefreshMutation.mutate()}
                      disabled={isUpnpMutating}
                    >
                      Rafraichir les mappings
                    </Button>
                  </Box>
                </Box>
              )}

              <Divider sx={{ my: 2 }} />

              <Typography variant="caption" color="text.secondary">
                UPnP (Universal Plug and Play) permet l'ouverture automatique des ports sur les routeurs compatibles.
                Le bail est renouvele automatiquement toutes les heures.
              </Typography>
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

        {/* Firebase Push Notifications (Legacy/Fallback) */}
        <Grid item xs={12}>
          <Card sx={{ opacity: pushRelayStatus?.configured ? 0.7 : 1 }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <AndroidIcon sx={{ mr: 1, color: '#34A853' }} />
                <Typography variant="h6" fontWeight={600}>
                  Push Notifications (Firebase) - Fallback
                </Typography>
                {firebaseStatus?.configured ? (
                  <Chip
                    icon={<CheckCircleIcon />}
                    label="Configure"
                    color="success"
                    size="small"
                    sx={{ ml: 2 }}
                  />
                ) : (
                  <Chip
                    label="Non configure"
                    color="default"
                    size="small"
                    sx={{ ml: 2 }}
                  />
                )}
                {pushRelayStatus?.configured && (
                  <Chip
                    label="Relay actif - Firebase desactive"
                    color="info"
                    size="small"
                    variant="outlined"
                    sx={{ ml: 1 }}
                  />
                )}
              </Box>

              {!pushRelayStatus?.configured && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  <Typography variant="caption">
                    Firebase est utilise uniquement si le Push Relay n'est pas configure.
                    Il est recommande d'utiliser le Push Relay pour une configuration simplifiee.
                  </Typography>
                </Alert>
              )}

              {pushRelayStatus?.configured ? (
                <Typography variant="body2" color="text.secondary">
                  Le Push Relay est configure et actif. Firebase n'est pas utilise.
                  {firebaseStatus?.configured && ' Vous pouvez supprimer la configuration Firebase si vous le souhaitez.'}
                </Typography>
              ) : (
                <Grid container spacing={3}>
                  <Grid item xs={12} md={6}>
                    {firebaseStatus?.configured ? (
                      <Box
                        sx={{
                          p: 2,
                          borderRadius: 2,
                          backgroundColor: alpha(theme.palette.success.main, 0.08),
                          border: '1px solid',
                          borderColor: alpha(theme.palette.success.main, 0.3),
                          mb: 2,
                        }}
                      >
                        <Typography variant="body2">
                          <strong>Projet:</strong> {firebaseStatus.projectId}
                        </Typography>
                        <Typography variant="body2">
                          <strong>Appareils:</strong> {firebaseStatus.registeredDevices}
                        </Typography>
                      </Box>
                    ) : (
                      <Alert severity="warning" sx={{ mb: 2 }}>
                        Firebase non configure. Configurez le Push Relay ci-dessus (recommande)
                        ou uploadez un fichier firebase-service-account.json.
                      </Alert>
                    )}

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Button
                          variant="outlined"
                          component="label"
                          startIcon={<CloudUploadIcon />}
                          size="small"
                        >
                          Choisir fichier
                          <input
                            type="file"
                            hidden
                            accept=".json"
                            onChange={handleFirebaseFileChange}
                          />
                        </Button>
                        {firebaseFile && (
                          <Typography variant="body2" color="text.secondary">
                            {firebaseFile.name}
                          </Typography>
                        )}
                      </Box>

                      {firebaseFile && (
                        <Button
                          variant="contained"
                          color="primary"
                          size="small"
                          startIcon={<CloudUploadIcon />}
                          onClick={handleFirebaseUpload}
                          disabled={firebaseUploadMutation.isPending}
                        >
                          Uploader
                        </Button>
                      )}

                      {firebaseUploadError && (
                        <Alert severity="error" sx={{ py: 0 }}>
                          {firebaseUploadError}
                        </Alert>
                      )}

                      {firebaseTestResult && (
                        <Alert severity={firebaseTestResult.includes('erreur') || firebaseTestResult.includes('Error') ? 'error' : 'success'} sx={{ py: 0 }}>
                          {firebaseTestResult}
                        </Alert>
                      )}

                      {firebaseStatus?.configured && (
                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <Button
                            variant="outlined"
                            size="small"
                            startIcon={<SendIcon />}
                            onClick={() => firebaseTestMutation.mutate()}
                            disabled={firebaseTestMutation.isPending}
                          >
                            Tester
                          </Button>
                          <Button
                            variant="outlined"
                            color="error"
                            size="small"
                            startIcon={<DeleteIcon />}
                            onClick={() => firebaseDeleteMutation.mutate()}
                            disabled={firebaseDeleteMutation.isPending}
                          >
                            Supprimer
                          </Button>
                        </Box>
                      )}
                    </Box>
                  </Grid>

                  <Grid item xs={12} md={6}>
                    <Typography variant="caption" color="text.secondary">
                      Pour configurer Firebase manuellement:
                      <ol style={{ margin: '8px 0', paddingLeft: 20 }}>
                        <li>Aller sur Firebase Console</li>
                        <li>Project Settings → Service Accounts</li>
                        <li>Generate new private key</li>
                        <li>Uploader le fichier JSON ici</li>
                      </ol>
                    </Typography>
                  </Grid>
                </Grid>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
