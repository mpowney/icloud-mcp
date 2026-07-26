/**
 * iCloud Drive (local sync folder) — filesystem access
 *
 * Reads files under the macOS iCloud Drive sync path (not CloudKit API).
 * Default: ~/Library/Mobile Documents/com~apple~CloudDocs
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const DEFAULT_ROOT = path.join(
  os.homedir(),
  'Library/Mobile Documents/com~apple~CloudDocs'
);

const MAX_READ_BYTES = 512 * 1024; // 512 KB
const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB

function encodeIcloudFileUri(relativePath) {
  const normalized = String(relativePath || '').replace(/^\/+/, '');
  return `icloud-file://${encodeURIComponent(normalized).replace(/%2F/g, '/')}`;
}

function getRoot() {
  return process.env.ICLOUD_DRIVE_PATH || DEFAULT_ROOT;
}

function resolveSafePath(relativePath = '') {
  const root = path.resolve(getRoot());
  const target = path.resolve(root, relativePath || '.');

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Path is outside the iCloud Drive folder');
  }

  return target;
}

async function getDriveInfo() {
  const root = getRoot();
  let exists = false;
  let accessible = false;

  try {
    await fs.access(root);
    exists = true;
    accessible = true;
  } catch {
    exists = false;
  }

  return {
    root,
    exists,
    accessible,
    note: 'Local sync folder only. Cloud-only files may not be downloaded yet.'
  };
}

async function listFiles(relativePath = '', { recursive = false, maxDepth = 2 } = {}) {
  const dir = resolveSafePath(relativePath);
  const stat = await fs.stat(dir);

  if (!stat.isDirectory()) {
    throw new Error('Path is not a directory');
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dir, entry.name);
    const rel = path.join(relativePath || '', entry.name);
    let size = null;
    let modified = null;

    try {
      const st = await fs.stat(fullPath);
      size = st.size;
      modified = st.mtime.toISOString();
    } catch {
      // cloud-only placeholder
    }

    const item = {
      name: entry.name,
      path: rel,
      type: entry.isDirectory() ? 'directory' : 'file',
      size,
      modified
    };

    if (item.type === 'file') {
      item.uri = encodeIcloudFileUri(rel);
    }

    results.push(item);

    if (recursive && entry.isDirectory() && maxDepth > 0) {
      const children = await listFiles(rel, { recursive: true, maxDepth: maxDepth - 1 });
      item.children = children;
    }
  }

  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Walk the drive and collect file metadata (for inventory / search)
 */
async function walkDrive({
  relativePath = '',
  maxDepth = 8,
  maxFiles = 5000
} = {}) {
  const files = [];
  const errors = [];

  async function walk(rel, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;

    let dirPath;
    try {
      dirPath = resolveSafePath(rel);
    } catch (e) {
      errors.push({ path: rel, error: e.message });
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: rel, error: e.message });
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;

      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await walk(childRel, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      try {
        const st = await fs.stat(fullPath);
        files.push({
          path: childRel,
          name: entry.name,
          size: st.size,
          modified: st.mtime.toISOString(),
          extension: path.extname(entry.name).toLowerCase() || '(none)',
          uri: encodeIcloudFileUri(childRel)
        });
      } catch (e) {
        files.push({
          path: childRel,
          name: entry.name,
          size: null,
          modified: null,
          extension: path.extname(entry.name).toLowerCase() || '(none)',
          uri: encodeIcloudFileUri(childRel),
          cloudOnly: true,
          error: e.message
        });
      }
    }
  }

  await walk(relativePath, 0);

  return {
    scannedFrom: relativePath || '.',
    fileCount: files.length,
    truncated: files.length >= maxFiles,
    files,
    errors
  };
}

/**
 * Top-level folder summary (size, file count) — good overview when iCloud is messy
 */
async function getDriveSummary() {
  const root = resolveSafePath('');
  const entries = await fs.readdir(root, { withFileTypes: true });
  const folders = [];
  let rootFileCount = 0;
  let rootSize = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const rel = entry.name;
    const fullPath = path.join(root, entry.name);

    if (entry.isFile()) {
      try {
        const st = await fs.stat(fullPath);
        rootFileCount += 1;
        rootSize += st.size;
      } catch {
        rootFileCount += 1;
      }
      continue;
    }

    if (!entry.isDirectory()) continue;

    const walkResult = await walkDrive({ relativePath: rel, maxDepth: 6, maxFiles: 2000 });
    const sizes = walkResult.files.filter((f) => f.size != null).map((f) => f.size);
    const totalSize = sizes.reduce((a, b) => a + b, 0);

    folders.push({
      name: rel,
      path: rel,
      fileCount: walkResult.fileCount,
      totalSizeBytes: totalSize,
      truncated: walkResult.truncated,
      cloudOnlyCount: walkResult.files.filter((f) => f.cloudOnly).length
    });
  }

  folders.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes);

  return {
    root: getRoot(),
    rootLevelFiles: rootFileCount,
    rootLevelSizeBytes: rootSize,
    folders,
    totalFolders: folders.length
  };
}

/**
 * Search files by name (substring match)
 */
async function searchFiles(query, { maxResults = 100, maxScan = 5000 } = {}) {
  const q = query.toLowerCase();
  const walkResult = await walkDrive({ maxFiles: maxScan });
  const matches = walkResult.files
    .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
    .slice(0, maxResults);

  return {
    query,
    matchCount: matches.length,
    truncated: walkResult.truncated || matches.length >= maxResults,
    matches
  };
}

function formatBytes(bytes) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function readFileText(relativePath, maxBytes = MAX_READ_BYTES) {
  const filePath = resolveSafePath(relativePath);
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    throw new Error('Path is not a file');
  }

  if (stat.size > maxBytes) {
    throw new Error(`File too large (${stat.size} bytes). Max ${maxBytes} bytes.`);
  }

  const buffer = await fs.readFile(filePath);
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.js', '.ts', '.yaml', '.yml', '.env'];

  const ext = path.extname(filePath).toLowerCase();
  const isText = textExtensions.includes(ext) || !buffer.includes(0);

  if (!isText) {
    throw new Error('File does not look like text. Use a binary-safe workflow outside this tool.');
  }

  return {
    path: relativePath,
    uri: encodeIcloudFileUri(relativePath),
    size: stat.size,
    modified: stat.mtime.toISOString(),
    content: buffer.toString('utf8')
  };
}

async function createDirectory(relativePath) {
  const dirPath = resolveSafePath(relativePath);
  await fs.mkdir(dirPath, { recursive: true });
  return { success: true, path: relativePath, uri: encodeIcloudFileUri(relativePath) };
}

async function createFile(relativePath, content = '', { overwrite = false } = {}) {
  const filePath = resolveSafePath(relativePath);

  // Ensure parent folder exists before creating the file.
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (!overwrite) {
    try {
      await fs.access(filePath);
      throw new Error('File already exists. Set overwrite=true to replace it.');
    } catch (error) {
      if (error.message.startsWith('File already exists')) throw error;
    }
  }

  await fs.writeFile(filePath, String(content), 'utf8');
  const stat = await fs.stat(filePath);

  return {
    success: true,
    path: relativePath,
    uri: encodeIcloudFileUri(relativePath),
    size: stat.size,
    overwritten: overwrite
  };
}

async function createFileBinary(relativePath, base64Content, { overwrite = false, maxBytes = MAX_WRITE_BYTES } = {}) {
  if (typeof base64Content !== 'string' || base64Content.trim() === '') {
    throw new Error('base64Content is required and must be a non-empty base64 string.');
  }

  let buffer;
  try {
    buffer = Buffer.from(base64Content, 'base64');
  } catch {
    throw new Error('Invalid base64Content.');
  }

  if (!buffer || buffer.length === 0) {
    throw new Error('Decoded base64 content is empty.');
  }

  if (buffer.length > maxBytes) {
    throw new Error(`Binary payload too large (${buffer.length} bytes). Max ${maxBytes} bytes.`);
  }

  const filePath = resolveSafePath(relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (!overwrite) {
    try {
      await fs.access(filePath);
      throw new Error('File already exists. Set overwrite=true to replace it.');
    } catch (error) {
      if (error.message.startsWith('File already exists')) throw error;
    }
  }

  await fs.writeFile(filePath, buffer);
  const stat = await fs.stat(filePath);

  return {
    success: true,
    path: relativePath,
    uri: encodeIcloudFileUri(relativePath),
    size: stat.size,
    overwritten: overwrite,
    encoding: 'base64'
  };
}

async function renamePath(fromPath, toPath) {
  const source = resolveSafePath(fromPath);
  const target = resolveSafePath(toPath);
  await fs.rename(source, target);
  return {
    success: true,
    from: fromPath,
    to: toPath,
    fromUri: encodeIcloudFileUri(fromPath),
    toUri: encodeIcloudFileUri(toPath)
  };
}

async function deletePath(relativePath, recursive = true) {
  const target = resolveSafePath(relativePath);
  await fs.rm(target, { recursive, force: false });
  return { success: true, path: relativePath, uri: encodeIcloudFileUri(relativePath), recursive };
}

module.exports = {
  getDriveInfo,
  listFiles,
  readFileText,
  createFile,
  createFileBinary,
  createDirectory,
  renamePath,
  deletePath,
  walkDrive,
  getDriveSummary,
  searchFiles,
  formatBytes,
  encodeIcloudFileUri,
  getRoot,
  resolveSafePath,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES
};
