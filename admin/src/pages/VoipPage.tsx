import { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Grid,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
  LinearProgress,
  IconButton,
  Tooltip,
  alpha,
  useTheme,
} from '@mui/material';
import {
  Phone as PhoneIcon,
  Refresh as RefreshIcon,
  Call as CallIcon,
  PhoneForwarded as TrunkIcon,
  PersonPin as ExtensionIcon,
  CheckCircle as OnlineIcon,
  Cancel as OfflineIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { voipApi } from '../services/api';

interface Trunk {
  id: string;
  name: string;
  type: string;
  host: string;
  status: 'online' | 'offline' | 'unknown';
  registrationStatus?: string;
}

interface Extension {
  extension: string;
  name: string;
  status: 'online' | 'offline' | 'busy' | 'ringing';
  ip?: string;
}

export default function VoipPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testExtension, setTestExtension] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);

  const { data: trunks, isLoading: trunksLoading } = useQuery<Trunk[]>({
    queryKey: ['voip-trunks'],
    queryFn: voipApi.getTrunks,
  });

  const { data: extensions, isLoading: extensionsLoading } = useQuery<Extension[]>({
    queryKey: ['voip-extensions'],
    queryFn: voipApi.getExtensions,
  });

  const testCallMutation = useMutation({
    mutationFn: voipApi.testCall,
    onSuccess: (result) => {
      setTestResult(result);
    },
    onError: (error: Error) => {
      setTestResult({ success: false, message: error.message });
    },
  });

  const handleTestCall = () => {
    if (testExtension) {
      testCallMutation.mutate(testExtension);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online':
        return <OnlineIcon sx={{ color: theme.palette.success.main, fontSize: 20 }} />;
      case 'offline':
        return <OfflineIcon sx={{ color: theme.palette.error.main, fontSize: 20 }} />;
      case 'busy':
        return <PhoneIcon sx={{ color: theme.palette.warning.main, fontSize: 20 }} />;
      case 'ringing':
        return <CallIcon sx={{ color: theme.palette.info.main, fontSize: 20 }} />;
      default:
        return <OfflineIcon sx={{ color: theme.palette.action.disabled, fontSize: 20 }} />;
    }
  };

  const isLoading = trunksLoading || extensionsLoading;

  if (isLoading) {
    return <LinearProgress />;
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            VoIP
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Gérez vos trunks et extensions VoIP
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['voip-trunks'] });
              queryClient.invalidateQueries({ queryKey: ['voip-extensions'] });
            }}
          >
            Actualiser
          </Button>
          <Button
            variant="contained"
            startIcon={<CallIcon />}
            onClick={() => setTestDialogOpen(true)}
          >
            Test d'appel
          </Button>
        </Box>
      </Box>

      <Grid container spacing={3}>
        {/* Trunks Section */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <TrunkIcon sx={{ mr: 1, color: 'warning.main' }} />
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Trunks SIP
                </Typography>
                <Chip
                  label={`${trunks?.length || 0} configuré(s)`}
                  size="small"
                  sx={{ ml: 1 }}
                />
              </Box>

              {trunks && trunks.length > 0 ? (
                <TableContainer>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableCell>Nom</TableCell>
                        <TableCell>Type</TableCell>
                        <TableCell>Hôte</TableCell>
                        <TableCell>Statut</TableCell>
                        <TableCell>Enregistrement</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {trunks.map((trunk) => (
                        <TableRow key={trunk.id} hover>
                          <TableCell>
                            <Typography variant="body2" fontWeight={500}>
                              {trunk.name}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={trunk.type}
                              size="small"
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell>{trunk.host}</TableCell>
                          <TableCell>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              {getStatusIcon(trunk.status)}
                              <Typography variant="body2">
                                {trunk.status}
                              </Typography>
                            </Box>
                          </TableCell>
                          <TableCell>
                            {trunk.registrationStatus || '-'}
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
                    backgroundColor: alpha(theme.palette.warning.main, 0.05),
                    borderRadius: 2,
                  }}
                >
                  <TrunkIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
                  <Typography color="text.secondary">
                    Aucun trunk SIP configuré
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Configurez FreePBX ou un provider SIP dans la section Providers
                  </Typography>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Extensions Section */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <ExtensionIcon sx={{ mr: 1, color: 'primary.main' }} />
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Extensions
                </Typography>
                <Chip
                  label={`${extensions?.filter(e => e.status === 'online').length || 0}/${extensions?.length || 0} en ligne`}
                  size="small"
                  color="success"
                  sx={{ ml: 1 }}
                />
              </Box>

              {extensions && extensions.length > 0 ? (
                <Grid container spacing={2}>
                  {extensions.map((ext) => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={ext.extension}>
                      <Card
                        variant="outlined"
                        sx={{
                          backgroundColor: alpha(
                            ext.status === 'online'
                              ? theme.palette.success.main
                              : ext.status === 'busy'
                              ? theme.palette.warning.main
                              : theme.palette.error.main,
                            0.05
                          ),
                        }}
                      >
                        <CardContent sx={{ py: 1.5 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            {getStatusIcon(ext.status)}
                            <Box sx={{ ml: 1, flex: 1 }}>
                              <Typography variant="subtitle2" fontWeight={600}>
                                {ext.extension}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {ext.name}
                              </Typography>
                            </Box>
                            <Tooltip title="Appeler">
                              <IconButton
                                size="small"
                                color="primary"
                                disabled={ext.status !== 'online'}
                                onClick={() => {
                                  setTestExtension(ext.extension);
                                  setTestDialogOpen(true);
                                }}
                              >
                                <CallIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Box>
                          {ext.ip && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                              IP: {ext.ip}
                            </Typography>
                          )}
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
                  <ExtensionIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
                  <Typography color="text.secondary">
                    Aucune extension enregistrée
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Les extensions apparaîtront ici une fois enregistrées sur le PBX
                  </Typography>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Test Call Dialog */}
      <Dialog open={testDialogOpen} onClose={() => setTestDialogOpen(false)}>
        <DialogTitle>Test d'appel</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Extension à appeler"
            fullWidth
            value={testExtension}
            onChange={(e) => setTestExtension(e.target.value)}
            placeholder="1001"
            sx={{ mt: 1 }}
          />
          <Alert severity="info" sx={{ mt: 2 }}>
            Un appel test sera initié vers l'extension spécifiée. Assurez-vous que l'extension est en ligne.
          </Alert>

          {testResult && (
            <Alert
              severity={testResult.success ? 'success' : 'error'}
              sx={{ mt: 2 }}
            >
              {testResult.success
                ? 'Appel initié avec succès !'
                : testResult.message || 'Erreur lors de l\'appel'}
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
            startIcon={<CallIcon />}
            onClick={handleTestCall}
            disabled={!testExtension || testCallMutation.isPending}
          >
            Appeler
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
