import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  TextField,
  Stepper,
  Step,
  StepLabel,
  Alert,
  CircularProgress,
  FormControl,
  FormControlLabel,
  Radio,
  RadioGroup,
  InputAdornment,
  IconButton,
  Divider,
  Chip,
  Grid,
  alpha,
  useTheme,
  Autocomplete,
  LinearProgress,
} from '@mui/material';
import {
  Visibility,
  VisibilityOff,
  CheckCircle as CheckCircleIcon,
  Warning as WarningIcon,
  Cloud as CloudIcon,
  Settings as SettingsIcon,
  Lock as LockIcon,
  NetworkCheck as NetworkIcon,
  SimCard as SimCardIcon,
  RocketLaunch as RocketIcon,
} from '@mui/icons-material';
import { useQuery, useMutation } from '@tanstack/react-query';
import { setupApi, type SetupStatus, type SystemSettings, type NetworkConfig, type ModemScanResult } from '../services/api';

// Step components
interface StepProps {
  onNext: () => void;
  onSkip?: () => void;
  setError: (error: string | null) => void;
}

// Step 0: Welcome
function WelcomeStep({ onNext }: StepProps) {
  return (
    <Box sx={{ textAlign: 'center', py: 4 }}>
      <Box
        sx={{
          width: 80,
          height: 80,
          borderRadius: 4,
          background: 'linear-gradient(135deg, #6366f1 0%, #22c55e 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          mx: 'auto',
          mb: 3,
        }}
      >
        <RocketIcon sx={{ fontSize: 40, color: 'white' }} />
      </Box>
      <Typography variant="h4" gutterBottom fontWeight={700}>
        Bienvenue sur Homenichat
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4, maxWidth: 500, mx: 'auto' }}>
        Ce wizard vous guidera pour configurer votre serveur Homenichat.
        Vous pourrez configurer le mot de passe admin, les parametres systeme,
        le reseau, les modems GSM et le service cloud.
      </Typography>
      <Button
        variant="contained"
        size="large"
        onClick={onNext}
        sx={{
          px: 4,
          py: 1.5,
          background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
        }}
      >
        Commencer la configuration
      </Button>
    </Box>
  );
}

// Step 1: Admin Password
function AdminPasswordStep({ onNext }: StepProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: { currentPassword?: string; newPassword: string; confirmPassword: string }) =>
      setupApi.setAdminPassword(data.newPassword, data.confirmPassword, data.currentPassword),
    onSuccess: () => {
      onNext();
    },
    onError: (error: Error & { response?: { data?: { error?: string } } }) => {
      setLocalError(error.response?.data?.error || error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (newPassword !== confirmPassword) {
      setLocalError('Les mots de passe ne correspondent pas');
      return;
    }

    if (newPassword.length < 8) {
      setLocalError('Le mot de passe doit contenir au moins 8 caracteres');
      return;
    }

    mutation.mutate({ currentPassword, newPassword, confirmPassword });
  };

  const getPasswordStrength = (password: string): { label: string; color: 'error' | 'warning' | 'success' } => {
    if (password.length < 8) return { label: 'Trop court', color: 'error' };
    if (password.length < 12) return { label: 'Moyen', color: 'warning' };
    if (/[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) {
      return { label: 'Fort', color: 'success' };
    }
    return { label: 'Bon', color: 'warning' };
  };

  const strength = newPassword ? getPasswordStrength(newPassword) : null;

  return (
    <Box sx={{ maxWidth: 450, mx: 'auto' }}>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <LockIcon sx={{ fontSize: 48, color: 'warning.main', mb: 2 }} />
        <Typography variant="h5" gutterBottom fontWeight={600}>
          Changer le mot de passe Admin
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Le mot de passe par defaut est <code>Homenichat</code>.
          Pour securiser votre serveur, vous devez le changer.
        </Typography>
      </Box>

      <Alert severity="warning" sx={{ mb: 3 }}>
        Cette etape est obligatoire. Vous ne pourrez pas terminer la configuration sans changer le mot de passe.
      </Alert>

      {localError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      )}

      <form onSubmit={handleSubmit}>
        <TextField
          fullWidth
          label="Mot de passe actuel"
          type={showPassword ? 'text' : 'password'}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          margin="normal"
          helperText="Laissez vide si c'est le mot de passe par defaut"
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton onClick={() => setShowPassword(!showPassword)} edge="end">
                  {showPassword ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              </InputAdornment>
            ),
          }}
        />

        <TextField
          fullWidth
          label="Nouveau mot de passe"
          type={showPassword ? 'text' : 'password'}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          margin="normal"
          required
          InputProps={{
            endAdornment: strength && (
              <InputAdornment position="end">
                <Chip label={strength.label} size="small" color={strength.color} />
              </InputAdornment>
            ),
          }}
        />

        <TextField
          fullWidth
          label="Confirmer le mot de passe"
          type={showPassword ? 'text' : 'password'}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          margin="normal"
          required
          error={confirmPassword !== '' && newPassword !== confirmPassword}
          helperText={
            confirmPassword !== '' && newPassword !== confirmPassword
              ? 'Les mots de passe ne correspondent pas'
              : 'Minimum 8 caracteres'
          }
        />

        <Button
          type="submit"
          fullWidth
          variant="contained"
          size="large"
          disabled={mutation.isPending || !newPassword || !confirmPassword}
          sx={{ mt: 3 }}
        >
          {mutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Enregistrer et continuer'}
        </Button>
      </form>
    </Box>
  );
}

// Step 2: System Settings
function SystemSettingsStep({ onNext, onSkip, setError }: StepProps) {
  const theme = useTheme();
  const [hostname, setHostname] = useState('');
  const [timezone, setTimezone] = useState('');
  const [timePreview, setTimePreview] = useState('');

  const { data: systemData, isLoading } = useQuery<SystemSettings>({
    queryKey: ['setup-system'],
    queryFn: setupApi.getSystemSettings,
  });

  useEffect(() => {
    if (systemData) {
      setHostname(systemData.hostname);
      setTimezone(systemData.timezone);
      setTimePreview(systemData.currentTime);
    }
  }, [systemData]);

  const mutation = useMutation({
    mutationFn: (data: { hostname: string; timezone: string }) =>
      setupApi.setSystemSettings(data.hostname, data.timezone),
    onSuccess: () => {
      onNext();
    },
    onError: (error: Error & { response?: { data?: { error?: string; details?: string } } }) => {
      setError(error.response?.data?.details || error.response?.data?.error || error.message);
    },
  });

  const skipMutation = useMutation({
    mutationFn: setupApi.skipSystemSettings,
    onSuccess: () => {
      onSkip?.();
    },
  });

  const handleTimezoneChange = async (tz: string) => {
    setTimezone(tz);
    // Preview time in new timezone
    try {
      const preview = await setupApi.getTimePreview(tz);
      setTimePreview(preview.currentTime);
    } catch {
      // Ignore preview errors
    }
  };

  if (isLoading) {
    return <LinearProgress />;
  }

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto' }}>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <SettingsIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
        <Typography variant="h5" gutterBottom fontWeight={600}>
          Parametres Systeme
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Configurez le nom d'hote et le fuseau horaire de votre serveur.
        </Typography>
      </Box>

      {!systemData?.isRoot && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          Homenichat n'est pas execute en tant que root. Certaines modifications systeme peuvent echouer.
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12}>
          <TextField
            fullWidth
            label="Nom d'hote"
            value={hostname}
            onChange={(e) => setHostname(e.target.value.toLowerCase())}
            helperText="Lettres minuscules, chiffres et tirets uniquement. Ex: homenichat-server"
            inputProps={{ pattern: '[a-z0-9-]+' }}
          />
        </Grid>

        <Grid item xs={12}>
          <Autocomplete
            value={timezone}
            onChange={(_, value) => value && handleTimezoneChange(value)}
            options={systemData?.commonTimezones || []}
            groupBy={(option) => option.split('/')[0]}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Fuseau horaire"
                helperText={timePreview ? `Heure actuelle: ${timePreview}` : undefined}
              />
            )}
          />
        </Grid>
      </Grid>

      <Box
        sx={{
          mt: 3,
          p: 2,
          borderRadius: 1,
          backgroundColor: alpha(theme.palette.info.main, 0.05),
        }}
      >
        <Typography variant="subtitle2" color="text.secondary">
          Informations systeme
        </Typography>
        <Typography variant="body2">
          Plateforme: {systemData?.systemInfo?.platform} {systemData?.systemInfo?.arch}
        </Typography>
        <Typography variant="body2">
          Node.js: {systemData?.systemInfo?.nodeVersion}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, mt: 4, justifyContent: 'flex-end' }}>
        <Button
          variant="text"
          onClick={() => skipMutation.mutate()}
          disabled={mutation.isPending || skipMutation.isPending}
        >
          Passer cette etape
        </Button>
        <Button
          variant="contained"
          onClick={() => mutation.mutate({ hostname, timezone })}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Enregistrer et continuer'}
        </Button>
      </Box>
    </Box>
  );
}

// Step 3: Network Configuration
function NetworkStep({ onNext, onSkip, setError }: StepProps) {
  const theme = useTheme();
  const [method, setMethod] = useState<'dhcp' | 'static'>('dhcp');
  const [ip, setIp] = useState('');
  const [gateway, setGateway] = useState('');
  const [dns, setDns] = useState('');

  const { data: networkData, isLoading } = useQuery<NetworkConfig>({
    queryKey: ['setup-network'],
    queryFn: setupApi.getNetworkConfig,
  });

  useEffect(() => {
    if (networkData?.currentConfig) {
      setMethod(networkData.currentConfig.method as 'dhcp' | 'static');
      if (networkData.currentConfig.ip) setIp(networkData.currentConfig.ip);
      if (networkData.currentConfig.gateway) setGateway(networkData.currentConfig.gateway);
      if (networkData.currentConfig.dns?.length) setDns(networkData.currentConfig.dns.join(', '));
    }
  }, [networkData]);

  const mutation = useMutation({
    mutationFn: (data: { connectionName: string; method: string; ip?: string; gateway?: string; dns?: string[] }) =>
      setupApi.setNetworkConfig(data),
    onSuccess: () => {
      onNext();
    },
    onError: (error: Error & { response?: { data?: { error?: string; details?: string } } }) => {
      setError(error.response?.data?.details || error.response?.data?.error || error.message);
    },
  });

  const skipMutation = useMutation({
    mutationFn: setupApi.skipNetworkConfig,
    onSuccess: () => {
      onSkip?.();
    },
  });

  const testMutation = useMutation({
    mutationFn: (host?: string) => setupApi.testNetwork(host),
    onSuccess: (data) => {
      if (data.success) {
        alert(`Connectivite OK! Latence: ${data.latency}ms`);
      } else {
        alert('Pas de connectivite Internet');
      }
    },
  });

  const handleSubmit = () => {
    if (!networkData?.primaryConnection) {
      setError('Aucune connexion reseau trouvee');
      return;
    }

    const config: { connectionName: string; method: string; ip?: string; gateway?: string; dns?: string[] } = {
      connectionName: networkData.primaryConnection,
      method,
    };

    if (method === 'static') {
      config.ip = ip;
      config.gateway = gateway;
      config.dns = dns.split(',').map((d) => d.trim()).filter((d) => d);
    }

    mutation.mutate(config);
  };

  if (isLoading) {
    return <LinearProgress />;
  }

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto' }}>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <NetworkIcon sx={{ fontSize: 48, color: 'info.main', mb: 2 }} />
        <Typography variant="h5" gutterBottom fontWeight={600}>
          Configuration Reseau
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Configurez l'adresse IP de votre serveur.
        </Typography>
      </Box>

      {!networkData?.nmcliAvailable && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          NetworkManager n'est pas disponible. La configuration automatique du reseau n'est pas possible.
        </Alert>
      )}

      <Box
        sx={{
          p: 2,
          borderRadius: 1,
          backgroundColor: alpha(theme.palette.success.main, 0.05),
          border: '1px solid',
          borderColor: alpha(theme.palette.success.main, 0.2),
          mb: 3,
        }}
      >
        <Typography variant="subtitle2" color="text.secondary">
          Configuration actuelle
        </Typography>
        <Typography variant="body1">
          IP: <strong>{networkData?.primaryIp || 'N/A'}</strong>
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Connexion: {networkData?.primaryConnection || 'N/A'}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
          <Chip
            size="small"
            icon={networkData?.connectivity?.success ? <CheckCircleIcon /> : <WarningIcon />}
            label={networkData?.connectivity?.success ? 'Connecte' : 'Hors ligne'}
            color={networkData?.connectivity?.success ? 'success' : 'error'}
          />
          <Button size="small" onClick={() => testMutation.mutate(undefined)} disabled={testMutation.isPending}>
            Tester
          </Button>
        </Box>
      </Box>

      <FormControl component="fieldset" sx={{ mb: 3 }}>
        <RadioGroup value={method} onChange={(e) => setMethod(e.target.value as 'dhcp' | 'static')}>
          <FormControlLabel value="dhcp" control={<Radio />} label="DHCP (automatique)" />
          <FormControlLabel value="static" control={<Radio />} label="IP statique" />
        </RadioGroup>
      </FormControl>

      {method === 'static' && (
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TextField
              fullWidth
              label="Adresse IP"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.100/24"
              helperText="Format CIDR (ex: 192.168.1.100/24)"
              required
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              fullWidth
              label="Passerelle"
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
              placeholder="192.168.1.1"
              required
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              fullWidth
              label="Serveurs DNS"
              value={dns}
              onChange={(e) => setDns(e.target.value)}
              placeholder="8.8.8.8, 8.8.4.4"
              helperText="Separes par des virgules"
            />
          </Grid>
        </Grid>
      )}

      <Alert severity="info" sx={{ mt: 3 }}>
        Attention: modifier la configuration reseau peut causer une perte de connexion temporaire.
      </Alert>

      <Box sx={{ display: 'flex', gap: 2, mt: 4, justifyContent: 'flex-end' }}>
        <Button
          variant="text"
          onClick={() => skipMutation.mutate()}
          disabled={mutation.isPending || skipMutation.isPending}
        >
          Passer cette etape
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={mutation.isPending || !networkData?.nmcliAvailable}
        >
          {mutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Appliquer et continuer'}
        </Button>
      </Box>
    </Box>
  );
}

// Step 4: Modem Configuration
function ModemStep({ onNext, onSkip, setError }: StepProps) {
  const [pinCode, setPinCode] = useState('');
  const [networkMode, setNetworkMode] = useState<'auto' | 'lte' | '3g'>('lte');

  const { data: modemData, isLoading, refetch } = useQuery<ModemScanResult>({
    queryKey: ['setup-modem'],
    queryFn: setupApi.scanModems,
  });

  const configureMutation = useMutation({
    mutationFn: (data: { modemType: string; dataPort: string; audioPort?: string; pinCode?: string; networkMode?: 'auto' | 'lte' | '3g' }) =>
      setupApi.configureModem(data),
    onSuccess: () => {
      onNext();
    },
    onError: (error: Error & { response?: { data?: { error?: string; details?: string } } }) => {
      setError(error.response?.data?.details || error.response?.data?.error || error.message);
    },
  });

  const skipMutation = useMutation({
    mutationFn: setupApi.skipModemConfig,
    onSuccess: () => {
      onSkip?.();
    },
  });

  // Auto-select first detected modem
  const detectedModem = modemData?.detected?.[0] || null;

  const handleConfigure = () => {
    if (!detectedModem) return;

    configureMutation.mutate({
      modemType: detectedModem.type.toLowerCase(),
      dataPort: detectedModem.dataPort,
      audioPort: detectedModem.audioPort,
      pinCode: pinCode || undefined,
      networkMode,
    });
  };

  if (isLoading) {
    return <LinearProgress />;
  }

  const hasModems = (modemData?.detected?.length || 0) > 0;
  const hasExisting = Object.keys(modemData?.existing || {}).length > 0;

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto' }}>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <SimCardIcon sx={{ fontSize: 48, color: 'secondary.main', mb: 2 }} />
        <Typography variant="h5" gutterBottom fontWeight={600}>
          Configuration Modem GSM
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Configurez votre modem GSM pour les SMS et appels.
        </Typography>
      </Box>

      {!hasModems && !hasExisting && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Aucun modem GSM detecte. Verifiez que le modem est bien branche en USB.
          <Button size="small" onClick={() => refetch()} sx={{ ml: 2 }}>
            Rescanner
          </Button>
        </Alert>
      )}

      {detectedModem && (
        <Box sx={{ mb: 3 }}>
          <Alert severity="success" sx={{ mb: 3 }}>
            <Typography variant="subtitle2" fontWeight={600}>
              Modem detecte: {detectedModem.type.toUpperCase()}
            </Typography>
            <Typography variant="body2">
              Ports: {detectedModem.dataPort} (data), {detectedModem.audioPort} (audio)
            </Typography>
          </Alert>

          <TextField
            fullWidth
            label="Code PIN (si carte SIM protegee)"
            value={pinCode}
            onChange={(e) => setPinCode(e.target.value)}
            placeholder="1234"
            type="password"
            helperText="Laissez vide si la carte SIM n'a pas de code PIN"
            sx={{ mb: 3 }}
          />

          <FormControl component="fieldset">
            <Typography variant="subtitle2" gutterBottom>
              Mode reseau
            </Typography>
            <RadioGroup
              row
              value={networkMode}
              onChange={(e) => setNetworkMode(e.target.value as 'auto' | 'lte' | '3g')}
            >
              <FormControlLabel value="lte" control={<Radio />} label="LTE/4G (recommande)" />
              <FormControlLabel value="3g" control={<Radio />} label="3G uniquement" />
              <FormControlLabel value="auto" control={<Radio />} label="Automatique" />
            </RadioGroup>
          </FormControl>
        </Box>
      )}

      {hasExisting && !hasModems && (
        <Alert severity="success" sx={{ mt: 3 }}>
          Modem deja configure. Vous pouvez continuer.
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 2, mt: 4, justifyContent: 'flex-end' }}>
        <Button
          variant="text"
          onClick={() => skipMutation.mutate()}
          disabled={configureMutation.isPending || skipMutation.isPending}
        >
          {hasModems || hasExisting ? 'Passer' : 'Continuer sans modem'}
        </Button>
        {(detectedModem || hasExisting) && (
          <Button
            variant="contained"
            onClick={hasExisting && !detectedModem ? onNext : handleConfigure}
            disabled={configureMutation.isPending}
          >
            {configureMutation.isPending ? <CircularProgress size={24} color="inherit" /> : 'Continuer'}
          </Button>
        )}
      </Box>
    </Box>
  );
}

// Step 5: Homenichat Cloud
function CloudStep({ onNext, onSkip }: StepProps) {
  const theme = useTheme();
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const { data: cloudStatus } = useQuery({
    queryKey: ['setup-cloud'],
    queryFn: setupApi.getCloudStatus,
  });

  const loginMutation = useMutation({
    mutationFn: (data: { email: string; password: string }) =>
      setupApi.cloudLogin(data.email, data.password),
    onSuccess: () => {
      onNext();
    },
    onError: (error: Error & { response?: { data?: { error?: string; details?: string } } }) => {
      setLocalError(error.response?.data?.details || error.response?.data?.error || error.message);
    },
  });

  const registerMutation = useMutation({
    mutationFn: (data: { email: string; password: string; name?: string }) =>
      setupApi.cloudRegister(data.email, data.password, data.name),
    onSuccess: () => {
      onNext();
    },
    onError: (error: Error & { response?: { data?: { error?: string; details?: string } } }) => {
      setLocalError(error.response?.data?.details || error.response?.data?.error || error.message);
    },
  });

  const skipMutation = useMutation({
    mutationFn: setupApi.skipCloudConfig,
    onSuccess: () => {
      onSkip?.();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (!email || !password) {
      setLocalError('Email et mot de passe requis');
      return;
    }

    if (isRegistering) {
      if (password.length < 8) {
        setLocalError('Le mot de passe doit contenir au moins 8 caracteres');
        return;
      }
      registerMutation.mutate({ email, password, name });
    } else {
      loginMutation.mutate({ email, password });
    }
  };

  const isMutating = loginMutation.isPending || registerMutation.isPending || skipMutation.isPending;

  return (
    <Box sx={{ maxWidth: 500, mx: 'auto' }}>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <CloudIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
        <Typography variant="h5" gutterBottom fontWeight={600}>
          Homenichat Cloud
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Connectez-vous a Homenichat Cloud pour activer les notifications push
          et l'acces a distance securise.
        </Typography>
      </Box>

      <Alert severity="info" sx={{ mb: 3 }}>
        <Typography variant="body2" fontWeight={500}>
          Un seul compte pour tout:
        </Typography>
        <Typography variant="caption">
          Push Notifications iOS/Android + Tunnel VPN securise + TURN WebRTC
        </Typography>
      </Alert>

      {localError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      )}

      {cloudStatus?.loggedIn ? (
        <Box
          sx={{
            p: 3,
            borderRadius: 2,
            backgroundColor: alpha(theme.palette.success.main, 0.1),
            border: '1px solid',
            borderColor: alpha(theme.palette.success.main, 0.3),
            textAlign: 'center',
          }}
        >
          <CheckCircleIcon sx={{ fontSize: 48, color: 'success.main', mb: 2 }} />
          <Typography variant="h6" gutterBottom>
            Deja connecte!
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {cloudStatus.email}
          </Typography>
          <Button variant="contained" onClick={onNext} sx={{ mt: 2 }}>
            Continuer
          </Button>
        </Box>
      ) : (
        <form onSubmit={handleSubmit}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            {isRegistering ? 'Creer un compte Homenichat Cloud' : 'Se connecter a Homenichat Cloud'}
          </Typography>

          {isRegistering && (
            <TextField
              fullWidth
              label="Nom (optionnel)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              margin="normal"
              placeholder="Votre nom ou celui de votre entreprise"
            />
          )}

          <TextField
            fullWidth
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            margin="normal"
            required
          />

          <TextField
            fullWidth
            label="Mot de passe"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            margin="normal"
            required
            helperText={isRegistering ? 'Minimum 8 caracteres' : undefined}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton onClick={() => setShowPassword(!showPassword)} edge="end">
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />

          <Box sx={{ display: 'flex', gap: 1, mt: 2, alignItems: 'center' }}>
            <Button
              type="submit"
              variant="contained"
              disabled={isMutating || !email || !password}
            >
              {isMutating ? (
                <CircularProgress size={24} color="inherit" />
              ) : isRegistering ? (
                'Creer le compte'
              ) : (
                'Se connecter'
              )}
            </Button>
            <Button variant="text" onClick={() => setIsRegistering(!isRegistering)}>
              {isRegistering ? 'Deja un compte?' : 'Creer un compte'}
            </Button>
          </Box>
        </form>
      )}

      <Divider sx={{ my: 3 }} />

      <Box sx={{ textAlign: 'center' }}>
        <Button
          variant="text"
          onClick={() => skipMutation.mutate()}
          disabled={isMutating}
        >
          Passer cette etape (configuration locale uniquement)
        </Button>
        <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 1 }}>
          Vous pourrez configurer Homenichat Cloud plus tard dans les parametres.
        </Typography>
      </Box>
    </Box>
  );
}

// Step 6: Summary
function SummaryStep(_props: StepProps) {
  const theme = useTheme();
  const navigate = useNavigate();

  const { data: summary, isLoading } = useQuery({
    queryKey: ['setup-summary'],
    queryFn: setupApi.getSummary,
  });

  const completeMutation = useMutation({
    mutationFn: setupApi.completeSetup,
    onSuccess: () => {
      navigate('/');
    },
  });

  if (isLoading) {
    return <LinearProgress />;
  }

  const items = [
    {
      label: 'Mot de passe Admin',
      configured: summary?.adminPassword?.configured,
      status: summary?.adminPassword?.status,
      icon: <LockIcon />,
    },
    {
      label: 'Parametres systeme',
      configured: summary?.system?.configured,
      skipped: summary?.system?.skipped,
      details: summary?.system?.configured ? `${summary.system.hostname} (${summary.system.timezone})` : undefined,
      icon: <SettingsIcon />,
    },
    {
      label: 'Reseau',
      configured: summary?.network?.configured,
      skipped: summary?.network?.skipped,
      details: summary?.network?.ip,
      icon: <NetworkIcon />,
    },
    {
      label: 'Modem GSM',
      configured: summary?.modem?.configured,
      skipped: summary?.modem?.skipped,
      details: summary?.modem?.modems?.join(', '),
      icon: <SimCardIcon />,
    },
    {
      label: 'Homenichat Cloud',
      configured: summary?.cloud?.configured && summary?.cloud?.loggedIn,
      skipped: summary?.cloud?.skipped,
      details: summary?.cloud?.email,
      icon: <CloudIcon />,
    },
  ];

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto' }}>
      <Box sx={{ textAlign: 'center', mb: 4 }}>
        <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main', mb: 2 }} />
        <Typography variant="h4" gutterBottom fontWeight={700}>
          Configuration terminee!
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Voici un resume de votre configuration.
        </Typography>
      </Box>

      <Box sx={{ mb: 4 }}>
        {items.map((item, index) => (
          <Box
            key={index}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              p: 2,
              borderRadius: 1,
              mb: 1,
              backgroundColor: item.configured
                ? alpha(theme.palette.success.main, 0.05)
                : item.skipped
                ? alpha(theme.palette.grey[500], 0.05)
                : alpha(theme.palette.warning.main, 0.05),
              border: '1px solid',
              borderColor: item.configured
                ? alpha(theme.palette.success.main, 0.2)
                : item.skipped
                ? alpha(theme.palette.grey[500], 0.2)
                : alpha(theme.palette.warning.main, 0.2),
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ color: item.configured ? 'success.main' : 'text.secondary' }}>
                {item.icon}
              </Box>
              <Box>
                <Typography variant="subtitle2">{item.label}</Typography>
                {item.details && (
                  <Typography variant="caption" color="text.secondary">
                    {item.details}
                  </Typography>
                )}
              </Box>
            </Box>
            <Chip
              size="small"
              label={item.configured ? 'Configure' : item.skipped ? 'Ignore' : 'Non configure'}
              color={item.configured ? 'success' : 'default'}
              variant={item.configured ? 'filled' : 'outlined'}
            />
          </Box>
        ))}
      </Box>

      <Alert severity="success" sx={{ mb: 3 }}>
        Votre serveur Homenichat est pret a etre utilise!
      </Alert>

      <Button
        fullWidth
        variant="contained"
        size="large"
        onClick={() => completeMutation.mutate()}
        disabled={completeMutation.isPending}
        sx={{
          py: 1.5,
          background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
          '&:hover': {
            background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
          },
        }}
      >
        {completeMutation.isPending ? (
          <CircularProgress size={24} color="inherit" />
        ) : (
          'Terminer et acceder au dashboard'
        )}
      </Button>
    </Box>
  );
}

// Main Setup Wizard Page
export default function SetupWizardPage() {
  const navigate = useNavigate();
  const [activeStep, setActiveStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<SetupStatus>({
    queryKey: ['setup-status'],
    queryFn: setupApi.getStatus,
  });

  useEffect(() => {
    if (status) {
      if (status.setupComplete) {
        navigate('/');
        return;
      }
      // Resume from last step
      if (status.currentStep > 0) {
        setActiveStep(status.currentStep);
      }
    }
  }, [status, navigate]);

  const steps = [
    { label: 'Bienvenue', icon: <RocketIcon /> },
    { label: 'Mot de passe', icon: <LockIcon /> },
    { label: 'Systeme', icon: <SettingsIcon /> },
    { label: 'Reseau', icon: <NetworkIcon /> },
    { label: 'Modem', icon: <SimCardIcon /> },
    { label: 'Cloud', icon: <CloudIcon /> },
    { label: 'Terminer', icon: <CheckCircleIcon /> },
  ];

  const handleNext = () => {
    setError(null);
    setActiveStep((prev) => Math.min(prev + 1, steps.length - 1));
  };

  const handleSkip = () => {
    setError(null);
    setActiveStep((prev) => Math.min(prev + 1, steps.length - 1));
  };

  if (isLoading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        py: 4,
        px: 2,
      }}
    >
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        {/* Header */}
        <Box sx={{ textAlign: 'center', mb: 4 }}>
          <Typography variant="h5" color="text.secondary" fontWeight={600}>
            Configuration initiale
          </Typography>
        </Box>

        {/* Stepper */}
        <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 4 }}>
          {steps.map((step, index) => (
            <Step key={index}>
              <StepLabel>{step.label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {/* Error Display */}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Step Content */}
        <Card sx={{ p: 4 }}>
          <CardContent>
            {activeStep === 0 && <WelcomeStep onNext={handleNext} setError={setError} />}
            {activeStep === 1 && <AdminPasswordStep onNext={handleNext} setError={setError} />}
            {activeStep === 2 && <SystemSettingsStep onNext={handleNext} onSkip={handleSkip} setError={setError} />}
            {activeStep === 3 && <NetworkStep onNext={handleNext} onSkip={handleSkip} setError={setError} />}
            {activeStep === 4 && <ModemStep onNext={handleNext} onSkip={handleSkip} setError={setError} />}
            {activeStep === 5 && <CloudStep onNext={handleNext} onSkip={handleSkip} setError={setError} />}
            {activeStep === 6 && <SummaryStep onNext={handleNext} setError={setError} />}
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
