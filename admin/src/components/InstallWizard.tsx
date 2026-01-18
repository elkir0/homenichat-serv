/**
 * InstallWizard.tsx
 * Wizard d'installation guidée pour Asterisk, chan_quectel et FreePBX
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Stepper,
  Step,
  StepLabel,
  Alert,
  LinearProgress,
  Grid,
  Chip,
  FormControlLabel,
  Checkbox,
  Divider,
  alpha,
  useTheme,
  CircularProgress,
} from '@mui/material';
import {
  Usb as UsbIcon,
  Settings as SettingsIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  PlayArrow as PlayIcon,
  Cancel as CancelIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import LiveTerminal, { useSSELogs } from './LiveTerminal';

// Types
interface ModemDevice {
  id: string;
  type: string;
  vendor: string;
  ports: string[];
  dataPort: string;
  audioPort: string;
}

interface ComponentStatus {
  installed: boolean;
  version?: string | null;
  running?: boolean;
  loaded?: boolean;
  path?: string | null;
  url?: string | null;
}

interface SystemStatus {
  os: {
    platform: string;
    arch: string;
    distro: string;
    version: string;
    codename: string;
  };
  components: {
    asterisk: ComponentStatus;
    chanQuectel: ComponentStatus;
    freepbx: ComponentStatus;
    gammu: ComponentStatus;
  };
  modems: {
    detected: number;
    devices: ModemDevice[];
  };
  canInstall: {
    asterisk: boolean;
    freepbx: boolean;
    chanQuectel: boolean;
    reason: string | null;
  };
  installing: boolean;
  currentInstallation: {
    component: string;
    startedAt: string;
    percent: number;
    step: string;
  } | null;
}

interface InstallWizardProps {
  onComplete?: () => void;
  onCancel?: () => void;
}

// API functions
const installApi = {
  getSystemStatus: async (): Promise<SystemStatus> => {
    const response = await fetch('/api/admin/system/status', {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to fetch system status');
    return response.json();
  },

  cancelInstallation: async (): Promise<{ success: boolean; message: string }> => {
    const response = await fetch('/api/admin/install/cancel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to cancel installation');
    return response.json();
  },
};

// Steps configuration
const steps = [
  { id: 'detection', label: 'Détection' },
  { id: 'selection', label: 'Sélection' },
  { id: 'installation', label: 'Installation' },
  { id: 'complete', label: 'Terminé' },
];

export default function InstallWizard({ onComplete, onCancel: _onCancel }: InstallWizardProps) {
  const theme = useTheme();
  const [activeStep, setActiveStep] = useState(0);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Installation options
  const [installOptions, setInstallOptions] = useState({
    asterisk: true,
    chanQuectel: true,
    freepbx: false,
    configureModems: true,
  });

  // SSE logs for installation
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const {
    logs,
    progress,
    status: installStatus,
    error: installError,
    connect: startInstall,
    disconnect: stopInstall,
    clearLogs,
  } = useSSELogs(installUrl);

  // Load system status
  const loadSystemStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await installApi.getSystemStatus();
      setSystemStatus(status);

      // Auto-check options based on what's missing
      setInstallOptions(prev => ({
        ...prev,
        asterisk: !status.components.asterisk.installed,
        chanQuectel: !status.components.chanQuectel.installed,
        freepbx: !status.components.freepbx.installed && status.components.asterisk.installed,
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSystemStatus();
  }, [loadSystemStatus]);

  // Start installation when URL is set
  useEffect(() => {
    if (installUrl) {
      startInstall();
    }
  }, [installUrl, startInstall]);

  // Handle installation complete
  useEffect(() => {
    if (installStatus === 'complete') {
      setTimeout(() => {
        setActiveStep(3); // Go to complete step
        loadSystemStatus(); // Refresh status
      }, 1000);
    }
  }, [installStatus, loadSystemStatus]);

  // Start installation
  const handleStartInstallation = () => {
    setActiveStep(2);
    clearLogs();

    // Build URL with auth token
    const token = localStorage.getItem('auth_token');
    const params = new URLSearchParams({
      modemType: systemStatus?.modems.devices[0]?.type.toLowerCase() || 'sim7600',
      installChanQuectel: String(installOptions.chanQuectel),
      configureModems: String(installOptions.configureModems),
    });

    // Note: SSE doesn't support POST body easily, we'll use query params
    // Or we could make a POST first to start the install, then connect to SSE
    const url = `/api/admin/install/asterisk?token=${token}&${params}`;
    setInstallUrl(url);
  };

  // Cancel installation
  const handleCancelInstallation = async () => {
    try {
      await installApi.cancelInstallation();
      stopInstall();
      setInstallUrl(null);
      setActiveStep(1);
    } catch (err) {
      console.error('Failed to cancel:', err);
    }
  };

  // Render detection step
  const renderDetectionStep = () => (
    <Box>
      <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        <UsbIcon color="primary" />
        Modems USB Détectés
      </Typography>

      {systemStatus?.modems.detected === 0 ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Aucun modem USB détecté. Connectez vos modems SIM7600 ou EC25 et cliquez sur "Actualiser".
        </Alert>
      ) : (
        <Grid container spacing={2} sx={{ mb: 3 }}>
          {systemStatus?.modems.devices.map((modem) => (
            <Grid item xs={12} md={6} key={modem.id}>
              <Card variant="outlined" sx={{ backgroundColor: alpha(theme.palette.success.main, 0.05) }}>
                <CardContent>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                    <Typography variant="subtitle1" fontWeight={600}>
                      {modem.id}
                    </Typography>
                    <Chip
                      label={modem.type}
                      color="success"
                      size="small"
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Vendor: {modem.vendor}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Data: {modem.dataPort}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Audio: {modem.audioPort}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {modem.ports.length} ports USB
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      <Divider sx={{ my: 3 }} />

      <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        <SettingsIcon color="primary" />
        Composants Système
      </Typography>

      <Grid container spacing={2}>
        {/* Asterisk */}
        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined">
            <CardContent sx={{ textAlign: 'center' }}>
              {systemStatus?.components.asterisk.installed ? (
                <CheckIcon color="success" sx={{ fontSize: 40 }} />
              ) : (
                <ErrorIcon color="error" sx={{ fontSize: 40 }} />
              )}
              <Typography variant="subtitle1" sx={{ mt: 1 }}>
                Asterisk
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {systemStatus?.components.asterisk.installed
                  ? `v${systemStatus.components.asterisk.version || '?'}`
                  : 'Non installé'}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        {/* chan_quectel */}
        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined">
            <CardContent sx={{ textAlign: 'center' }}>
              {systemStatus?.components.chanQuectel.installed ? (
                <CheckIcon color="success" sx={{ fontSize: 40 }} />
              ) : (
                <ErrorIcon color="error" sx={{ fontSize: 40 }} />
              )}
              <Typography variant="subtitle1" sx={{ mt: 1 }}>
                chan_quectel
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {systemStatus?.components.chanQuectel.installed
                  ? (systemStatus.components.chanQuectel.loaded ? 'Chargé' : 'Installé')
                  : 'Non installé'}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        {/* FreePBX */}
        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined">
            <CardContent sx={{ textAlign: 'center' }}>
              {systemStatus?.components.freepbx.installed ? (
                <CheckIcon color="success" sx={{ fontSize: 40 }} />
              ) : (
                <ErrorIcon color="disabled" sx={{ fontSize: 40 }} />
              )}
              <Typography variant="subtitle1" sx={{ mt: 1 }}>
                FreePBX
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {systemStatus?.components.freepbx.installed
                  ? `v${systemStatus.components.freepbx.version || '?'}`
                  : 'Optionnel'}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        {/* Gammu */}
        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined">
            <CardContent sx={{ textAlign: 'center' }}>
              {systemStatus?.components.gammu.installed ? (
                <CheckIcon color="success" sx={{ fontSize: 40 }} />
              ) : (
                <ErrorIcon color="disabled" sx={{ fontSize: 40 }} />
              )}
              <Typography variant="subtitle1" sx={{ mt: 1 }}>
                Gammu
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {systemStatus?.components.gammu.installed
                  ? `v${systemStatus.components.gammu.version || '?'}`
                  : 'Non installé'}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={loadSystemStatus}
          disabled={loading}
        >
          Actualiser
        </Button>
        <Button
          variant="contained"
          onClick={() => setActiveStep(1)}
          disabled={systemStatus?.modems.detected === 0}
        >
          Continuer
        </Button>
      </Box>
    </Box>
  );

  // Render selection step
  const renderSelectionStep = () => {
    const needsAsterisk = !systemStatus?.components.asterisk.installed;
    const needsChanQuectel = !systemStatus?.components.chanQuectel.installed;
    const canInstallFreePBX = systemStatus?.components.asterisk.installed && !systemStatus?.components.freepbx.installed;

    return (
      <Box>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Sélectionnez les composants à installer
        </Typography>

        {!needsAsterisk && !needsChanQuectel ? (
          <Alert severity="success" sx={{ mb: 3 }}>
            Asterisk et chan_quectel sont déjà installés. Vos modems devraient être opérationnels.
          </Alert>
        ) : (
          <Alert severity="info" sx={{ mb: 3 }}>
            L'installation prendra environ 15-20 minutes selon votre connexion et votre matériel.
          </Alert>
        )}

        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <FormControlLabel
              control={
                <Checkbox
                  checked={installOptions.asterisk}
                  onChange={(e) => setInstallOptions(prev => ({
                    ...prev,
                    asterisk: e.target.checked,
                    chanQuectel: e.target.checked ? prev.chanQuectel : false,
                  }))}
                  disabled={!needsAsterisk}
                />
              }
              label={
                <Box>
                  <Typography variant="subtitle1">
                    Asterisk {needsAsterisk ? '' : '(déjà installé)'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Serveur de téléphonie open-source. Nécessaire pour VoIP et modems GSM.
                  </Typography>
                </Box>
              }
            />
          </CardContent>
        </Card>

        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <FormControlLabel
              control={
                <Checkbox
                  checked={installOptions.chanQuectel}
                  onChange={(e) => setInstallOptions(prev => ({ ...prev, chanQuectel: e.target.checked }))}
                  disabled={!needsChanQuectel || (!installOptions.asterisk && needsAsterisk)}
                />
              }
              label={
                <Box>
                  <Typography variant="subtitle1">
                    chan_quectel {needsChanQuectel ? '' : '(déjà installé)'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Module Asterisk pour les modems SIM7600/EC25. Permet les appels et SMS via GSM.
                  </Typography>
                </Box>
              }
            />
          </CardContent>
        </Card>

        <Card variant="outlined" sx={{ mb: 2 }}>
          <CardContent>
            <FormControlLabel
              control={
                <Checkbox
                  checked={installOptions.configureModems}
                  onChange={(e) => setInstallOptions(prev => ({ ...prev, configureModems: e.target.checked }))}
                />
              }
              label={
                <Box>
                  <Typography variant="subtitle1">
                    Configuration automatique des modems
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Configure automatiquement les {systemStatus?.modems.detected || 0} modem(s) détecté(s).
                  </Typography>
                </Box>
              }
            />
          </CardContent>
        </Card>

        <Card variant="outlined" sx={{ mb: 2, opacity: canInstallFreePBX ? 1 : 0.5 }}>
          <CardContent>
            <FormControlLabel
              control={
                <Checkbox
                  checked={installOptions.freepbx}
                  onChange={(e) => setInstallOptions(prev => ({ ...prev, freepbx: e.target.checked }))}
                  disabled={!canInstallFreePBX && !installOptions.asterisk}
                />
              }
              label={
                <Box>
                  <Typography variant="subtitle1">
                    FreePBX (optionnel)
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Interface web pour Asterisk. Ajoute ~30 min d'installation.
                  </Typography>
                </Box>
              }
            />
          </CardContent>
        </Card>

        <Box sx={{ mt: 3, display: 'flex', justifyContent: 'space-between' }}>
          <Button variant="outlined" onClick={() => setActiveStep(0)}>
            Retour
          </Button>
          <Button
            variant="contained"
            color="primary"
            startIcon={<PlayIcon />}
            onClick={handleStartInstallation}
            disabled={!installOptions.asterisk && !installOptions.chanQuectel && !installOptions.freepbx}
          >
            Démarrer l'installation
          </Button>
        </Box>
      </Box>
    );
  };

  // Render installation step
  const renderInstallationStep = () => (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">
          Installation en cours...
        </Typography>
        {installStatus === 'connected' && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<CancelIcon />}
            onClick={handleCancelInstallation}
            size="small"
          >
            Annuler
          </Button>
        )}
      </Box>

      {/* Progress bar */}
      {progress && (
        <Box sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {progress.message}
            </Typography>
            <Typography variant="body2" fontWeight={600}>
              {progress.percent}%
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={progress.percent}
            sx={{
              height: 10,
              borderRadius: 5,
              backgroundColor: alpha(theme.palette.primary.main, 0.1),
              '& .MuiLinearProgress-bar': {
                borderRadius: 5,
              },
            }}
          />
        </Box>
      )}

      {/* Terminal */}
      <LiveTerminal logs={logs} height={350} />

      {/* Error alert */}
      {installError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {installError}
        </Alert>
      )}

      {/* Status indicator */}
      <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
        {installStatus === 'connecting' && (
          <>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">Connexion...</Typography>
          </>
        )}
        {installStatus === 'connected' && (
          <>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'success.main' }} />
            <Typography variant="body2" color="text.secondary">Installation en cours</Typography>
          </>
        )}
        {installStatus === 'error' && (
          <>
            <ErrorIcon color="error" fontSize="small" />
            <Typography variant="body2" color="error">Erreur</Typography>
          </>
        )}
      </Box>
    </Box>
  );

  // Render complete step
  const renderCompleteStep = () => (
    <Box sx={{ textAlign: 'center', py: 4 }}>
      <CheckIcon sx={{ fontSize: 80, color: 'success.main', mb: 2 }} />
      <Typography variant="h5" sx={{ mb: 2 }}>
        Installation Terminée!
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Asterisk et chan_quectel ont été installés avec succès.
        Vos modems GSM sont prêts à être configurés.
      </Typography>

      {systemStatus?.components.asterisk.running && (
        <Alert severity="success" sx={{ mb: 3, textAlign: 'left' }}>
          <Typography variant="body2">
            Asterisk est en cours d'exécution.
          </Typography>
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button
          variant="outlined"
          onClick={loadSystemStatus}
          startIcon={<RefreshIcon />}
        >
          Vérifier le statut
        </Button>
        <Button
          variant="contained"
          onClick={onComplete}
        >
          Configurer les modems
        </Button>
      </Box>
    </Box>
  );

  // Loading state
  if (loading && !systemStatus) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Error state
  if (error && !systemStatus) {
    return (
      <Alert severity="error">
        Erreur lors du chargement: {error}
        <Button onClick={loadSystemStatus} sx={{ ml: 2 }}>
          Réessayer
        </Button>
      </Alert>
    );
  }

  return (
    <Card>
      <CardContent>
        {/* Stepper */}
        <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
          {steps.map((step) => (
            <Step key={step.id}>
              <StepLabel>{step.label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {/* Step content */}
        {activeStep === 0 && renderDetectionStep()}
        {activeStep === 1 && renderSelectionStep()}
        {activeStep === 2 && renderInstallationStep()}
        {activeStep === 3 && renderCompleteStep()}
      </CardContent>
    </Card>
  );
}
