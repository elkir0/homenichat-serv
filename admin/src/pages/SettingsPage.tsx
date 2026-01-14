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
} from '@mui/material';
import {
  Settings as SettingsIcon,
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Security as SecurityIcon,
  Speed as SpeedIcon,
  Notifications as NotificationsIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { configApi } from '../services/api';

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
      </Grid>
    </Box>
  );
}
