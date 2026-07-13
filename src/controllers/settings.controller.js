const prisma = require('../lib/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const {
  DEFAULT_PLATFORM_SETTINGS,
  sanitizePlatformSettings,
  settingsScopeForUser,
  getResolvedSettingsForUser,
} = require('../utils/platformSettings');
const { backupFiles, createDatabaseBackup } = require('../utils/backupService');

const get = asyncHandler(async (req, res) => {
  const target = settingsScopeForUser(req.user);
  const [stored, resolved] = await Promise.all([
    prisma.platformSetting.findUnique({ where: { scopeKey: target.scopeKey } }),
    getResolvedSettingsForUser(req.user),
  ]);
  res.json({ ...DEFAULT_PLATFORM_SETTINGS, ...resolved, updatedAt: stored?.updatedAt || null });
});
const update = asyncHandler(async (req, res) => {
  const target = settingsScopeForUser(req.user); const data = sanitizePlatformSettings(req.body);
  const stored = await prisma.platformSetting.upsert({
    where: { scopeKey: target.scopeKey }, update: { data },
    create: { ...target, data },
  });
  res.json({ ...data, updatedAt: stored.updatedAt });
});
const backupStatus = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') throw new ApiError(403, 'Super Admin access required');
  const latest = backupFiles()[0];
  res.json({
    latest: latest ? {
      name: latest.name,
      bytes: latest.bytes,
      createdAt: latest.createdAt,
      includeMedia: !!latest.metadata?.includeMedia,
      mediaPath: latest.metadata?.mediaPath || null,
    } : null,
  });
});
const runBackup = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') throw new ApiError(403, 'Super Admin access required');
  const settings = await getResolvedSettingsForUser(req.user);
  const backup = await createDatabaseBackup({ includeMedia: settings.includeMedia, trigger: 'manual' });
  res.status(201).json(backup);
});
const downloadLatest = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') throw new ApiError(403, 'Super Admin access required');
  const latest = backupFiles()[0]; if (!latest) throw new ApiError(404, 'No backup is available');
  res.download(latest.fullPath, latest.name);
});

module.exports = { get, update, backupStatus, runBackup, downloadLatest };
