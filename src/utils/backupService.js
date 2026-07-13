const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const ApiError = require('./ApiError');

const backupDirectory = () => path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups'));
const uploadsDirectory = () => path.resolve(__dirname, '..', '..', 'uploads');
const metadataPathFor = (fullPath) => `${fullPath}.json`;

const readBackupMetadata = (fullPath) => {
  try {
    return JSON.parse(fs.readFileSync(metadataPathFor(fullPath), 'utf8'));
  } catch {
    return null;
  }
};

const backupFiles = () => {
  const directory = backupDirectory();
  fs.mkdirSync(directory, { recursive: true });
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.dump'))
    .map((name) => {
      const fullPath = path.join(directory, name);
      const stat = fs.statSync(fullPath);
      const metadata = readBackupMetadata(fullPath);
      return {
        name,
        fullPath,
        bytes: stat.size,
        createdAt: stat.mtime,
        metadata,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
};

const copyMediaSnapshot = async (baseName) => {
  const source = uploadsDirectory();
  try {
    const stat = await fsp.stat(source);
    if (!stat.isDirectory()) return { included: false, relativePath: null };
  } catch {
    return { included: false, relativePath: null };
  }

  const destinationRoot = path.join(backupDirectory(), 'media', baseName);
  const destination = path.join(destinationRoot, 'uploads');
  await fsp.rm(destinationRoot, { recursive: true, force: true });
  await fsp.mkdir(destinationRoot, { recursive: true });
  await fsp.cp(source, destination, { recursive: true, force: true });
  return {
    included: true,
    relativePath: path.relative(backupDirectory(), destinationRoot).replaceAll('\\', '/'),
  };
};

const createDatabaseBackup = async ({ includeMedia = false, trigger = 'manual' } = {}) => {
  if (!process.env.DATABASE_URL) throw new ApiError(503, 'DATABASE_URL is not configured');
  const directory = backupDirectory();
  await fsp.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `hextorq-${stamp}.dump`;
  const output = path.join(directory, name);
  const binary = path.join(process.env.PG_BIN || '', process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
  await new Promise((resolve, reject) => {
    execFile(binary, ['--dbname', process.env.DATABASE_URL, '--format=custom', '--no-owner', '--file', output], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const stat = await fsp.stat(output);
  if (!stat.size) throw new ApiError(500, 'Backup output was empty');

  const media = includeMedia ? await copyMediaSnapshot(name.replace(/\.dump$/, '')) : { included: false, relativePath: null };
  const metadata = {
    includeMedia: !!media.included,
    mediaPath: media.relativePath,
    trigger,
    createdAt: stat.mtime.toISOString(),
  };
  await fsp.writeFile(metadataPathFor(output), JSON.stringify(metadata, null, 2), 'utf8');

  return {
    name,
    bytes: stat.size,
    createdAt: stat.mtime,
    includeMedia: metadata.includeMedia,
    mediaPath: metadata.mediaPath,
  };
};

module.exports = {
  backupDirectory,
  backupFiles,
  createDatabaseBackup,
};
