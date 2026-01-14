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
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { modemsApi, providersApi } from '../services/api';
import type { Modem, Provider } from '../services/api';

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

  const smsProviders = providers?.filter(p =>
    ['twilio', 'ovh', 'plivo'].includes(p.type)
  );

  const scanMutation = useMutation({
    mutationFn: modemsApi.scan,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['modems'] });
    },
  });

  const sendTestMutation = useMutation({
    mutationFn: ({ modemId, to, message }: { modemId: string; to: string; message: string }) =>
      modemsApi.sendTestSms(modemId, to, message),
    onSuccess: (result) => {
      setTestResult(result);
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

  const isLoading = modemsLoading || providersLoading;

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
            Gérez vos modems GSM et providers SMS cloud
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['modems'] });
              queryClient.invalidateQueries({ queryKey: ['providers'] });
            }}
          >
            Actualiser
          </Button>
          <Button
            variant="contained"
            startIcon={<UsbIcon />}
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
          >
            Scanner les modems
          </Button>
        </Box>
      </Box>

      <Grid container spacing={3}>
        {/* Modems Section */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <SimCardIcon sx={{ mr: 1, color: 'primary.main' }} />
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Modems GSM
                </Typography>
                <Chip
                  label={`${modems?.length || 0} détecté(s)`}
                  size="small"
                  sx={{ ml: 1 }}
                />
              </Box>

              {modems && modems.length > 0 ? (
                <TableContainer>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableCell>Appareil</TableCell>
                        <TableCell>Type</TableCell>
                        <TableCell>Numéro</TableCell>
                        <TableCell>Opérateur</TableCell>
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
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={modem.type}
                              size="small"
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell>
                            {modem.phone || '-'}
                          </TableCell>
                          <TableCell>
                            {modem.operator || '-'}
                          </TableCell>
                          <TableCell>
                            {getSignalBars(modem.signal)}
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={modem.status}
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
                    Aucun modem GSM détecté
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Connectez un modem USB (SIM7600, EC25) et cliquez sur "Scanner les modems"
                  </Typography>
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
                  label={`${smsProviders?.length || 0} configuré(s)`}
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
                    Aucun provider cloud SMS configuré
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
              Via: {selectedModem.device} ({selectedModem.phone || 'Numéro inconnu'})
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Numéro de téléphone"
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
                ? 'SMS envoyé avec succès !'
                : testResult.message || 'Erreur lors de l\'envoi'}
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
