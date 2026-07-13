const prisma = require('../lib/prisma');

const DEFAULT_PLATFORM_SETTINGS = {
  platformName: 'HexTorq Examinations',
  supportEmail: '',
  timezone: 'Asia/Kolkata',
  strictFullscreen: true,
  disableClipboard: true,
  defaultGraceMinutes: 5,
  theme: 'system',
  primaryColor: 'blue',
  emailNotifications: true,
  systemAlerts: true,
  examSubmissionAlerts: false,
  sessionTimeoutMinutes: 30,
  ipWhitelistEnabled: false,
  backupFrequency: 'daily',
  includeMedia: true,
};

const sanitizePlatformSettings = (input = {}) => ({
  platformName: String(input.platformName || DEFAULT_PLATFORM_SETTINGS.platformName).trim().slice(0, 100),
  supportEmail: String(input.supportEmail || '').trim().slice(0, 200),
  timezone: String(input.timezone || DEFAULT_PLATFORM_SETTINGS.timezone).trim().slice(0, 100),
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

const settingsScopeForUser = (user) => user.role === 'SUPER_ADMIN'
  ? { scopeKey: 'GLOBAL', organizationId: null }
  : { scopeKey: `ORG:${user.organizationId}`, organizationId: user.organizationId };

const getResolvedSettings = async ({ organizationId = null, includeGlobal = true } = {}) => {
  const scopeKeys = [
    ...(includeGlobal ? ['GLOBAL'] : []),
    ...(organizationId ? [`ORG:${organizationId}`] : []),
  ];
  const rows = scopeKeys.length === 0
    ? []
    : await prisma.platformSetting.findMany({ where: { scopeKey: { in: scopeKeys } } });
  const merged = { ...DEFAULT_PLATFORM_SETTINGS };
  for (const scopeKey of scopeKeys) {
    const row = rows.find((entry) => entry.scopeKey === scopeKey);
    if (row?.data && typeof row.data === 'object') Object.assign(merged, row.data);
  }
  return sanitizePlatformSettings(merged);
};

const getResolvedSettingsForUser = (user) => getResolvedSettings({
  organizationId: user?.role === 'SUPER_ADMIN' ? null : user?.organizationId || null,
  includeGlobal: true,
});

module.exports = {
  DEFAULT_PLATFORM_SETTINGS,
  sanitizePlatformSettings,
  settingsScopeForUser,
  getResolvedSettings,
  getResolvedSettingsForUser,
};
