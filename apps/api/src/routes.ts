import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canTransition, isTerminal, type AccountStatus } from '@switchboard/shared';
import type { Db } from './db.js';
import { emitEvent, transaction } from './db.js';
import { AppError } from './errors.js';
import { GatewayClient } from './gateway.js';
import { requireAuth } from './auth.js';

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

export async function registerRoutes(app: FastifyInstance, db: Db, gateway: GatewayClient) {
  app.get('/api/health', async () => {
    const version =
      (await db.query('SELECT max(version) version FROM schema_migrations')).rows[0]?.version ?? 0;
    return { ok: true, schemaVersion: version };
  });

  app.get('/api/accounts', async (request) => {
    await requireAuth(request, db);
    const rows = (
      await db.query(
        'SELECT id,status,platform_user_id,rate_limited_until FROM accounts ORDER BY id',
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      platformUserId: r.platform_user_id,
      rateLimitedUntil: iso(r.rate_limited_until),
    }));
  });

  app.post('/api/accounts/:id/connect', async (request) => {
    await requireAuth(request, db, true);
    const { id } = request.params as { id: string };
    const account = (await db.query('SELECT * FROM accounts WHERE id=$1', [id])).rows[0];
    if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    if (isTerminal(account.status))
      throw new AppError(409, 'ILLEGAL_TRANSITION', 'Terminal account cannot reconnect');
    if (!canTransition(account.status, 'online'))
      throw new AppError(
        409,
        'ILLEGAL_TRANSITION',
        'Account cannot connect from its current state',
      );
    const result = await gateway.connect(id);
    await transitionAccount(db, id, account.status, 'online', result.platformUserId);
    return { status: 'online', platformUserId: result.platformUserId };
  });

  app.post('/api/accounts/:id/transition', async (request) => {
    await requireAuth(request, db, true);
    const { id } = request.params as { id: string };
    const { to, expectedFrom } = request.body as {
      to?: AccountStatus;
      expectedFrom?: AccountStatus;
    };
    if (!to || !expectedFrom)
      throw new AppError(400, 'VALIDATION_ERROR', 'to and expectedFrom are required');
    const exists = (await db.query('SELECT 1 FROM accounts WHERE id=$1', [id])).rowCount;
    if (!exists) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    if (!canTransition(expectedFrom, to))
      throw new AppError(409, 'ILLEGAL_TRANSITION', 'Transition is not allowed');
    if (to === 'idle' || to === 'disconnected') await gateway.disconnect(id);
    await transitionAccount(db, id, expectedFrom, to);
    return { status: to };
  });

  app.post('/api/groups', async (request, reply) => {
    await requireAuth(request, db, true);
    const body = request.body as { creatorAccountId?: string; memberAccountIds?: string[] };
    if (
      !body.creatorAccountId ||
      !Array.isArray(body.memberAccountIds) ||
      body.memberAccountIds.length < 1 ||
      body.memberAccountIds.includes(body.creatorAccountId) ||
      new Set(body.memberAccountIds).size !== body.memberAccountIds.length
    )
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'A creator and at least one distinct member are required',
      );
    const ids = [body.creatorAccountId, ...body.memberAccountIds];
    const online = (
      await db.query(`SELECT id FROM accounts WHERE id=ANY($1) AND status='online'`, [ids])
    ).rows.map((r) => r.id);
    if (online.length !== ids.length)
      throw new AppError(422, 'ACCOUNT_NOT_ONLINE', 'All accounts must be online');
    const jobId = randomUUID();
    await db.query(`INSERT INTO jobs(id,kind,input) VALUES($1,'create_group',$2)`, [jobId, body]);
    reply.code(202);
    return { jobId };
  });

  app.get('/api/jobs/:id', async (request) => {
    await requireAuth(request, db);
    const { id } = request.params as { id: string };
    const row = (await db.query('SELECT status,errors FROM jobs WHERE id=$1', [id])).rows[0];
    if (!row) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found');
    return row;
  });

  app.get('/api/groups', async (request) => {
    await requireAuth(request, db);
    return listGroups(db);
  });
  app.get('/api/groups/:id', async (request) => {
    await requireAuth(request, db);
    const { id } = request.params as { id: string };
    const rows = await listGroups(db, id);
    if (!rows[0]) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
    return rows[0];
  });

  app.patch('/api/groups/:id', async (request) => {
    await requireAuth(request, db, true);
    const { id } = request.params as { id: string };
    const body = request.body as { agentEnabled?: boolean; autoKickEnabled?: boolean };
    if (body.agentEnabled === undefined && body.autoKickEnabled === undefined)
      throw new AppError(400, 'VALIDATION_ERROR', 'No supported field supplied');
    const row = (
      await db.query(
        `UPDATE groups SET agent_enabled=coalesce($2,agent_enabled),auto_kick_enabled=coalesce($3,auto_kick_enabled),updated_at=now() WHERE id=$1 RETURNING *`,
        [id, body.agentEnabled, body.autoKickEnabled],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
    if (body.agentEnabled === false)
      await db.query(
        `UPDATE agent_runs SET cancel_requested=true WHERE group_id=$1 AND status='running'`,
        [id],
      );
    return { ok: true };
  });

  app.post('/api/groups/:id/send', async (request, reply) => {
    await requireAuth(request, db, true);
    const { id } = request.params as { id: string };
    const body = request.body as { accountId?: string; text?: string };
    if (!body.accountId || typeof body.text !== 'string' || !body.text.trim())
      throw new AppError(400, 'VALIDATION_ERROR', 'accountId and non-empty text are required');
    const member = (
      await db.query(
        `SELECT a.status FROM group_members m JOIN accounts a ON a.id=m.account_id JOIN groups g ON g.id=m.group_id WHERE m.group_id=$1 AND m.account_id=$2 AND g.status='active'`,
        [id, body.accountId],
      )
    ).rows[0];
    if (!member)
      throw new AppError(409, 'ACCOUNT_NOT_IN_GROUP', 'Account is not in this active group');
    if (!['online', 'rate_limited'].includes(member.status))
      throw new AppError(409, 'ACCOUNT_UNAVAILABLE', 'Account cannot send');
    const clientMsgId = randomUUID();
    const messageId = randomUUID();
    await db.query(
      `INSERT INTO messages(id,group_id,client_msg_id,account_id,is_own,text,sent_at,delivery_status,next_attempt_at) VALUES($1,$2,$3,$4,true,$5,now(),'queued',now())`,
      [messageId, id, clientMsgId, body.accountId, body.text],
    );
    reply.code(202);
    return { clientMsgId };
  });

  app.get('/api/groups/:id/messages', async (request) => {
    await requireAuth(request, db);
    const { id } = request.params as { id: string };
    const q = request.query as { before?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50)));
    let cursorDate: string | undefined, cursorId: string | undefined;
    if (q.before) {
      try {
        [cursorDate, cursorId] = JSON.parse(Buffer.from(q.before, 'base64url').toString());
      } catch {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor');
      }
    }
    const rows = (
      await db.query(
        `SELECT * FROM messages WHERE group_id=$1 AND ($2::timestamptz IS NULL OR (sent_at,id)<($2,$3::uuid)) ORDER BY sent_at DESC,id DESC LIMIT $4`,
        [id, cursorDate ?? null, cursorId ?? null, limit + 1],
      )
    ).rows;
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(messageDto),
      nextCursor:
        more && last
          ? Buffer.from(JSON.stringify([last.sent_at.toISOString(), last.id])).toString('base64url')
          : null,
    };
  });

  app.post('/api/groups/:id/leave-all', async (request, reply) => {
    await requireAuth(request, db, true);
    const { id } = request.params as { id: string };
    const exists = (await db.query('SELECT 1 FROM groups WHERE id=$1', [id])).rowCount;
    if (!exists) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
    const jobId = randomUUID();
    await db.query(`INSERT INTO jobs(id,kind,group_id,input) VALUES($1,'leave_all',$2,'{}')`, [
      jobId,
      id,
    ]);
    reply.code(202);
    return { jobId };
  });

  registerSequenceRoutes(app, db);
  registerAgentReadRoutes(app, db);
}

async function transitionAccount(
  db: Db,
  id: string,
  from: AccountStatus,
  to: AccountStatus,
  platformUserId?: string,
) {
  await transaction(db, async (c) => {
    const row = (
      await c.query(
        `UPDATE accounts SET status=$3,platform_user_id=coalesce($4,platform_user_id),rate_limited_until=NULL,version=version+1,updated_at=now() WHERE id=$1 AND status=$2 RETURNING id`,
        [id, from, to, platformUserId ?? null],
      )
    ).rows[0];
    if (!row) throw new AppError(409, 'CAS_CONFLICT', 'Account changed concurrently');
    if (isTerminal(to)) {
      await c.query('DELETE FROM group_members WHERE account_id=$1', [id]);
      await c.query(
        `UPDATE messages SET delivery_status='cancelled',fail_code='ACCOUNT_TERMINAL',next_attempt_at=NULL WHERE account_id=$1 AND delivery_status='queued'`,
        [id],
      );
      await c.query(
        `UPDATE sequence_run_steps s SET status='skipped',sent_at=now() FROM messages m WHERE s.client_msg_id=m.client_msg_id AND m.account_id=$1 AND s.status='pending'`,
        [id],
      );
      await emitEvent(c, 'account_terminal', { accountId: id, status: to });
    }
    await emitEvent(c, 'account_status_changed', { accountId: id, from, to });
  });
}

async function listGroups(db: Db, id?: string) {
  const groups = (
    await db.query(
      `SELECT g.*, (SELECT id FROM sequence_runs WHERE group_id=g.id AND status='running') active_sequence_run_id,(SELECT id FROM agent_runs WHERE group_id=g.id AND status='running') active_agent_run_id FROM groups g WHERE ($1::uuid IS NULL OR g.id=$1) ORDER BY g.created_at DESC`,
      [id ?? null],
    )
  ).rows;
  return Promise.all(
    groups.map(async (g) => {
      const members = (
        await db.query(
          'SELECT account_id,platform_user_id,role FROM group_members WHERE group_id=$1 ORDER BY role,account_id',
          [g.id],
        )
      ).rows;
      return {
        id: g.id,
        gatewayGroupId: g.gateway_group_id,
        status: g.status,
        creatorAccountId: g.creator_account_id,
        agentEnabled: g.agent_enabled,
        autoKickEnabled: g.auto_kick_enabled,
        members: members.map((m) => ({
          accountId: m.account_id,
          platformUserId: m.platform_user_id,
          role: m.role,
        })),
        activeSequenceRunId: g.active_sequence_run_id,
        activeAgentRunId: g.active_agent_run_id,
      };
    }),
  );
}

function messageDto(r: any) {
  return {
    msgId: r.msg_id,
    clientMsgId: r.client_msg_id,
    senderPlatformUserId: r.sender_platform_user_id,
    isOwn: r.is_own,
    text: r.text,
    sentAt: r.sent_at.toISOString(),
    deliveryStatus: r.delivery_status,
    failCode: r.fail_code,
    localFilePath: r.local_file_path,
  };
}

function registerAgentReadRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/agent-runs/:id', async (request) => {
    await requireAuth(request, db);
    const { id } = request.params as { id: string };
    const run = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [id])).rows[0];
    if (!run) throw new AppError(404, 'AGENT_RUN_NOT_FOUND', 'Agent run not found');
    const steps = (
      await db.query('SELECT * FROM agent_steps WHERE run_id=$1 ORDER BY step_index', [id])
    ).rows;
    return agentRunDto(run, steps);
  });
  app.get('/api/groups/:id/agent-runs', async (request) => {
    await requireAuth(request, db);
    const { id } = request.params as { id: string };
    return (
      await db.query(
        'SELECT * FROM agent_runs WHERE group_id=$1 ORDER BY created_at DESC LIMIT 20',
        [id],
      )
    ).rows.map((r) => agentRunDto(r));
  });
}
function agentRunDto(r: any, steps?: any[]) {
  return {
    id: r.id,
    groupId: r.group_id,
    status: r.status,
    endReason: r.end_reason,
    summary: r.summary,
    ...(steps
      ? {
          steps: steps.map((s) => ({
            kind: s.kind,
            toolUseId: s.tool_use_id,
            name: s.name,
            input: s.input,
            resultSummary: s.result_summary,
            isError: s.is_error,
            errorCode: s.error_code,
            auditVerdict: s.audit_verdict,
            rawResponse: s.raw_response,
          })),
        }
      : {}),
  };
}

function registerSequenceRoutes(app: FastifyInstance, db: Db) {
  app.post('/api/sequences', async (request) => {
    await requireAuth(request, db, true);
    const body = request.body as any;
    validateSequence(body);
    const id = randomUUID();
    await db.query('INSERT INTO sequences(id,name,steps) VALUES($1,$2,$3)', [
      id,
      body.name,
      JSON.stringify(body.steps),
    ]);
    return { id };
  });
  app.get('/api/sequences', async (request) => {
    await requireAuth(request, db);
    return (await db.query('SELECT id,name,steps FROM sequences ORDER BY created_at DESC')).rows;
  });
  app.post('/api/sequences/:id/preview', async (request) => {
    await requireAuth(request, db);
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const sequence = (await db.query('SELECT steps FROM sequences WHERE id=$1', [id])).rows[0];
    if (!sequence) throw new AppError(404, 'SEQUENCE_NOT_FOUND', 'Sequence not found');
    return {
      steps: resolveSteps(sequence.steps, body.vars ?? {}, body.stepVars ?? {}).map((step) => ({
        index: step.index,
        text: step.resolvedText,
        resolvedVars: step.resolvedVars,
        varSources: step.varSources,
      })),
    };
  });
  app.post('/api/groups/:id/sequence-runs', async (request, reply) => {
    await requireAuth(request, db, true);
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const seq = (await db.query('SELECT * FROM sequences WHERE id=$1', [body.sequenceId])).rows[0];
    if (!seq) throw new AppError(404, 'SEQUENCE_NOT_FOUND', 'Sequence not found');
    const resolved = resolveSteps(seq.steps, body.vars ?? {}, body.stepVars ?? {});
    const runId = randomUUID();
    try {
      await transaction(db, async (c) => {
        await c.query('INSERT INTO sequence_runs(id,group_id,sequence_id) VALUES($1,$2,$3)', [
          runId,
          id,
          body.sequenceId,
        ]);
        for (const s of resolved)
          await c.query(
            `INSERT INTO sequence_run_steps(run_id,step_index,account_role,text_template,resolved_text,delay_seconds,scheduled_at,resolved_vars,var_sources) VALUES($1,$2,$3,$4,$5,$6,now()+($6||' seconds')::interval,$7,$8)`,
            [
              runId,
              s.index,
              s.accountRole,
              s.text,
              s.resolvedText,
              s.delaySeconds,
              s.resolvedVars,
              s.varSources,
            ],
          );
      });
    } catch (e: any) {
      if (e.code === '23505')
        throw new AppError(409, 'SEQUENCE_ALREADY_RUNNING', 'A sequence is already running');
      throw e;
    }
    reply.code(201);
    return { runId };
  });
  app.get('/api/sequence-runs/:id', async (request) => {
    await requireAuth(request, db);
    const { id } = request.params as { id: string };
    const run = (
      await db.query('SELECT status,current_step_index FROM sequence_runs WHERE id=$1', [id])
    ).rows[0];
    if (!run) throw new AppError(404, 'SEQUENCE_RUN_NOT_FOUND', 'Sequence run not found');
    const steps = (
      await db.query('SELECT * FROM sequence_run_steps WHERE run_id=$1 ORDER BY step_index', [id])
    ).rows;
    return {
      status: run.status,
      currentStepIndex: run.current_step_index,
      steps: steps.map((s) => ({
        index: s.step_index,
        status: s.status,
        scheduledAt: s.scheduled_at.toISOString(),
        sentAt: iso(s.sent_at),
        clientMsgId: s.client_msg_id,
        resolvedVars: s.resolved_vars,
        varSources: s.var_sources,
      })),
    };
  });
}
function validateSequence(body: any) {
  if (!body?.name || !Array.isArray(body.steps) || !body.steps.length)
    throw new AppError(400, 'VALIDATION_ERROR', 'name and steps are required');
  body.steps.forEach((s: any, i: number) => {
    if (
      s.index !== i + 1 ||
      !['admin', 'member'].includes(s.accountRole) ||
      typeof s.text !== 'string' ||
      !Number.isInteger(s.delaySeconds) ||
      s.delaySeconds < 0
    )
      throw new AppError(400, 'VALIDATION_ERROR', 'Steps must be contiguous and valid');
  });
}
export function resolveSteps(
  steps: any[],
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
) {
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars))
    if (v !== '') {
      values[k] = v;
      sources[k] = 'default';
    }
  return steps.map((step) => {
    for (const [k, v] of Object.entries(stepVars[String(step.index)] ?? {}))
      if (v !== '') {
        values[k] = v;
        sources[k] = `step:${step.index}`;
      }
    const keys = [...step.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m: any) => m[1]);
    for (const key of keys)
      if (values[key] === undefined)
        throw new AppError(422, 'UNRESOLVED_PLACEHOLDER', `Unresolved placeholder ${key}`, {
          stepIndex: step.index,
          key,
        });
    return {
      ...step,
      resolvedText: step.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_: string, k: string) => values[k]),
      resolvedVars: { ...values },
      varSources: { ...sources },
    };
  });
}
