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
  VpnLock as VpnIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Cloud as CloudIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import { configApi, homenichatCloudApi, HomenichatCloudStatus } from '../services/api';

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

  const { data: config, isLoading } = useQuery<ServerConfig>({
    queryKey: ['config'],
    queryFn: configApi.get,
  });

  // Homenichat Cloud status query (UNIFIED: Push + Tunnel with email/password)
  const { data: cloudStatus, refetch: refetchCloud } = useQuery<HomenichatCloudStatus>({
    queryKey: ['homenichatCloudStatus'],
    queryFn: homenichatCloudApi.getStatus,
    refetchInterval: 10000,
  });

  // Cloud auth state
  const [cloudEmail, setCloudEmail] = useState('');
  const [cloudPassword, setCloudPassword] = useState('');
  const [cloudName, setCloudName] = useState('');
  const [showCloudPassword, setShowCloudPassword] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudResult, setCloudResult] = useState<string | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  // Cloud mutations
  const cloudLoginMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      homenichatCloudApi.login(email, password),
    onSuccess: () => {
      refetchCloud();
      setCloudResult('Connexion reussie a Homenichat Cloud');
      setCloudError(null);
      setCloudEmail('');
      setCloudPassword('');
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setCloudError(error.response?.data?.error || error.message);
    },
  });

  const cloudRegisterMutation = useMutation({
    mutationFn: ({ email, password, name }: { email: string; password: string; name?: string }) =>
      homenichatCloudApi.register(email, password, name),
    onSuccess: () => {
      refetchCloud();
      setCloudResult('Compte cree et connecte a Homenichat Cloud');
      setCloudError(null);
      setCloudEmail('');
      setCloudPassword('');
      setCloudName('');
      setIsRegistering(false);
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setCloudError(error.response?.data?.error || error.message);
    },
  });

  const cloudLogoutMutation = useMutation({
    mutationFn: homenichatCloudApi.logout,
    onSuccess: () => {
      refetchCloud();
      setCloudResult('Deconnecte de Homenichat Cloud');
    },
  });

  const cloudConnectMutation = useMutation({
    mutationFn: homenichatCloudApi.connect,
    onSuccess: () => {
      refetchCloud();
      setCloudResult('Tunnel connecte');
      setCloudError(null);
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setCloudError(error.response?.data?.error || error.message);
    },
  });

  const cloudDisconnectMutation = useMutation({
    mutationFn: homenichatCloudApi.disconnect,
    onSuccess: () => {
      refetchCloud();
      setCloudResult('Tunnel deconnecte');
    },
  });

  const cloudTestMutation = useMutation({
    mutationFn: homenichatCloudApi.test,
    onSuccess: (data) => {
      if (data.success) {
        setCloudResult('Connexion au serveur relay reussie');
        setCloudError(null);
      } else {
        setCloudError(data.error || 'Echec du test');
      }
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setCloudError(error.response?.data?.error || error.message);
    },
  });

  const isCloudMutating = cloudLoginMutation.isPending ||
    cloudRegisterMutation.isPending ||
    cloudLogoutMutation.isPending ||
    cloudConnectMutation.isPending ||
    cloudDisconnectMutation.isPending ||
    cloudTestMutation.isPending;

  const handleCloudLogin = () => {
    if (!cloudEmail || !cloudPassword) {
      setCloudError('Email et mot de passe requis');
      return;
    }
    setCloudError(null);
    cloudLoginMutation.mutate({ email: cloudEmail, password: cloudPassword });
  };

  const handleCloudRegister = () => {
    if (!cloudEmail || !cloudPassword) {
      setCloudError('Email et mot de passe requis');
      return;
    }
    if (cloudPassword.length < 8) {
      setCloudError('Mot de passe: minimum 8 caracteres');
      return;
    }
    setCloudError(null);
    cloudRegisterMutation.mutate({ email: cloudEmail, password: cloudPassword, name: cloudName });
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
        {/* Homenichat Cloud - UNIFIED Push + Tunnel with email/password */}
        <Grid item xs={12}>
          <Card
            sx={{
              border: cloudStatus?.loggedIn ? '2px solid' : 'none',
              borderColor: 'primary.main',
              background: cloudStatus?.loggedIn
                ? `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.05)} 0%, ${alpha(theme.palette.success.main, 0.05)} 100%)`
                : undefined,
            }}
          >
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <CloudIcon sx={{ mr: 1, color: cloudStatus?.loggedIn ? 'primary.main' : 'text.secondary', fontSize: 32 }} />
                  <Box>
                    <Typography variant="h6" fontWeight={600}>
                      Homenichat Cloud
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Push Notifications + Tunnel VPN - Configuration unifiee
                    </Typography>
                  </Box>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {isCloudMutating && <CircularProgress size={20} />}
                  {cloudStatus?.loggedIn ? (
                    <Chip label="Connecte" color="success" icon={<CheckCircleIcon />} />
                  ) : (
                    <Chip label="Non connecte" color="default" variant="outlined" />
                  )}
                </Box>
              </Box>

              <Alert severity="info" sx={{ mb: 3 }}>
                <Typography variant="body2" fontWeight={500}>
                  Un seul compte pour tout: Push Notifications iOS/Android + Tunnel VPN securise
                </Typography>
                <Typography variant="caption">
                  Connectez-vous avec votre compte Homenichat Cloud pour activer automatiquement tous les services.
                </Typography>
              </Alert>

              {cloudError && (
                <Alert severity="error" sx={{ mb: 2 }} onClose={() => setCloudError(null)}>
                  {cloudError}
                </Alert>
              )}

              {cloudResult && (
                <Alert severity="success" sx={{ mb: 2 }} onClose={() => setCloudResult(null)}>
                  {cloudResult}
                </Alert>
              )}

              {!cloudStatus?.loggedIn ? (
                // Login/Register Form
                <Box sx={{ maxWidth: 500 }}>
                  <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                    {isRegistering ? 'Creer un compte Homenichat Cloud' : 'Se connecter a Homenichat Cloud'}
                  </Typography>

                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}>
                    {isRegistering && (
                      <TextField
                        fullWidth
                        size="small"
                        label="Nom (optionnel)"
                        value={cloudName}
                        onChange={(e) => setCloudName(e.target.value)}
                        placeholder="Votre nom ou celui de votre entreprise"
                      />
                    )}
                    <TextField
                      fullWidth
                      size="small"
                      label="Email"
                      type="email"
                      value={cloudEmail}
                      onChange={(e) => setCloudEmail(e.target.value)}
                      placeholder="votre@email.com"
                    />
                    <TextField
                      fullWidth
                      size="small"
                      label="Mot de passe"
                      type={showCloudPassword ? 'text' : 'password'}
                      value={cloudPassword}
                      onChange={(e) => setCloudPassword(e.target.value)}
                      placeholder={isRegistering ? 'Minimum 8 caracteres' : 'Votre mot de passe'}
                      InputProps={{
                        endAdornment: (
                          <IconButton
                            size="small"
                            onClick={() => setShowCloudPassword(!showCloudPassword)}
                          >
                            {showCloudPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                          </IconButton>
                        ),
                      }}
                    />

                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <Button
                        variant="contained"
                        onClick={isRegistering ? handleCloudRegister : handleCloudLogin}
                        disabled={isCloudMutating || !cloudEmail || !cloudPassword}
                        startIcon={isCloudMutating ? <CircularProgress size={20} color="inherit" /> : undefined}
                      >
                        {isRegistering ? 'Creer le compte' : 'Se connecter'}
                      </Button>
                      <Button
                        variant="text"
                        onClick={() => {
                          setIsRegistering(!isRegistering);
                          setCloudError(null);
                        }}
                      >
                        {isRegistering ? 'Deja un compte?' : 'Creer un compte'}
                      </Button>
                    </Box>
                  </Box>

                  <Divider sx={{ my: 3 }} />

                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => cloudTestMutation.mutate()}
                    disabled={isCloudMutating}
                  >
                    Tester la connexion au serveur
                  </Button>
                </Box>
              ) : (
                // Logged in - Show status
                <Box>
                  <Box
                    sx={{
                      p: 2,
                      borderRadius: 2,
                      backgroundColor: alpha(theme.palette.success.main, 0.08),
                      border: '1px solid',
                      borderColor: alpha(theme.palette.success.main, 0.3),
                      mb: 3,
                    }}
                  >
                    <Grid container spacing={2}>
                      <Grid item xs={12} md={6}>
                        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                          Compte
                        </Typography>
                        <Typography variant="body1" fontWeight={500}>
                          {cloudStatus.email}
                        </Typography>
                      </Grid>
                      {cloudStatus.publicUrl && (
                        <Grid item xs={12} md={6}>
                          <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 1 }}>
                            URL Publique
                          </Typography>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Link
                              href={cloudStatus.publicUrl}
                              target="_blank"
                              rel="noopener"
                              sx={{ fontFamily: 'monospace', fontWeight: 500 }}
                            >
                              {cloudStatus.publicUrl}
                            </Link>
                            <IconButton
                              size="small"
                              component="a"
                              href={cloudStatus.publicUrl}
                              target="_blank"
                              rel="noopener"
                            >
                              <OpenInNewIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </Grid>
                      )}
                    </Grid>
                  </Box>

                  {/* Services Status */}
                  <Grid container spacing={2} sx={{ mb: 3 }}>
                    <Grid item xs={12} md={6}>
                      <Box
                        sx={{
                          p: 2,
                          borderRadius: 1,
                          backgroundColor: cloudStatus.services?.push?.enabled
                            ? alpha(theme.palette.success.main, 0.05)
                            : alpha(theme.palette.grey[500], 0.05),
                          border: '1px solid',
                          borderColor: cloudStatus.services?.push?.enabled
                            ? alpha(theme.palette.success.main, 0.2)
                            : alpha(theme.palette.grey[500], 0.2),
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <NotificationsIcon sx={{ mr: 1, color: cloudStatus.services?.push?.enabled ? 'success.main' : 'text.secondary' }} />
                            <Typography variant="subtitle2">Push Notifications</Typography>
                          </Box>
                          {cloudStatus.services?.push?.enabled ? (
                            <CheckCircleIcon color="success" />
                          ) : (
                            <ErrorIcon color="disabled" />
                          )}
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          iOS (APNs) + Android (FCM)
                        </Typography>
                      </Box>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Box
                        sx={{
                          p: 2,
                          borderRadius: 1,
                          backgroundColor: cloudStatus.services?.tunnel?.connected
                            ? alpha(theme.palette.success.main, 0.05)
                            : cloudStatus.services?.tunnel?.enabled
                            ? alpha(theme.palette.warning.main, 0.05)
                            : alpha(theme.palette.grey[500], 0.05),
                          border: '1px solid',
                          borderColor: cloudStatus.services?.tunnel?.connected
                            ? alpha(theme.palette.success.main, 0.2)
                            : cloudStatus.services?.tunnel?.enabled
                            ? alpha(theme.palette.warning.main, 0.2)
                            : alpha(theme.palette.grey[500], 0.2),
                        }}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <VpnIcon sx={{ mr: 1, color: cloudStatus.services?.tunnel?.connected ? 'success.main' : 'text.secondary' }} />
                            <Typography variant="subtitle2">Tunnel VPN</Typography>
                          </Box>
                          {cloudStatus.services?.tunnel?.connected ? (
                            <CheckCircleIcon color="success" />
                          ) : cloudStatus.services?.tunnel?.enabled ? (
                            <Chip label="Enregistre" size="small" color="warning" />
                          ) : (
                            <ErrorIcon color="disabled" />
                          )}
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          WireGuard + TURN WebRTC
                        </Typography>
                        {cloudStatus.wireguard && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            IP: {cloudStatus.wireguard.clientIP}
                          </Typography>
                        )}
                      </Box>
                    </Grid>
                  </Grid>

                  {/* Actions */}
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    {!cloudStatus.services?.tunnel?.connected && cloudStatus.services?.tunnel?.enabled && (
                      <Button
                        variant="contained"
                        onClick={() => cloudConnectMutation.mutate()}
                        disabled={isCloudMutating}
                        startIcon={<VpnIcon />}
                      >
                        Connecter le tunnel
                      </Button>
                    )}
                    {cloudStatus.services?.tunnel?.connected && (
                      <Button
                        variant="outlined"
                        onClick={() => cloudDisconnectMutation.mutate()}
                        disabled={isCloudMutating}
                      >
                        Deconnecter le tunnel
                      </Button>
                    )}
                    <Button
                      variant="outlined"
                      onClick={() => cloudTestMutation.mutate()}
                      disabled={isCloudMutating}
                    >
                      Tester
                    </Button>
                    <Button
                      variant="outlined"
                      color="error"
                      onClick={() => cloudLogoutMutation.mutate()}
                      disabled={isCloudMutating}
                    >
                      Deconnexion
                    </Button>
                  </Box>

                  {/* TURN Credentials Info */}
                  {cloudStatus.turn && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="caption" color="text.secondary">
                        TURN: {cloudStatus.turn.urls.length} serveur(s) - Expire: {new Date(cloudStatus.turn.expiresAt).toLocaleString()}
                      </Typography>
                    </Box>
                  )}
                </Box>
              )}

              <Divider sx={{ my: 2 }} />
              <Typography variant="caption" color="text.secondary">
                Propulse par Homenichat Cloud - relay.homenichat.com
              </Typography>
            </CardContent>
          </Card>
        </Grid>

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

      </Grid>
    </Box>
  );
}
