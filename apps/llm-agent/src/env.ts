import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  override: false,
  quiet: true,
});
