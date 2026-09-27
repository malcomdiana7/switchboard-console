import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { emitEvent, transaction } from './db.js';
import { GatewayClient, GatewayError } from './gateway.js';

const tools = [
  {
    name: 'get_recent_messages',
    description: 'Read recent group messages',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: ['limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to this group',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, idempotency_key: { type: 'string' } },
      required: ['text', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'kick_user',
    description: 'Remove a user from this group',
    input_schema: {
      type: 'object',
      properties: { platform_user_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['platform_user_id', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'Finish this run',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function agentTick(
  db: Db,
  agentUrl: string,
  gateway: GatewayClient,
  workerId: string,
  timeoutMs: number,
): Promise<boolean> {
  const run = (
    await db.query(
      `UPDATE agent_runs SET lease_owner=$1,lease_until=now()+interval '20 seconds',active_since=coalesce(active_since,now()) WHERE id=(SELECT id FROM agent_runs WHERE status='running' AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [workerId],
    )
  ).rows[0];
  if (!run) return false;
  const started = Date.now();
  try {
    if (run.cancel_requested) {
      await endRun(db, run, 'cancelled', 'cancelled');
      return true;
    }
    if (run.step_count >= 12 || Number(run.elapsed_ms) >= 60000) {
      await endRun(db, run, run.step_count >= 12 ? 'budget_exhausted' : 'wall_clock', 'failed');
      return true;
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(timeoutMs, 60000 - Number(run.elapsed_ms)),
    );
    let raw = '';
    let response: any;
    try {
      const r = await fetch(`${agentUrl}/agent/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: run.id, tools, messages: run.messages }),
        signal: controller.signal,
      });
      raw = await r.text();
      if (!r.ok) throw new Error('BAD_JSON');
      response = JSON.parse(raw);
      validateResponse(response);
    } catch (e: any) {
      const code = e.name === 'AbortError' ? 'TURN_TIMEOUT' : 'BAD_JSON';
      await protocolError(db, run, code, raw || String(e), Date.now() - started);
      return true;
    } finally {
      clearTimeout(timeout);
    }
    const block = response.content[0];
    if (response.stop_reason === 'end_turn') {
      await recordFinal(db, run, block.text, raw, Date.now() - started);
      return true;
    }
    const duplicate = (
      await db.query('SELECT 1 FROM agent_steps WHERE run_id=$1 AND tool_use_id=$2', [
        run.id,
        block.id,
      ])
    ).rowCount;
    if (duplicate) {
      await protocolError(db, run, 'DUPLICATE_TOOL_USE_ID', raw, Date.now() - started);
      return true;
    }
    const validation = validateTool(block.name, block.input);
    if (validation) {
      await toolResult(
        db,
        run,
        block,
        raw,
        { code: validation, message: 'Tool name or input is invalid' },
        true,
        null,
        Date.now() - started,
      );
      return true;
    }
    if (block.name === 'finish') {
      await finishTool(db, run, block, raw, Date.now() - started);
      return true;
    }
    if (block.name === 'get_recent_messages') {
      const result = await recentMessages(db, run.group_id, block.input.limit);
      await toolResult(db, run, block, raw, result, false, null, Date.now() - started);
      return true;
    }
    if (block.name === 'send_message') {
      const existing = (
        await db.query(
          'SELECT result,message_id FROM agent_tool_effects WHERE run_id=$1 AND idempotency_key=$2',
          [run.id, block.input.idempotency_key],
        )
      ).rows[0];
      if (existing) {
        let result = existing.result;
        if (existing.message_id) {
          const m = (
            await db.query('SELECT client_msg_id,delivery_status FROM messages WHERE id=$1', [
              existing.message_id,
            ])
          ).rows[0];
          result = { clientMsgId: m.client_msg_id, deliveryStatus: m.delivery_status };
        }
        await toolResult(db, run, block, raw, result, false, 'not_required', Date.now() - started);
        return true;
      }
      const audit = await auditCall(
        agentUrl,
        block.input.text,
        run.group_id,
        60000 - Number(run.elapsed_ms),
      );
      if (audit !== 'pass') {
        if (audit === 'blocked') {
          await blocked(db, run, Date.now() - started);
          return true;
        }
        await toolResult(
          db,
          run,
          block,
          raw,
          { code: 'AUDIT_REJECTED', message: 'Audit rejected the message' },
          true,
          'fail',
          Date.now() - started,
        );
        return true;
      }
      const account = await chooseAccount(db, run.group_id, false);
      if (!account) {
        await toolResult(
          db,
          run,
          block,
          raw,
          { code: 'NO_AVAILABLE_ACCOUNT', message: 'No online group account' },
          true,
          'pass',
          Date.now() - started,
        );
        return true;
      }
      const messageId = randomUUID(),
        clientMsgId = randomUUID();
      await transaction(db, async (c) => {
        await c.query(
          `INSERT INTO messages(id,group_id,client_msg_id,account_id,is_own,text,sent_at,delivery_status,next_attempt_at) VALUES($1,$2,$3,$4,true,$5,now(),'queued',now())`,
          [messageId, run.group_id, clientMsgId, account.id, block.input.text],
        );
        await c.query(
          `INSERT INTO agent_tool_effects(run_id,idempotency_key,tool_use_id,kind,phase,message_id,result) VALUES($1,$2,$3,'send_message','queued',$4,$5)`,
          [
            run.id,
            block.input.idempotency_key,
            block.id,
            messageId,
            { clientMsgId, deliveryStatus: 'queued' },
          ],
        );
      });
      let deliveryStatus = 'queued';
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const m = (await db.query('SELECT delivery_status FROM messages WHERE id=$1', [messageId]))
          .rows[0];
        deliveryStatus = m.delivery_status;
        if (['accepted', 'sent', 'failed', 'cancelled'].includes(deliveryStatus)) break;
        await sleep(100);
      }
      const timedOut = !['accepted', 'sent', 'failed', 'cancelled'].includes(deliveryStatus);
      const isError = timedOut || ['failed', 'cancelled'].includes(deliveryStatus);
      const result = timedOut
        ? { code: 'SEND_TIMEOUT', message: 'Delivery could not be confirmed within five seconds' }
        : isError
          ? { code: 'SEND_FAILED', message: 'Message delivery failed' }
          : { clientMsgId, deliveryStatus };
      await db.query(
        'UPDATE agent_tool_effects SET phase=$3,result=$4,updated_at=now() WHERE run_id=$1 AND idempotency_key=$2',
        [run.id, block.input.idempotency_key, deliveryStatus, result],
      );
      await toolResult(db, run, block, raw, result, isError, 'pass', Date.now() - started);
      return true;
    }
    if (block.name === 'kick_user') {
      const group = (
        await db.query('SELECT gateway_group_id,auto_kick_enabled FROM groups WHERE id=$1', [
          run.group_id,
        ])
      ).rows[0];
      if (!group.auto_kick_enabled) {
        await toolResult(
          db,
          run,
          block,
          raw,
          { code: 'POLICY_DENIED', message: 'Automatic kicking is disabled' },
          true,
          null,
          Date.now() - started,
        );
        return true;
      }
      const auditText = JSON.stringify({
        action: 'kick',
        platform_user_id: block.input.platform_user_id,
        reason: block.input.reason,
      });
      const audit = await auditCall(
        agentUrl,
        auditText,
        run.group_id,
        60000 - Number(run.elapsed_ms),
      );
      if (audit !== 'pass') {
        if (audit === 'blocked') {
          await blocked(db, run, Date.now() - started);
          return true;
        }
        await toolResult(
          db,
          run,
          block,
          raw,
          { code: 'AUDIT_REJECTED', message: 'Audit rejected the kick' },
          true,
          'fail',
          Date.now() - started,
        );
        return true;
      }
      const account = await chooseAccount(db, run.group_id, true);
      if (!account) {
        await toolResult(
          db,
          run,
          block,
          raw,
          { code: 'NO_AVAILABLE_ACCOUNT', message: 'No online admin account' },
          true,
          'pass',
          Date.now() - started,
        );
        return true;
      }
      try {
        const result = await gateway.kick(
          group.gateway_group_id,
          account.id,
          block.input.platform_user_id,
        );
        await toolResult(db, run, block, raw, result, false, 'pass', Date.now() - started);
      } catch (e) {
        const code =
          e instanceof GatewayError && ['OWNER_LEFT', 'NO_PERMISSION'].includes(e.code)
            ? e.code
            : 'GROUP_UNREACHABLE';
        await toolResult(
          db,
          run,
          block,
          raw,
          { code, message: 'Kick failed' },
          true,
          'pass',
          Date.now() - started,
        );
      }
      return true;
    }
  } finally {
    await db
      .query(
        `UPDATE agent_runs SET elapsed_ms=elapsed_ms+$2,active_since=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1 AND status='running'`,
        [run.id, Date.now() - started],
      )
      .catch(() => undefined);
  }
  return true;
}

function validateResponse(r: any) {
  if (
    !r ||
    !['tool_use', 'end_turn'].includes(r.stop_reason) ||
    !Array.isArray(r.content) ||
    r.content.length !== 1
  )
    throw new Error('shape');
  const b = r.content[0];
  if (
    r.stop_reason === 'tool_use' &&
    (b?.type !== 'tool_use' ||
      typeof b.id !== 'string' ||
      typeof b.name !== 'string' ||
      typeof b.input !== 'object')
  )
    throw new Error('shape');
  if (r.stop_reason === 'end_turn' && (b?.type !== 'text' || typeof b.text !== 'string'))
    throw new Error('shape');
}
function validateTool(name: string, input: any): string | null {
  if (!tools.some((t) => t.name === name)) return 'UNKNOWN_TOOL';
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'INVALID_INPUT';
  if (name === 'get_recent_messages' && typeof input.limit !== 'number') return 'INVALID_INPUT';
  if (
    name === 'send_message' &&
    (typeof input.text !== 'string' || typeof input.idempotency_key !== 'string')
  )
    return 'INVALID_INPUT';
  if (
    name === 'kick_user' &&
    (typeof input.platform_user_id !== 'string' || typeof input.reason !== 'string')
  )
    return 'INVALID_INPUT';
  if (name === 'finish' && typeof input.summary !== 'string') return 'INVALID_INPUT';
  return null;
}
async function auditCall(
  url: string,
  text: string,
  groupId: string,
  remaining: number,
): Promise<'pass' | 'fail' | 'blocked'> {
  for (let i = 0; i < 3; i++) {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), Math.min(5000, remaining));
    try {
      const r = await fetch(`${url}/agent/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, groupId }),
        signal: c.signal,
      });
      const b = await r.json();
      if (r.ok && (b.verdict === 'pass' || b.verdict === 'fail')) return b.verdict;
    } catch {
      // Audit transport and protocol failures are retried.
    } finally {
      clearTimeout(timer);
    }
  }
  return 'blocked';
}
async function recentMessages(db: Db, groupId: string, limit: number) {
  const effective = Math.min(50, Math.max(1, Math.floor(limit)));
  const rows = (
    await db.query(
      `SELECT msg_id,sender_platform_user_id,is_own,text,sent_at FROM (SELECT * FROM messages WHERE group_id=$1 ORDER BY sent_at DESC,id DESC LIMIT $2) m ORDER BY sent_at,id`,
      [groupId, effective],
    )
  ).rows;
  let truncated = limit > 50;
  return {
    messages: rows.map((r) => {
      if (r.text.length > 500) truncated = true;
      return {
        msgId: r.msg_id,
        senderPlatformUserId: r.sender_platform_user_id,
        isOwn: r.is_own,
        text: clip(r.text, 500),
        sentAt: r.sent_at.getTime(),
      };
    }),
    truncated,
  };
}
async function chooseAccount(db: Db, groupId: string, admin: boolean) {
  return (
    await db.query(
      `SELECT a.id FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND a.status='online' AND ($2=false OR m.role IN ('creator','admin')) ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'creator' THEN 1 ELSE 2 END,a.id LIMIT 1`,
      [groupId, admin],
    )
  ).rows[0];
}
function safeJson(value: any) {
  let json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= 8192) return json;
  json = JSON.stringify({ truncated: true, summary: clip(json, 7900) });
  return json;
}
async function toolResult(
  db: Db,
  run: any,
  block: any,
  raw: string,
  result: any,
  isError: boolean,
  audit: string | null,
  _elapsed: number,
) {
  void _elapsed;
  const content = safeJson(result);
  const assistant = { role: 'assistant', content: [block] };
  const user = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: block.id,
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  };
  await transaction(db, async (c) => {
    await c.query(
      `INSERT INTO agent_steps(run_id,step_index,kind,tool_use_id,name,input,result_summary,is_error,error_code,audit_verdict,raw_response) VALUES($1,$2,'tool_use',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        run.id,
        run.step_count + 1,
        block.id,
        block.name,
        block.input,
        clip(content, 200),
        isError,
        isError ? result.code : null,
        audit,
        clip(raw, 2048),
      ],
    );
    await c.query(
      `UPDATE agent_runs SET messages=messages||$2::jsonb,step_count=step_count+1,consecutive_protocol_errors=0,next_attempt_at=now() WHERE id=$1`,
      [run.id, JSON.stringify([assistant, user])],
    );
  });
  await maybeCancelOrBudget(db, run.id);
}
async function protocolError(db: Db, run: any, code: string, raw: string, _elapsed: number) {
  void _elapsed;
  await transaction(db, async (c) => {
    await c.query(
      `INSERT INTO agent_steps(run_id,step_index,kind,result_summary,is_error,error_code,raw_response) VALUES($1,$2,'protocol_error',$3,true,$4,$5)`,
      [run.id, run.step_count + 1, code, code, clip(raw, 2048)],
    );
    await c.query(
      `UPDATE agent_runs SET messages=messages||$2::jsonb,step_count=step_count+1,consecutive_protocol_errors=consecutive_protocol_errors+1,next_attempt_at=now() WHERE id=$1`,
      [
        run.id,
        JSON.stringify([
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `PROTOCOL_ERROR ${code}: The previous response violated the tool protocol.`,
              },
            ],
          },
        ]),
      ],
    );
  });
  const current = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0];
  if (current.consecutive_protocol_errors >= 3)
    await endRun(db, current, 'protocol_errors', 'failed');
  else await maybeCancelOrBudget(db, run.id);
}
async function finishTool(db: Db, run: any, block: any, raw: string, elapsed: number) {
  await transaction(db, async (c) => {
    await c.query(
      `INSERT INTO agent_steps(run_id,step_index,kind,tool_use_id,name,input,result_summary,raw_response) VALUES($1,$2,'tool_use',$3,'finish',$4,'{"ok":true}',$5)`,
      [run.id, run.step_count + 1, block.id, block.input, clip(raw, 2048)],
    );
    await c.query(
      `UPDATE agent_runs SET step_count=step_count+1,elapsed_ms=elapsed_ms+$2,summary=$3 WHERE id=$1`,
      [run.id, elapsed, block.input.summary],
    );
  });
  await endRun(db, { ...run, summary: block.input.summary }, 'final', 'finished');
}
async function recordFinal(db: Db, run: any, summary: string, raw: string, elapsed: number) {
  await db.query(
    `INSERT INTO agent_steps(run_id,step_index,kind,result_summary,raw_response) VALUES($1,$2,'final',$3,$4)`,
    [run.id, run.step_count + 1, clip(summary, 200), clip(raw, 2048)],
  );
  await db.query(
    'UPDATE agent_runs SET summary=$2,step_count=step_count+1,elapsed_ms=elapsed_ms+$3 WHERE id=$1',
    [run.id, summary, elapsed],
  );
  await endRun(db, { ...run, summary }, 'final', 'finished');
}
async function blocked(db: Db, run: any, elapsed: number) {
  await db.query(
    `UPDATE agent_runs SET status='blocked',end_reason='audit_blocked',elapsed_ms=elapsed_ms+$2 WHERE id=$1`,
    [run.id, elapsed],
  );
  await db.query(`INSERT INTO frontend_events(type,payload) VALUES('agent_run',$1)`, [
    { runId: run.id, groupId: run.group_id, status: 'blocked', endReason: 'audit_blocked' },
  ]);
}
async function maybeCancelOrBudget(db: Db, id: string) {
  const r = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [id])).rows[0];
  if (r.cancel_requested) await endRun(db, r, 'cancelled', 'cancelled');
  else if (r.step_count >= 12) await endRun(db, r, 'budget_exhausted', 'failed');
}
async function endRun(db: Db, run: any, reason: string, status: string) {
  await transaction(db, async (c) => {
    const updated = (
      await c.query(
        `UPDATE agent_runs SET status=$2,end_reason=$3,lease_owner=NULL,lease_until=NULL,active_since=NULL WHERE id=$1 AND status='running' RETURNING *`,
        [run.id, status, reason],
      )
    ).rows[0];
    if (!updated) return;
    await emitEvent(c, 'agent_run', {
      runId: run.id,
      groupId: run.group_id,
      status,
      endReason: reason,
    });
    const group = (
      await c.query('SELECT auto_kick_enabled,agent_enabled,status FROM groups WHERE id=$1', [
        run.group_id,
      ])
    ).rows[0];
    if (
      reason !== 'cancelled' &&
      group?.agent_enabled &&
      group.status === 'active' &&
      updated.pending_trigger_messages?.length
    ) {
      const id = randomUUID();
      const own = (
        await c.query(
          'SELECT platform_user_id FROM group_members WHERE group_id=$1 AND account_id IS NOT NULL',
          [run.group_id],
        )
      ).rows.map((x: any) => x.platform_user_id);
      const context = {
        groupId: run.group_id,
        triggerMessages: updated.pending_trigger_messages.sort(
          (a: any, b: any) => a.sentAt - b.sentAt,
        ),
        policy: { autoKickEnabled: group.auto_kick_enabled },
        ownPlatformUserIds: own,
      };
      await c.query(
        `INSERT INTO agent_runs(id,group_id,trigger_messages,messages) VALUES($1,$2,$3,$4)`,
        [
          id,
          run.group_id,
          context.triggerMessages,
          [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(context) }] }],
        ],
      );
      await emitEvent(c, 'agent_run', {
        runId: id,
        groupId: run.group_id,
        status: 'running',
        endReason: null,
      });
    }
  });
}
