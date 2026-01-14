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
  TablePagination,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Alert,
  LinearProgress,
  IconButton,
  Tooltip,
  alpha,
  useTheme,
} from '@mui/material';
import {
  History as HistoryIcon,
  Key as KeyIcon,
  Block as BlockIcon,
  Refresh as RefreshIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { securityApi } from '../services/api';
import type { AuditLogEntry } from '../services/api';

const availablePermissions = [
  { key: 'sms:send', label: 'Envoyer SMS' },
  { key: 'sms:read', label: 'Lire SMS' },
  { key: 'whatsapp:send', label: 'Envoyer WhatsApp' },
  { key: 'whatsapp:read', label: 'Lire WhatsApp' },
  { key: 'voip:call', label: 'Passer des appels' },
  { key: 'voip:read', label: 'Lire historique appels' },
  { key: 'contacts:read', label: 'Lire contacts' },
  { key: 'contacts:write', label: 'Modifier contacts' },
];

export default function SecurityPage() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: ['audit-log', page, rowsPerPage],
    queryFn: () => securityApi.getAuditLog({ limit: rowsPerPage, offset: page * rowsPerPage }),
  });

  const { data: apiTokens, isLoading: tokensLoading } = useQuery({
    queryKey: ['api-tokens'],
    queryFn: securityApi.getApiTokens,
  });

  const { data: blockedIps, isLoading: ipsLoading } = useQuery({
    queryKey: ['blocked-ips'],
    queryFn: securityApi.getBlockedIps,
  });

  const { data: stats } = useQuery({
    queryKey: ['security-stats'],
    queryFn: securityApi.getStats,
  });

  const createTokenMutation = useMutation({
    mutationFn: ({ name, permissions }: { name: string; permissions: string[] }) =>
      securityApi.createApiToken(name, permissions),
    onSuccess: (data) => {
      setGeneratedToken(data.token);
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: securityApi.revokeApiToken,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });

  const unblockIpMutation = useMutation({
    mutationFn: securityApi.unblockIp,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-ips'] });
    },
  });

  const handleCreateToken = () => {
    if (newTokenName && selectedPermissions.length > 0) {
      createTokenMutation.mutate({
        name: newTokenName,
        permissions: selectedPermissions,
      });
    }
  };

  const handleCopyToken = () => {
    if (generatedToken) {
      navigator.clipboard.writeText(generatedToken);
    }
  };

  const getActionColor = (action: string) => {
    if (action.includes('login')) return 'success';
    if (action.includes('denied') || action.includes('blocked') || action.includes('failed')) return 'error';
    if (action.includes('create') || action.includes('add')) return 'info';
    if (action.includes('delete') || action.includes('revoke')) return 'warning';
    return 'default';
  };

  const isLoading = auditLoading || tokensLoading || ipsLoading;

  if (isLoading) {
    return <LinearProgress />;
  }

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Sécurité
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Journal d'audit, tokens API et gestion des accès
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['audit-log'] });
            queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
            queryClient.invalidateQueries({ queryKey: ['blocked-ips'] });
          }}
        >
          Actualiser
        </Button>
      </Box>

      {/* Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} md={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.info.main, 0.1) }}>
            <CardContent sx={{ py: 2 }}>
              <Typography variant="overline" color="text.secondary">
                Événements (24h)
              </Typography>
              <Typography variant="h4" fontWeight={700}>
                {stats?.todayEvents || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} md={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.success.main, 0.1) }}>
            <CardContent sx={{ py: 2 }}>
              <Typography variant="overline" color="text.secondary">
                Sessions actives
              </Typography>
              <Typography variant="h4" fontWeight={700}>
                {stats?.activeSessions || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} md={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.warning.main, 0.1) }}>
            <CardContent sx={{ py: 2 }}>
              <Typography variant="overline" color="text.secondary">
                Tokens API
              </Typography>
              <Typography variant="h4" fontWeight={700}>
                {apiTokens?.length || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6} md={3}>
          <Card sx={{ backgroundColor: alpha(theme.palette.error.main, 0.1) }}>
            <CardContent sx={{ py: 2 }}>
              <Typography variant="overline" color="text.secondary">
                IPs bloquées
              </Typography>
              <Typography variant="h4" fontWeight={700}>
                {blockedIps?.length || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Grid container spacing={3}>
        {/* API Tokens */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <KeyIcon sx={{ mr: 1, color: 'warning.main' }} />
                  <Typography variant="h6" fontWeight={600}>
                    Tokens API
                  </Typography>
                </Box>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => setTokenDialogOpen(true)}
                >
                  Créer
                </Button>
              </Box>

              {apiTokens && apiTokens.length > 0 ? (
                <Box sx={{ maxHeight: 300, overflow: 'auto' }}>
                  {apiTokens.map((token: { id: number; name: string; permissions: string[]; createdAt: string }) => (
                    <Box
                      key={token.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        p: 1.5,
                        borderRadius: 1,
                        mb: 1,
                        backgroundColor: alpha(theme.palette.background.paper, 0.5),
                        border: `1px solid ${theme.palette.divider}`,
                      }}
                    >
                      <Box>
                        <Typography variant="body2" fontWeight={500}>
                          {token.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {token.permissions.length} permissions - Créé le{' '}
                          {new Date(token.createdAt).toLocaleDateString('fr-FR')}
                        </Typography>
                      </Box>
                      <Tooltip title="Révoquer">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => {
                            if (confirm('Révoquer ce token API ?')) {
                              revokeTokenMutation.mutate(token.id);
                            }
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ))}
                </Box>
              ) : (
                <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                  Aucun token API
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Blocked IPs */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <BlockIcon sx={{ mr: 1, color: 'error.main' }} />
                <Typography variant="h6" fontWeight={600}>
                  IPs bloquées
                </Typography>
              </Box>

              {blockedIps && blockedIps.length > 0 ? (
                <Box sx={{ maxHeight: 300, overflow: 'auto' }}>
                  {blockedIps.map((item: { ip: string; reason: string; blockedAt: string }) => (
                    <Box
                      key={item.ip}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        p: 1.5,
                        borderRadius: 1,
                        mb: 1,
                        backgroundColor: alpha(theme.palette.error.main, 0.05),
                        border: `1px solid ${alpha(theme.palette.error.main, 0.2)}`,
                      }}
                    >
                      <Box>
                        <Typography variant="body2" fontWeight={500}>
                          {item.ip}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {item.reason} - {new Date(item.blockedAt).toLocaleString('fr-FR')}
                        </Typography>
                      </Box>
                      <Tooltip title="Débloquer">
                        <IconButton
                          size="small"
                          onClick={() => unblockIpMutation.mutate(item.ip)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ))}
                </Box>
              ) : (
                <Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                  Aucune IP bloquée
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Audit Log */}
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <HistoryIcon sx={{ mr: 1, color: 'info.main' }} />
                <Typography variant="h6" fontWeight={600}>
                  Journal d'audit
                </Typography>
              </Box>

              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Date</TableCell>
                      <TableCell>Utilisateur</TableCell>
                      <TableCell>Action</TableCell>
                      <TableCell>Catégorie</TableCell>
                      <TableCell>IP</TableCell>
                      <TableCell>Résultat</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {auditData?.logs?.map((log: AuditLogEntry) => (
                      <TableRow key={log.id} hover>
                        <TableCell>
                          <Typography variant="caption">
                            {new Date(log.createdAt).toLocaleString('fr-FR')}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {log.username || '-'}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={log.action}
                            size="small"
                            color={getActionColor(log.action) as 'success' | 'error' | 'info' | 'warning' | 'default'}
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          {log.category}
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                            {log.ip || '-'}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={log.success ? 'Succès' : 'Échec'}
                            size="small"
                            color={log.success ? 'success' : 'error'}
                            variant="outlined"
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              <TablePagination
                component="div"
                count={auditData?.total || 0}
                page={page}
                onPageChange={(_, newPage) => setPage(newPage)}
                rowsPerPage={rowsPerPage}
                onRowsPerPageChange={(e) => {
                  setRowsPerPage(parseInt(e.target.value, 10));
                  setPage(0);
                }}
                rowsPerPageOptions={[10, 25, 50, 100]}
                labelRowsPerPage="Lignes par page:"
              />
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Create Token Dialog */}
      <Dialog open={tokenDialogOpen} onClose={() => !generatedToken && setTokenDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {generatedToken ? 'Token créé' : 'Créer un token API'}
        </DialogTitle>
        <DialogContent>
          {generatedToken ? (
            <Box>
              <Alert severity="warning" sx={{ mb: 2 }}>
                Ce token ne sera affiché qu'une seule fois. Copiez-le maintenant.
              </Alert>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  p: 2,
                  backgroundColor: alpha(theme.palette.primary.main, 0.1),
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.875rem',
                  wordBreak: 'break-all',
                }}
              >
                <Typography sx={{ flex: 1, fontFamily: 'monospace' }}>
                  {generatedToken}
                </Typography>
                <IconButton onClick={handleCopyToken}>
                  <CopyIcon />
                </IconButton>
              </Box>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
              <TextField
                label="Nom du token"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                fullWidth
                placeholder="Ex: App Mobile, Integration CI/CD..."
              />

              <Typography variant="subtitle2" sx={{ mt: 1 }}>
                Permissions
              </Typography>
              <FormGroup>
                {availablePermissions.map((perm) => (
                  <FormControlLabel
                    key={perm.key}
                    control={
                      <Checkbox
                        checked={selectedPermissions.includes(perm.key)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedPermissions([...selectedPermissions, perm.key]);
                          } else {
                            setSelectedPermissions(selectedPermissions.filter(p => p !== perm.key));
                          }
                        }}
                      />
                    }
                    label={perm.label}
                  />
                ))}
              </FormGroup>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {generatedToken ? (
            <Button
              variant="contained"
              onClick={() => {
                setTokenDialogOpen(false);
                setGeneratedToken(null);
                setNewTokenName('');
                setSelectedPermissions([]);
              }}
            >
              Fermer
            </Button>
          ) : (
            <>
              <Button onClick={() => setTokenDialogOpen(false)}>Annuler</Button>
              <Button
                variant="contained"
                onClick={handleCreateToken}
                disabled={!newTokenName || selectedPermissions.length === 0 || createTokenMutation.isPending}
              >
                Créer
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
