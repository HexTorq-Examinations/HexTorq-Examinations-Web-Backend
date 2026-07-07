const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const DEFAULTS = {
  platformName: 'HexTorq Examinations', supportEmail: '', timezone: 'Asia/Kolkata',
  strictFullscreen: true, disableClipboard: true, defaultGraceMinutes: 5,
  theme: 'system', primaryColor: 'blue', emailNotifications: true,
  systemAlerts: true, examSubmissionAlerts: false, sessionTimeoutMinutes: 30,
  ipWhitelistEnabled: false, backupFrequency: 'daily', includeMedia: true,
};
const scope = (req) => req.user.role === 'SUPER_ADMIN'
  ? { scopeKey: 'GLOBAL', organizationId: null }
  : { scopeKey: `ORG:${req.user.organizationId}`, organizationId: req.user.organizationId };
const sanitize = (input = {}) => ({
  platformName: String(input.platformName || DEFAULTS.platformName).trim().slice(0, 100),
  supportEmail: String(input.supportEmail || '').trim().slice(0, 200),
  timezone: String(input.timezone || DEFAULTS.timezone).trim().slice(0, 100),
  strictFullscreen: input.strictFullscreen !== false,
  disableClipboard: input.disableClipboard !== false,
  defaultGraceMinutes: Math.min(1440, Math.max(0, Number(input.defaultGraceMinutes) || 0)),
  theme: ['light', 'dark', 'system'].includes(input.theme) ? input.theme : 'system',
  primaryColor: ['blue', 'emerald', 'purple', 'slate'].includes(input.primaryColor) ? input.primaryColor : 'blue',
  emailNotifications: input.emailNotifications !== false,
  systemAlerts: input.systemAlerts !== false,
  examSubmissionAlerts: !!input.examSubmissionAlerts,
  sessionTimeoutMinutes: Math.min(1440, Math.max(5, Number(input.sessionTimeoutMinutes) || 30)),
  ipWhitelistEnabled: !!input.ipWhitelistEnabled,
  backupFrequency: ['daily', 'weekly', 'monthly'].includes(input.backupFrequency) ? input.backupFrequency : 'daily',
  includeMedia: input.includeMedia !== false,
});

const get = asyncHandler(async (req, res) => {
  const target = scope(req);
  const stored = await prisma.platformSetting.findUnique({ where: { scopeKey: target.scopeKey } });
  res.json({ ...DEFAULTS, ...(stored?.data || {}), updatedAt: stored?.updatedAt || null });
});
const update = asyncHandler(async (req, res) => {
  const target = scope(req); const data = sanitize(req.body);
  const stored = await prisma.platformSetting.upsert({
    where: { scopeKey: target.scopeKey }, update: { data },
    create: { ...target, data },
  });
  res.json({ ...data, updatedAt: stored.updatedAt });
});

const backupDirectory = () => path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups'));
const backupFiles = () => {
  const directory = backupDirectory(); fs.mkdirSync(directory, { recursive: true });
  return fs.readdirSync(directory).filter((name) => name.endsWith('.dump')).map((name) => {
    const fullPath = path.join(directory, name); const stat = fs.statSync(fullPath);
    return { name, fullPath, bytes: stat.size, createdAt: stat.mtime };
  }).sort((a, b) => b.createdAt - a.createdAt);
};
const backupStatus = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') throw new ApiError(403, 'Super Admin access required');
  const latest = backupFiles()[0];
  res.json({ latest: latest ? { name: latest.name, bytes: latest.bytes, createdAt: latest.createdAt } : null });
});
const runBackup = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') throw new ApiError(403, 'Super Admin access required');
  if (!process.env.DATABASE_URL) throw new ApiError(503, 'DATABASE_URL is not configured');
  const directory = backupDirectory(); fs.mkdirSync(directory, { recursive: true });
  const name = `hextorq-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
  const output = path.join(directory, name);
  const binary = path.join(process.env.PG_BIN || '', process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
  await new Promise((resolve, reject) => execFile(binary, ['--dbname', process.env.DATABASE_URL, '--format=custom', '--no-owner', '--file', output], (error) => error ? reject(error) : resolve()));
  const stat = fs.statSync(output); if (!stat.size) throw new ApiError(500, 'Backup output was empty');
  res.status(201).json({ name, bytes: stat.size, createdAt: stat.mtime });
});
const downloadLatest = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') throw new ApiError(403, 'Super Admin access required');
  const latest = backupFiles()[0]; if (!latest) throw new ApiError(404, 'No backup is available');
  res.download(latest.fullPath, latest.name);
});

module.exports = { get, update, backupStatus, runBackup, downloadLatest };
