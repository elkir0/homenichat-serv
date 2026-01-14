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
  Switch,
  FormControlLabel,
  Alert,
  LinearProgress,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  PlayArrow as TestIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { providersApi } from '../services/api';
import type { Provider } from '../services/api';

const providerTypes = [
  { value: 'baileys', label: 'WhatsApp Baileys', category: 'whatsapp' },
  { value: 'meta_cloud', label: 'WhatsApp Meta Cloud', category: 'whatsapp' },
  { value: 'twilio', label: 'Twilio SMS', category: 'sms' },
  { value: 'ovh', label: 'OVH SMS', category: 'sms' },
  { value: 'gammu', label: 'Modem Gammu', category: 'sms' },
  { value: 'at_command', label: 'Modem AT Commands', category: 'sms' },
  { value: 'freepbx', label: 'FreePBX', category: 'voip' },
  { value: 'sip', label: 'SIP Direct', category: 'voip' },
];

export default function ProvidersPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [formData, setFormData] = useState({
    type: '',
    name: '',
    enabled: true,
    config: '{}',
  });
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const { data: providers, isLoading } = useQuery<Provider[]>({
    queryKey: ['providers'],
    queryFn: providersApi.getAll,
  });

  const createMutation = useMutation({
    mutationFn: providersApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      handleCloseDialog();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Provider> }) =>
      providersApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      handleCloseDialog();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: providersApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
  });

  const testMutation = useMutation({
    mutationFn: providersApi.test,
    onSuccess: (result) => {
      setTestResult(result);
    },
  });

  const handleOpenDialog = (provider?: Provider) => {
    if (provider) {
      setEditingProvider(provider);
      setFormData({
        type: provider.type,
        name: provider.name,
        enabled: provider.enabled,
        config: JSON.stringify(provider.config, null, 2),
      });
    } else {
      setEditingProvider(null);
      setFormData({
        type: '',
        name: '',
        enabled: true,
        config: '{}',
      });
    }
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingProvider(null);
    setTestResult(null);
  };

  const handleSubmit = () => {
    try {
      const config = JSON.parse(formData.config);
      const data = {
        type: formData.type,
        name: formData.name,
        enabled: formData.enabled,
        config,
      };

      if (editingProvider) {
        updateMutation.mutate({ id: editingProvider.id, data });
      } else {
        createMutation.mutate(data);
      }
    } catch (e) {
      alert('Configuration JSON invalide');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected':
        return 'success';
      case 'disconnected':
        return 'default';
      case 'error':
        return 'error';
      case 'initializing':
        return 'warning';
      default:
        return 'default';
    }
  };

  const getCategoryColor = (type: string) => {
    const providerType = providerTypes.find(p => p.value === type);
    switch (providerType?.category) {
      case 'whatsapp':
        return '#25D366';
      case 'sms':
        return '#2196f3';
      case 'voip':
        return '#ff9800';
      default:
        return '#9e9e9e';
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
            Providers
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Gérez vos providers de communication
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['providers'] })}
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

      {/* Providers Table */}
      <Card>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Nom</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Statut</TableCell>
                <TableCell>Activé</TableCell>
                <TableCell>Dernière activité</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {providers && providers.length > 0 ? (
                providers.map((provider) => (
                  <TableRow key={provider.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {provider.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={providerTypes.find(p => p.value === provider.type)?.label || provider.type}
                        size="small"
                        sx={{
                          backgroundColor: getCategoryColor(provider.type),
                          color: 'white',
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={provider.status}
                        size="small"
                        color={getStatusColor(provider.status) as 'success' | 'error' | 'warning' | 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={provider.enabled}
                        onChange={(e) => {
                          updateMutation.mutate({
                            id: provider.id,
                            data: { enabled: e.target.checked },
                          });
                        }}
                        size="small"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {provider.lastActivity
                          ? new Date(provider.lastActivity).toLocaleString('fr-FR')
                          : '-'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Tester">
                        <IconButton
                          size="small"
                          onClick={() => testMutation.mutate(provider.id)}
                          disabled={testMutation.isPending}
                        >
                          <TestIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Modifier">
                        <IconButton
                          size="small"
                          onClick={() => handleOpenDialog(provider)}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Supprimer">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => {
                            if (confirm(`Supprimer le provider "${provider.name}" ?`)) {
                              deleteMutation.mutate(provider.id);
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
                      Aucun provider configuré. Cliquez sur "Ajouter" pour commencer.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* Test Result */}
      {testResult && (
        <Alert
          severity={testResult.success ? 'success' : 'error'}
          sx={{ mt: 2 }}
          onClose={() => setTestResult(null)}
        >
          {testResult.message}
        </Alert>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>
          {editingProvider ? 'Modifier le provider' : 'Ajouter un provider'}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField
              select
              label="Type"
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              fullWidth
              disabled={!!editingProvider}
            >
              {providerTypes.map((type) => (
                <MenuItem key={type.value} value={type.value}>
                  {type.label}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              label="Nom"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              fullWidth
              placeholder="Ex: WhatsApp Principal"
            />

            <FormControlLabel
              control={
                <Switch
                  checked={formData.enabled}
                  onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                />
              }
              label="Activé"
            />

            <TextField
              label="Configuration (JSON)"
              value={formData.config}
              onChange={(e) => setFormData({ ...formData, config: e.target.value })}
              fullWidth
              multiline
              rows={8}
              placeholder='{"apiKey": "...", "secret": "..."}'
              sx={{
                '& .MuiInputBase-root': {
                  fontFamily: 'monospace',
                  fontSize: '0.875rem',
                },
              }}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Annuler</Button>
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={createMutation.isPending || updateMutation.isPending}
          >
            {editingProvider ? 'Enregistrer' : 'Créer'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
