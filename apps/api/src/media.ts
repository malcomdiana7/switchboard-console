import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

const extensions: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
};

export async function archiveMediaFile(input: {
  mediaUrl: string;
  mediaDir: string;
  messageId: string;
}): Promise<string> {
  const response = await fetch(input.mediaUrl);
  if (!response.ok) throw new Error(`MEDIA_HTTP_${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
  const urlExtension = extname(new URL(input.mediaUrl).pathname).slice(0, 10);
  const extension = extensions[contentType] ?? urlExtension ?? '.bin';
  const fileName = `${input.messageId}${extension || '.bin'}`;
  const temporaryName = `.${fileName}.${randomUUID()}.tmp`;
  await mkdir(input.mediaDir, { recursive: true });
  await writeFile(join(input.mediaDir, temporaryName), Buffer.from(await response.arrayBuffer()), {
    flag: 'wx',
  });
  await rename(join(input.mediaDir, temporaryName), join(input.mediaDir, fileName));
  return fileName;
}

export async function mediaArchiveTick(db: Db, mediaDir: string): Promise<boolean> {
  const message = (
    await db.query(
      `UPDATE messages SET media_archive_attempts=media_archive_attempts+1,media_next_attempt_at=now()+interval '30 seconds'
       WHERE id=(SELECT id FROM messages WHERE media_url IS NOT NULL AND local_file_path IS NULL
         AND coalesce(media_next_attempt_at,now())<=now() ORDER BY sent_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id,media_url`,
    )
  ).rows[0];
  if (!message) return false;
  let fileName: string | undefined;
  try {
    fileName = await archiveMediaFile({
      mediaUrl: message.media_url,
      mediaDir,
      messageId: message.id,
    });
    await db.query(
      'UPDATE messages SET local_file_path=$2,media_archived_at=now(),media_next_attempt_at=NULL WHERE id=$1',
      [message.id, fileName],
    );
  } catch (error) {
    if (fileName) await unlink(join(mediaDir, fileName)).catch(() => undefined);
    const terminal = String(error).includes('MEDIA_HTTP_404');
    await db.query(
      `UPDATE messages SET media_url=CASE WHEN $2 THEN NULL ELSE media_url END,
       media_next_attempt_at=CASE WHEN $2 THEN NULL ELSE now()+interval '30 seconds' END WHERE id=$1`,
      [message.id, terminal],
    );
  }
  return true;
}

export async function mediaCleanupTick(
  db: Db,
  mediaDir: string,
  retentionDays: number,
): Promise<boolean> {
  const message = (
    await db.query(
      `WITH candidate AS (
         SELECT candidate.id,candidate.local_file_path FROM messages candidate
         WHERE candidate.local_file_path IS NOT NULL
           AND coalesce(candidate.media_archived_at,candidate.sent_at)<now()-($1::text||' days')::interval
           AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.group_id=candidate.group_id AND r.status='running')
         ORDER BY coalesce(candidate.media_archived_at,candidate.sent_at) LIMIT 1 FOR UPDATE SKIP LOCKED
       ), cleared AS (
         UPDATE messages m SET local_file_path=NULL FROM candidate
         WHERE m.id=candidate.id RETURNING candidate.local_file_path
       ) SELECT local_file_path FROM cleared`,
      [retentionDays],
    )
  ).rows[0];
  if (!message) return false;
  if (message.local_file_path) {
    await unlink(join(mediaDir, message.local_file_path)).catch(() => undefined);
  }
  return true;
}
