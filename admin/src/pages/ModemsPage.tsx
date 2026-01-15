import { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Grid,
  Chip,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Tooltip,
  alpha,
  useTheme,
  CircularProgress,
  Tabs,
  Tab,
  Paper,
  Divider,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Send as SendIcon,
  Refresh as RefreshIcon,
  SimCard as SimCardIcon,
  Usb as UsbIcon,
  SignalCellular4Bar as SignalIcon,
  Terminal as TerminalIcon,
  RestartAlt as RestartIcon,
  VolumeUp as AudioIcon,
  Visibility as ViewIcon,
  Memory as MemoryIcon,
  Storage as StorageIcon,
  Speed as SpeedIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  Warning as WarningIcon,
  PlayArrow as PlayIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Extended types for modem management
interface ModemStatus {
  id: string;
  name: string;
  number: string;
  state: string;
  rssi: number;
  rssiDbm: number;
  rssiPercent: number;
  technology: string;
  operator: string;
  registered: boolean;
  voice: boolean;
  sms: boolean;
  callsActive: number;
  imei: string;
  model: string;
  sipPort: number;
}

interface ModemStats {
  incomingCalls: number;
  outgoingCalls: number;
  answeredIncoming: number;
  answeredOutgoing: number;
  secondsIncoming: number;
  secondsOutgoing: number;
}

interface SystemStatus {
  cpuPercent: number;
  ramPercent: number;
  ramUsedGb: number;
  ramTotalGb: number;
  diskPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  uptimeSeconds: number;
  uptimeHuman: string;
}

interface ServiceStatus {
  asterisk: { active: boolean; status: string };
  smsBridge: { active: boolean; status: string };
  smsGateway: { active: boolean; status: string };
  watchdog: { active: boolean; status: string };
  allOk: boolean;
}

interface UsbStatus {
  portsCount: number;
  portsExpected: number;
  ports: string[];
  symlinks: string[];
  ok: boolean;
}

interface WatchdogLog {
  timestamp: string;
  level: string;
  message: string;
}

interface FullModemData {
  timestamp: string;
  modems: Record<string, { status: ModemStatus; stats: ModemStats }>;
  services: ServiceStatus;
  system: SystemStatus;
  usb: UsbStatus;
}

// API functions
const modemsApi = {
  getFullStatus: async (): Promise<FullModemData> => {
    const response = await fetch('/api/admin/modems/full-status', {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to fetch modem status');
    return response.json();
  },

  getWatchdogLogs: async (lines = 30): Promise<WatchdogLog[]> => {
    const response = await fetch(`/api/admin/modems/watchdog-logs?lines=${lines}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to fetch watchdog logs');
    return response.json();
  },

  restartModem: async (modemId: string): Promise<{ success: boolean; result: string }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to restart modem');
    return response.json();
  },

  sendAtCommand: async (modemId: string, command: string): Promise<{ success: boolean; result: string }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/at-command`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command }),
    });
    if (!response.ok) throw new Error('Failed to send AT command');
    return response.json();
  },

  sendSms: async (modemId: string, to: string, message: string): Promise<{ success: boolean; result: string }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, message }),
    });
    if (!response.ok) throw new Error('Failed to send SMS');
    return response.json();
  },

  configureAudio: async (modemId: string): Promise<{ success: boolean; results: Record<string, string> }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/configure-audio`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to configure audio');
    return response.json();
  },

  restartAsterisk: async (): Promise<{ success: boolean; result: string }> => {
    const response = await fetch('/api/admin/modems/restart-asterisk', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to restart Asterisk');
    return response.json();
  },
};

// Signal strength component
function SignalBars({ rssi, rssiPercent }: { rssi: number; rssiPercent: number }) {
  const theme = useTheme();
  const bars = Math.min(5, Math.max(0, Math.ceil(rssiPercent / 20)));
  const getColor = () => {
    if (rssiPercent >= 60) return theme.palette.success.main;
    if (rssiPercent >= 30) return theme.palette.warning.main;
    return theme.palette.error.main;
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.3 }}>
      {[1, 2, 3, 4, 5].map((bar) => (
        <Box
          key={bar}
          sx={{
            width: 4,
            height: 4 + bar * 4,
            backgroundColor: bar <= bars ? getColor() : theme.palette.action.disabled,
            borderRadius: 0.5,
          }}
        />
      ))}
      <Typography variant="caption" sx={{ ml: 1, color: getColor() }}>
        {rssi} ({rssiPercent}%)
      </Typography>
    </Box>
  );
}

// Status chip component
function StatusChip({ active, label }: { active: boolean; label: string }) {
  return (
    <Chip
      icon={active ? <CheckIcon /> : <ErrorIcon />}
      label={label}
      size="small"
      color={active ? 'success' : 'error'}
      variant="outlined"
      sx={{ minWidth: 100 }}
    />
  );
}

export default function ModemsPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [selectedTab, setSelectedTab] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Dialogs
  const [atDialogOpen, setAtDialogOpen] = useState(false);
  const [smsDialogOpen, setSmsDialogOpen] = useState(false);
  const [selectedModemId, setSelectedModemId] = useState<string | null>(null);
  const [atCommand, setAtCommand] = useState('AT+CSQ');
  const [smsTo, setSmsTo] = useState('');
  const [smsMessage, setSmsMessage] = useState('Test SMS depuis Homenichat Admin');
  const [actionResult, setActionResult] = useState<{ success: boolean; message: string } | null>(null);

  // Queries
  const { data: fullStatus, isLoading, error, refetch } = useQuery({
    queryKey: ['modemFullStatus'],
    queryFn: modemsApi.getFullStatus,
    refetchInterval: autoRefresh ? 10000 : false,
    retry: 2,
  });

  const { data: watchdogLogs } = useQuery({
    queryKey: ['watchdogLogs'],
    queryFn: () => modemsApi.getWatchdogLogs(30),
    refetchInterval: autoRefresh ? 30000 : false,
  });

  // Mutations
  const restartModemMutation = useMutation({
    mutationFn: (modemId: string) => modemsApi.restartModem(modemId),
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.result });
      queryClient.invalidateQueries({ queryKey: ['modemFullStatus'] });
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  const atCommandMutation = useMutation({
    mutationFn: ({ modemId, command }: { modemId: string; command: string }) =>
      modemsApi.sendAtCommand(modemId, command),
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.result });
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  const sendSmsMutation = useMutation({
    mutationFn: ({ modemId, to, message }: { modemId: string; to: string; message: string }) =>
      modemsApi.sendSms(modemId, to, message),
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.result });
      setSmsDialogOpen(false);
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  const configureAudioMutation = useMutation({
    mutationFn: (modemId: string) => modemsApi.configureAudio(modemId),
    onSuccess: (result) => {
      setActionResult({
        success: result.success,
        message: Object.entries(result.results).map(([k, v]) => `${k}: ${v}`).join('\n'),
      });
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  const restartAsteriskMutation = useMutation({
    mutationFn: modemsApi.restartAsterisk,
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.result });
      queryClient.invalidateQueries({ queryKey: ['modemFullStatus'] });
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  // Handlers
  const handleAtCommand = () => {
    if (selectedModemId && atCommand) {
      atCommandMutation.mutate({ modemId: selectedModemId, command: atCommand });
    }
  };

  const handleSendSms = () => {
    if (selectedModemId && smsTo && smsMessage) {
      sendSmsMutation.mutate({ modemId: selectedModemId, to: smsTo, message: smsMessage });
    }
  };

  const openAtDialog = (modemId: string) => {
    setSelectedModemId(modemId);
    setAtCommand('AT+CSQ');
    setActionResult(null);
    setAtDialogOpen(true);
  };

  const openSmsDialog = (modemId: string) => {
    setSelectedModemId(modemId);
    setSmsTo('');
    setSmsMessage('Test SMS depuis Homenichat Admin');
    setActionResult(null);
    setSmsDialogOpen(true);
  };

  const modemsList = fullStatus?.modems ? Object.entries(fullStatus.modems) : [];

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          Impossible de charger le statut des modems: {(error as Error).message}
        </Alert>
        <Alert severity="info">
          Assurez-vous que le service de surveillance des modems est actif et configuré.
          Cette fonctionnalité nécessite un accès au serveur Asterisk avec chan_quectel.
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Modems GSM
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Surveillance et gestion des modems GSM (SIM7600, EC25)
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <FormControlLabel
            control={
              <Switch
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                color="primary"
              />
            }
            label="Auto-refresh"
          />
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => refetch()}
            disabled={isLoading}
          >
            Actualiser
          </Button>
          <Button
            variant="contained"
            color="warning"
            startIcon={<RestartIcon />}
            onClick={() => restartAsteriskMutation.mutate()}
            disabled={restartAsteriskMutation.isPending}
          >
            Restart Asterisk
          </Button>
        </Box>
      </Box>

      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      {/* Tabs for each modem */}
      {modemsList.length > 0 && (
        <Paper sx={{ mb: 3 }}>
          <Tabs
            value={selectedTab}
            onChange={(_, newValue) => setSelectedTab(newValue)}
            variant="fullWidth"
          >
            {modemsList.map(([modemId, data], index) => (
              <Tab
                key={modemId}
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <SimCardIcon />
                    {data.status.name || modemId}
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        backgroundColor:
                          data.status.state === 'Free'
                            ? theme.palette.success.main
                            : data.status.state === 'Unknown'
                            ? theme.palette.error.main
                            : theme.palette.warning.main,
                      }}
                    />
                  </Box>
                }
              />
            ))}
          </Tabs>
        </Paper>
      )}

      {modemsList.length === 0 && !isLoading && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Aucun modem détecté. Vérifiez la connexion USB et la configuration chan_quectel.
        </Alert>
      )}

      {/* Modem Content */}
      {modemsList.map(([modemId, data], index) => (
        <Box key={modemId} sx={{ display: selectedTab === index ? 'block' : 'none' }}>
          <Grid container spacing={3}>
            {/* Modem Status Card */}
            <Grid item xs={12} md={4}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <SimCardIcon sx={{ mr: 1, color: 'primary.main' }} />
                    <Typography variant="h6" sx={{ fontWeight: 600, flex: 1 }}>
                      {data.status.name || modemId}
                    </Typography>
                    <Chip
                      label={data.status.state}
                      size="small"
                      color={
                        data.status.state === 'Free'
                          ? 'success'
                          : data.status.state === 'Unknown'
                          ? 'error'
                          : 'warning'
                      }
                    />
                  </Box>

                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Numero</Typography>
                      <Typography fontWeight={500}>{data.status.number || '-'}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Technologie</Typography>
                      <Typography fontWeight={500}>{data.status.technology || '-'}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Operateur</Typography>
                      <Typography fontWeight={500}>{data.status.operator || '-'}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Port SIP</Typography>
                      <Typography fontWeight={500}>{data.status.sipPort}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">Appels actifs</Typography>
                      <Typography fontWeight={500}>{data.status.callsActive}</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography color="text.secondary">IMEI</Typography>
                      <Typography fontWeight={500} sx={{ fontSize: '0.75rem' }}>
                        {data.status.imei || '-'}
                      </Typography>
                    </Box>
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            {/* Signal Card */}
            <Grid item xs={12} md={4}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <SignalIcon sx={{ mr: 1, color: 'info.main' }} />
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Signal
                    </Typography>
                  </Box>

                  <Box sx={{ textAlign: 'center', py: 2 }}>
                    <Typography variant="h2" sx={{ fontWeight: 700, color: 'primary.main' }}>
                      {data.status.rssi}
                    </Typography>
                    <Typography variant="body1" color="text.secondary">
                      {data.status.rssiDbm} dBm
                    </Typography>
                    <Box sx={{ mt: 2 }}>
                      <SignalBars rssi={data.status.rssi} rssiPercent={data.status.rssiPercent} />
                    </Box>
                    <Box sx={{ mt: 2 }}>
                      <LinearProgress
                        variant="determinate"
                        value={data.status.rssiPercent}
                        sx={{
                          height: 10,
                          borderRadius: 5,
                          backgroundColor: alpha(theme.palette.primary.main, 0.1),
                        }}
                      />
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                      {data.status.rssiPercent >= 60
                        ? 'Excellent'
                        : data.status.rssiPercent >= 40
                        ? 'Bon'
                        : data.status.rssiPercent >= 20
                        ? 'Moyen'
                        : 'Faible'}
                    </Typography>
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            {/* Stats Card */}
            <Grid item xs={12} md={4}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <SpeedIcon sx={{ mr: 1, color: 'success.main' }} />
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Statistiques
                    </Typography>
                  </Box>

                  <Grid container spacing={2}>
                    <Grid item xs={6}>
                      <Box sx={{ textAlign: 'center', p: 1, bgcolor: alpha(theme.palette.info.main, 0.1), borderRadius: 2 }}>
                        <Typography variant="h4" fontWeight={700} color="info.main">
                          {data.stats.incomingCalls}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Appels entrants
                        </Typography>
                      </Box>
                    </Grid>
                    <Grid item xs={6}>
                      <Box sx={{ textAlign: 'center', p: 1, bgcolor: alpha(theme.palette.success.main, 0.1), borderRadius: 2 }}>
                        <Typography variant="h4" fontWeight={700} color="success.main">
                          {data.stats.outgoingCalls}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Appels sortants
                        </Typography>
                      </Box>
                    </Grid>
                    <Grid item xs={12}>
                      <Box sx={{ textAlign: 'center', p: 1, bgcolor: alpha(theme.palette.primary.main, 0.1), borderRadius: 2 }}>
                        <Typography variant="h5" fontWeight={700} color="primary.main">
                          {Math.round((data.stats.secondsIncoming + data.stats.secondsOutgoing) / 60)}m
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Duree totale
                        </Typography>
                      </Box>
                    </Grid>
                  </Grid>
                </CardContent>
              </Card>
            </Grid>

            {/* Actions Card */}
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <PlayIcon sx={{ mr: 1, color: 'warning.main' }} />
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Actions
                    </Typography>
                  </Box>

                  <Grid container spacing={1}>
                    <Grid item xs={6}>
                      <Button
                        fullWidth
                        variant="outlined"
                        startIcon={<RestartIcon />}
                        onClick={() => restartModemMutation.mutate(modemId)}
                        disabled={restartModemMutation.isPending}
                      >
                        Restart Modem
                      </Button>
                    </Grid>
                    <Grid item xs={6}>
                      <Button
                        fullWidth
                        variant="outlined"
                        startIcon={<TerminalIcon />}
                        onClick={() => openAtDialog(modemId)}
                      >
                        Commande AT
                      </Button>
                    </Grid>
                    <Grid item xs={6}>
                      <Button
                        fullWidth
                        variant="outlined"
                        startIcon={<SendIcon />}
                        onClick={() => openSmsDialog(modemId)}
                      >
                        Envoyer SMS
                      </Button>
                    </Grid>
                    <Grid item xs={6}>
                      <Button
                        fullWidth
                        variant="outlined"
                        startIcon={<AudioIcon />}
                        onClick={() => configureAudioMutation.mutate(modemId)}
                        disabled={configureAudioMutation.isPending}
                      >
                        Config Audio 16kHz
                      </Button>
                    </Grid>
                  </Grid>

                  {actionResult && (
                    <Alert severity={actionResult.success ? 'success' : 'error'} sx={{ mt: 2 }}>
                      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        {actionResult.message}
                      </pre>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            </Grid>

            {/* Services Card */}
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <MemoryIcon sx={{ mr: 1, color: 'secondary.main' }} />
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Services
                    </Typography>
                  </Box>

                  <Grid container spacing={1}>
                    <Grid item xs={6}>
                      <StatusChip
                        active={fullStatus?.services?.asterisk?.active || false}
                        label="Asterisk"
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <StatusChip
                        active={fullStatus?.services?.smsBridge?.active || false}
                        label="SMS Bridge"
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <StatusChip
                        active={fullStatus?.services?.smsGateway?.active || false}
                        label="SMS Gateway"
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <StatusChip
                        active={fullStatus?.services?.watchdog?.active || false}
                        label="Watchdog"
                      />
                    </Grid>
                  </Grid>

                  <Divider sx={{ my: 2 }} />

                  {/* System metrics */}
                  <Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="body2">CPU</Typography>
                      <Typography variant="body2">{fullStatus?.system?.cpuPercent?.toFixed(1)}%</Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={fullStatus?.system?.cpuPercent || 0}
                      sx={{ mb: 1, height: 6, borderRadius: 3 }}
                    />

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="body2">RAM</Typography>
                      <Typography variant="body2">{fullStatus?.system?.ramPercent?.toFixed(1)}%</Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={fullStatus?.system?.ramPercent || 0}
                      sx={{ mb: 1, height: 6, borderRadius: 3 }}
                      color="secondary"
                    />

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="body2">Disque</Typography>
                      <Typography variant="body2">{fullStatus?.system?.diskPercent?.toFixed(1)}%</Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={fullStatus?.system?.diskPercent || 0}
                      sx={{ height: 6, borderRadius: 3 }}
                      color="warning"
                    />

                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                      Uptime: {fullStatus?.system?.uptimeHuman || '-'}
                    </Typography>
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            {/* USB Status Card */}
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <UsbIcon sx={{ mr: 1, color: 'info.main' }} />
                    <Typography variant="h6" sx={{ fontWeight: 600, flex: 1 }}>
                      Ports USB
                    </Typography>
                    <Chip
                      label={fullStatus?.usb?.ok ? 'OK' : 'Probleme'}
                      size="small"
                      color={fullStatus?.usb?.ok ? 'success' : 'error'}
                    />
                  </Box>

                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {fullStatus?.usb?.portsCount || 0} / {fullStatus?.usb?.portsExpected || 10} ports detectes
                  </Typography>

                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {fullStatus?.usb?.ports?.map((port) => (
                      <Chip key={port} label={port} size="small" variant="outlined" />
                    ))}
                  </Box>

                  {fullStatus?.usb?.symlinks && fullStatus.usb.symlinks.length > 0 && (
                    <>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, mb: 1 }}>
                        Symlinks:
                      </Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {fullStatus.usb.symlinks.map((link) => (
                          <Chip key={link} label={link} size="small" color="primary" variant="outlined" />
                        ))}
                      </Box>
                    </>
                  )}
                </CardContent>
              </Card>
            </Grid>

            {/* Watchdog Logs Card */}
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    <ViewIcon sx={{ mr: 1, color: 'warning.main' }} />
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Logs Watchdog
                    </Typography>
                  </Box>

                  <Box
                    sx={{
                      maxHeight: 200,
                      overflow: 'auto',
                      bgcolor: 'background.default',
                      borderRadius: 1,
                      p: 1,
                      fontFamily: 'monospace',
                      fontSize: '0.75rem',
                    }}
                  >
                    {watchdogLogs?.map((log, idx) => (
                      <Box
                        key={idx}
                        sx={{
                          py: 0.25,
                          color:
                            log.level === 'ERROR'
                              ? 'error.main'
                              : log.level === 'WARNING'
                              ? 'warning.main'
                              : log.level === 'OK'
                              ? 'success.main'
                              : 'text.primary',
                        }}
                      >
                        <span style={{ color: '#888' }}>{log.timestamp}</span>{' '}
                        <strong>[{log.level}]</strong> {log.message}
                      </Box>
                    ))}
                    {(!watchdogLogs || watchdogLogs.length === 0) && (
                      <Typography color="text.secondary">Aucun log disponible</Typography>
                    )}
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        </Box>
      ))}

      {/* AT Command Dialog */}
      <Dialog open={atDialogOpen} onClose={() => setAtDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Commande AT
          <Typography variant="body2" color="text.secondary">
            Modem: {selectedModemId}
          </Typography>
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Commande"
            fullWidth
            value={atCommand}
            onChange={(e) => setAtCommand(e.target.value)}
            placeholder="AT+CSQ"
            helperText="Exemples: AT+CSQ, AT+COPS?, AT+CPIN?, AT+CFUN?"
          />

          {actionResult && (
            <Alert severity={actionResult.success ? 'success' : 'error'} sx={{ mt: 2 }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {actionResult.message}
              </pre>
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAtDialogOpen(false)}>Fermer</Button>
          <Button
            variant="contained"
            onClick={handleAtCommand}
            disabled={!atCommand || atCommandMutation.isPending}
          >
            Envoyer
          </Button>
        </DialogActions>
      </Dialog>

      {/* SMS Dialog */}
      <Dialog open={smsDialogOpen} onClose={() => setSmsDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Envoyer SMS
          <Typography variant="body2" color="text.secondary">
            Via: {selectedModemId}
          </Typography>
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Numero de telephone"
            fullWidth
            value={smsTo}
            onChange={(e) => setSmsTo(e.target.value)}
            placeholder="+590690XXXXXX"
            sx={{ mb: 2 }}
          />
          <TextField
            margin="dense"
            label="Message"
            fullWidth
            multiline
            rows={3}
            value={smsMessage}
            onChange={(e) => setSmsMessage(e.target.value)}
          />

          {actionResult && (
            <Alert severity={actionResult.success ? 'success' : 'error'} sx={{ mt: 2 }}>
              {actionResult.message}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSmsDialogOpen(false)}>Annuler</Button>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={handleSendSms}
            disabled={!smsTo || !smsMessage || sendSmsMutation.isPending}
          >
            Envoyer
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
