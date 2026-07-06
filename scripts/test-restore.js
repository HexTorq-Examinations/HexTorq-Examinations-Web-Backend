const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config();

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sourceUrl = new URL(process.env.DATABASE_URL);
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const backup = process.argv[2] || fs.readdirSync(backupDir).filter((name) => name.endsWith('.dump')).sort().map((name) => path.join(backupDir, name)).at(-1);
if (!backup || !fs.existsSync(backup)) throw new Error('Backup dump not found');

const temporaryDatabase = `hextorq_restore_test_${Date.now()}`;
const adminUrl = new URL(sourceUrl); adminUrl.pathname = '/postgres';
const testUrl = new URL(sourceUrl); testUrl.pathname = `/${temporaryDatabase}`;
const binary = (name) => path.join(process.env.PG_BIN || '', process.platform === 'win32' ? `${name}.exe` : name);

try {
  execFileSync(binary('createdb'), ['--maintenance-db', adminUrl.toString(), temporaryDatabase], { stdio: 'inherit' });
  execFileSync(binary('pg_restore'), ['--dbname', testUrl.toString(), '--no-owner', '--exit-on-error', backup], { stdio: 'inherit' });
  const output = execFileSync(binary('psql'), [testUrl.toString(), '--tuples-only', '--no-align', '--command', 'SELECT COUNT(*) FROM "_prisma_migrations";'], { encoding: 'utf8' }).trim();
  if (!Number(output)) throw new Error('Restored database has no Prisma migration history');
  console.log(JSON.stringify({ status: 'restore_verified', backup, migrationRows: Number(output) }));
} finally {
  execFileSync(binary('dropdb'), ['--maintenance-db', adminUrl.toString(), '--if-exists', temporaryDatabase], { stdio: 'inherit' });
}
