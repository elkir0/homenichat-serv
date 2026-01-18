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
import { configApi, tunnelApi, upnpApi } from '../services/api';

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
    sipTls: boolean;
    rtpCount: number;
    rtpTotal: number;
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

export default function SettingsPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [hasChanges, setHasChanges] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  const { data: config, isLoading } = useQuery<ServerConfig>({
    queryKey: ['config'],
    queryFn: configApi.get,
  });

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
              border: upnpStatus?.enabled && upnpStatus?.mappings?.sipTls ? '1px solid' : 'none',
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
                          <strong>SIP TLS (5061):</strong>{' '}
                          {upnpStatus.mappings?.sipTls ? (
                            <Chip label="OK" size="small" color="success" sx={{ ml: 1 }} />
                          ) : (
                            <Chip label="Non mappe" size="small" color="error" sx={{ ml: 1 }} />
                          )}
                        </Typography>
                        <Typography variant="body2">
                          <strong>RTP (10000-10100):</strong>{' '}
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
      </Grid>
    </Box>
  );
}
