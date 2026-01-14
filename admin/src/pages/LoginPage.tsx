import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  Alert,
  InputAdornment,
  IconButton,
  CircularProgress,
} from '@mui/material';
import {
  Visibility,
  VisibilityOff,
  Lock as LockIcon,
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [requires2FA, setRequires2FA] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const result = await login(username, password, requires2FA ? twoFactorCode : undefined);

      if (result.success) {
        navigate('/');
      } else if (result.requires2FA) {
        setRequires2FA(true);
      } else {
        setError(result.error || 'Erreur de connexion');
      }
    } catch (err) {
      setError('Erreur de connexion au serveur');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
        p: 2,
      }}
    >
      <Card
        sx={{
          width: '100%',
          maxWidth: 400,
          backgroundColor: 'background.paper',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        <CardContent sx={{ p: 4 }}>
          {/* Logo */}
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <Box
              sx={{
                width: 64,
                height: 64,
                borderRadius: 3,
                background: 'linear-gradient(135deg, #6366f1 0%, #22c55e 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                mx: 'auto',
                mb: 2,
              }}
            >
              <LockIcon sx={{ fontSize: 32, color: 'white' }} />
            </Box>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Homenichat Admin
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Connectez-vous pour administrer le serveur
            </Typography>
          </Box>

          {/* Error Alert */}
          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit}>
            {!requires2FA ? (
              <>
                <TextField
                  fullWidth
                  label="Nom d'utilisateur"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  margin="normal"
                  required
                  autoFocus
                  autoComplete="username"
                />
                <TextField
                  fullWidth
                  label="Mot de passe"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  margin="normal"
                  required
                  autoComplete="current-password"
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
              </>
            ) : (
              <>
                <Alert severity="info" sx={{ mb: 2 }}>
                  Entrez le code de votre application d'authentification
                </Alert>
                <TextField
                  fullWidth
                  label="Code 2FA"
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value)}
                  margin="normal"
                  required
                  autoFocus
                  inputProps={{ maxLength: 6, pattern: '[0-9]*' }}
                  placeholder="000000"
                />
              </>
            )}

            <Button
              type="submit"
              fullWidth
              variant="contained"
              size="large"
              disabled={isLoading}
              sx={{
                mt: 3,
                py: 1.5,
                background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                '&:hover': {
                  background: 'linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)',
                },
              }}
            >
              {isLoading ? (
                <CircularProgress size={24} color="inherit" />
              ) : requires2FA ? (
                'Vérifier'
              ) : (
                'Se connecter'
              )}
            </Button>

            {requires2FA && (
              <Button
                fullWidth
                variant="text"
                sx={{ mt: 1 }}
                onClick={() => {
                  setRequires2FA(false);
                  setTwoFactorCode('');
                }}
              >
                Retour
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
