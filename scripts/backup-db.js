const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config();

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const outputDir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
fs.mkdirSync(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(outputDir, `hextorq-${stamp}.dump`);
const pgDump = path.join(process.env.PG_BIN || '', process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');

execFileSync(pgDump, ['--dbname', process.env.DATABASE_URL, '--format=custom', '--no-owner', '--file', output], { stdio: 'inherit' });
const stat = fs.statSync(output);
if (stat.size === 0) throw new Error('Backup file is empty');
console.log(JSON.stringify({ status: 'ok', output, bytes: stat.size }));
