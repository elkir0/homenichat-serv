import { useState } from 'react';
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
} from '@mui/material';
import {
  Send as SendIcon,
  Refresh as RefreshIcon,
  SimCard as SimCardIcon,
  Usb as UsbIcon,
  Cloud as CloudIcon,
  Inbox as InboxIcon,
  Outbox as OutboxIcon,
  Storage as StorageIcon,
  Schedule as ScheduleIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { modemsApi, providersApi, smsApi } from '../services/api';
import type { Modem, Provider, SmsStats } from '../services/api';

export default function SmsPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [selectedModem, setSelectedModem] = useState<Modem | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [testMessage, setTestMessage] = useState('Test SMS depuis Homenichat Admin');
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);

  const { data: modems, isLoading: modemsLoading } = useQuery<Modem[]>({
    queryKey: ['modems'],
    queryFn: modemsApi.getAll,
  });

  const { data: providers, isLoading: providersLoading } = useQuery<Provider[]>({
    queryKey: ['providers'],
    queryFn: providersApi.getAll,
  });

  const { data: smsStats, isLoading: statsLoading } = useQuery<SmsStats>({
    queryKey: ['smsStats'],
    queryFn: smsApi.getStats,
    refetchInterval: 30000,
  });

  const smsProviders = providers?.filter(p =>
    ['twilio', 'ovh', 'plivo'].includes(p.type)
  );

  const sendTestMutation = useMutation({
    mutationFn: ({ modemId, to, message }: { modemId: string; to: string; message: string }) =>
      modemsApi.sendTestSms(modemId, to, message),
    onSuccess: (result) => {
      setTestResult(result);
      queryClient.invalidateQueries({ queryKey: ['smsStats'] });
    },
    onError: (error: Error) => {
      setTestResult({ success: false, message: error.message });
    },
  });

  const handleSendTest = () => {
    if (selectedModem && testPhone) {
      sendTestMutation.mutate({
        modemId: selectedModem.id,
        to: testPhone,
        message: testMessage,
      });
    }
  };

  const getSignalBars = (signal?: number) => {
    if (signal === undefined) return null;
    const bars = Math.min(5, Math.max(1, Math.ceil(signal / 20)));
    return (
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.3 }}>
        {[1, 2, 3, 4, 5].map((bar) => (
          <Box
            key={bar}
            sx={{
              width: 4,
              height: 4 + bar * 3,
              backgroundColor: bar <= bars ? theme.palette.success.main : theme.palette.action.disabled,
              borderRadius: 0.5,
            }}
          />
        ))}
        <Typography variant="caption" sx={{ ml: 0.5 }}>
          {signal}%
        </Typography>
      </Box>
    );
  };

  const formatLastActivity = (timestamp: string | null) => {
    if (!timestamp) return 'Jamais';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "A l'instant";
    if (minutes < 60) return `Il y a ${minutes} min`;
    if (hours < 24) return `Il y a ${hours}h`;
    return `Il y a ${days}j`;
  };

  const isLoading = modemsLoading || providersLoading || statsLoading;

  if (isLoading) {
    return <LinearProgress />;
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            SMS
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Gerez vos modems GSM et providers SMS cloud
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['modems'] });
              queryClient.invalidateQueries({ queryKey: ['providers'] });
              queryClient.invalidateQueries({ queryKey: ['smsStats'] });
            }}
          >
            Actualiser
          </Button>
        </Box>
      </Box>

      {/* Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} sm={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.success.main, 0.1) }}>
            <CardContent sx={{ py: 2, '&:last-child': { pb: 2 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <OutboxIcon sx={{ color: 'success.main', mr: 1 }} />
                <Typography variant="body2" color="text.secondary">Envoyes</Typography>
              </Box>
              <Typography variant="h4" sx={{ fontWeight: 700, color: 'success.main' }}>
                {smsStats?.total.sent || 0}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                +{smsStats?.today.sent || 0} aujourd'hui
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={6} sm={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.info.main, 0.1) }}>
            <CardContent sx={{ py: 2, '&:last-child': { pb: 2 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <InboxIcon sx={{ color: 'info.main', mr: 1 }} />
                <Typography variant="body2" color="text.secondary">Recus</Typography>
              </Box>
              <Typography variant="h4" sx={{ fontWeight: 700, color: 'info.main' }}>
                {smsStats?.total.received || 0}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                +{smsStats?.today.received || 0} aujourd'hui
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={6} sm={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.warning.main, 0.1) }}>
            <CardContent sx={{ py: 2, '&:last-child': { pb: 2 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <StorageIcon sx={{ color: 'warning.main', mr: 1 }} />
                <Typography variant="body2" color="text.secondary">Stockes</Typography>
              </Box>
              <Typography variant="h4" sx={{ fontWeight: 700, color: 'warning.main' }}>
                {smsStats?.storage.count || 0}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {smsStats?.config?.storage === 'sqlite' ? 'SQLite' : smsStats?.config?.storage || 'N/A'}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={6} sm={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.text.primary, 0.05) }}>
            <CardContent sx={{ py: 2, '&:last-child': { pb: 2 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <ScheduleIcon sx={{ color: 'text.secondary', mr: 1 }} />
                <Typography variant="body2" color="text.secondary">Derniere activite</Typography>
              </Box>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                {formatLastActivity(smsStats?.lastActivity || null)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {smsStats?.total.failed || 0} echec(s)
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Grid container spacing={3}>
        {/* Modems Section */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <SimCardIcon sx={{ mr: 1, color: 'primary.main' }} />
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    Trunk GSM
                  </Typography>
                  {smsStats?.config?.enabled && (
                    <Chip
                      icon={<CheckIcon />}
                      label="SMS actif"
                      size="small"
                      color="success"
                      sx={{ ml: 1 }}
                    />
                  )}
                </Box>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<SettingsIcon />}
                  href="/modems"
                >
                  Configurer
                </Button>
              </Box>

              {modems && modems.length > 0 ? (
                <TableContainer>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableCell>Modem</TableCell>
                        <TableCell>Type</TableCell>
                        <TableCell>Numero</TableCell>
                        <TableCell>Operateur</TableCell>
                        <TableCell>Reseau</TableCell>
                        <TableCell>Signal</TableCell>
                        <TableCell>Statut</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {modems.map((modem) => (
                        <TableRow key={modem.id} hover>
                          <TableCell>
                            <Typography variant="body2" fontWeight={500}>
                              {modem.device}
                            </Typography>
                            {modem.imei && (
                              <Typography variant="caption" color="text.secondary">
                                IMEI: {modem.imei}
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={modem.type}
                              size="small"
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" fontWeight={500}>
                              {modem.phone || '-'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            {modem.operator || '-'}
                          </TableCell>
                          <TableCell>
                            {modem.technology && (
                              <Chip
                                label={modem.technology}
                                size="small"
                                variant="outlined"
                                color="info"
                              />
                            )}
                          </TableCell>
                          <TableCell>
                            {getSignalBars(modem.signal)}
                          </TableCell>
                          <TableCell>
                            <Chip
                              icon={modem.status === 'connected' ? <CheckIcon /> : <ErrorIcon />}
                              label={modem.status === 'connected' ? 'Connecte' : modem.status}
                              size="small"
                              color={modem.status === 'connected' ? 'success' : 'error'}
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell align="right">
                            <Tooltip title="Envoyer un SMS test">
                              <IconButton
                                size="small"
                                color="primary"
                                onClick={() => {
                                  setSelectedModem(modem);
                                  setTestDialogOpen(true);
                                }}
                                disabled={modem.status !== 'connected'}
                              >
                                <SendIcon />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              ) : (
                <Box
                  sx={{
                    textAlign: 'center',
                    py: 4,
                    backgroundColor: alpha(theme.palette.info.main, 0.05),
                    borderRadius: 2,
                  }}
                >
                  <UsbIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
                  <Typography color="text.secondary">
                    Aucun modem GSM detecte
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Configurez votre modem dans la section "Modems"
                  </Typography>
                  <Button
                    variant="contained"
                    href="/modems"
                    startIcon={<SettingsIcon />}
                  >
                    Configurer un modem
                  </Button>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Cloud Providers Section */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <CloudIcon sx={{ mr: 1, color: 'info.main' }} />
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Providers Cloud SMS
                </Typography>
                <Chip
                  label={`${smsProviders?.length || 0} configure(s)`}
                  size="small"
                  sx={{ ml: 1 }}
                />
              </Box>

              {smsProviders && smsProviders.length > 0 ? (
                <Grid container spacing={2}>
                  {smsProviders.map((provider) => (
                    <Grid item xs={12} sm={6} md={4} key={provider.id}>
                      <Card
                        variant="outlined"
                        sx={{
                          backgroundColor: alpha(
                            provider.status === 'connected'
                              ? theme.palette.success.main
                              : theme.palette.error.main,
                            0.05
                          ),
                        }}
                      >
                        <CardContent>
                          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                            <Typography variant="subtitle1" fontWeight={600}>
                              {provider.name}
                            </Typography>
                            <Chip
                              label={provider.type}
                              size="small"
                              sx={{ ml: 'auto' }}
                            />
                          </Box>
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <Chip
                              label={provider.enabled ? 'Actif' : 'Inactif'}
                              size="small"
                              color={provider.enabled ? 'success' : 'default'}
                              variant="outlined"
                            />
                          </Box>
                        </CardContent>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              ) : (
                <Box
                  sx={{
                    textAlign: 'center',
                    py: 4,
                    backgroundColor: alpha(theme.palette.info.main, 0.05),
                    borderRadius: 2,
                  }}
                >
                  <CloudIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
                  <Typography color="text.secondary">
                    Aucun provider cloud SMS configure
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Configurez Twilio, OVH ou Plivo dans la section Providers
                  </Typography>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Test SMS Dialog */}
      <Dialog open={testDialogOpen} onClose={() => setTestDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Envoyer un SMS test
          {selectedModem && (
            <Typography variant="body2" color="text.secondary">
              Via: {selectedModem.device} ({selectedModem.phone || 'Numero inconnu'})
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Numero de telephone"
            fullWidth
            value={testPhone}
            onChange={(e) => setTestPhone(e.target.value)}
            placeholder="+33612345678"
            sx={{ mb: 2 }}
          />
          <TextField
            margin="dense"
            label="Message"
            fullWidth
            multiline
            rows={3}
            value={testMessage}
            onChange={(e) => setTestMessage(e.target.value)}
          />

          {testResult && (
            <Alert
              severity={testResult.success ? 'success' : 'error'}
              sx={{ mt: 2 }}
            >
              {testResult.success
                ? 'SMS envoye avec succes !'
                : testResult.message || "Erreur lors de l'envoi"}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => {
            setTestDialogOpen(false);
            setTestResult(null);
          }}>
            Fermer
          </Button>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={handleSendTest}
            disabled={!testPhone || sendTestMutation.isPending}
          >
            Envoyer
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
