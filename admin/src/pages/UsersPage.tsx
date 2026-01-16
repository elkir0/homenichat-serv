import { useState } from 'react';
import {
  Box,
  Card,
  Typography,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Alert,
  LinearProgress,
  Tooltip,
  InputAdornment,
  FormControlLabel,
  Checkbox,
  Divider,
  Stack,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  Key as KeyIcon,
  Visibility,
  VisibilityOff,
  Shield as ShieldIcon,
  Phone as PhoneIcon,
  PhoneDisabled as PhoneDisabledIcon,
  ContentCopy as CopyIcon,
  Sync as SyncIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi, voipApi } from '../services/api';
import type { User, CreateUserResponse } from '../services/api';

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [voipDialogOpen, setVoipDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showVoipSecret, setShowVoipSecret] = useState(false);
  const [voipCredentials, setVoipCredentials] = useState<{ extension: string; secret: string } | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    role: 'user',
    createVoipExtension: true,
  });
  const [newPassword, setNewPassword] = useState('');

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: usersApi.getAll,
  });

  const { data: amiStatus } = useQuery({
    queryKey: ['ami-status'],
    queryFn: voipApi.getAmiStatus,
  });

  const createMutation = useMutation({
    mutationFn: usersApi.create,
    onSuccess: (response: CreateUserResponse) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });

      // Show VoIP credentials if created
      if (response.voip?.success && response.voip.secret) {
        setVoipCredentials({
          extension: response.voip.extension || '',
          secret: response.voip.secret,
        });
        setVoipDialogOpen(true);
      }

      handleCloseDialog();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<User> }) =>
      usersApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      handleCloseDialog();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: usersApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      usersApi.resetPassword(id, password),
    onSuccess: () => {
      setPasswordDialogOpen(false);
      setNewPassword('');
    },
  });

  const createVoipMutation = useMutation({
    mutationFn: (userId: number) => voipApi.createExtension({ userId, createOnPbx: true }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (response.secret) {
        setVoipCredentials({
          extension: response.extension.extension,
          secret: response.secret,
        });
        setVoipDialogOpen(true);
      }
    },
  });

  const deleteVoipMutation = useMutation({
    mutationFn: voipApi.deleteExtension,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const syncVoipMutation = useMutation({
    mutationFn: voipApi.syncExtension,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const regenerateSecretMutation = useMutation({
    mutationFn: voipApi.regenerateSecret,
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (response.newSecret) {
        setVoipCredentials({
          extension: response.extension.extension,
          secret: response.newSecret,
        });
        setVoipDialogOpen(true);
      }
    },
  });

  const handleOpenDialog = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setFormData({
        username: user.username,
        password: '',
        role: user.role,
        createVoipExtension: false,
      });
    } else {
      setEditingUser(null);
      setFormData({
        username: '',
        password: '',
        role: 'user',
        createVoipExtension: true,
      });
    }
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingUser(null);
    setShowPassword(false);
  };

  const handleSubmit = () => {
    if (editingUser) {
      const updateData: Partial<User> = {
        username: formData.username,
        role: formData.role as 'admin' | 'user',
      };
      updateMutation.mutate({ id: editingUser.id, data: updateData });
    } else {
      createMutation.mutate({
        username: formData.username,
        password: formData.password,
        role: formData.role,
        createVoipExtension: formData.createVoipExtension,
      });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
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
            Utilisateurs
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Gérez les comptes utilisateurs et leurs extensions VoIP
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          {amiStatus && (
            <Chip
              icon={amiStatus.canCreateExtensions ? <PhoneIcon /> : <PhoneDisabledIcon />}
              label={amiStatus.canCreateExtensions ? 'PBX connecté' : 'PBX déconnecté'}
              color={amiStatus.canCreateExtensions ? 'success' : 'default'}
              size="small"
              variant="outlined"
            />
          )}
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['users'] })}
          >
            Actualiser
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => handleOpenDialog()}
          >
            Ajouter
          </Button>
        </Box>
      </Box>

      {/* Users Table */}
      <Card>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Utilisateur</TableCell>
                <TableCell>Rôle</TableCell>
                <TableCell>Extension VoIP</TableCell>
                <TableCell>2FA</TableCell>
                <TableCell>Dernière connexion</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users && users.length > 0 ? (
                users.map((user) => (
                  <TableRow key={user.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {user.username}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={user.role}
                        size="small"
                        color={user.role === 'admin' ? 'primary' : 'default'}
                        variant={user.role === 'admin' ? 'filled' : 'outlined'}
                      />
                    </TableCell>
                    <TableCell>
                      {user.voipExtension ? (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Chip
                            icon={<PhoneIcon />}
                            label={user.voipExtension.extension}
                            size="small"
                            color={user.voipExtension.syncedToPbx ? 'success' : 'warning'}
                            variant="outlined"
                          />
                          {!user.voipExtension.syncedToPbx && (
                            <Tooltip title="Synchroniser avec le PBX">
                              <IconButton
                                size="small"
                                onClick={() => syncVoipMutation.mutate(user.id)}
                                disabled={syncVoipMutation.isPending}
                              >
                                <SyncIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                          <Tooltip title="Régénérer le secret">
                            <IconButton
                              size="small"
                              onClick={() => regenerateSecretMutation.mutate(user.id)}
                              disabled={regenerateSecretMutation.isPending}
                            >
                              <KeyIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Supprimer l'extension">
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => {
                                if (confirm(`Supprimer l'extension ${user.voipExtension?.extension} ?`)) {
                                  deleteVoipMutation.mutate(user.id);
                                }
                              }}
                              disabled={deleteVoipMutation.isPending}
                            >
                              <PhoneDisabledIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      ) : (
                        <Button
                          size="small"
                          startIcon={<PhoneIcon />}
                          onClick={() => createVoipMutation.mutate(user.id)}
                          disabled={createVoipMutation.isPending || !amiStatus?.canCreateExtensions}
                        >
                          Créer extension
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.twoFactorEnabled ? (
                        <Chip
                          icon={<ShieldIcon />}
                          label="Activé"
                          size="small"
                          color="success"
                          variant="outlined"
                        />
                      ) : (
                        <Chip
                          label="Désactivé"
                          size="small"
                          variant="outlined"
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {user.lastLogin
                          ? new Date(user.lastLogin).toLocaleString('fr-FR')
                          : 'Jamais'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Réinitialiser le mot de passe">
                        <IconButton
                          size="small"
                          onClick={() => {
                            setEditingUser(user);
                            setPasswordDialogOpen(true);
                          }}
                        >
                          <KeyIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Modifier">
                        <IconButton
                          size="small"
                          onClick={() => handleOpenDialog(user)}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Supprimer">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => {
                            if (confirm(`Supprimer l'utilisateur "${user.username}" ?${user.voipExtension ? '\nSon extension VoIP sera également supprimée.' : ''}`)) {
                              deleteMutation.mutate(user.id);
                            }
                          }}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 4 }}>
                      Aucun utilisateur trouvé
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* Add/Edit User Dialog */}
      <Dialog open={dialogOpen} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>
          {editingUser ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur'}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField
              label="Nom d'utilisateur"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              fullWidth
              required
            />

            {!editingUser && (
              <>
                <TextField
                  label="Mot de passe"
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  fullWidth
                  required
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          onClick={() => setShowPassword(!showPassword)}
                          edge="end"
                        >
                          {showPassword ? <VisibilityOff /> : <Visibility />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  }}
                />

                <Divider sx={{ my: 1 }} />

                <FormControlLabel
                  control={
                    <Checkbox
                      checked={formData.createVoipExtension}
                      onChange={(e) => setFormData({ ...formData, createVoipExtension: e.target.checked })}
                    />
                  }
                  label={
                    <Box>
                      <Typography variant="body1">Créer une extension VoIP</Typography>
                      <Typography variant="caption" color="text.secondary">
                        Permet à l'utilisateur de passer des appels depuis l'app
                      </Typography>
                    </Box>
                  }
                />

                {formData.createVoipExtension && !amiStatus?.canCreateExtensions && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    Le PBX n'est pas connecté. L'extension sera créée localement et synchronisée plus tard.
                  </Alert>
                )}
              </>
            )}

            <TextField
              select
              label="Rôle"
              value={formData.role}
              onChange={(e) => setFormData({ ...formData, role: e.target.value })}
              fullWidth
            >
              <MenuItem value="user">Utilisateur</MenuItem>
              <MenuItem value="admin">Administrateur</MenuItem>
            </TextField>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Annuler</Button>
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={createMutation.isPending || updateMutation.isPending}
          >
            {editingUser ? 'Enregistrer' : 'Créer'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={passwordDialogOpen} onClose={() => setPasswordDialogOpen(false)}>
        <DialogTitle>
          Réinitialiser le mot de passe
          {editingUser && (
            <Typography variant="body2" color="text.secondary">
              Utilisateur: {editingUser.username}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Nouveau mot de passe"
            type={showPassword ? 'text' : 'password'}
            fullWidth
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    onClick={() => setShowPassword(!showPassword)}
                    edge="end"
                  >
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
          <Alert severity="warning" sx={{ mt: 2 }}>
            L'utilisateur devra se reconnecter avec le nouveau mot de passe.
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => {
            setPasswordDialogOpen(false);
            setNewPassword('');
          }}>
            Annuler
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              if (editingUser) {
                resetPasswordMutation.mutate({
                  id: editingUser.id,
                  password: newPassword,
                });
              }
            }}
            disabled={!newPassword || resetPasswordMutation.isPending}
          >
            Réinitialiser
          </Button>
        </DialogActions>
      </Dialog>

      {/* VoIP Credentials Dialog */}
      <Dialog open={voipDialogOpen} onClose={() => setVoipDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PhoneIcon color="success" />
            Extension VoIP créée
          </Box>
        </DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 3 }}>
            Conservez ces informations ! Le secret ne sera plus affiché après fermeture de cette fenêtre.
          </Alert>

          {voipCredentials && (
            <Stack spacing={2}>
              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  Extension (username SIP)
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="h5" fontWeight={600}>
                    {voipCredentials.extension}
                  </Typography>
                  <IconButton size="small" onClick={() => copyToClipboard(voipCredentials.extension)}>
                    <CopyIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>

              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  Secret (password SIP)
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="h6" fontFamily="monospace">
                    {showVoipSecret ? voipCredentials.secret : '••••••••••••••••'}
                  </Typography>
                  <IconButton size="small" onClick={() => setShowVoipSecret(!showVoipSecret)}>
                    {showVoipSecret ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                  <IconButton size="small" onClick={() => copyToClipboard(voipCredentials.secret)}>
                    <CopyIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>

              <Divider />

              <Typography variant="body2" color="text.secondary">
                Ces identifiants permettent à l'utilisateur de se connecter en WebRTC
                depuis l'application mobile ou la PWA pour passer et recevoir des appels.
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            variant="contained"
            onClick={() => {
              setVoipDialogOpen(false);
              setVoipCredentials(null);
              setShowVoipSecret(false);
            }}
          >
            J'ai noté les identifiants
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
