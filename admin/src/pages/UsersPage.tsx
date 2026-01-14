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
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '../services/api';
import type { User } from '../services/api';

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    role: 'user',
  });
  const [newPassword, setNewPassword] = useState('');

  const { data: users, isLoading } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: usersApi.getAll,
  });

  const createMutation = useMutation({
    mutationFn: usersApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
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

  const handleOpenDialog = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setFormData({
        username: user.username,
        email: user.email,
        password: '',
        role: user.role,
      });
    } else {
      setEditingUser(null);
      setFormData({
        username: '',
        email: '',
        password: '',
        role: 'user',
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
        email: formData.email,
        role: formData.role as 'admin' | 'user',
      };
      updateMutation.mutate({ id: editingUser.id, data: updateData });
    } else {
      createMutation.mutate(formData);
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
            Utilisateurs
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Gérez les comptes utilisateurs
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
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
                <TableCell>Email</TableCell>
                <TableCell>Rôle</TableCell>
                <TableCell>2FA</TableCell>
                <TableCell>Dernière connexion</TableCell>
                <TableCell>Créé le</TableCell>
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
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      <Chip
                        label={user.role}
                        size="small"
                        color={user.role === 'admin' ? 'primary' : 'default'}
                        variant={user.role === 'admin' ? 'filled' : 'outlined'}
                      />
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
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {new Date(user.createdAt).toLocaleDateString('fr-FR')}
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
                            if (confirm(`Supprimer l'utilisateur "${user.username}" ?`)) {
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
                  <TableCell colSpan={7} align="center">
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

            <TextField
              label="Email"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              fullWidth
              required
            />

            {!editingUser && (
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
    </Box>
  );
}
