import { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Grid,
  Chip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
  LinearProgress,
  Skeleton,
  alpha,
  useTheme,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  QrCode as QrCodeIcon,
  Logout as LogoutIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  HourglassEmpty as PendingIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { whatsappApi } from '../services/api';
import type { WhatsAppSession } from '../services/api';

export default function WhatsAppPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<WhatsAppSession | null>(null);
  const [newSessionName, setNewSessionName] = useState('');
  const [qrData, setQrData] = useState<{ qr: string; status: string } | null>(null);

  const { data: sessions, isLoading } = useQuery<WhatsAppSession[]>({
    queryKey: ['whatsapp-sessions'],
    queryFn: whatsappApi.getSessions,
  });

  const createMutation = useMutation({
    mutationFn: whatsappApi.createSession,
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-sessions'] });
      setCreateDialogOpen(false);
      setNewSessionName('');
      // Ouvrir le QR code pour la nouvelle session
      setSelectedSession(session);
      setQrDialogOpen(true);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: whatsappApi.deleteSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-sessions'] });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: whatsappApi.logout,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-sessions'] });
    },
  });

  // Polling du QR code
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;

    if (qrDialogOpen && selectedSession) {
      const fetchQr = async () => {
        try {
          const data = await whatsappApi.getQrCode(selectedSession.id);
          setQrData(data);

          // Si connecté, fermer le dialog
          if (data.status === 'connected') {
            setQrDialogOpen(false);
            queryClient.invalidateQueries({ queryKey: ['whatsapp-sessions'] });
          }
        } catch (error) {
          console.error('Error fetching QR:', error);
        }
      };

      fetchQr();
      interval = setInterval(fetchQr, 3000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [qrDialogOpen, selectedSession, queryClient]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
        return <CheckCircleIcon sx={{ color: theme.palette.success.main }} />;
      case 'qr_pending':
        return <QrCodeIcon sx={{ color: theme.palette.warning.main }} />;
      case 'initializing':
        return <PendingIcon sx={{ color: theme.palette.info.main }} />;
      default:
        return <ErrorIcon sx={{ color: theme.palette.error.main }} />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected':
        return theme.palette.success.main;
      case 'qr_pending':
        return theme.palette.warning.main;
      case 'initializing':
        return theme.palette.info.main;
      default:
        return theme.palette.error.main;
    }
  };

  if (isLoading) {
    return <LinearProgress />;
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            WhatsApp
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Gérez vos sessions WhatsApp Baileys
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['whatsapp-sessions'] })}
          >
            Actualiser
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateDialogOpen(true)}
            sx={{
              backgroundColor: '#25D366',
              '&:hover': { backgroundColor: '#128C7E' },
            }}
          >
            Nouvelle session
          </Button>
        </Box>
      </Box>

      {/* Sessions Grid */}
      <Grid container spacing={3}>
        {sessions && sessions.length > 0 ? (
          sessions.map((session) => (
            <Grid item xs={12} sm={6} md={4} key={session.id}>
              <Card
                sx={{
                  height: '100%',
                  border: `1px solid ${alpha(getStatusColor(session.status), 0.3)}`,
                  backgroundColor: alpha(getStatusColor(session.status), 0.05),
                }}
              >
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                    {getStatusIcon(session.status)}
                    <Typography variant="h6" sx={{ ml: 1, fontWeight: 600, flex: 1 }}>
                      {session.name}
                    </Typography>
                    <Chip
                      label={session.status}
                      size="small"
                      sx={{
                        backgroundColor: alpha(getStatusColor(session.status), 0.2),
                        color: getStatusColor(session.status),
                      }}
                    />
                  </Box>

                  {session.phone && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Numéro: {session.phone}
                    </Typography>
                  )}

                  {session.lastSeen && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Dernière activité: {new Date(session.lastSeen).toLocaleString('fr-FR')}
                    </Typography>
                  )}

                  {session.messageCount !== undefined && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      Messages: {session.messageCount}
                    </Typography>
                  )}

                  <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
                    {session.status === 'qr_pending' && (
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<QrCodeIcon />}
                        onClick={() => {
                          setSelectedSession(session);
                          setQrDialogOpen(true);
                        }}
                      >
                        Scanner QR
                      </Button>
                    )}

                    {session.status === 'connected' && (
                      <Button
                        variant="outlined"
                        size="small"
                        color="warning"
                        startIcon={<LogoutIcon />}
                        onClick={() => {
                          if (confirm('Déconnecter cette session ?')) {
                            logoutMutation.mutate(session.id);
                          }
                        }}
                      >
                        Déconnecter
                      </Button>
                    )}

                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => {
                        if (confirm(`Supprimer la session "${session.name}" ?`)) {
                          deleteMutation.mutate(session.id);
                        }
                      }}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          ))
        ) : (
          <Grid item xs={12}>
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 6 }}>
                <QrCodeIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
                <Typography variant="h6" color="text.secondary" sx={{ mb: 2 }}>
                  Aucune session WhatsApp
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Créez une nouvelle session pour commencer à utiliser WhatsApp via Baileys
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => setCreateDialogOpen(true)}
                  sx={{
                    backgroundColor: '#25D366',
                    '&:hover': { backgroundColor: '#128C7E' },
                  }}
                >
                  Créer une session
                </Button>
              </CardContent>
            </Card>
          </Grid>
        )}
      </Grid>

      {/* Create Session Dialog */}
      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)}>
        <DialogTitle>Nouvelle session WhatsApp</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Nom de la session"
            fullWidth
            value={newSessionName}
            onChange={(e) => setNewSessionName(e.target.value)}
            placeholder="Ex: Bureau, Personnel..."
            sx={{ mt: 1 }}
          />
          <Alert severity="info" sx={{ mt: 2 }}>
            Après la création, vous devrez scanner le QR code avec WhatsApp sur votre téléphone.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialogOpen(false)}>Annuler</Button>
          <Button
            variant="contained"
            onClick={() => createMutation.mutate(newSessionName)}
            disabled={!newSessionName.trim() || createMutation.isPending}
          >
            Créer
          </Button>
        </DialogActions>
      </Dialog>

      {/* QR Code Dialog */}
      <Dialog
        open={qrDialogOpen}
        onClose={() => setQrDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Scanner le QR Code
          {selectedSession && (
            <Typography variant="body2" color="text.secondary">
              Session: {selectedSession.name}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              py: 3,
            }}
          >
            {qrData?.qr ? (
              <>
                <Box
                  sx={{
                    p: 2,
                    backgroundColor: 'white',
                    borderRadius: 2,
                    mb: 2,
                  }}
                >
                  <img
                    src={qrData.qr}
                    alt="WhatsApp QR Code"
                    style={{ width: 256, height: 256 }}
                  />
                </Box>
                <Typography variant="body2" color="text.secondary" align="center">
                  Ouvrez WhatsApp sur votre téléphone, allez dans Paramètres &gt; Appareils liés
                  &gt; Lier un appareil, puis scannez ce QR code.
                </Typography>
              </>
            ) : qrData?.status === 'connected' ? (
              <Alert severity="success" sx={{ width: '100%' }}>
                Session connectée avec succès !
              </Alert>
            ) : (
              <Box sx={{ width: '100%' }}>
                <Skeleton variant="rectangular" height={256} sx={{ borderRadius: 2, mb: 2 }} />
                <Typography variant="body2" color="text.secondary" align="center">
                  Génération du QR code en cours...
                </Typography>
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setQrDialogOpen(false)}>Fermer</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
