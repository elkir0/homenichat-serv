/**
 * LiveTerminal.tsx
 * Terminal en temps réel pour afficher les logs d'installation via SSE
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  alpha,
  useTheme,
} from '@mui/material';
import {
  ContentCopy as CopyIcon,
  Delete as ClearIcon,
  KeyboardArrowDown as ScrollDownIcon,
} from '@mui/icons-material';

interface LogLine {
  id: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  timestamp: Date;
}

interface LiveTerminalProps {
  logs: LogLine[];
  maxLines?: number;
  height?: number | string;
  onClear?: () => void;
  autoScroll?: boolean;
}

export default function LiveTerminal({
  logs,
  maxLines = 500,
  height = 300,
  onClear,
  autoScroll = true,
}: LiveTerminalProps) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAutoScrolling, setIsAutoScrolling] = useState(autoScroll);
  const [copied, setCopied] = useState(false);

  // Auto-scroll vers le bas
  useEffect(() => {
    if (isAutoScrolling && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, isAutoScrolling]);

  // Détecter si l'utilisateur scroll manuellement
  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setIsAutoScrolling(isAtBottom);
    }
  }, []);

  // Scroll vers le bas
  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setIsAutoScrolling(true);
    }
  };

  // Copier les logs
  const copyLogs = () => {
    const text = logs.map(l => `[${l.level.toUpperCase()}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Couleur selon le niveau
  const getColor = (level: string) => {
    switch (level) {
      case 'error':
        return theme.palette.error.main;
      case 'warn':
        return theme.palette.warning.main;
      case 'success':
        return theme.palette.success.main;
      default:
        return theme.palette.text.secondary;
    }
  };

  // Limiter le nombre de lignes affichées
  const displayedLogs = logs.slice(-maxLines);

  return (
    <Box sx={{ position: 'relative' }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 0.5,
          mb: 0.5,
        }}
      >
        <Tooltip title={copied ? 'Copié!' : 'Copier les logs'}>
          <IconButton size="small" onClick={copyLogs}>
            <CopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {onClear && (
          <Tooltip title="Effacer">
            <IconButton size="small" onClick={onClear}>
              <ClearIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {!isAutoScrolling && (
          <Tooltip title="Aller en bas">
            <IconButton size="small" onClick={scrollToBottom} color="primary">
              <ScrollDownIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Terminal */}
      <Box
        ref={containerRef}
        onScroll={handleScroll}
        sx={{
          height,
          overflow: 'auto',
          backgroundColor: '#1e1e1e',
          borderRadius: 1,
          p: 1.5,
          fontFamily: '"Fira Code", "Consolas", "Monaco", monospace',
          fontSize: '0.8rem',
          lineHeight: 1.6,
          '&::-webkit-scrollbar': {
            width: 8,
          },
          '&::-webkit-scrollbar-track': {
            backgroundColor: alpha(theme.palette.common.white, 0.05),
          },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: alpha(theme.palette.common.white, 0.2),
            borderRadius: 4,
            '&:hover': {
              backgroundColor: alpha(theme.palette.common.white, 0.3),
            },
          },
        }}
      >
        {displayedLogs.length === 0 ? (
          <Typography
            sx={{
              color: alpha(theme.palette.common.white, 0.5),
              fontFamily: 'inherit',
              fontStyle: 'italic',
            }}
          >
            En attente des logs...
          </Typography>
        ) : (
          displayedLogs.map((log) => (
            <Box
              key={log.id}
              sx={{
                color: getColor(log.level),
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                '&::before': {
                  content: log.level === 'error' ? '"❌ "' :
                           log.level === 'warn' ? '"⚠️ "' :
                           log.level === 'success' ? '"✅ "' : '"› "',
                },
              }}
            >
              {log.message}
            </Box>
          ))
        )}
      </Box>

      {/* Indicateur d'auto-scroll */}
      {!isAutoScrolling && logs.length > 0 && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            backgroundColor: alpha(theme.palette.primary.main, 0.9),
            color: theme.palette.primary.contrastText,
            borderRadius: 2,
            px: 1.5,
            py: 0.5,
            fontSize: '0.75rem',
            cursor: 'pointer',
            '&:hover': {
              backgroundColor: theme.palette.primary.main,
            },
          }}
          onClick={scrollToBottom}
        >
          ↓ Nouveaux logs
        </Box>
      )}
    </Box>
  );
}

/**
 * Hook pour gérer la connexion SSE et les logs
 */
export function useSSELogs(url: string | null) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<{ percent: number; step: string; message: string } | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'complete' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logIdRef = useRef(0);

  const addLog = useCallback((level: LogLine['level'], message: string) => {
    setLogs(prev => [...prev, {
      id: logIdRef.current++,
      level,
      message,
      timestamp: new Date(),
    }]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    logIdRef.current = 0;
  }, []);

  const connect = useCallback(() => {
    if (!url) return;

    // Fermer connexion existante
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('connecting');
    clearLogs();
    setError(null);
    setProgress(null);

    const eventSource = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setStatus('connected');
      addLog('info', 'Connexion établie...');
    };

    eventSource.addEventListener('start', (e) => {
      const data = JSON.parse(e.data);
      addLog('info', data.message || 'Démarrage...');
    });

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      setProgress({
        percent: data.percent,
        step: data.step,
        message: data.message,
      });
      addLog('info', data.message);
    });

    eventSource.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      addLog(data.level || 'info', data.message);
    });

    eventSource.addEventListener('success', (e) => {
      const data = JSON.parse(e.data);
      addLog('success', data.message);
    });

    eventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      if (data.success) {
        addLog('success', data.message || 'Terminé!');
      } else {
        addLog('error', data.message || 'Échec');
      }
      setStatus('complete');
      eventSource.close();
    });

    eventSource.addEventListener('error', (e) => {
      if (e instanceof MessageEvent) {
        const data = JSON.parse(e.data);
        addLog('error', data.message);
        setError(data.message);
      }
      setStatus('error');
    });

    eventSource.onerror = () => {
      if (status !== 'complete') {
        addLog('error', 'Connexion perdue');
        setStatus('error');
        setError('Connexion perdue avec le serveur');
      }
    };
  }, [url, addLog, clearLogs, status]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStatus('idle');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  return {
    logs,
    progress,
    status,
    error,
    connect,
    disconnect,
    clearLogs,
    addLog,
  };
}
