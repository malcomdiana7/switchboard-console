import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readdir, readFile as readMigration } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveMediaFile, mediaCleanupTick } from '../apps/api/src/media.js';

describe('媒体归档', () => {
  let directory: string | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('将媒体原子保存到配置目录并返回相对文件名', async () => {
    directory = await mkdtemp(join(tmpdir(), 'switchboard-media-'));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      ),
    );

    const fileName = await archiveMediaFile({
      mediaUrl: 'http://gateway/media/asset-1',
      mediaDir: directory,
      messageId: 'message-1',
    });

    expect(fileName).toBe('message-1.png');
    expect(await readFile(join(directory, fileName))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('清理时先移除数据库引用，再删除对应文件', async () => {
    directory = await mkdtemp(join(tmpdir(), 'switchboard-media-cleanup-'));
    const fileName = 'old.png';
    await writeFile(join(directory, fileName), Buffer.from([1]));
    const db = new PGlite();
    const migrationDirectory = new URL('../db/migrations/', import.meta.url);
    for (const file of (await readdir(migrationDirectory)).sort()) {
      await db.exec(await readMigration(new URL(file, migrationDirectory), 'utf8'));
    }
    await db.exec(`
      INSERT INTO accounts(id) VALUES ('account-1');
      INSERT INTO groups(id,gateway_group_id,creator_account_id)
        VALUES ('00000000-0000-0000-0000-000000000001','group-1','account-1');
      INSERT INTO messages(id,group_id,msg_id,is_own,text,sent_at,local_file_path,media_archived_at)
        VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','msg-1',false,'old',now()-interval '40 days','old.png',now()-interval '40 days');
    `);

    expect(await mediaCleanupTick(db as any, directory, 30)).toBe(true);
    const row = await db.query<{ local_file_path: string | null }>(
      `SELECT local_file_path FROM messages WHERE msg_id='msg-1'`,
    );
    expect(row.rows[0].local_file_path).toBeNull();
    await expect(access(join(directory, fileName))).rejects.toThrow();
    await db.close();
  }, 30_000);
});
