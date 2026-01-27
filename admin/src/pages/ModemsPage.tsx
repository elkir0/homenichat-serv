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
  alpha,
  useTheme,
  Tabs,
  Tab,
  Paper,
  Divider,
  Switch,
  FormControlLabel,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  InputAdornment,
  IconButton,
  Tooltip,
  Collapse,
  CircularProgress,
} from '@mui/material';
import { systemApi } from '../services/api';
import InstallWizard from '../components/InstallWizard';
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
  Speed as SpeedIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  PlayArrow as PlayIcon,
  Settings as SettingsIcon,
  Lock as LockIcon,
  LockOpen as LockOpenIcon,
  Search as SearchIcon,
  Save as SaveIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Code as CodeIcon,
  PhoneForwarded as TrunkIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  Router as RouterIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Extended types for modem management
interface ModemStatus {
  id: string;
  name: string;
  number: string;
  state: string;
  stateMessage?: string;
  needsPin?: boolean;
  pinAttemptsRemaining?: number;
  pinLocked?: boolean;
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
  homenichat: { active: boolean; status: string };
  chanQuectel: { active: boolean; status: string };
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

// Configuration interfaces
interface ModemProfile {
  id: string;
  name: string;
  slin16: boolean;
  description: string;
}

interface SmsConfig {
  enabled: boolean;
  storage: 'sqlite' | 'modem' | 'sim';
  autoDelete: boolean;
  deliveryReports: boolean;
  serviceCenter: string;
  encoding: 'auto' | 'gsm7' | 'ucs2';
}

interface ModemConfig {
  modemType: string;
  modemName: string;
  phoneNumber: string;
  pinCode: string;
  pinConfigured: boolean;
  dataPort: string;
  audioPort: string;
  autoDetect: boolean;
  sms: SmsConfig;
}

// Multi-modem config response
interface AllModemsConfig {
  modems: Record<string, ModemConfig>;
  global?: {
    maxModems: number;
  };
  maxModems: number;
  profiles: ModemProfile[];
}

interface DetectedPorts {
  ports: string[];
  suggestedDataPort: string | null;
  suggestedAudioPort: string | null;
  modemType: string | null;
  error?: string;
}

interface SimStatus {
  status: string;
  message: string;
  needsPin: boolean;
  attemptsUsed?: number;
  attemptsRemaining?: number;
  isLocked?: boolean;
  maxAttempts?: number;
}

// VoLTE status interface (matches backend API response)
interface VoLTEStatus {
  modemId: string;
  volteSupported: boolean;
  volteEnabled: boolean;
  imsRegistered: boolean;
  networkMode: string | null;
  audioMode: string | null;
  uacDeviceAvailable?: boolean;
  modemType?: string;
  details?: {
    qcfg_ims?: string;
    qnwprefcfg?: string;
    qaudmod?: string;
    cereg?: string;
  };
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

  // Configuration APIs - Multi-modem support
  getConfig: async (modemId?: string): Promise<AllModemsConfig | { config: ModemConfig; profiles: ModemProfile[]; modemId: string }> => {
    const url = modemId
      ? `/api/admin/modems/config?modemId=${modemId}`
      : '/api/admin/modems/config';
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to fetch modem config');
    return response.json();
  },

  getAllConfigs: async (): Promise<AllModemsConfig> => {
    const response = await fetch('/api/admin/modems/config', {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to fetch modems config');
    return response.json();
  },

  updateConfig: async (modemId: string, config: Partial<ModemConfig>): Promise<{ success: boolean; modemId: string; config: ModemConfig }> => {
    const response = await fetch('/api/admin/modems/config', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modemId, ...config }),
    });
    if (!response.ok) throw new Error('Failed to update modem config');
    return response.json();
  },

  deleteConfig: async (modemId: string): Promise<{ success: boolean; message: string }> => {
    const response = await fetch(`/api/admin/modems/config/${modemId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to delete modem config');
    return response.json();
  },

  detectPorts: async (): Promise<DetectedPorts> => {
    const response = await fetch('/api/admin/modems/detect', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to detect USB ports');
    return response.json();
  },

  getSimStatus: async (modemId?: string): Promise<SimStatus> => {
    const url = modemId ? `/api/admin/modems/pin-status?modemId=${modemId}` : '/api/admin/modems/pin-status';
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to get SIM status');
    return response.json();
  },

  enterPin: async (pin: string, pinConfirm: string, modemId?: string): Promise<{ success: boolean; message: string; attemptsRemaining?: number }> => {
    const response = await fetch('/api/admin/modems/enter-pin', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pin, pinConfirm, modemId }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Failed to enter PIN');
    }
    return result;
  },

  resetPinAttempts: async (): Promise<{ success: boolean; message: string }> => {
    const response = await fetch('/api/admin/modems/reset-pin-attempts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to reset PIN attempts');
    return response.json();
  },

  getQuectelConf: async (): Promise<{ current: string | null; preview: string }> => {
    const response = await fetch('/api/admin/modems/quectel-conf', {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to get quectel.conf');
    return response.json();
  },

  applyConfig: async (modemId: string, config: Partial<ModemConfig>): Promise<{ success: boolean; message: string }> => {
    // First save the config for this specific modem
    const saveResponse = await fetch('/api/admin/modems/config', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modemId, ...config }),
    });
    if (!saveResponse.ok) throw new Error('Failed to save modem config');

    // Then apply to quectel.conf and reload Asterisk
    const response = await fetch('/api/admin/modems/apply-config', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modemId, ...config }),
    });
    if (!response.ok) throw new Error('Failed to apply config');
    return response.json();
  },

  initializeModem: async (modemId?: string): Promise<{ success: boolean; pinStatus: SimStatus; pinEntered: boolean; audioConfigured: boolean }> => {
    const response = await fetch('/api/admin/modems/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modemId }),
    });
    if (!response.ok) throw new Error('Failed to initialize modem');
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

  // Trunk SIP Management
  getTrunkStatus: async (modemId: string): Promise<{ exists: boolean; trunkName?: string; status?: string; canCreate: boolean; error?: string }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/trunk`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to get trunk status');
    return response.json();
  },

  createTrunk: async (modemId: string, config: {
    phoneNumber?: string;
    modemName?: string;
    context?: string;
    maxChannels?: number;
    callerIdMode?: string;
  }): Promise<{ success: boolean; message: string; trunkName?: string; dialString?: string }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/trunk`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to create trunk');
    }
    return response.json();
  },

  deleteTrunk: async (modemId: string): Promise<{ success: boolean; message: string }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/trunk`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to delete trunk');
    return response.json();
  },

  getTrunkDefaults: async (): Promise<{
    defaults: { context: string; maxChannels: number; callerIdMode: string };
    options: {
      contexts: { value: string; label: string; description: string }[];
      callerIdModes: { value: string; label: string; description: string }[];
    };
    pbxConnected: boolean;
  }> => {
    const response = await fetch('/api/admin/modems/trunk-defaults', {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to get trunk defaults');
    return response.json();
  },

  // Add modem to quectel.conf
  addModem: async (modem: {
    modemId?: string;
    modemType: string;
    dataPort: string;
    audioPort: string;
    modemName?: string;
    phoneNumber?: string;
  }): Promise<{ success: boolean; message: string; modemId: string; modemName: string }> => {
    const response = await fetch('/api/admin/modems/add', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(modem),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to add modem');
    }
    return response.json();
  },

  // VoLTE APIs
  getVoLTEStatus: async (modemId: string): Promise<VoLTEStatus> => {
    const response = await fetch(`/api/admin/modems/${modemId}/volte/status`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    });
    if (!response.ok) throw new Error('Failed to get VoLTE status');
    return response.json();
  },

  toggleVoLTE: async (modemId: string, enable: boolean): Promise<{ success: boolean; message: string; volteEnabled: boolean }> => {
    const response = await fetch(`/api/admin/modems/${modemId}/volte/toggle`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enable }),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to toggle VoLTE');
    }
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
  const [showInstallWizard, setShowInstallWizard] = useState(false);

  // Query system status to check if Asterisk is installed
  const { data: systemStatus, isLoading: isLoadingSystem, refetch: refetchSystem } = useQuery({
    queryKey: ['systemStatus'],
    queryFn: systemApi.getStatus,
    staleTime: 60000, // 1 minute
    retry: 1,
  });

  // Dialogs
  const [atDialogOpen, setAtDialogOpen] = useState(false);
  const [smsDialogOpen, setSmsDialogOpen] = useState(false);
  const [selectedModemId, setSelectedModemId] = useState<string | null>(null);
  const [atCommand, setAtCommand] = useState('AT+CSQ');
  const [smsTo, setSmsTo] = useState('');
  const [smsMessage, setSmsMessage] = useState('Test SMS depuis Homenichat Admin');
  const [actionResult, setActionResult] = useState<{ success: boolean; message: string } | null>(null);

  // Configuration panel state
  const [configExpanded, setConfigExpanded] = useState(true);
  const [confDialogOpen, setConfDialogOpen] = useState(false);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [trunkDialogOpen, setTrunkDialogOpen] = useState(false);
  const [trunkConfig, setTrunkConfig] = useState({
    phoneNumber: '',
    modemName: '',
    context: 'from-gsm',
    maxChannels: 1,
    callerIdMode: 'keep',
  });
  const [pinInput, setPinInput] = useState('');
  const [pinConfirmInput, setPinConfirmInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  // Add modem dialog state
  const [addModemDialogOpen, setAddModemDialogOpen] = useState(false);
  const [addModemForm, setAddModemForm] = useState({
    modemType: 'sim7600',
    dataPort: '/dev/ttyUSB2',
    audioPort: '/dev/ttyUSB4',
    modemName: '',
    phoneNumber: '',
  });
  const [detectedModems, setDetectedModems] = useState<Array<{
    id: string;
    type: string;
    dataPort: string;
    audioPort: string;
  }>>([]);

  const [configForm, setConfigForm] = useState<Partial<ModemConfig>>({
    modemType: 'ec25',
    modemName: 'hni-modem',
    phoneNumber: '',
    dataPort: '/dev/ttyUSB2',
    audioPort: '/dev/ttyUSB1',
    autoDetect: true,
    sms: {
      enabled: true,
      storage: 'sqlite',
      autoDelete: true,
      deliveryReports: false,
      serviceCenter: '',
      encoding: 'auto',
    },
  });

  // VoLTE state
  const [volteStatus, setVolteStatus] = useState<VoLTEStatus | null>(null);
  const [volteLoading, setVolteLoading] = useState(false);
  const [volteError, setVolteError] = useState<string | null>(null);

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

  // Configuration queries - Multi-modem support
  const { data: modemConfigData } = useQuery({
    queryKey: ['modemConfig'],
    queryFn: modemsApi.getAllConfigs,
    staleTime: 30000,
  });

  const { data: simStatusData, refetch: refetchSimStatus } = useQuery({
    queryKey: ['simStatus'],
    queryFn: () => modemsApi.getSimStatus(),
    refetchInterval: autoRefresh ? 30000 : false,
  });

  const { data: quectelConfData } = useQuery({
    queryKey: ['quectelConf'],
    queryFn: modemsApi.getQuectelConf,
    enabled: confDialogOpen,
  });

  const { data: trunkDefaultsData } = useQuery({
    queryKey: ['trunkDefaults'],
    queryFn: modemsApi.getTrunkDefaults,
    staleTime: 60000,
  });

  // Trunk status for selected modem
  const { data: trunkStatusData, refetch: refetchTrunkStatus } = useQuery({
    queryKey: ['trunkStatus', selectedModemId],
    queryFn: () => selectedModemId ? modemsApi.getTrunkStatus(selectedModemId) : Promise.resolve({ exists: false, canCreate: false, trunkName: undefined }),
    enabled: !!selectedModemId && trunkDialogOpen,
  });

  // Get modem ID for current tab (for config purposes)
  // Maps tab index to modem-1, modem-2, etc.
  const currentConfigModemId = `modem-${selectedTab + 1}`;

  // Update configForm when config is loaded or when selectedTab changes
  useEffect(() => {
    if (modemConfigData?.modems) {
      // Multi-modem format
      const cfg = modemConfigData.modems[currentConfigModemId];
      if (cfg) {
        setConfigForm({
          modemType: cfg.modemType || 'sim7600',
          modemName: cfg.modemName || currentConfigModemId,
          phoneNumber: cfg.phoneNumber || '',
          dataPort: cfg.dataPort || `/dev/ttyUSB${selectedTab * 5 + 2}`,
          audioPort: cfg.audioPort || `/dev/ttyUSB${selectedTab * 5 + 4}`,
          autoDetect: cfg.autoDetect !== false,
          sms: {
            enabled: cfg.sms?.enabled !== false,
            storage: cfg.sms?.storage || 'sqlite',
            autoDelete: cfg.sms?.autoDelete !== false,
            deliveryReports: cfg.sms?.deliveryReports || false,
            serviceCenter: cfg.sms?.serviceCenter || '',
            encoding: cfg.sms?.encoding || 'auto',
          },
        });
      } else {
        // No config for this modem yet - set defaults
        setConfigForm({
          modemType: 'sim7600',
          modemName: currentConfigModemId,
          phoneNumber: '',
          dataPort: `/dev/ttyUSB${selectedTab * 5 + 2}`,
          audioPort: `/dev/ttyUSB${selectedTab * 5 + 4}`,
          autoDetect: true,
          sms: {
            enabled: true,
            storage: 'sqlite',
            autoDelete: true,
            deliveryReports: false,
            serviceCenter: '',
            encoding: 'auto',
          },
        });
      }
    }
  }, [modemConfigData, selectedTab, currentConfigModemId]);

  // Fetch VoLTE status when modem changes (only for EC25 modems)
  useEffect(() => {
    const fetchVolteStatus = async () => {
      const modemType = modemConfigData?.modems?.[currentConfigModemId]?.modemType?.toLowerCase();
      if (modemType === 'ec25') {
        setVolteLoading(true);
        setVolteError(null);
        try {
          const status = await modemsApi.getVoLTEStatus(currentConfigModemId);
          setVolteStatus(status);
        } catch (err) {
          setVolteError(err instanceof Error ? err.message : 'Failed to get VoLTE status');
          setVolteStatus(null);
        } finally {
          setVolteLoading(false);
        }
      } else {
        setVolteStatus(null);
        setVolteError(null);
      }
    };

    if (currentConfigModemId && modemConfigData?.modems) {
      fetchVolteStatus();
    }
  }, [currentConfigModemId, modemConfigData]);

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

  // Configuration mutations
  const detectPortsMutation = useMutation({
    mutationFn: modemsApi.detectPorts,
    onSuccess: (result) => {
      if (result.suggestedDataPort) {
        setConfigForm(prev => ({
          ...prev,
          dataPort: result.suggestedDataPort || prev.dataPort,
          audioPort: result.suggestedAudioPort || prev.audioPort,
          modemType: result.modemType || prev.modemType,
        }));
        // Also update add modem form
        setAddModemForm(prev => ({
          ...prev,
          dataPort: result.suggestedDataPort || prev.dataPort,
          audioPort: result.suggestedAudioPort || prev.audioPort,
          modemType: result.modemType || prev.modemType,
        }));
      }
      // Store detected modems list
      if ((result as DetectedPorts & { modems?: typeof detectedModems }).modems) {
        setDetectedModems((result as DetectedPorts & { modems: typeof detectedModems }).modems);
      }
      setActionResult({
        success: true,
        message: `Détecté: ${result.ports.length} ports USB. Type suggéré: ${result.modemType || 'inconnu'}`,
      });
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  const enterPinMutation = useMutation({
    mutationFn: ({ pin, pinConfirm, modemId }: { pin: string; pinConfirm: string; modemId?: string }) =>
      modemsApi.enterPin(pin, pinConfirm, modemId),
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.message });
      setPinDialogOpen(false);
      setPinInput('');
      setPinConfirmInput('');
      setPinError(null);
      refetchSimStatus();
      queryClient.invalidateQueries({ queryKey: ['modemConfig'] });
      queryClient.invalidateQueries({ queryKey: ['modemFullStatus'] });
    },
    onError: (err: Error) => {
      setPinError(err.message);
      refetchSimStatus();
    },
  });

  const resetPinAttemptsMutation = useMutation({
    mutationFn: modemsApi.resetPinAttempts,
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.message });
      setPinError(null);
      refetchSimStatus();
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  const applyConfigMutation = useMutation({
    mutationFn: ({ modemId, config }: { modemId: string; config: Partial<ModemConfig> }) =>
      modemsApi.applyConfig(modemId, config),
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.message });
      queryClient.invalidateQueries({ queryKey: ['modemConfig'] });
      queryClient.invalidateQueries({ queryKey: ['modemFullStatus'] });
      queryClient.invalidateQueries({ queryKey: ['quectelConf'] });
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  // Add modem mutation
  const addModemMutation = useMutation({
    mutationFn: (modem: typeof addModemForm) => modemsApi.addModem(modem),
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.message });
      setAddModemDialogOpen(false);
      setAddModemForm({
        modemType: 'sim7600',
        dataPort: '/dev/ttyUSB2',
        audioPort: '/dev/ttyUSB4',
        modemName: '',
        phoneNumber: '',
      });
      setDetectedModems([]);
      // Refresh all modem data
      queryClient.invalidateQueries({ queryKey: ['modemConfig'] });
      queryClient.invalidateQueries({ queryKey: ['modemFullStatus'] });
      queryClient.invalidateQueries({ queryKey: ['quectelConf'] });
      refetch();
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  // Trunk mutations
  const createTrunkMutation = useMutation({
    mutationFn: ({ modemId, config }: { modemId: string; config: typeof trunkConfig }) =>
      modemsApi.createTrunk(modemId, config),
    onSuccess: (result) => {
      setActionResult({
        success: result.success,
        message: result.message + (result.dialString ? `\n\nDial string: ${result.dialString}` : ''),
      });
      refetchTrunkStatus();
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  const deleteTrunkMutation = useMutation({
    mutationFn: (modemId: string) => modemsApi.deleteTrunk(modemId),
    onSuccess: (result) => {
      setActionResult({ success: result.success, message: result.message });
      refetchTrunkStatus();
    },
    onError: (err: Error) => {
      setActionResult({ success: false, message: err.message });
    },
  });

  // VoLTE toggle mutation
  const toggleVoLTEMutation = useMutation({
    mutationFn: ({ modemId, enable }: { modemId: string; enable: boolean }) =>
      modemsApi.toggleVoLTE(modemId, enable),
    onSuccess: async (result) => {
      setActionResult({ success: result.success, message: result.message });
      // Refresh VoLTE status
      try {
        const status = await modemsApi.getVoLTEStatus(currentConfigModemId);
        setVolteStatus(status);
      } catch {
        // Ignore refresh errors
      }
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

  const openTrunkDialog = (modemId: string, modemData?: { status: ModemStatus }) => {
    setSelectedModemId(modemId);
    setTrunkConfig({
      phoneNumber: modemData?.status?.number || '',
      modemName: modemData?.status?.name || modemId,
      context: trunkDefaultsData?.defaults?.context || 'from-gsm',
      maxChannels: trunkDefaultsData?.defaults?.maxChannels || 1,
      callerIdMode: trunkDefaultsData?.defaults?.callerIdMode || 'keep',
    });
    setActionResult(null);
    setTrunkDialogOpen(true);
  };

  const modemsList = fullStatus?.modems ? Object.entries(fullStatus.modems) : [];

  // Handler for when installation is complete
  const handleInstallComplete = () => {
    setShowInstallWizard(false);
    refetchSystem();
    queryClient.invalidateQueries({ queryKey: ['modemFullStatus'] });
  };

  // Show loading state while checking system status
  if (isLoadingSystem) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 400, gap: 2 }}>
        <CircularProgress />
        <Typography color="text.secondary">Vérification du système...</Typography>
      </Box>
    );
  }

  // Show InstallWizard if Asterisk is not installed or user requested it
  const needsInstallation = systemStatus && (!systemStatus.asterisk?.installed || !systemStatus.chanQuectel?.installed);
  const hasModems = systemStatus?.modems && systemStatus.modems.length > 0;

  if (showInstallWizard || (needsInstallation && hasModems)) {
    return (
      <Box>
        {/* Header with back button if coming from explicit request */}
        {showInstallWizard && systemStatus?.asterisk?.installed && (
          <Box sx={{ mb: 2 }}>
            <Button onClick={() => setShowInstallWizard(false)} variant="outlined">
              ← Retour aux modems
            </Button>
          </Box>
        )}
        <InstallWizard onComplete={handleInstallComplete} />
      </Box>
    );
  }

  // Show prompt to install if modems detected but no Asterisk
  if (needsInstallation && !hasModems) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="info" sx={{ mb: 3 }}>
          <Typography variant="subtitle1" fontWeight={600}>
            Configuration requise
          </Typography>
          <Typography variant="body2">
            Asterisk et chan_quectel ne sont pas installés. Connectez un modem USB pour lancer l'assistant d'installation.
          </Typography>
        </Alert>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              État du système
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={6} md={3}>
                <Chip
                  label={`Asterisk: ${systemStatus?.asterisk?.installed ? 'Installé' : 'Non installé'}`}
                  color={systemStatus?.asterisk?.installed ? 'success' : 'error'}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <Chip
                  label={`chan_quectel: ${systemStatus?.chanQuectel?.installed ? 'Installé' : 'Non installé'}`}
                  color={systemStatus?.chanQuectel?.installed ? 'success' : 'error'}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <Chip
                  label={`FreePBX: ${systemStatus?.freepbx?.installed ? 'Installé' : 'Non installé'}`}
                  color={systemStatus?.freepbx?.installed ? 'success' : 'default'}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <Chip
                  label={`Modems: ${systemStatus?.modems?.length || 0} détecté(s)`}
                  color={systemStatus?.modems?.length ? 'success' : 'warning'}
                  variant="outlined"
                />
              </Grid>
            </Grid>
            <Box sx={{ mt: 3 }}>
              <Button
                variant="contained"
                onClick={() => setShowInstallWizard(true)}
                disabled={!systemStatus?.platform?.canInstall}
              >
                Lancer l'assistant d'installation
              </Button>
              {!systemStatus?.platform?.canInstall && (
                <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
                  L'installation nécessite les droits root sur un système Linux.
                </Typography>
              )}
            </Box>
          </CardContent>
        </Card>
      </Box>
    );
  }

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
        {systemStatus && !systemStatus.asterisk?.installed && (
          <Box sx={{ mt: 2 }}>
            <Button variant="contained" onClick={() => setShowInstallWizard(true)}>
              Installer Asterisk + chan_quectel
            </Button>
          </Box>
        )}
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
          {systemStatus?.platform?.canInstall && (
            <Tooltip title="Réinstaller Asterisk + chan_quectel">
              <Button
                variant="outlined"
                color="secondary"
                onClick={() => setShowInstallWizard(true)}
              >
                Installation
              </Button>
            </Tooltip>
          )}
        </Box>
      </Box>

      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      {/* Modem Selector Tabs - MUST BE FIRST */}
      {modemsList.length > 0 && (
        <Paper sx={{ mb: 3 }}>
          <Tabs
            value={selectedTab}
            onChange={(_, newValue) => setSelectedTab(newValue)}
            variant="fullWidth"
          >
            {modemsList.map(([modemId, data]) => (
              <Tab
                key={modemId}
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <SimCardIcon />
                    <Box sx={{ textAlign: 'left' }}>
                      <Typography variant="body2" fontWeight={600}>
                        {data.status.name || modemId}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {data.status.number || 'Non configuré'}
                      </Typography>
                    </Box>
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        ml: 1,
                        backgroundColor:
                          data.status.state === 'Free'
                            ? theme.palette.success.main
                            : data.status.needsPin || data.status.state?.toLowerCase().includes('pin')
                            ? theme.palette.warning.main
                            : data.status.state === 'Unknown' || data.status.state?.toLowerCase().includes('not init')
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
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <RouterIcon sx={{ color: 'warning.main' }} />
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Aucun modem configure
              </Typography>
            </Box>

            <Alert severity="info" sx={{ mb: 3 }}>
              <Typography variant="body2">
                Aucun modem n'est configure dans Asterisk. Connectez un modem USB (SIM7600 ou EC25)
                et cliquez sur "Scanner les ports USB" pour le detecter automatiquement.
              </Typography>
            </Alert>

            {/* Detected modems list */}
            {detectedModems.length > 0 && (
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" color="success.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CheckIcon fontSize="small" />
                  {detectedModems.length} modem(s) detecte(s) via USB
                </Typography>
                <Grid container spacing={2}>
                  {detectedModems.map((modem) => (
                    <Grid item xs={12} md={6} key={modem.id}>
                      <Paper
                        sx={{
                          p: 2,
                          border: '1px solid',
                          borderColor: 'success.main',
                          backgroundColor: alpha(theme.palette.success.main, 0.05),
                        }}
                      >
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <SimCardIcon color="success" />
                            <Typography variant="subtitle1" fontWeight={600}>
                              {modem.type}
                            </Typography>
                          </Box>
                          <Chip label={modem.id} size="small" color="success" variant="outlined" />
                        </Box>
                        <Typography variant="body2" color="text.secondary">
                          Port AT: <strong>{modem.dataPort}</strong>
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Port Audio: <strong>{modem.audioPort}</strong>
                        </Typography>
                        <Box sx={{ mt: 2 }}>
                          <Button
                            variant="contained"
                            color="success"
                            size="small"
                            startIcon={<AddIcon />}
                            onClick={() => {
                              setAddModemForm({
                                modemType: modem.type.toLowerCase(),
                                dataPort: modem.dataPort,
                                audioPort: modem.audioPort,
                                modemName: `hni-${modem.type.toLowerCase()}`,
                                phoneNumber: '',
                              });
                              setAddModemDialogOpen(true);
                            }}
                          >
                            Ajouter ce modem
                          </Button>
                        </Box>
                      </Paper>
                    </Grid>
                  ))}
                </Grid>
              </Box>
            )}

            {/* Action buttons */}
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                color="primary"
                startIcon={detectPortsMutation.isPending ? <CircularProgress size={20} color="inherit" /> : <SearchIcon />}
                onClick={() => detectPortsMutation.mutate()}
                disabled={detectPortsMutation.isPending}
              >
                Scanner les ports USB
              </Button>
              <Button
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={() => setAddModemDialogOpen(true)}
              >
                Ajouter manuellement
              </Button>
              <Button
                variant="outlined"
                color="warning"
                startIcon={<RestartIcon />}
                onClick={() => restartAsteriskMutation.mutate()}
                disabled={restartAsteriskMutation.isPending}
              >
                Restart Asterisk
              </Button>
            </Box>

            {/* Detection result */}
            {actionResult && (
              <Alert
                severity={actionResult.success ? 'success' : 'error'}
                sx={{ mt: 2 }}
                onClose={() => setActionResult(null)}
              >
                {actionResult.message}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Configuration Panel - For selected modem */}
      <Card sx={{ mb: 3 }}>
        <CardContent sx={{ pb: configExpanded ? 2 : '16px !important' }}>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              cursor: 'pointer',
            }}
            onClick={() => setConfigExpanded(!configExpanded)}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <SettingsIcon sx={{ color: 'primary.main' }} />
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Configuration - {currentConfigModemId}
              </Typography>
              {modemConfigData?.modems?.[currentConfigModemId]?.modemType && (
                <Chip
                  label={modemConfigData.modems[currentConfigModemId].modemType.toUpperCase()}
                  size="small"
                  color="primary"
                  variant="outlined"
                />
              )}
              {simStatusData?.needsPin && (
                <Chip label="PIN requis" size="small" color="warning" icon={<LockIcon />} />
              )}
              {simStatusData?.status === 'ready' && (
                <Chip label="SIM OK" size="small" color="success" icon={<LockOpenIcon />} />
              )}
            </Box>
            <IconButton size="small">
              {configExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
          </Box>

          <Collapse in={configExpanded}>
            <Divider sx={{ my: 2 }} />

            <Grid container spacing={3}>
              {/* Type de modem */}
              <Grid item xs={12} md={4}>
                <FormControl fullWidth size="small">
                  <InputLabel>Type de Modem</InputLabel>
                  <Select
                    value={configForm.modemType || 'ec25'}
                    label="Type de Modem"
                    onChange={(e) => setConfigForm({ ...configForm, modemType: e.target.value })}
                  >
                    {modemConfigData?.profiles?.map((profile) => (
                      <MenuItem key={profile.id} value={profile.id}>
                        <Box>
                          <Typography variant="body2" fontWeight={500}>
                            {profile.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {profile.description}
                          </Typography>
                        </Box>
                      </MenuItem>
                    )) || (
                      <>
                        <MenuItem value="ec25">
                          <Box>
                            <Typography variant="body2" fontWeight={500}>Quectel EC25</Typography>
                            <Typography variant="caption" color="text.secondary">Audio 8kHz (standard)</Typography>
                          </Box>
                        </MenuItem>
                        <MenuItem value="sim7600">
                          <Box>
                            <Typography variant="body2" fontWeight={500}>Simcom SIM7600</Typography>
                            <Typography variant="caption" color="text.secondary">Audio 16kHz (haute qualité)</Typography>
                          </Box>
                        </MenuItem>
                      </>
                    )}
                  </Select>
                </FormControl>
              </Grid>

              {/* Nom du modem */}
              <Grid item xs={12} md={4}>
                <TextField
                  fullWidth
                  size="small"
                  label="Nom du Modem"
                  value={configForm.modemName || ''}
                  onChange={(e) => setConfigForm({ ...configForm, modemName: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12) })}
                  inputProps={{ maxLength: 12 }}
                  helperText={`${(configForm.modemName || '').length}/12 caracteres (lettres, chiffres, tirets)`}
                  error={(configForm.modemName || '').length > 12}
                />
              </Grid>

              {/* Numéro de téléphone */}
              <Grid item xs={12} md={4}>
                <TextField
                  fullWidth
                  size="small"
                  label="Numero de telephone"
                  value={configForm.phoneNumber || ''}
                  onChange={(e) => setConfigForm({ ...configForm, phoneNumber: e.target.value.replace(/[^0-9+]/g, '') })}
                  placeholder="+590690XXXXXX"
                  helperText="Format international"
                />
              </Grid>

              {/* Ports USB */}
              <Grid item xs={12} md={4}>
                <TextField
                  fullWidth
                  size="small"
                  label="Port Data (AT)"
                  value={configForm.dataPort || ''}
                  onChange={(e) => setConfigForm({ ...configForm, dataPort: e.target.value })}
                  placeholder="/dev/ttyUSB2"
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <Tooltip title="Detecter automatiquement">
                          <IconButton
                            size="small"
                            onClick={() => detectPortsMutation.mutate()}
                            disabled={detectPortsMutation.isPending}
                          >
                            <SearchIcon />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  }}
                />
              </Grid>

              <Grid item xs={12} md={4}>
                <TextField
                  fullWidth
                  size="small"
                  label="Port Audio"
                  value={configForm.audioPort || ''}
                  onChange={(e) => setConfigForm({ ...configForm, audioPort: e.target.value })}
                  placeholder="/dev/ttyUSB1"
                />
              </Grid>

              {/* SIM PIN Status & Actions */}
              <Grid item xs={12} md={4}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', height: '100%' }}>
                  <Button
                    variant={simStatusData?.needsPin ? 'contained' : 'outlined'}
                    color={simStatusData?.needsPin ? 'warning' : 'primary'}
                    startIcon={simStatusData?.needsPin ? <LockIcon /> : <LockOpenIcon />}
                    onClick={() => setPinDialogOpen(true)}
                    size="small"
                  >
                    {simStatusData?.needsPin ? 'Entrer PIN' : 'Gerer PIN'}
                  </Button>
                  <Chip
                    label={simStatusData?.message || 'Verification...'}
                    size="small"
                    color={
                      simStatusData?.status === 'ready' ? 'success' :
                      simStatusData?.status === 'pin_required' ? 'warning' :
                      simStatusData?.status === 'error' ? 'error' : 'default'
                    }
                    variant="outlined"
                  />
                </Box>
              </Grid>

              {/* VoLTE Toggle - Only for EC25 modems */}
              {(configForm.modemType?.toLowerCase() === 'ec25' || modemConfigData?.modems?.[currentConfigModemId]?.modemType?.toLowerCase() === 'ec25') && (
                <Grid item xs={12}>
                  <Paper
                    sx={{
                      p: 2,
                      backgroundColor: (theme) => alpha(theme.palette.info.main, 0.05),
                      border: (theme) => `1px solid ${alpha(theme.palette.info.main, 0.2)}`,
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
                      <Box>
                        <Typography variant="subtitle1" fontWeight={600} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <SignalIcon color="info" />
                          Mode d'appel VoLTE / 3G
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          VoLTE offre une meilleure qualite audio et une connexion plus rapide. Disponible uniquement avec les modems EC25.
                        </Typography>
                      </Box>

                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        {volteLoading ? (
                          <CircularProgress size={24} />
                        ) : volteError ? (
                          <Chip label={volteError} size="small" color="error" variant="outlined" />
                        ) : (
                          <>
                            {/* Status indicators */}
                            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                              <Chip
                                label={volteStatus?.volteEnabled ? 'VoLTE' : '3G'}
                                size="small"
                                color={volteStatus?.volteEnabled ? 'success' : 'default'}
                                variant={volteStatus?.volteEnabled ? 'filled' : 'outlined'}
                              />
                              {volteStatus?.imsRegistered && (
                                <Chip label="IMS OK" size="small" color="success" variant="outlined" />
                              )}
                              {volteStatus?.networkMode && (
                                <Chip label={volteStatus.networkMode} size="small" color="info" variant="outlined" />
                              )}
                            </Box>

                            {/* Toggle switch */}
                            <FormControlLabel
                              control={
                                <Switch
                                  checked={volteStatus?.volteEnabled || false}
                                  onChange={(e) => {
                                    toggleVoLTEMutation.mutate({
                                      modemId: currentConfigModemId,
                                      enable: e.target.checked,
                                    });
                                  }}
                                  disabled={toggleVoLTEMutation.isPending || !volteStatus?.volteSupported}
                                  color="success"
                                />
                              }
                              label={
                                <Typography variant="body2" fontWeight={500}>
                                  {volteStatus?.volteEnabled ? 'VoLTE actif' : 'Mode 3G'}
                                </Typography>
                              }
                              labelPlacement="start"
                            />
                          </>
                        )}
                      </Box>
                    </Box>

                    {toggleVoLTEMutation.isPending && (
                      <Box sx={{ mt: 2 }}>
                        <LinearProgress color="info" />
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                          Changement de mode en cours... Le modem va redemarrer.
                        </Typography>
                      </Box>
                    )}
                  </Paper>
                </Grid>
              )}

              {/* Actions */}
              <Grid item xs={12}>
                <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <Button
                    variant="outlined"
                    startIcon={<SearchIcon />}
                    onClick={() => detectPortsMutation.mutate()}
                    disabled={detectPortsMutation.isPending}
                  >
                    Auto-detecter
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<CodeIcon />}
                    onClick={() => setConfDialogOpen(true)}
                  >
                    Voir quectel.conf
                  </Button>
                  <Button
                    variant="contained"
                    color="primary"
                    startIcon={<SaveIcon />}
                    onClick={() => applyConfigMutation.mutate({ modemId: currentConfigModemId, config: configForm })}
                    disabled={applyConfigMutation.isPending}
                  >
                    Appliquer la configuration
                  </Button>
                </Box>
              </Grid>
            </Grid>

            {/* Alert for config result */}
            {actionResult && (
              <Alert
                severity={actionResult.success ? 'success' : 'error'}
                sx={{ mt: 2 }}
                onClose={() => setActionResult(null)}
              >
                {actionResult.message}
              </Alert>
            )}
          </Collapse>
        </CardContent>
      </Card>

      {/* SMS Configuration Card */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <SendIcon color="primary" />
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Configuration SMS - {currentConfigModemId}
              </Typography>
            </Box>
            <FormControlLabel
              control={
                <Switch
                  checked={configForm.sms?.enabled !== false}
                  onChange={(e) => setConfigForm({
                    ...configForm,
                    sms: { ...configForm.sms!, enabled: e.target.checked }
                  })}
                  color="primary"
                />
              }
              label={configForm.sms?.enabled !== false ? 'Actif' : 'Desactive'}
            />
          </Box>

          <Collapse in={configForm.sms?.enabled !== false}>
            <Grid container spacing={2}>
              {/* Stockage SMS */}
              <Grid item xs={12} md={4}>
                <FormControl fullWidth size="small">
                  <InputLabel>Stockage des SMS</InputLabel>
                  <Select
                    value={configForm.sms?.storage || 'sqlite'}
                    label="Stockage des SMS"
                    onChange={(e) => setConfigForm({
                      ...configForm,
                      sms: { ...configForm.sms!, storage: e.target.value as 'sqlite' | 'modem' | 'sim' }
                    })}
                  >
                    <MenuItem value="sqlite">
                      <Box>
                        <Typography variant="body2" fontWeight={500}>SQLite (recommande)</Typography>
                        <Typography variant="caption" color="text.secondary">Base de donnees locale</Typography>
                      </Box>
                    </MenuItem>
                    <MenuItem value="modem">
                      <Box>
                        <Typography variant="body2" fontWeight={500}>Memoire modem</Typography>
                        <Typography variant="caption" color="text.secondary">Stockage temporaire</Typography>
                      </Box>
                    </MenuItem>
                    <MenuItem value="sim">
                      <Box>
                        <Typography variant="body2" fontWeight={500}>Carte SIM</Typography>
                        <Typography variant="caption" color="text.secondary">Capacite limitee (~20 SMS)</Typography>
                      </Box>
                    </MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              {/* Auto-suppression */}
              <Grid item xs={12} md={4}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={configForm.sms?.autoDelete !== false}
                      onChange={(e) => setConfigForm({
                        ...configForm,
                        sms: { ...configForm.sms!, autoDelete: e.target.checked }
                      })}
                    />
                  }
                  label="Supprimer apres lecture"
                />
                <Typography variant="caption" color="text.secondary" display="block">
                  Libere la memoire du modem
                </Typography>
              </Grid>

              {/* Accusés de réception */}
              <Grid item xs={12} md={4}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={configForm.sms?.deliveryReports || false}
                      onChange={(e) => setConfigForm({
                        ...configForm,
                        sms: { ...configForm.sms!, deliveryReports: e.target.checked }
                      })}
                    />
                  }
                  label="Accuses de reception"
                />
                <Typography variant="caption" color="text.secondary" display="block">
                  Confirme la livraison
                </Typography>
              </Grid>

              {/* Centre de service (optionnel) */}
              <Grid item xs={12} md={6}>
                <TextField
                  fullWidth
                  size="small"
                  label="Centre de service SMS (optionnel)"
                  value={configForm.sms?.serviceCenter || ''}
                  onChange={(e) => setConfigForm({
                    ...configForm,
                    sms: { ...configForm.sms!, serviceCenter: e.target.value.replace(/[^0-9+]/g, '') }
                  })}
                  placeholder="Auto-detecte"
                  helperText="Laissez vide pour detection automatique"
                />
              </Grid>

              {/* Encodage */}
              <Grid item xs={12} md={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>Encodage</InputLabel>
                  <Select
                    value={configForm.sms?.encoding || 'auto'}
                    label="Encodage"
                    onChange={(e) => setConfigForm({
                      ...configForm,
                      sms: { ...configForm.sms!, encoding: e.target.value as 'auto' | 'gsm7' | 'ucs2' }
                    })}
                  >
                    <MenuItem value="auto">Auto (recommande)</MenuItem>
                    <MenuItem value="gsm7">GSM-7 (caracteres basiques)</MenuItem>
                    <MenuItem value="ucs2">UCS-2 (emojis, accents)</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              {/* Bouton Appliquer */}
              <Grid item xs={12}>
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
                  <Button
                    variant="contained"
                    color="primary"
                    startIcon={<SaveIcon />}
                    onClick={() => applyConfigMutation.mutate({ modemId: currentConfigModemId, config: configForm })}
                    disabled={applyConfigMutation.isPending}
                  >
                    Appliquer
                  </Button>
                </Box>
              </Grid>
            </Grid>
          </Collapse>
        </CardContent>
      </Card>

      {/* Modem Content */}
      {modemsList.map(([modemId, data], idx) => (
        <Box key={modemId} sx={{ display: selectedTab === idx ? 'block' : 'none' }}>
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
                      icon={data.status.needsPin ? <LockIcon /> : undefined}
                      label={data.status.needsPin ? 'PIN requis' : data.status.state}
                      size="small"
                      color={
                        data.status.state === 'Free'
                          ? 'success'
                          : data.status.needsPin || data.status.state?.toLowerCase().includes('pin')
                          ? 'warning'
                          : data.status.state === 'Unknown' || data.status.state?.toLowerCase().includes('not init')
                          ? 'error'
                          : 'warning'
                      }
                      onClick={data.status.needsPin ? () => setPinDialogOpen(true) : undefined}
                      sx={data.status.needsPin ? { cursor: 'pointer' } : {}}
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
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <SignalIcon sx={{ mr: 1, color: 'info.main' }} />
                      <Typography variant="h6" sx={{ fontWeight: 600 }}>
                        Signal
                      </Typography>
                    </Box>
                    {/* Network Type Badge */}
                    {data.status.technology && data.status.technology !== 'No Service' && (
                      <Chip
                        label={data.status.technology}
                        size="small"
                        color={
                          data.status.technology.includes('LTE') || data.status.technology === '4G'
                            ? 'success'
                            : data.status.technology === '3G' || data.status.technology.includes('WCDMA')
                            ? 'warning'
                            : 'default'
                        }
                        sx={{ fontWeight: 700 }}
                      />
                    )}
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
                    <Grid item xs={12}>
                      <Button
                        fullWidth
                        variant="contained"
                        color="secondary"
                        startIcon={<TrunkIcon />}
                        onClick={() => openTrunkDialog(modemId, data)}
                        disabled={!trunkDefaultsData?.pbxConnected}
                      >
                        {trunkDefaultsData?.pbxConnected ? 'Créer Trunk SIP FreePBX' : 'PBX non connecté'}
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
                        active={fullStatus?.services?.homenichat?.active || false}
                        label="Homenichat"
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <StatusChip
                        active={fullStatus?.services?.chanQuectel?.active || false}
                        label="chan_quectel"
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

      {/* PIN Dialog */}
      <Dialog open={pinDialogOpen} onClose={() => { setPinDialogOpen(false); setPinError(null); }} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <LockIcon color="warning" />
            Code PIN SIM
          </Box>
        </DialogTitle>
        <DialogContent>
          {/* Avertissement important */}
          <Alert severity="warning" sx={{ mb: 2 }}>
            <strong>ATTENTION:</strong> 3 codes PIN incorrects bloqueront definitivement votre carte SIM!
            Pour votre securite, l'interface limite a 2 tentatives.
          </Alert>

          {/* Statut actuel */}
          <Alert
            severity={simStatusData?.status === 'ready' ? 'success' : simStatusData?.isLocked ? 'error' : 'info'}
            sx={{ mb: 2 }}
          >
            <strong>Statut:</strong> {simStatusData?.message || 'Verification...'}
            {simStatusData?.attemptsRemaining !== undefined && (
              <Box component="span" sx={{ ml: 1 }}>
                | Tentatives restantes: <strong>{simStatusData.attemptsRemaining}</strong>/{simStatusData.maxAttempts}
              </Box>
            )}
          </Alert>

          {/* Verrouillage des tentatives */}
          {simStatusData?.isLocked && (
            <Alert severity="error" sx={{ mb: 2 }}>
              Les tentatives sont verrouillees. Cliquez sur "Reinitialiser" si vous etes sur du code.
              <Button
                size="small"
                color="error"
                onClick={() => resetPinAttemptsMutation.mutate()}
                sx={{ ml: 2 }}
              >
                Reinitialiser le compteur
              </Button>
            </Alert>
          )}

          {/* Erreur */}
          {pinError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {pinError}
            </Alert>
          )}

          {/* Champs PIN */}
          <TextField
            autoFocus
            margin="dense"
            label="Code PIN"
            fullWidth
            type="password"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="****"
            helperText="4 a 8 chiffres"
            inputProps={{ maxLength: 8, inputMode: 'numeric' }}
            disabled={simStatusData?.isLocked}
            sx={{ mb: 2 }}
          />

          <TextField
            margin="dense"
            label="Confirmer le code PIN"
            fullWidth
            type="password"
            value={pinConfirmInput}
            onChange={(e) => setPinConfirmInput(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="****"
            helperText={pinInput && pinConfirmInput && pinInput !== pinConfirmInput ? 'Les codes ne correspondent pas' : 'Entrez le meme code pour confirmer'}
            error={pinInput.length > 0 && pinConfirmInput.length > 0 && pinInput !== pinConfirmInput}
            inputProps={{ maxLength: 8, inputMode: 'numeric' }}
            disabled={simStatusData?.isLocked}
          />

          {modemConfigData?.modems?.[currentConfigModemId]?.pinConfigured && (
            <Alert severity="success" sx={{ mt: 2 }}>
              Un code PIN est deja configure. Entrez un nouveau code pour le remplacer.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setPinDialogOpen(false); setPinInput(''); setPinConfirmInput(''); setPinError(null); }}>
            Annuler
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => enterPinMutation.mutate({ pin: pinInput, pinConfirm: pinConfirmInput, modemId: currentConfigModemId })}
            disabled={
              !pinInput ||
              pinInput.length < 4 ||
              pinInput !== pinConfirmInput ||
              enterPinMutation.isPending ||
              simStatusData?.isLocked
            }
          >
            {enterPinMutation.isPending ? 'Verification...' : 'Valider PIN'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* quectel.conf Dialog */}
      <Dialog open={confDialogOpen} onClose={() => setConfDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CodeIcon color="primary" />
            Configuration Asterisk (quectel.conf)
          </Box>
        </DialogTitle>
        <DialogContent>
          <Tabs
            value={0}
            sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab label="Apercu (nouvelle config)" />
          </Tabs>

          <Box
            sx={{
              bgcolor: 'grey.900',
              color: 'grey.100',
              p: 2,
              borderRadius: 1,
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              whiteSpace: 'pre-wrap',
              overflow: 'auto',
              maxHeight: 400,
            }}
          >
            {quectelConfData?.preview || 'Chargement...'}
          </Box>

          {quectelConfData?.current && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                Configuration actuelle sur le serveur:
              </Typography>
              <Box
                sx={{
                  bgcolor: alpha(theme.palette.info.main, 0.1),
                  p: 2,
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                  whiteSpace: 'pre-wrap',
                  overflow: 'auto',
                  maxHeight: 200,
                }}
              >
                {quectelConfData.current}
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfDialogOpen(false)}>Fermer</Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={() => {
              applyConfigMutation.mutate({ modemId: currentConfigModemId, config: configForm });
              setConfDialogOpen(false);
            }}
            disabled={applyConfigMutation.isPending}
          >
            Appliquer cette configuration
          </Button>
        </DialogActions>
      </Dialog>

      {/* Trunk SIP Dialog */}
      <Dialog open={trunkDialogOpen} onClose={() => setTrunkDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TrunkIcon color="secondary" />
            Créer Trunk SIP FreePBX
          </Box>
          <Typography variant="body2" color="text.secondary">
            Modem: {selectedModemId}
          </Typography>
        </DialogTitle>
        <DialogContent>
          {/* Trunk Status */}
          {trunkStatusData?.exists && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Un trunk <strong>{trunkStatusData.trunkName}</strong> existe déjà pour ce modem.
              <Button
                size="small"
                color="error"
                onClick={() => selectedModemId && deleteTrunkMutation.mutate(selectedModemId)}
                sx={{ ml: 2 }}
              >
                Supprimer
              </Button>
            </Alert>
          )}

          {!trunkDefaultsData?.pbxConnected && (
            <Alert severity="error" sx={{ mb: 2 }}>
              FreePBX n'est pas connecté. Vérifiez la configuration AMI.
            </Alert>
          )}

          <Grid container spacing={2} sx={{ mt: 1 }}>
            {/* Phone Number */}
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                size="small"
                label="Numéro de téléphone"
                value={trunkConfig.phoneNumber}
                onChange={(e) => setTrunkConfig({ ...trunkConfig, phoneNumber: e.target.value.replace(/[^0-9+]/g, '') })}
                placeholder="+590690XXXXXX"
                helperText="CallerID sortant"
              />
            </Grid>

            {/* Modem Name */}
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                size="small"
                label="Nom du trunk"
                value={trunkConfig.modemName}
                onChange={(e) => setTrunkConfig({ ...trunkConfig, modemName: e.target.value })}
                helperText="Ex: GSM-Principal"
              />
            </Grid>

            {/* Context */}
            <Grid item xs={12} md={6}>
              <FormControl fullWidth size="small">
                <InputLabel>Contexte entrant</InputLabel>
                <Select
                  value={trunkConfig.context}
                  label="Contexte entrant"
                  onChange={(e) => setTrunkConfig({ ...trunkConfig, context: e.target.value })}
                >
                  {trunkDefaultsData?.options?.contexts?.map((ctx) => (
                    <MenuItem key={ctx.value} value={ctx.value}>
                      <Box>
                        <Typography variant="body2" fontWeight={500}>{ctx.label}</Typography>
                        <Typography variant="caption" color="text.secondary">{ctx.description}</Typography>
                      </Box>
                    </MenuItem>
                  )) || (
                    <>
                      <MenuItem value="from-gsm">from-gsm (défaut)</MenuItem>
                      <MenuItem value="from-internal">from-internal</MenuItem>
                      <MenuItem value="from-trunk">from-trunk</MenuItem>
                    </>
                  )}
                </Select>
              </FormControl>
            </Grid>

            {/* Caller ID Mode */}
            <Grid item xs={12} md={6}>
              <FormControl fullWidth size="small">
                <InputLabel>Mode CallerID</InputLabel>
                <Select
                  value={trunkConfig.callerIdMode}
                  label="Mode CallerID"
                  onChange={(e) => setTrunkConfig({ ...trunkConfig, callerIdMode: e.target.value })}
                >
                  {trunkDefaultsData?.options?.callerIdModes?.map((mode) => (
                    <MenuItem key={mode.value} value={mode.value}>
                      <Box>
                        <Typography variant="body2" fontWeight={500}>{mode.label}</Typography>
                        <Typography variant="caption" color="text.secondary">{mode.description}</Typography>
                      </Box>
                    </MenuItem>
                  )) || (
                    <>
                      <MenuItem value="keep">Conserver</MenuItem>
                      <MenuItem value="trunk">Trunk</MenuItem>
                      <MenuItem value="none">Aucun</MenuItem>
                    </>
                  )}
                </Select>
              </FormControl>
            </Grid>

            {/* Max Channels */}
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Canaux max"
                value={trunkConfig.maxChannels}
                onChange={(e) => setTrunkConfig({ ...trunkConfig, maxChannels: Math.max(1, Math.min(4, parseInt(e.target.value) || 1)) })}
                inputProps={{ min: 1, max: 4 }}
                helperText="1 pour modem GSM standard"
              />
            </Grid>
          </Grid>

          {/* Info */}
          <Alert severity="info" sx={{ mt: 2 }}>
            <Typography variant="body2">
              Le trunk sera créé avec le dial string: <code>Quectel/{selectedModemId}/$OUTNUM$</code>
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Utilisez ce trunk dans les routes sortantes FreePBX pour router les appels via ce modem.
            </Typography>
          </Alert>

          {actionResult && (
            <Alert severity={actionResult.success ? 'success' : 'error'} sx={{ mt: 2 }}>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {actionResult.message}
              </pre>
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTrunkDialogOpen(false)}>Annuler</Button>
          {trunkStatusData?.exists ? (
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => selectedModemId && deleteTrunkMutation.mutate(selectedModemId)}
              disabled={deleteTrunkMutation.isPending}
            >
              Supprimer le trunk
            </Button>
          ) : (
            <Button
              variant="contained"
              color="secondary"
              startIcon={<TrunkIcon />}
              onClick={() => selectedModemId && createTrunkMutation.mutate({ modemId: selectedModemId, config: trunkConfig })}
              disabled={createTrunkMutation.isPending || !trunkDefaultsData?.pbxConnected}
            >
              Créer le trunk
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Add Modem Dialog */}
      <Dialog open={addModemDialogOpen} onClose={() => setAddModemDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <AddIcon color="primary" />
            Ajouter un modem
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Configurez les parametres du modem a ajouter a Asterisk. Les ports seront ajoutes au fichier quectel.conf.
          </Typography>

          <Grid container spacing={2}>
            <Grid item xs={12}>
              <FormControl fullWidth size="small">
                <InputLabel>Type de Modem</InputLabel>
                <Select
                  value={addModemForm.modemType}
                  label="Type de Modem"
                  onChange={(e) => {
                    const type = e.target.value;
                    // Auto-adjust audio port based on modem type
                    const audioPort = type === 'sim7600' ? '/dev/ttyUSB4' : '/dev/ttyUSB1';
                    setAddModemForm(prev => ({
                      ...prev,
                      modemType: type,
                      audioPort: prev.audioPort === '/dev/ttyUSB4' || prev.audioPort === '/dev/ttyUSB1' ? audioPort : prev.audioPort,
                    }));
                  }}
                >
                  <MenuItem value="sim7600">
                    <Box>
                      <Typography variant="body2" fontWeight={500}>Simcom SIM7600</Typography>
                      <Typography variant="caption" color="text.secondary">Audio 16kHz - Port audio: ttyUSB+4</Typography>
                    </Box>
                  </MenuItem>
                  <MenuItem value="ec25">
                    <Box>
                      <Typography variant="body2" fontWeight={500}>Quectel EC25</Typography>
                      <Typography variant="caption" color="text.secondary">Audio 8kHz - Port audio: ttyUSB+1</Typography>
                    </Box>
                  </MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={6}>
              <TextField
                fullWidth
                size="small"
                label="Port Data (AT)"
                value={addModemForm.dataPort}
                onChange={(e) => setAddModemForm(prev => ({ ...prev, dataPort: e.target.value }))}
                placeholder="/dev/ttyUSB2"
                helperText="Port pour commandes AT"
              />
            </Grid>

            <Grid item xs={6}>
              <TextField
                fullWidth
                size="small"
                label="Port Audio"
                value={addModemForm.audioPort}
                onChange={(e) => setAddModemForm(prev => ({ ...prev, audioPort: e.target.value }))}
                placeholder="/dev/ttyUSB4"
                helperText="Port pour audio PCM"
              />
            </Grid>

            <Grid item xs={6}>
              <TextField
                fullWidth
                size="small"
                label="Nom du modem (optionnel)"
                value={addModemForm.modemName}
                onChange={(e) => setAddModemForm(prev => ({ ...prev, modemName: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12) }))}
                placeholder={`hni-${addModemForm.modemType}`}
                helperText="Identifiant dans Asterisk"
              />
            </Grid>

            <Grid item xs={6}>
              <TextField
                fullWidth
                size="small"
                label="Numero de telephone (optionnel)"
                value={addModemForm.phoneNumber}
                onChange={(e) => setAddModemForm(prev => ({ ...prev, phoneNumber: e.target.value.replace(/[^0-9+]/g, '') }))}
                placeholder="+590690XXXXXX"
                helperText="Format international"
              />
            </Grid>
          </Grid>

          {actionResult && (
            <Alert
              severity={actionResult.success ? 'success' : 'error'}
              sx={{ mt: 2 }}
              onClose={() => setActionResult(null)}
            >
              {actionResult.message}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddModemDialogOpen(false)}>
            Annuler
          </Button>
          <Button
            variant="contained"
            color="primary"
            startIcon={addModemMutation.isPending ? <CircularProgress size={20} color="inherit" /> : <AddIcon />}
            onClick={() => addModemMutation.mutate(addModemForm)}
            disabled={addModemMutation.isPending || !addModemForm.dataPort || !addModemForm.audioPort}
          >
            Ajouter le modem
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
