import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { emitEvent, transaction } from './db.js';
import { GatewayClient, GatewayError } from './gateway.js';
import { agentTick } from './agent.js';
import { mediaArchiveTick, mediaCleanupTick } from './media.js';

const workerId = randomUUID();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startWorkers(db: Db, config: Config) {
  let stopped = false;
  const gateway = new GatewayClient(config.gatewayUrl);
  void db.query(
    `UPDATE sequence_run_steps s SET scheduled_at=now()+(s.delay_seconds||' seconds')::interval FROM sequence_runs r WHERE s.run_id=r.id AND r.status='running' AND s.step_index=r.current_step_index AND s.status='pending' AND s.scheduled_at<now()`,
  );
  const loops = [
    loop('delivery', () => deliveryTick(db, gateway)),
    loop('events', () => eventApplyTick(db, config.gatewayUrl)),
    loop('jobs', () => jobTick(db, gateway)),
    loop('rate-limit', () => rateLimitTick(db)),
    loop('agent', () => agentTick(db, config.agentUrl, gateway, workerId, config.turnTimeoutMs)),
    loop('sequence', () => sequenceTick(db)),
    ...(config.mediaEnabled
      ? [
          loop('media-archive', () => mediaArchiveTick(db, config.mediaDir)),
          loop('media-cleanup', () =>
            mediaCleanupTick(db, config.mediaDir, config.mediaRetentionDays),
          ),
        ]
      : []),
    sseLoop(db, config.gatewayUrl),
  ];
  async function loop(name: string, tick: () => Promise<boolean>) {
    while (!stopped) {
      try {
        const did = await tick();
        if (!did) await delay(250);
      } catch (e) {
        console.error(`${name} worker`, e);
        await delay(1000);
      }
    }
  }
  async function sseLoop(db: Db, url: string) {
    while (!stopped) {
      try {
        await consumeSse(db, url, () => stopped);
      } catch (e) {
        console.error('SSE connection', e);
      }
      if (!stopped) await delay(1000);
    }
  }
  void Promise.all(loops);
  return {
    stop() {
      stopped = true;
    },
  };
}

async function deliveryTick(db: Db, gateway: GatewayClient): Promise<boolean> {
  const row = await transaction(
    db,
    async (c) =>
      (
        await c.query(
          `UPDATE messages SET lease_owner=$1,lease_until=now()+interval '20 seconds' WHERE id=(SELECT m.id FROM messages m JOIN accounts a ON a.id=m.account_id JOIN groups g ON g.id=m.group_id WHERE m.delivery_status IN ('queued','unknown') AND coalesce(m.next_attempt_at,now())<=now() AND (m.lease_until IS NULL OR m.lease_until<now()) AND a.status='online' AND g.status='active' ORDER BY m.created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [workerId],
        )
      ).rows[0],
  );
  if (!row) return false;
  const group = (await db.query('SELECT gateway_group_id FROM groups WHERE id=$1', [row.group_id]))
    .rows[0];
  try {
    if (row.delivery_status === 'unknown') {
      try {
        const found = await gateway.byClientId(group.gateway_group_id, row.client_msg_id);
        await db.query(
          `UPDATE messages SET msg_id=$2,sent_at=to_timestamp($3/1000.0),delivery_status='sent',fail_code=NULL,next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
          [row.id, found.msgId, found.sentAt],
        );
        return true;
      } catch (e) {
        if (e instanceof GatewayError && e.status === 404) {
          if (Date.now() - new Date(row.unknown_since).getTime() < 2000) {
            await release(db, row.id, 500);
            return true;
          }
          if (row.attempt_count < 2) {
            await db.query(
              `UPDATE messages SET delivery_status='queued',next_attempt_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1`,
              [row.id],
            );
            return true;
          }
          await failMessage(db, row.id, 'NETWORK_TIMEOUT');
          return true;
        }
        throw e;
      }
    }
    await db.query(
      'UPDATE messages SET attempt_count=attempt_count+1,last_attempt_at=now() WHERE id=$1',
      [row.id],
    );
    await gateway.send(group.gateway_group_id, row.account_id, row.client_msg_id, row.text);
    await db.query(
      `UPDATE messages SET delivery_status='accepted',next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
      [row.id],
    );
    await db.query(
      `UPDATE sequence_run_steps SET status='accepted' WHERE client_msg_id=$1 AND status='pending'`,
      [row.client_msg_id],
    );
  } catch (e) {
    if (e instanceof GatewayError) {
      if (e.code === 'RATE_LIMITED') {
        const seconds = Number(e.body.retryAfterSeconds ?? e.body.error?.retryAfterSeconds ?? 1);
        await transaction(db, async (c) => {
          await c.query(
            `UPDATE accounts SET status='rate_limited',rate_limited_until=now()+($2||' seconds')::interval WHERE id=$1 AND status='online'`,
            [row.account_id, seconds],
          );
          await c.query(
            `UPDATE messages SET next_attempt_at=now()+($2||' seconds')::interval,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
            [row.id, seconds],
          );
          await emitEvent(c, 'account_status_changed', {
            accountId: row.account_id,
            from: 'online',
            to: 'rate_limited',
          });
        });
      } else if (e.code === 'NETWORK_TIMEOUT') {
        await db.query(
          `UPDATE messages SET delivery_status='unknown',unknown_since=now(),next_attempt_at=now()+interval '500ms',lease_owner=NULL,lease_until=NULL WHERE id=$1`,
          [row.id],
        );
      } else if (e.code === 'ACCOUNT_SUSPENDED' || e.code === 'SESSION_EXPIRED') {
        await terminalFromDelivery(
          db,
          row.account_id,
          e.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired',
        );
      } else if (e.code === 'GROUP_WRITE_FORBIDDEN') {
        await groupUnreachable(db, row.group_id);
      } else await failMessage(db, row.id, e.code);
    } else await release(db, row.id, 1000);
  }
  return true;
}
async function release(db: Db, id: string, ms: number) {
  await db.query(
    `UPDATE messages SET next_attempt_at=now()+($2||' milliseconds')::interval,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
    [id, ms],
  );
}
async function failMessage(db: Db, id: string, code: string) {
  await transaction(db, async (c) => {
    const m = (
      await c.query(
        `UPDATE messages SET delivery_status='failed',fail_code=$2,next_attempt_at=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1 RETURNING client_msg_id`,
        [id, code],
      )
    ).rows[0];
    if (m?.client_msg_id) {
      const step = (
        await c.query(
          `UPDATE sequence_run_steps SET status='failed',sent_at=now() WHERE client_msg_id=$1 RETURNING run_id`,
          [m.client_msg_id],
        )
      ).rows[0];
      if (step)
        await c.query(`UPDATE sequence_runs SET status='failed' WHERE id=$1`, [step.run_id]);
    }
  });
}

async function terminalFromDelivery(db: Db, accountId: string, status: string) {
  await transaction(db, async (c) => {
    const r = (
      await c.query(
        `UPDATE accounts SET status=$2,rate_limited_until=NULL,updated_at=now() WHERE id=$1 AND status NOT IN ('suspended','session_expired') RETURNING status`,
        [accountId, status],
      )
    ).rows[0];
    if (!r) return;
    await c.query('DELETE FROM group_members WHERE account_id=$1', [accountId]);
    await c.query(
      `UPDATE messages SET delivery_status='cancelled',fail_code='ACCOUNT_TERMINAL',next_attempt_at=NULL WHERE account_id=$1 AND delivery_status='queued'`,
      [accountId],
    );
    await emitEvent(c, 'account_terminal', { accountId, status });
  });
}
async function groupUnreachable(db: Db, groupId: string) {
  await transaction(db, async (c) => {
    await c.query(`UPDATE groups SET status='unreachable' WHERE id=$1`, [groupId]);
    await c.query(
      `UPDATE messages SET delivery_status='cancelled',fail_code='GROUP_UNREACHABLE',next_attempt_at=NULL WHERE group_id=$1 AND delivery_status='queued'`,
      [groupId],
    );
    await c.query(
      `UPDATE sequence_runs SET status='stopped' WHERE group_id=$1 AND status='running'`,
      [groupId],
    );
    await c.query(
      `UPDATE agent_runs SET cancel_requested=true WHERE group_id=$1 AND status='running'`,
      [groupId],
    );
    await emitEvent(c, 'inconsistency', {
      kind: 'group_unreachable',
      ref: groupId,
      message: 'Gateway reports that this group is not writable',
    });
  });
}

async function consumeSse(db: Db, baseUrl: string, stopped: () => boolean) {
  const since = Number(
    (await db.query("SELECT contiguous_event_id FROM gateway_checkpoints WHERE stream='main'"))
      .rows[0].contiguous_event_id,
  );
  const response = await fetch(`${baseUrl}/events?since=${since}`, {
    headers: { accept: 'text/event-stream' },
  });
  if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!stopped()) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = frame.split('\n');
      const id = Number(
        lines
          .find((l) => l.startsWith('id:'))
          ?.slice(3)
          .trim(),
      );
      const type = lines
        .find((l) => l.startsWith('event:'))
        ?.slice(6)
        .trim();
      const data = lines
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
        .trim();
      if (id && type && data) {
        try {
          await db.query(
            `INSERT INTO gateway_events(event_id,type,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
            [id, type, JSON.parse(data)],
          );
        } catch (e) {
          await db
            .query(`INSERT INTO frontend_events(type,payload) VALUES('inconsistency',$1)`, [
              { kind: 'gateway_event_persist', ref: String(id), message: String(e) },
            ])
            .catch(() => undefined);
        }
      }
    }
  }
}

async function eventApplyTick(db: Db, baseGatewayUrl: string): Promise<boolean> {
  const event = await transaction(
    db,
    async (c) =>
      (
        await c.query(
          `UPDATE gateway_events SET lease_owner=$1,lease_until=now()+interval '10 seconds',attempts=attempts+1 WHERE event_id=(SELECT event_id FROM gateway_events WHERE applied_at IS NULL AND received_at<=now()-interval '1100 milliseconds' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY event_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [workerId],
        )
      ).rows[0],
  );
  if (!event) return false;
  try {
    await transaction(db, async (c) => {
      const p = event.payload;
      if (event.type === 'message') {
        const group = (
          await c.query('SELECT id,agent_enabled FROM groups WHERE gateway_group_id=$1', [
            p.groupId,
          ])
        ).rows[0];
        if (group) {
          const own = (
            await c.query('SELECT id FROM accounts WHERE platform_user_id=$1', [
              p.senderPlatformUserId,
            ])
          ).rows[0];
          const outbound = (
            await c.query('SELECT id FROM messages WHERE group_id=$1 AND msg_id=$2', [
              group.id,
              p.msgId,
            ])
          ).rows[0];
          const mediaUrl = p.mediaUrl ? new URL(p.mediaUrl, `${baseGatewayUrl}/`).toString() : null;
          if (outbound)
            await c.query(
              `UPDATE messages SET sender_platform_user_id=$2,is_own=true,text=$3,sent_at=to_timestamp($4/1000.0),delivery_status='sent',fail_code=NULL,media_url=coalesce($5,media_url) WHERE id=$1`,
              [outbound.id, p.senderPlatformUserId, p.text, p.sentAt, mediaUrl],
            );
          else
            await c.query(
              `INSERT INTO messages(id,group_id,msg_id,sender_platform_user_id,is_own,text,sent_at,media_url) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),$8) ON CONFLICT(group_id,msg_id) DO NOTHING`,
              [
                randomUUID(),
                group.id,
                p.msgId,
                p.senderPlatformUserId,
                !!own,
                p.text,
                p.sentAt,
                mediaUrl,
              ],
            );
          await emitEvent(c, 'message', { groupId: group.id, msgId: p.msgId, isOwn: !!own });
          if (!own && group.agent_enabled) await queueAgentTrigger(c, group.id, p);
        }
      } else if (event.type === 'message_sent') {
        await c.query(
          `WITH outbound AS (
             SELECT id,group_id FROM messages WHERE client_msg_id=$1 FOR UPDATE
           ), echo AS (
             DELETE FROM messages duplicate USING outbound
             WHERE duplicate.group_id=outbound.group_id AND duplicate.msg_id=$2 AND duplicate.id<>outbound.id
             RETURNING duplicate.*
           )
           UPDATE messages target SET
             msg_id=$2,
             sent_at=to_timestamp($3/1000.0),
             delivery_status='sent',
             fail_code=NULL,
             next_attempt_at=NULL,
             sender_platform_user_id=coalesce((SELECT sender_platform_user_id FROM echo),target.sender_platform_user_id),
             media_url=coalesce((SELECT media_url FROM echo),target.media_url),
             local_file_path=coalesce((SELECT local_file_path FROM echo),target.local_file_path),
             media_archived_at=coalesce((SELECT media_archived_at FROM echo),target.media_archived_at)
           WHERE target.id=(SELECT id FROM outbound)`,
          [p.clientMsgId, p.msgId, p.sentAt],
        );
        const step = (
          await c.query(
            `UPDATE sequence_run_steps SET status='sent',sent_at=to_timestamp($2/1000.0) WHERE client_msg_id=$1 AND status IN ('pending','accepted') RETURNING run_id,step_index`,
            [p.clientMsgId, p.sentAt],
          )
        ).rows[0];
        if (step) await advanceSequence(c, step.run_id, step.step_index, new Date(p.sentAt));
      } else if (event.type === 'message_failed') {
        await c.query(
          `UPDATE messages SET delivery_status='failed',fail_code=$2,next_attempt_at=NULL WHERE client_msg_id=$1`,
          [p.clientMsgId, p.code],
        );
        const step = (
          await c.query(
            `UPDATE sequence_run_steps SET status='failed',sent_at=now() WHERE client_msg_id=$1 RETURNING run_id`,
            [p.clientMsgId],
          )
        ).rows[0];
        if (step)
          await c.query(`UPDATE sequence_runs SET status='failed' WHERE id=$1`, [step.run_id]);
      } else if (event.type === 'member_joined') {
        const group = (
          await c.query('SELECT id FROM groups WHERE gateway_group_id=$1', [p.groupId])
        ).rows[0];
        const account = (
          await c.query('SELECT id FROM accounts WHERE platform_user_id=$1', [p.platformUserId])
        ).rows[0];
        if (group && account)
          await c.query(
            `INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
            [group.id, account.id, p.platformUserId],
          );
      } else if (event.type === 'member_left') {
        const group = (
          await c.query('SELECT id FROM groups WHERE gateway_group_id=$1', [p.groupId])
        ).rows[0];
        if (group)
          await c.query('DELETE FROM group_members WHERE group_id=$1 AND platform_user_id=$2', [
            group.id,
            p.platformUserId,
          ]);
      } else if (event.type === 'account_status') {
        const account = (await c.query('SELECT id FROM accounts WHERE id=$1', [p.accountId]))
          .rows[0];
        if (account) await terminalFromClient(c, p.accountId, p.status);
      }
      await c.query(
        'UPDATE gateway_events SET applied_at=now(),lease_owner=NULL,lease_until=NULL,last_error=NULL WHERE event_id=$1',
        [event.event_id],
      );
      await c.query(
        `UPDATE gateway_checkpoints SET contiguous_event_id=$1,updated_at=now() WHERE stream='main' AND contiguous_event_id+1=$1`,
        [event.event_id],
      );
    });
  } catch (e) {
    await db.query(
      `UPDATE gateway_events SET last_error=$2,next_attempt_at=now()+interval '1 second',lease_owner=NULL,lease_until=NULL WHERE event_id=$1`,
      [event.event_id, String(e)],
    );
    await db.query(`INSERT INTO frontend_events(type,payload) VALUES('inconsistency',$1)`, [
      { kind: 'gateway_event_apply', ref: String(event.event_id), message: String(e) },
    ]);
  }
  return true;
}
async function terminalFromClient(c: any, id: string, status: string) {
  const r = (
    await c.query(
      `UPDATE accounts SET status=$2 WHERE id=$1 AND status NOT IN ('suspended','session_expired') RETURNING id`,
      [id, status],
    )
  ).rows[0];
  if (r) {
    await c.query('DELETE FROM group_members WHERE account_id=$1', [id]);
    await c.query(
      `UPDATE messages SET delivery_status='cancelled',fail_code='ACCOUNT_TERMINAL' WHERE account_id=$1 AND delivery_status='queued'`,
      [id],
    );
    await emitEvent(c, 'account_terminal', { accountId: id, status });
  }
}
async function queueAgentTrigger(c: any, groupId: string, p: any) {
  const running = (
    await c.query(`SELECT id FROM agent_runs WHERE group_id=$1 AND status='running' FOR UPDATE`, [
      groupId,
    ])
  ).rows[0];
  const trigger = {
    msgId: p.msgId,
    senderPlatformUserId: p.senderPlatformUserId,
    text: p.text,
    sentAt: p.sentAt,
  };
  if (running)
    await c.query(
      `UPDATE agent_runs SET pending_trigger_messages=pending_trigger_messages||$2::jsonb WHERE id=$1`,
      [running.id, JSON.stringify([trigger])],
    );
  else {
    const id = randomUUID();
    const group = (await c.query('SELECT auto_kick_enabled FROM groups WHERE id=$1', [groupId]))
      .rows[0];
    const own = (
      await c.query(
        'SELECT platform_user_id FROM group_members WHERE group_id=$1 AND account_id IS NOT NULL',
        [groupId],
      )
    ).rows.map((x: any) => x.platform_user_id);
    const context = {
      groupId,
      triggerMessages: [trigger],
      policy: { autoKickEnabled: group.auto_kick_enabled },
      ownPlatformUserIds: own,
    };
    await c.query(
      `INSERT INTO agent_runs(id,group_id,trigger_messages,messages) VALUES($1,$2,$3,$4)`,
      [
        id,
        groupId,
        JSON.stringify([trigger]),
        JSON.stringify([
          { role: 'user', content: [{ type: 'text', text: JSON.stringify(context) }] },
        ]),
      ],
    );
    await emitEvent(c, 'agent_run', { runId: id, groupId, status: 'running', endReason: null });
  }
}

async function rateLimitTick(db: Db): Promise<boolean> {
  const row = (
    await db.query(
      `UPDATE accounts SET status='online',rate_limited_until=NULL,updated_at=now() WHERE id=(SELECT id FROM accounts WHERE status='rate_limited' AND rate_limited_until<=now() LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`,
    )
  ).rows[0];
  if (!row) return false;
  await db.query(`INSERT INTO frontend_events(type,payload) VALUES('account_status_changed',$1)`, [
    { accountId: row.id, from: 'rate_limited', to: 'online' },
  ]);
  return true;
}

async function jobTick(db: Db, gateway: GatewayClient): Promise<boolean> {
  const job = (
    await db.query(
      `UPDATE jobs SET lease_owner=$1,lease_until=now()+interval '15 seconds' WHERE id=(SELECT id FROM jobs WHERE status='running' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [workerId],
    )
  ).rows[0];
  if (!job) return false;
  try {
    if (job.kind === 'create_group') await createGroupJob(db, gateway, job);
    else await leaveAllJob(db, gateway, job);
  } catch (e: any) {
    await db.query(
      `UPDATE jobs SET status='failed',errors=errors||$2::jsonb,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
      [
        job.id,
        JSON.stringify([{ step: job.state?.step ?? 'create', code: e.code ?? 'INTERNAL_ERROR' }]),
      ],
    );
  }
  return true;
}
async function createGroupJob(db: Db, gateway: GatewayClient, job: any) {
  const input = job.input;
  let state = job.state ?? {};
  if (!state.gatewayGroupId) {
    const out = await gateway.createGroup(input.creatorAccountId);
    const groupId = randomUUID();
    const creator = (
      await db.query('SELECT platform_user_id FROM accounts WHERE id=$1', [input.creatorAccountId])
    ).rows[0];
    await transaction(db, async (c) => {
      await c.query('INSERT INTO groups(id,gateway_group_id,creator_account_id) VALUES($1,$2,$3)', [
        groupId,
        out.groupId,
        input.creatorAccountId,
      ]);
      await c.query(
        `INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'creator')`,
        [groupId, input.creatorAccountId, creator.platform_user_id],
      );
      state = { ...state, gatewayGroupId: out.groupId, groupId, step: 'invite', memberIndex: 0 };
      await c.query('UPDATE jobs SET group_id=$2,state=$3 WHERE id=$1', [job.id, groupId, state]);
    });
  }
  if (!state.inviteLink) {
    const inv = await gateway.invite(state.gatewayGroupId);
    state = {
      ...state,
      inviteLink: inv.inviteLink,
      inviteReadyAt: Date.now() + inv.readyAfterMs,
      step: `join:${input.memberAccountIds[state.memberIndex]}`,
    };
    await db.query(
      'UPDATE jobs SET state=$2,next_attempt_at=to_timestamp($3/1000.0),lease_owner=NULL,lease_until=NULL WHERE id=$1',
      [job.id, state, state.inviteReadyAt],
    );
    return;
  }
  if (Date.now() < state.inviteReadyAt) {
    await db.query(
      'UPDATE jobs SET lease_owner=NULL,lease_until=NULL,next_attempt_at=to_timestamp($2/1000.0) WHERE id=$1',
      [job.id, state.inviteReadyAt],
    );
    return;
  }
  const memberId = input.memberAccountIds[state.memberIndex];
  if (memberId) {
    try {
      await gateway.join(state.gatewayGroupId, memberId, state.inviteLink);
    } catch (e) {
      if (e instanceof GatewayError && e.code === 'INVITE_NOT_READY') {
        await db.query(
          `UPDATE jobs SET next_attempt_at=now()+interval '250 milliseconds',lease_owner=NULL,lease_until=NULL WHERE id=$1`,
          [job.id],
        );
        return;
      }
      if (e instanceof GatewayError && e.code === 'INVITE_EXPIRED' && !state.inviteRefreshed) {
        const invite = await gateway.invite(state.gatewayGroupId);
        state = {
          ...state,
          inviteLink: invite.inviteLink,
          inviteReadyAt: Date.now() + invite.readyAfterMs,
          inviteRefreshed: true,
        };
        await db.query(
          'UPDATE jobs SET state=$2,next_attempt_at=to_timestamp($3/1000.0),lease_owner=NULL,lease_until=NULL WHERE id=$1',
          [job.id, state, state.inviteReadyAt],
        );
        return;
      }
      if (!(e instanceof GatewayError && e.code === 'ALREADY_MEMBER')) throw e;
    }
    const account = (
      await db.query('SELECT platform_user_id FROM accounts WHERE id=$1', [memberId])
    ).rows[0];
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const exists = (
        await db.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2', [
          state.groupId,
          memberId,
        ])
      ).rowCount;
      if (exists) break;
      const remote = await gateway.members(state.gatewayGroupId);
      if (remote.some((m) => m.platformUserId === account.platform_user_id)) {
        await db.query(
          `INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`,
          [state.groupId, memberId, account.platform_user_id],
        );
        break;
      }
      await delay(250);
    }
    if (
      !(
        await db.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2', [
          state.groupId,
          memberId,
        ])
      ).rowCount
    ) {
      const err: any = new Error('join timeout');
      err.code = 'JOIN_TIMEOUT';
      throw err;
    }
    state = {
      ...state,
      memberIndex: state.memberIndex + 1,
      step: `join:${input.memberAccountIds[state.memberIndex + 1] ?? 'done'}`,
    };
    await db.query('UPDATE jobs SET state=$2 WHERE id=$1', [job.id, state]);
    if (state.memberIndex < input.memberAccountIds.length) {
      await db.query(
        'UPDATE jobs SET lease_owner=NULL,lease_until=NULL,next_attempt_at=now() WHERE id=$1',
        [job.id],
      );
      return;
    }
  }
  state.promoteAttempts = (state.promoteAttempts ?? 0) + 1;
  state.step = 'promote';
  try {
    await gateway.promote(state.gatewayGroupId, input.creatorAccountId, input.memberAccountIds[0]);
    await db.query(`UPDATE group_members SET role='admin' WHERE group_id=$1 AND account_id=$2`, [
      state.groupId,
      input.memberAccountIds[0],
    ]);
    await db.query(
      `UPDATE jobs SET status='finished',state=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
      [job.id, state],
    );
  } catch (e) {
    if (e instanceof GatewayError && e.code === 'NOT_MEMBER_YET' && state.promoteAttempts < 2) {
      await db.query(
        `UPDATE jobs SET state=$2,next_attempt_at=now()+interval '500ms',lease_owner=NULL,lease_until=NULL WHERE id=$1`,
        [job.id, state],
      );
      return;
    }
    throw e;
  }
}
async function leaveAllJob(db: Db, gateway: GatewayClient, job: any) {
  const group = (
    await db.query('SELECT gateway_group_id,creator_account_id FROM groups WHERE id=$1', [
      job.group_id,
    ])
  ).rows[0];
  const members = (
    await db.query(
      "SELECT account_id,role FROM group_members WHERE group_id=$1 ORDER BY (role='creator'),account_id",
      [job.group_id],
    )
  ).rows;
  const errors = [];
  for (const m of members.filter((x: any) => x.role !== 'creator')) {
    try {
      await gateway.leave(group.gateway_group_id, m.account_id);
      await db.query('DELETE FROM group_members WHERE group_id=$1 AND account_id=$2', [
        job.group_id,
        m.account_id,
      ]);
    } catch (e: any) {
      errors.push({ step: `leave:${m.account_id}`, code: e.code ?? 'LEAVE_FAILED' });
    }
  }
  if (errors.length) {
    await db.query(
      `UPDATE jobs SET status='failed',errors=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
      [job.id, JSON.stringify(errors)],
    );
    return;
  }
  try {
    await gateway.leave(group.gateway_group_id, group.creator_account_id);
    await transaction(db, async (c) => {
      await c.query('DELETE FROM group_members WHERE group_id=$1', [job.group_id]);
      await c.query(`UPDATE groups SET status='left' WHERE id=$1`, [job.group_id]);
      await c.query(
        `UPDATE jobs SET status='finished',lease_owner=NULL,lease_until=NULL WHERE id=$1`,
        [job.id],
      );
    });
  } catch (e: any) {
    await db.query(
      `UPDATE jobs SET status='failed',errors=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1`,
      [
        job.id,
        JSON.stringify([
          { step: `leave:${group.creator_account_id}`, code: e.code ?? 'LEAVE_FAILED' },
        ]),
      ],
    );
  }
}

async function sequenceTick(db: Db): Promise<boolean> {
  const step = (
    await db.query(
      `SELECT s.*,r.group_id FROM sequence_run_steps s JOIN sequence_runs r ON r.id=s.run_id WHERE r.status='running' AND s.step_index=r.current_step_index AND s.status='pending' AND s.scheduled_at<=now() ORDER BY s.scheduled_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    )
  ).rows[0];
  if (!step) return false;
  const roles = step.account_role === 'admin' ? ['admin', 'creator'] : ['member'];
  const candidates = (
    await db.query(
      `SELECT a.id,a.status,a.rate_limited_until,m.role FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND m.role=ANY($2) AND a.status IN ('online','rate_limited') ORDER BY CASE WHEN m.role='admin' THEN 0 ELSE 1 END,a.id`,
      [step.group_id, roles],
    )
  ).rows;
  const online = candidates.find((a: any) => a.status === 'online');
  if (!online) {
    const limited = candidates
      .filter((a: any) => a.status === 'rate_limited')
      .sort((a: any, b: any) => a.rate_limited_until - b.rate_limited_until)[0];
    if (limited) {
      await db.query(
        'UPDATE sequence_run_steps SET scheduled_at=$3 WHERE run_id=$1 AND step_index=$2',
        [step.run_id, step.step_index, limited.rate_limited_until],
      );
      return true;
    }
    await transaction(db, async (c) => {
      await c.query(
        `UPDATE sequence_run_steps SET status='skipped',sent_at=now() WHERE run_id=$1 AND step_index=$2`,
        [step.run_id, step.step_index],
      );
      await advanceSequence(c, step.run_id, step.step_index, new Date());
    });
    return true;
  }
  const messageId = randomUUID(),
    clientMsgId = randomUUID();
  await transaction(db, async (c) => {
    await c.query(
      `INSERT INTO messages(id,group_id,client_msg_id,account_id,is_own,text,sent_at,delivery_status,next_attempt_at) VALUES($1,$2,$3,$4,true,$5,now(),'queued',now())`,
      [messageId, step.group_id, clientMsgId, online.id, step.resolved_text],
    );
    await c.query(
      `UPDATE sequence_run_steps SET client_msg_id=$3 WHERE run_id=$1 AND step_index=$2`,
      [step.run_id, step.step_index, clientMsgId],
    );
    await emitEvent(c, 'sequence_run', {
      runId: step.run_id,
      groupId: step.group_id,
      status: 'running',
      currentStepIndex: step.step_index,
    });
  });
  return true;
}
async function advanceSequence(c: any, runId: string, index: number, at: Date) {
  const next = (
    await c.query(
      'SELECT delay_seconds FROM sequence_run_steps WHERE run_id=$1 AND step_index=$2',
      [runId, index + 1],
    )
  ).rows[0];
  if (!next) {
    const run = (
      await c.query(
        `UPDATE sequence_runs SET status='finished',current_step_index=$2,updated_at=now() WHERE id=$1 RETURNING group_id`,
        [runId, index],
      )
    ).rows[0];
    if (run)
      await emitEvent(c, 'sequence_run', {
        runId,
        groupId: run.group_id,
        status: 'finished',
        currentStepIndex: index,
      });
    return;
  }
  await c.query(`UPDATE sequence_runs SET current_step_index=$2,updated_at=now() WHERE id=$1`, [
    runId,
    index + 1,
  ]);
  await c.query(
    `UPDATE sequence_run_steps SET scheduled_at=$3::timestamptz+(delay_seconds||' seconds')::interval WHERE run_id=$1 AND step_index=$2`,
    [runId, index + 1, at.toISOString()],
  );
}
