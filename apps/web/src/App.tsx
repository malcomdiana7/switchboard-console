import { useEffect, useMemo, useState } from 'react';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { prefixer } from 'stylis';
import rtlPlugin from 'stylis-plugin-rtl';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppBar,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CssBaseline,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Toolbar,
  Typography,
  createTheme,
  ThemeProvider,
  useMediaQuery,
} from '@mui/material';
import { Brightness4, Language, Menu as MenuIcon } from '@mui/icons-material';
import { api, decodeRole, getToken, hasToken, setToken } from './api';
type ThemeMode = 'light' | 'dark' | 'system';
export default function App() {
  const { i18n } = useTranslation();
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [mode, setMode] = useState<ThemeMode>(
    (localStorage.getItem('theme') as ThemeMode) || 'system',
  );
  const direction = i18n.language === 'ar' ? 'rtl' : 'ltr';
  useEffect(() => {
    document.documentElement.dir = direction;
    document.documentElement.lang = i18n.language;
    document.body.dir = direction;
  }, [direction, i18n.language]);
  const emotionCache = useMemo(
    () =>
      createCache({
        key: direction === 'rtl' ? 'mui-rtl' : 'mui-ltr',
        stylisPlugins: direction === 'rtl' ? [prefixer, rtlPlugin] : [prefixer],
      }),
    [direction],
  );
  const theme = useMemo(
    () =>
      createTheme({
        direction,
        palette: {
          mode: mode === 'system' ? (systemDark ? 'dark' : 'light') : mode,
          primary: { main: '#5b5bd6' },
          background: { default: mode === 'dark' ? '#101218' : undefined },
        },
        shape: { borderRadius: 12 },
        typography: { fontFamily: 'Inter, system-ui, sans-serif' },
      }),
    [direction, mode, systemDark],
  );
  return (
    <CacheProvider value={emotionCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/*"
              element={
                hasToken() ? (
                  <Shell
                    mode={mode}
                    setMode={(m) => {
                      setMode(m);
                      localStorage.setItem('theme', m);
                    }}
                  />
                ) : (
                  <Navigate to="/login" />
                )
              }
            />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </CacheProvider>
  );
}
function Login() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('admin');
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      const r = await api<{ accessToken: string }>(
        '/api/auth/login',
        { method: 'POST', body: JSON.stringify({ username: user, password }) },
        false,
      );
      setToken(r.accessToken);
      nav('/accounts');
      location.reload();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(circle at 20% 10%,#6366f133,transparent 40%)',
      }}
    >
      <Card sx={{ width: 380, p: 2 }}>
        <CardContent>
          <Typography variant="h4" fontWeight={700} mb={3}>
            {t('app')}
          </Typography>
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label={t('username')}
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
            <TextField
              label={t('password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <Button size="large" variant="contained" onClick={submit}>
              {t('login')}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
function Shell({ mode, setMode }: { mode: ThemeMode; setMode: (m: ThemeMode) => void }) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === 'ar';
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const role = decodeRole();
  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;
    let socket: WebSocket | undefined;
    const connect = () => {
      if (stopped) return;
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws`);
      socket.onopen = () =>
        socket?.send(
          JSON.stringify({
            type: 'auth',
            accessToken: getToken(),
            sinceSeq: Number(localStorage.getItem('lastSeq') ?? 0),
          }),
        );
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.seq) {
          localStorage.setItem('lastSeq', String(message.seq));
          void queryClient.invalidateQueries();
        }
      };
      socket.onclose = () => {
        if (!stopped) retry = window.setTimeout(connect, 1_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      socket?.close();
      if (retry) clearTimeout(retry);
    };
  }, [queryClient]);
  const items = [
    ['/accounts', t('accounts')],
    ['/groups', t('groups')],
    ['/sequences', t('sequences')],
  ];
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    nav('/login');
    location.reload();
  };
  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar position="fixed" sx={{ zIndex: 1300 }}>
        <Toolbar>
          <IconButton
            color="inherit"
            onClick={() => setOpen(!open)}
            sx={{ display: { md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flex: 1, fontWeight: 700 }}>
            {t('app')}
          </Typography>
          <Brightness4 sx={{ mx: 1 }} />
          <Select
            size="small"
            value={mode}
            onChange={(e) => setMode(e.target.value as ThemeMode)}
            sx={{
              color: 'inherit',
              '& .MuiOutlinedInput-notchedOutline': { borderColor: '#ffffff55' },
            }}
          >
            {['system', 'light', 'dark'].map((x) => (
              <MenuItem key={x} value={x}>
                {t(x)}
              </MenuItem>
            ))}
          </Select>
          <Language sx={{ mx: 1 }} />
          <Select
            size="small"
            value={i18n.language}
            onChange={(e) => {
              void i18n.changeLanguage(e.target.value);
              localStorage.setItem('language', e.target.value);
            }}
            sx={{
              color: 'inherit',
              '& .MuiOutlinedInput-notchedOutline': { borderColor: '#ffffff55' },
            }}
          >
            <MenuItem value="zh">中文</MenuItem>
            <MenuItem value="en">English</MenuItem>
            <MenuItem value="ar">العربية</MenuItem>
          </Select>
          <Chip label={role === 'admin' ? t('admin') : t('viewer')} size="small" sx={{ mx: 2 }} />
          <Button color="inherit" onClick={logout}>
            {t('logout')}
          </Button>
        </Toolbar>
      </AppBar>
      <Drawer
        anchor={isRtl ? 'right' : 'left'}
        variant="permanent"
        open={open}
        slotProps={{
          paper: {
            // The RTL Stylis plugin mirrors generated CSS. Drawer anchors already
            // account for direction, so pin the physical edge after that transform.
            style: isRtl ? { left: 'auto', right: 0 } : { left: 0, right: 'auto' },
          },
        }}
        sx={{
          width: 220,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: 220,
            pt: 9,
            boxSizing: 'border-box',
            display: { xs: open ? 'block' : 'none', md: 'block' },
          },
        }}
      >
        <List>
          {items.map(([to, label]) => (
            <ListItem key={to} disablePadding>
              <ListItemButton component={Link} to={to}>
                <ListItemText primary={label} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Drawer>
      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          p: { xs: 2, md: 4 },
          pt: { xs: 11, md: 12 },
          maxWidth: 1500,
          width: '100%',
          mx: 'auto',
        }}
      >
        <Routes>
          <Route path="accounts" element={<Accounts />} />
          <Route path="groups" element={<Groups />} />
          <Route path="groups/:id" element={<GroupDetail />} />
          <Route path="agent-runs/:id" element={<AgentRun />} />
          <Route path="sequences" element={<Sequences />} />
          <Route path="*" element={<Navigate to="accounts" />} />
        </Routes>
      </Box>
    </Box>
  );
}
function Page({ title, children, action }: { title: string; children: any; action?: any }) {
  return (
    <>
      <Stack
        direction={{ xs: 'column', lg: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', lg: 'center' }}
        gap={2}
        mb={3}
      >
        <Typography variant="h4" fontWeight={700}>
          {title}
        </Typography>
        {action}
      </Stack>
      {children}
    </>
  );
}
const Status = ({ value }: { value: string }) => (
  <Chip
    size="small"
    label={value}
    color={
      value === 'online' || value === 'sent' || value === 'finished'
        ? 'success'
        : value === 'suspended' || value === 'failed' || value === 'blocked'
          ? 'error'
          : value === 'rate_limited'
            ? 'warning'
            : 'default'
    }
  />
);
function Accounts() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const role = decodeRole();
  const q = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/api/accounts') });
  const mutate = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body?: any }) =>
      api(`/api/accounts/${id}/${path}`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });
  return (
    <Page title={t('accounts')}>
      <Card>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>{t('status')}</TableCell>
              <TableCell>Platform ID</TableCell>
              <TableCell>{t('actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {q.data?.map((a) => (
              <TableRow key={a.id}>
                <TableCell>{a.id}</TableCell>
                <TableCell>
                  <Status value={a.status} />
                </TableCell>
                <TableCell>{a.platformUserId ?? '—'}</TableCell>
                <TableCell>
                  {role === 'admin' && (
                    <Stack direction="row" spacing={1}>
                      {['idle', 'disconnected'].includes(a.status) && (
                        <Button onClick={() => mutate.mutate({ id: a.id, path: 'connect' })}>
                          {t('connect')}
                        </Button>
                      )}
                      {['online', 'rate_limited'].includes(a.status) && (
                        <Button
                          onClick={() =>
                            mutate.mutate({
                              id: a.id,
                              path: 'transition',
                              body: { expectedFrom: a.status, to: 'disconnected' },
                            })
                          }
                        >
                          {t('disconnect')}
                        </Button>
                      )}
                      {a.status === 'online' && (
                        <Button
                          onClick={() =>
                            mutate.mutate({
                              id: a.id,
                              path: 'transition',
                              body: { expectedFrom: 'online', to: 'idle' },
                            })
                          }
                        >
                          {t('release')}
                        </Button>
                      )}
                    </Stack>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Page>
  );
}
function Groups() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const role = decodeRole();
  const q = useQuery({ queryKey: ['groups'], queryFn: () => api<any[]>('/api/groups') });
  const [creator, setCreator] = useState('account-01');
  const [members, setMembers] = useState('account-02, account-03');
  const create = useMutation({
    mutationFn: () =>
      api('/api/groups', {
        method: 'POST',
        body: JSON.stringify({
          creatorAccountId: creator,
          memberAccountIds: members
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
  const createError = create.error as (Error & { code?: string }) | null;
  return (
    <Page
      title={t('groups')}
      action={
        role === 'admin' ? (
          <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1} sx={{ minWidth: 0 }}>
            <TextField
              size="small"
              label={t('creator')}
              value={creator}
              onChange={(e) => setCreator(e.target.value)}
            />
            <TextField
              size="small"
              label={t('memberAccounts')}
              value={members}
              onChange={(e) => setMembers(e.target.value)}
            />
            <Button variant="contained" onClick={() => create.mutate()}>
              {t('createGroup')}
            </Button>
          </Stack>
        ) : null
      }
    >
      {create.isError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            createError?.code === 'ACCOUNT_NOT_ONLINE' ? (
              <Button component={Link} to="/accounts" color="inherit" size="small">
                {t('goToAccounts')}
              </Button>
            ) : undefined
          }
        >
          {createError?.code === 'ACCOUNT_NOT_ONLINE'
            ? t('accountNotOnline')
            : `${t('error')}: ${createError?.message ?? ''}`}
        </Alert>
      )}
      <Stack spacing={2}>
        {q.data?.map((g) => (
          <Card
            key={g.id}
            component={Link}
            to={`/groups/${g.id}`}
            sx={{
              textDecoration: 'none',
              color: 'inherit',
              transition: '.2s',
              '&:hover': { transform: 'translateY(-2px)', boxShadow: 5 },
            }}
          >
            <CardContent>
              <Stack direction="row" justifyContent="space-between">
                <Box>
                  <Typography variant="h6">{g.gatewayGroupId ?? g.id}</Typography>
                  <Typography color="text.secondary">
                    {g.members.length} {t('members')}
                  </Typography>
                </Box>
                <Status value={g.status} />
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Page>
  );
}
function GroupDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const role = decodeRole();
  const qc = useQueryClient();
  const group = useQuery({ queryKey: ['group', id], queryFn: () => api<any>(`/api/groups/${id}`) });
  const messages = useQuery({
    queryKey: ['messages', id],
    queryFn: () => api<any>(`/api/groups/${id}/messages?limit=50`),
  });
  const [older, setOlder] = useState<any[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ['runs', id],
    queryFn: () => api<any[]>(`/api/groups/${id}/agent-runs`),
  });
  const [text, setText] = useState('');
  const [accountId, setAccount] = useState('');
  useEffect(() => {
    if (group.data?.members?.[0] && !accountId) setAccount(group.data.members[0].accountId);
  }, [group.data, accountId]);
  const send = useMutation({
    mutationFn: () =>
      api(`/api/groups/${id}/send`, { method: 'POST', body: JSON.stringify({ accountId, text }) }),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['messages', id] });
    },
  });
  const loadOlder = async () => {
    const cursor = olderCursor ?? messages.data?.nextCursor;
    if (!cursor) return;
    const page = await api<any>(`/api/groups/${id}/messages?limit=50&before=${cursor}`);
    setOlder((current) => [...current, ...page.items]);
    setOlderCursor(page.nextCursor);
  };
  const patch = useMutation({
    mutationFn: (b: any) => api(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['group', id] }),
  });
  return (
    <Page title={group.data?.gatewayGroupId ?? t('groups')}>
      <Stack spacing={3}>
        <Card>
          <CardContent>
            <Typography variant="h6">{t('members')}</Typography>
            <Stack direction="row" flexWrap="wrap" gap={1} mt={2}>
              {group.data?.members.map((m: any) => (
                <Chip key={m.platformUserId} label={`${m.accountId} · ${m.role}`} />
              ))}
            </Stack>
            {role === 'admin' && (
              <Stack direction="row" spacing={2} mt={3}>
                <Button
                  variant={group.data?.agentEnabled ? 'contained' : 'outlined'}
                  onClick={() => patch.mutate({ agentEnabled: !group.data.agentEnabled })}
                >
                  Agent {group.data?.agentEnabled ? 'ON' : 'OFF'}
                </Button>
                <Button
                  variant={group.data?.autoKickEnabled ? 'contained' : 'outlined'}
                  onClick={() => patch.mutate({ autoKickEnabled: !group.data.autoKickEnabled })}
                >
                  Auto kick {group.data?.autoKickEnabled ? 'ON' : 'OFF'}
                </Button>
              </Stack>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h6" mb={2}>
              {t('messages')}
            </Typography>
            {role === 'admin' && (
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} mb={2}>
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel>{t('account')}</InputLabel>
                  <Select
                    label={t('account')}
                    value={accountId}
                    onChange={(e) => setAccount(e.target.value)}
                  >
                    {group.data?.members.map((m: any) => (
                      <MenuItem key={m.accountId} value={m.accountId}>
                        {m.accountId}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  fullWidth
                  size="small"
                  label={t('message')}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button variant="contained" disabled={!text} onClick={() => send.mutate()}>
                  {t('send')}
                </Button>
              </Stack>
            )}
            <List>
              {[...(messages.data?.items ?? []), ...older].map((m: any) => (
                <ListItem key={m.msgId ?? m.clientMsgId} divider>
                  <ListItemText
                    primary={m.text}
                    secondary={`${new Date(m.sentAt).toLocaleString()} · ${m.senderPlatformUserId ?? m.accountId ?? ''}`}
                  />
                  {m.isOwn && <Status value={m.deliveryStatus} />}
                </ListItem>
              ))}
            </List>
            <Button
              onClick={() => void loadOlder()}
              disabled={!(olderCursor ?? messages.data?.nextCursor)}
            >
              {t('loadMore')}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h6" mb={2}>
              {t('agentRuns')}
            </Typography>
            {runs.data?.map((r) => (
              <ListItem
                key={r.id}
                component={Link}
                to={`/agent-runs/${r.id}`}
                divider
                sx={{ color: 'inherit' }}
              >
                <ListItemText primary={r.id} secondary={r.endReason} />
                <Status value={r.status} />
              </ListItem>
            ))}
          </CardContent>
        </Card>
      </Stack>
    </Page>
  );
}
function AgentRun() {
  const { id } = useParams();
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['agent-run', id],
    queryFn: () => api<any>(`/api/agent-runs/${id}`),
  });
  return (
    <Page title={t('runDetails')} action={q.data && <Status value={q.data.status} />}>
      {q.data?.status === 'blocked' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {t('blocked')}
        </Alert>
      )}
      <Stack spacing={2}>
        {q.data?.steps?.map((s: any, i: number) => (
          <Card key={i}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="h6">
                  #{i + 1} · {s.kind} · {s.name ?? ''}
                </Typography>
                {s.errorCode && <Chip color="error" label={s.errorCode} />}
              </Stack>
              <Typography
                component="pre"
                sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 13 }}
              >
                {JSON.stringify(s.input, null, 2)}
              </Typography>
              <Divider />
              <Typography mt={1}>
                {t('result')}: {s.resultSummary}
              </Typography>
              <Typography>
                {t('audit')}: {s.auditVerdict ?? '—'}
              </Typography>
              {s.kind === 'protocol_error' && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  {s.rawResponse}
                </Alert>
              )}
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Page>
  );
}
function Sequences() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const role = decodeRole();
  const seqs = useQuery({ queryKey: ['sequences'], queryFn: () => api<any[]>('/api/sequences') });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<any[]>('/api/groups') });
  const [name, setName] = useState('Event reminder');
  const [steps, setSteps] = useState(
    '[{"index":1,"accountRole":"admin","text":"{event} starts at {time}","delaySeconds":10}]',
  );
  const [sequenceId, setSequenceId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [vars, setVars] = useState('{"event":"Demo","time":"10:00"}');
  const [stepVars, setStepVars] = useState('{}');
  const [preview, setPreview] = useState<any[] | null>(null);
  const [preflightError, setPreflightError] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const run = useQuery({
    queryKey: ['sequence-run', runId],
    queryFn: () => api<any>(`/api/sequence-runs/${runId}`),
    enabled: !!runId,
  });
  const create = useMutation({
    mutationFn: () =>
      api('/api/sequences', {
        method: 'POST',
        body: JSON.stringify({ name, steps: JSON.parse(steps) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sequences'] }),
  });
  const preflight = async () => {
    try {
      setPreflightError('');
      const result = await api<any>(`/api/sequences/${sequenceId}/preview`, {
        method: 'POST',
        body: JSON.stringify({ vars: JSON.parse(vars), stepVars: JSON.parse(stepVars) }),
      });
      setPreview(result.steps);
    } catch (error: any) {
      setPreflightError(
        error.stepIndex
          ? `${error.message} (stepIndex: ${error.stepIndex}, key: ${error.key})`
          : error.message,
      );
    }
  };
  const start = async () => {
    const result = await api<{ runId: string }>(`/api/groups/${groupId}/sequence-runs`, {
      method: 'POST',
      body: JSON.stringify({
        sequenceId,
        vars: JSON.parse(vars),
        stepVars: JSON.parse(stepVars),
      }),
    });
    setRunId(result.runId);
    setPreview(null);
  };
  return (
    <Page title={t('sequences')}>
      <Stack spacing={3}>
        {role === 'admin' && (
          <Card>
            <CardContent>
              <Typography variant="h6" mb={2}>
                {t('start')}
              </Typography>
              <Stack spacing={2}>
                {preflightError && <Alert severity="error">{preflightError}</Alert>}
                <FormControl>
                  <InputLabel>{t('selectSequence')}</InputLabel>
                  <Select
                    label={t('selectSequence')}
                    value={sequenceId}
                    onChange={(e) => setSequenceId(e.target.value)}
                  >
                    {seqs.data?.map((s) => (
                      <MenuItem key={s.id} value={s.id}>
                        {s.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl>
                  <InputLabel>{t('groups')}</InputLabel>
                  <Select
                    label={t('groups')}
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                  >
                    {groups.data
                      ?.filter((g) => g.status === 'active')
                      .map((g) => (
                        <MenuItem key={g.id} value={g.id}>
                          {g.gatewayGroupId}
                        </MenuItem>
                      ))}
                  </Select>
                </FormControl>
                <TextField
                  label={t('vars')}
                  value={vars}
                  onChange={(e) => setVars(e.target.value)}
                  inputProps={{ dir: 'ltr' }}
                />
                <TextField
                  label={t('stepVars')}
                  value={stepVars}
                  onChange={(e) => setStepVars(e.target.value)}
                  inputProps={{ dir: 'ltr' }}
                />
                <Button
                  variant="contained"
                  disabled={!sequenceId || !groupId}
                  onClick={() => void preflight()}
                >
                  {t('start')}
                </Button>
              </Stack>
              {run.data && (
                <Box mt={3}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Status value={run.data.status} />
                    <Typography>Step {run.data.currentStepIndex}</Typography>
                  </Stack>
                  {run.data.steps.map((step: any) => (
                    <ListItem key={step.index} divider>
                      <ListItemText
                        primary={`#${step.index}`}
                        secondary={`${step.status} · ${new Date(step.scheduledAt).toLocaleString()}`}
                      />
                      <Status value={step.status} />
                    </ListItem>
                  ))}
                </Box>
              )}
            </CardContent>
          </Card>
        )}
        {role === 'admin' && (
          <Card>
            <CardContent>
              <Typography variant="h6" mb={2}>
                {t('createSequence')}
              </Typography>
              <Stack spacing={2}>
                <TextField
                  label={t('sequenceName')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <TextField
                  label={t('sequenceJson')}
                  multiline
                  minRows={5}
                  value={steps}
                  onChange={(e) => setSteps(e.target.value)}
                  inputProps={{ dir: 'ltr' }}
                />
                <Button variant="contained" onClick={() => create.mutate()}>
                  {t('createSequence')}
                </Button>
              </Stack>
            </CardContent>
          </Card>
        )}
        {seqs.data?.map((s) => (
          <Card key={s.id}>
            <CardContent>
              <Typography variant="h6">{s.name}</Typography>
              <Typography component="pre" sx={{ overflow: 'auto', fontSize: 13, direction: 'ltr' }}>
                {JSON.stringify(s.steps, null, 2)}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Stack>
      <Dialog open={!!preview} onClose={() => setPreview(null)} maxWidth="md" fullWidth>
        <DialogTitle>{t('selectSequence')}</DialogTitle>
        <DialogContent>
          {preview?.map((step) => (
            <Card key={step.index} variant="outlined" sx={{ my: 1 }}>
              <CardContent>
                <Typography fontWeight={700}>
                  #{step.index} · {step.text}
                </Typography>
                <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', direction: 'ltr' }}>
                  {JSON.stringify(
                    { resolvedVars: step.resolvedVars, varSources: step.varSources },
                    null,
                    2,
                  )}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreview(null)}>Cancel</Button>
          <Button variant="contained" onClick={() => void start()}>
            {t('start')}
          </Button>
        </DialogActions>
      </Dialog>
    </Page>
  );
}
