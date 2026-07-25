/**
 * Local Notes Client
 * Accesses Notes.app via AppleScript
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { runAppleScript, runJXA, escapeAppleScript, escapeJXA } = require('../utils/applescript');

const ATTACHMENT_EXPORT_ROOT = path.join(os.tmpdir(), 'icloud-mcp', 'notes-attachments');
const ICLOUD_DRIVE_ROOT = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs');
const attachmentResourceStore = new Map();
const execFileAsync = promisify(execFile);

function sanitizeFileName(name) {
  return (name || 'attachment')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'attachment';
}

function toAbsolutePathFromFileUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('file://')) {
    return null;
  }

  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}

function guessMimeTypeFromName(fileName = '') {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4'
  };

  return map[ext] || 'application/octet-stream';
}

function isLikelyTextFile(buffer, mimeType) {
  if ((mimeType || '').startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'application/xml') return true;
  return !buffer.includes(0);
}

function parseReferenceScheme(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return match ? match[1].toLowerCase() : null;
}

function classifyAttachmentKind(attachment) {
  const mime = (attachment.mimeType || '').toLowerCase();
  const uti = (attachment.uti || '').toLowerCase();
  const type = (attachment.type || '').toLowerCase();
  const scheme = attachment.referenceScheme || parseReferenceScheme(attachment.url);

  if (scheme === 'http' || scheme === 'https') return 'rich_link';
  if (mime.startsWith('image/') || uti.includes('image') || type.includes('image')) return 'image';
  if (mime.startsWith('video/') || uti.includes('movie') || type.includes('video')) return 'video';
  if (mime.startsWith('audio/') || uti.includes('audio') || type.includes('audio')) return 'audio';
  if (uti.includes('drawing') || type.includes('drawing')) return 'drawing';
  if (uti.includes('scan') || type.includes('scan')) return 'scan';
  if (attachment.filePath || attachment.url) return 'file';
  return 'unknown';
}

function isResolvableReference(attachment) {
  return Boolean(attachment.filePath || toAbsolutePathFromFileUrl(attachment.url));
}

function inferUnresolvedReason(attachment) {
  if (attachment.cloudOnly) return 'cloud_only_placeholder';
  const scheme = attachment.referenceScheme || parseReferenceScheme(attachment.url);
  if (scheme && !['file', 'http', 'https'].includes(scheme)) return 'unsupported_scheme';
  if (attachment.url || attachment.filePath) return 'not_locally_resolved';
  return 'no_local_path_exposed';
}

function buildUnresolvedEmbed(attachment) {
  return {
    attachmentId: attachment.attachmentId,
    name: attachment.name || null,
    sourceKind: attachment.sourceKind,
    referenceScheme: attachment.referenceScheme || parseReferenceScheme(attachment.url),
    rawReference: attachment.rawReference || attachment.url || attachment.filePath || null,
    reason: inferUnresolvedReason(attachment),
    exportHint: attachment.exportHint,
    cloudOnly: attachment.cloudOnly === true,
    icloudRelativePath: attachment.icloudRelativePath || null
  };
}

function makeAttachmentId(noteId, raw, index) {
  const input = [
    noteId,
    raw?.scriptId || '',
    raw?.filePath || '',
    raw?.url || '',
    raw?.name || '',
    String(index)
  ].join('|');

  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 20);
}

function buildAttachmentResourceUri(noteId, attachmentId) {
  return `notes-attachment://${encodeURIComponent(noteId)}/${encodeURIComponent(attachmentId)}`;
}

function isUnderIcloudDrive(filePath) {
  if (!filePath) return false;
  const root = path.resolve(ICLOUD_DRIVE_ROOT);
  const candidate = path.resolve(filePath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

function toIcloudRelativePath(filePath) {
  if (!isUnderIcloudDrive(filePath)) return null;
  return path.relative(ICLOUD_DRIVE_ROOT, filePath);
}

async function readDownloadingStatus(filePath) {
  try {
    const { stdout } = await execFileAsync('mdls', ['-raw', '-name', 'kMDItemDownloadingStatus', filePath], {
      timeout: 4000,
      maxBuffer: 256 * 1024
    });

    const value = (stdout || '').trim();
    if (!value || value === '(null)') return null;
    return value;
  } catch {
    return null;
  }
}

async function enrichAttachment(raw, noteId, index) {
  const attachment = {
    attachmentId: makeAttachmentId(noteId, raw, index),
    noteId,
    name: raw?.name || raw?.fileName || null,
    sourceKind: raw?.source || 'unknown',
    scriptId: raw?.scriptId || null,
    url: raw?.url || null,
    filePath: raw?.filePath || null,
    mimeType: raw?.mimeType || null,
    uti: raw?.uti || null,
    type: raw?.type || null,
    htmlTag: raw?.htmlTag || null,
    htmlAttr: raw?.htmlAttr || null,
    rawReference: raw?.rawReference || null,
    referenceScheme: raw?.referenceScheme || parseReferenceScheme(raw?.url || raw?.rawReference),
    size: typeof raw?.size === 'number' ? raw.size : null,
    icloudRelativePath: null,
    cloudOnly: false,
    cloudState: 'unknown',
    downloadingStatus: null,
    attachmentKind: 'unknown',
    available: false,
    exportHint: 'not_available'
  };

  const candidatePath = attachment.filePath || toAbsolutePathFromFileUrl(attachment.url);
  if (!candidatePath) {
    attachment.attachmentKind = classifyAttachmentKind(attachment);
    return attachment;
  }

  attachment.icloudRelativePath = toIcloudRelativePath(candidatePath);
  const mdlsStatus = await readDownloadingStatus(candidatePath);
  if (mdlsStatus) {
    attachment.downloadingStatus = mdlsStatus;
  }

  try {
    const stat = await fs.stat(candidatePath);
    if (stat.isFile()) {
      attachment.filePath = candidatePath;
      attachment.size = attachment.size ?? stat.size;
      attachment.available = true;
      attachment.exportHint = 'exportable';
      attachment.cloudState = 'local';
      if (!attachment.name) {
        attachment.name = path.basename(candidatePath);
      }
      if (!attachment.mimeType) {
        attachment.mimeType = guessMimeTypeFromName(attachment.name);
      }
    }
  } catch {
    if (attachment.icloudRelativePath || attachment.downloadingStatus === 'NotDownloaded') {
      attachment.cloudOnly = true;
      attachment.cloudState = 'cloud_only';
      attachment.exportHint = 'cloud_only_placeholder';
      attachment.downloadingStatus = attachment.downloadingStatus || 'NotDownloaded';
    } else {
      attachment.exportHint = 'metadata_only';
    }
  }

  attachment.attachmentKind = classifyAttachmentKind(attachment);
  return attachment;
}

async function normalizeAttachments(rawAttachments, noteId, maxAttachments = 50, dedupeMode = 'safe') {
  if (!Array.isArray(rawAttachments)) {
    return { attachments: [], dedupedCount: 0, inputCount: 0, truncated: false };
  }

  const normalized = [];
  const seen = new Set();
  const cap = Math.max(1, Math.min(Number(maxAttachments) || 50, 500));
  let dedupedCount = 0;

  for (let i = 0; i < rawAttachments.length && normalized.length < cap; i += 1) {
    const enriched = await enrichAttachment(rawAttachments[i], noteId, i);

    if (dedupeMode !== 'none') {
      const dedupeKey = dedupeMode === 'strict'
        ? [enriched.scriptId || '', enriched.filePath || '', enriched.url || '', enriched.name || '', enriched.sourceKind || ''].join('|')
        : [enriched.scriptId || '', enriched.filePath || '', enriched.url || '', enriched.name || ''].join('|');
      if (seen.has(dedupeKey)) {
        dedupedCount += 1;
        continue;
      }
      seen.add(dedupeKey);
    }

    normalized.push(enriched);
  }

  return {
    attachments: normalized,
    dedupedCount,
    inputCount: rawAttachments.length,
    truncated: rawAttachments.length > cap
  };
}

/**
 * List note folders
 * @returns {Promise<Array>} - List of folders
 */
async function listNoteFolders() {
  const script = `
    const notes = Application('Notes');
    const folders = notes.folders();
    let result = [];

    for (let folder of folders) {
      try {
        result.push({
          id: folder.id(),
          name: folder.name(),
          noteCount: folder.notes().length
        });
      } catch (e) {}
    }

    JSON.stringify(result);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * List notes
 * @param {string} folderName - Folder name (optional)
 * @param {number} count - Max notes to return
 * @returns {Promise<Array>} - List of notes
 */
async function listNotes(folderName = null, count = 25) {
  const script = `
    const notes = Application('Notes');
    let allNotes = [];

    ${folderName ? `
    const folder = notes.folders.byName("${escapeJXA(folderName)}");
    const notesList = folder.notes();
    for (let note of notesList) {
      allNotes.push({
        id: note.id(),
        name: note.name(),
        creationDate: note.creationDate().toISOString(),
        modificationDate: note.modificationDate().toISOString(),
        folder: "${escapeJXA(folderName)}"
      });
    }
    ` : `
    const folders = notes.folders();
    for (let folder of folders) {
      try {
        const notesList = folder.notes();
        for (let note of notesList) {
          allNotes.push({
            id: note.id(),
            name: note.name(),
            creationDate: note.creationDate().toISOString(),
            modificationDate: note.modificationDate().toISOString(),
            folder: folder.name()
          });
        }
      } catch (e) {}
    }
    `}

    allNotes.sort((a, b) => new Date(b.modificationDate) - new Date(a.modificationDate));
    JSON.stringify(allNotes.slice(0, ${count}));
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Read a note's content
 * @param {string} noteId - Note ID
 * @param {Object} options - Read options
 * @returns {Promise<Object>} - Note content
 */
async function readNote(noteId, options = {}) {
  const includeAttachments = options.includeAttachments === true;
  const maxAttachments = Math.max(1, Math.min(Number(options.maxAttachments) || 50, 500));
  const attachmentDiscoveryMode = ['jxa', 'html', 'hybrid', 'deep'].includes(options.attachmentDiscoveryMode)
    ? options.attachmentDiscoveryMode
    : 'hybrid';
  const includeUnresolvedEmbeds = options.includeUnresolvedEmbeds !== false;
  const includeDiscoveryStats = options.includeDiscoveryStats === true;
  const dedupeMode = ['none', 'safe', 'strict'].includes(options.dedupeMode) ? options.dedupeMode : 'safe';
  const useMethodDiscovery = attachmentDiscoveryMode !== 'html';
  const useHtmlDiscovery = attachmentDiscoveryMode !== 'jxa';

  const script = `
    const notes = Application('Notes');
    let found = null;

    function safeCall(fn, fallback = null) {
      try {
        return fn();
      } catch (e) {
        return fallback;
      }
    }

    function getArray(value) {
      if (!value) return [];
      return Array.isArray(value) ? value : [];
    }

    function itemId(item) {
      return safeCall(() => String(item.id()), null);
    }

    function valueFor(item, key) {
      try {
        if (!item) return null;
        const candidate = item[key];
        if (typeof candidate === 'function') return candidate.call(item);
        return candidate;
      } catch (e) {
        return null;
      }
    }

    function collectFoldersRecursive(container, out, seenFolderIds, depth = 0) {
      if (!container || depth > 8) return;

      const subfolders = safeCall(() => container.folders(), []);
      const list = getArray(subfolders);
      for (let i = 0; i < list.length; i += 1) {
        const folder = list[i];
        const fid = itemId(folder) || ('anon-folder-' + depth + '-' + i);
        if (seenFolderIds[fid]) continue;
        seenFolderIds[fid] = true;
        out.push(folder);
        collectFoldersRecursive(folder, out, seenFolderIds, depth + 1);
      }
    }

    function collectAllFolders() {
      const out = [];
      const seenFolderIds = {};

      collectFoldersRecursive(notes, out, seenFolderIds, 0);

      const accounts = safeCall(() => notes.accounts(), []);
      const accountList = getArray(accounts);
      for (let i = 0; i < accountList.length; i += 1) {
        collectFoldersRecursive(accountList[i], out, seenFolderIds, 0);
      }

      return out;
    }

    function pushIfObject(target, raw, source) {
      if (!raw) return;
      target.push({
        source,
        scriptId: valueFor(raw, 'id'),
        name: valueFor(raw, 'name') || valueFor(raw, 'fileName') || valueFor(raw, 'filename'),
        url: valueFor(raw, 'url') || valueFor(raw, 'URL'),
        filePath: valueFor(raw, 'filePath') || valueFor(raw, 'path'),
        mimeType: valueFor(raw, 'mimeType') || valueFor(raw, 'contentType'),
        uti: valueFor(raw, 'uti') || valueFor(raw, 'uniformTypeIdentifier'),
        type: valueFor(raw, 'type') || valueFor(raw, 'kind'),
        size: valueFor(raw, 'size') || valueFor(raw, 'fileSize'),
        htmlTag: null,
        htmlAttr: null,
        rawReference: null,
        referenceScheme: null
      });
    }

    function collectFromMethod(note, methodName, output, limit) {
      try {
        const method = note[methodName];
        if (typeof method !== 'function') return;
        const items = method.call(note) || [];
        if (!Array.isArray(items)) return;

        for (let i = 0; i < items.length && output.length < limit; i += 1) {
          pushIfObject(output, items[i], 'method:' + methodName);
        }
      } catch (e) {}
    }

    function collectFromHeuristicMethods(note, output, limit) {
      const names = [
        'attachments', 'mediaItems', 'objects', 'embeddedObjects', 'files', 'images', 'links',
        'resources', 'assets', 'documents', 'sharedItems', 'items', 'attachmentsByDate'
      ];
      for (let i = 0; i < names.length && output.length < limit; i += 1) {
        collectFromMethod(note, names[i], output, limit);
      }
    }

    function collectFromBody(body, output, limit) {
      try {
        const attrRegex = /<([a-zA-Z0-9:-]+)\\b[^>]*?\\b(src|href|data|srcset|poster|data-src|data-url|data-attachment-url|data-asset-url)=["']([^"']+)["']/gi;
        const cssRegex = /style=["'][^"']*url\\(([^\\)]+)\\)[^"']*["']/gi;
        let match;

        while ((match = attrRegex.exec(body)) && output.length < limit) {
          const htmlTag = (match[1] || '').toLowerCase();
          const htmlAttr = (match[2] || '').toLowerCase();
          const rawValue = (match[3] || '').trim();
          const reference = htmlAttr === 'srcset' ? rawValue.split(',')[0].trim().split(/\\s+/)[0] : rawValue;

          output.push({
            source: 'body-html',
            url: reference,
            filePath: (typeof reference === 'string' && reference.startsWith('file://')) ? decodeURIComponent(reference.replace('file://', '')) : null,
            name: null,
            size: null,
            mimeType: null,
            uti: null,
            type: null,
            scriptId: null,
            htmlTag,
            htmlAttr,
            rawReference: rawValue,
            referenceScheme: (reference.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [])[1] || null
          });
        }

        while ((match = cssRegex.exec(body)) && output.length < limit) {
          const rawValue = (match[1] || '').replace(/["']/g, '').trim();
          output.push({
            source: 'body-style',
            url: rawValue,
            filePath: (typeof rawValue === 'string' && rawValue.startsWith('file://')) ? decodeURIComponent(rawValue.replace('file://', '')) : null,
            name: null,
            size: null,
            mimeType: null,
            uti: null,
            type: null,
            scriptId: null,
            htmlTag: null,
            htmlAttr: 'style',
            rawReference: rawValue,
            referenceScheme: (rawValue.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [])[1] || null
          });
        }

        if (output.length < limit && /<object\\b|<embed\\b|x-apple-|x-coredata-|cid:/i.test(body || '')) {
          output.push({
            source: 'body-signal',
            url: null,
            filePath: null,
            name: null,
            size: null,
            mimeType: null,
            uti: null,
            type: null,
            scriptId: null,
            htmlTag: null,
            htmlAttr: null,
            rawReference: null,
            referenceScheme: null
          });
        }
      } catch (e) {}
    }

    function buildNoteResult(note, folderName, accountName) {
      const body = safeCall(() => note.body(), '');
      const plaintext = safeCall(() => note.plaintext(), '');
      const attachments = [];
      const discovery = {
        mode: '${escapeJXA(attachmentDiscoveryMode)}',
        attemptedSources: [],
        sourceCounts: {}
      };

      if (${includeAttachments}) {
        if (${useMethodDiscovery}) {
          const candidateMethods = ['attachments', 'mediaItems', 'objects', 'embeddedObjects', 'files', 'images', 'links', 'resources', 'assets', 'documents'];
          for (let i = 0; i < candidateMethods.length && attachments.length < ${maxAttachments}; i += 1) {
            const before = attachments.length;
            collectFromMethod(note, candidateMethods[i], attachments, ${maxAttachments});
            const added = attachments.length - before;
            discovery.attemptedSources.push('method:' + candidateMethods[i]);
            discovery.sourceCounts['method:' + candidateMethods[i]] = added;
          }

          if (attachments.length < ${maxAttachments}) {
            const before = attachments.length;
            collectFromHeuristicMethods(note, attachments, ${maxAttachments});
            const added = attachments.length - before;
            discovery.attemptedSources.push('method:heuristic');
            discovery.sourceCounts['method:heuristic'] = added;
          }
        }

        if (${useHtmlDiscovery} && attachments.length < ${maxAttachments}) {
          const before = attachments.length;
          collectFromBody(body || '', attachments, ${maxAttachments});
          const added = attachments.length - before;
          discovery.attemptedSources.push('body-html');
          discovery.sourceCounts['body-html'] = added;
        }
      }

      return {
        id: safeCall(() => note.id(), null),
        name: safeCall(() => note.name(), null),
        body,
        plaintext,
        creationDate: safeCall(() => note.creationDate().toISOString(), null),
        modificationDate: safeCall(() => note.modificationDate().toISOString(), null),
        folder: folderName,
        account: accountName,
        attachments,
        attachmentDiscovery: discovery
      };
    }

    const folders = collectAllFolders();
    for (let f = 0; f < folders.length && !found; f += 1) {
      const folder = folders[f];
      try {
        const notesList = getArray(safeCall(() => folder.notes(), []));
        const folderName = safeCall(() => folder.name(), null);
        const accountName = safeCall(() => folder.container().name(), null);

        for (let i = 0; i < notesList.length && !found; i += 1) {
          const note = notesList[i];
          if (safeCall(() => note.id(), null) === '${escapeJXA(noteId)}') {
            found = buildNoteResult(note, folderName, accountName);
          }
        }
      } catch (e) {}
    }

    if (!found) {
      try {
        const globalNotes = getArray(safeCall(() => notes.notes(), []));
        for (let i = 0; i < globalNotes.length && !found; i += 1) {
          const note = globalNotes[i];
          if (safeCall(() => note.id(), null) === '${escapeJXA(noteId)}') {
            found = buildNoteResult(
              note,
              safeCall(() => note.container().name(), null),
              safeCall(() => note.container().container().name(), null)
            );
          }
        }
      } catch (e) {}
    }

    JSON.stringify(found);
  `;

  const result = await runJXA(script);
  const parsed = result ? JSON.parse(result) : null;

  if (!parsed || !includeAttachments) {
    if (parsed && !includeAttachments) {
      delete parsed.attachments;
      delete parsed.attachmentDiscovery;
      delete parsed.unresolvedEmbeds;
    }
    return parsed;
  }

  const normalized = await normalizeAttachments(parsed.attachments || [], noteId, maxAttachments, dedupeMode);
  const attachments = normalized.attachments;
  const unresolvedEmbeds = includeUnresolvedEmbeds
    ? attachments
      .filter((item) => !item.available || !isResolvableReference(item))
      .map(buildUnresolvedEmbed)
    : [];

  const output = {
    ...parsed,
    attachments
  };

  if (includeUnresolvedEmbeds) {
    output.unresolvedEmbeds = unresolvedEmbeds;
  }

  if (includeDiscoveryStats) {
    output.attachmentDiscovery = {
      ...parsed.attachmentDiscovery,
      dedupeMode,
      dedupedCount: normalized.dedupedCount,
      inputCount: normalized.inputCount,
      outputCount: attachments.length,
      truncated: normalized.truncated,
      unresolvedCount: unresolvedEmbeds.length,
      warnings: attachmentDiscoveryMode === 'deep'
        ? ['deep mode currently aliases hybrid extraction in this version']
        : []
    };
  } else {
    delete output.attachmentDiscovery;
  }

  return output;
}

/**
 * Export an embedded note attachment to a local temp path and register it as MCP resource.
 * @param {string} noteId - Note ID
 * @param {string} attachmentId - Attachment ID
 * @returns {Promise<Object>} - Export metadata and resource URI
 */
async function exportNoteAttachment(noteId, attachmentId) {
  const note = await readNote(noteId, { includeAttachments: true, maxAttachments: 500 });
  if (!note) {
    throw new Error('Note not found');
  }

  const attachment = (note.attachments || []).find((item) => item.attachmentId === attachmentId);
  if (!attachment) {
    throw new Error('Attachment not found in note');
  }

  const sourcePath = attachment.filePath || toAbsolutePathFromFileUrl(attachment.url);
  if (!sourcePath) {
    throw new Error('Attachment export is not supported for this item (no file path exposed by Notes scripting).');
  }

  if (attachment.cloudOnly && attachment.icloudRelativePath) {
    throw new Error(`Attachment is a cloud-only placeholder. Download it first with icloud-download using path: ${attachment.icloudRelativePath}`);
  }

  await fs.mkdir(ATTACHMENT_EXPORT_ROOT, { recursive: true });

  const baseName = sanitizeFileName(attachment.name || path.basename(sourcePath) || `attachment-${attachmentId}`);
  const targetPath = path.join(ATTACHMENT_EXPORT_ROOT, `${Date.now()}-${baseName}`);

  try {
    await fs.copyFile(sourcePath, targetPath);
  } catch (error) {
    if (attachment.icloudRelativePath) {
      throw new Error(`Attachment could not be read locally. It may be cloud-only. Download first with icloud-download using path: ${attachment.icloudRelativePath}`);
    }
    throw error;
  }
  const stat = await fs.stat(targetPath);

  const mimeType = attachment.mimeType || guessMimeTypeFromName(baseName);
  const uri = buildAttachmentResourceUri(noteId, attachmentId);
  const now = new Date().toISOString();

  attachmentResourceStore.set(uri, {
    uri,
    noteId,
    attachmentId,
    name: baseName,
    mimeType,
    size: stat.size,
    path: targetPath,
    exportedAt: now
  });

  return {
    noteId,
    attachmentId,
    name: baseName,
    mimeType,
    size: stat.size,
    exportedAt: now,
    exportPath: targetPath,
    resource: {
      uri,
      mimeType,
      name: baseName
    }
  };
}

/**
 * List exported note attachment resources.
 * @returns {Promise<Array>} - MCP resource descriptors
 */
async function listAttachmentResources() {
  return Array.from(attachmentResourceStore.values()).map((entry) => ({
    uri: entry.uri,
    name: entry.name,
    mimeType: entry.mimeType,
    description: `Notes attachment (${entry.noteId})`
  }));
}

/**
 * Read an exported attachment resource.
 * @param {string} uri - Resource URI
 * @returns {Promise<Object|null>} - MCP resource content or null when not found
 */
async function readAttachmentResource(uri) {
  const entry = attachmentResourceStore.get(uri);
  if (!entry) {
    return null;
  }

  let buffer;
  try {
    buffer = await fs.readFile(entry.path);
  } catch {
    attachmentResourceStore.delete(uri);
    return null;
  }

  if (isLikelyTextFile(buffer, entry.mimeType)) {
    return {
      uri: entry.uri,
      mimeType: entry.mimeType,
      text: buffer.toString('utf8')
    };
  }

  return {
    uri: entry.uri,
    mimeType: entry.mimeType,
    blob: buffer.toString('base64')
  };
}

/**
 * Create a new note
 * @param {Object} options - Note options
 * @returns {Promise<Object>} - Created note info
 */
async function createNote({ title, body, folderName = 'Notes' }) {
  const htmlBody = `<h1>${escapeAppleScript(title)}</h1><br>${escapeAppleScript(body || '').replace(/\n/g, '<br>')}`;

  const script = `
    tell application "Notes"
      tell folder "${escapeAppleScript(folderName)}"
        set newNote to make new note with properties {body:"${htmlBody}"}
        return id of newNote
      end tell
    end tell
  `;

  const id = await runAppleScript(script);
  return { success: true, id, message: 'Note created successfully' };
}

/**
 * Search notes
 * @param {string} query - Search query
 * @param {number} count - Max results
 * @returns {Promise<Array>} - Matching notes
 */
async function searchNotes(query, count = 25) {
  const searchTerm = escapeJXA(query.toLowerCase());

  const script = `
    const notes = Application('Notes');
    const folders = notes.folders();
    let results = [];

    for (let folder of folders) {
      if (results.length >= ${count}) break;

      try {
        const notesList = folder.notes();
        for (let note of notesList) {
          if (results.length >= ${count}) break;

          const name = (note.name() || '').toLowerCase();
          const plaintext = (note.plaintext() || '').toLowerCase();

          if (name.includes("${searchTerm}") || plaintext.includes("${searchTerm}")) {
            results.push({
              id: note.id(),
              name: note.name(),
              creationDate: note.creationDate().toISOString(),
              modificationDate: note.modificationDate().toISOString(),
              folder: folder.name(),
              snippet: note.plaintext().substring(0, 200)
            });
          }
        }
      } catch (e) {}
    }

    JSON.stringify(results);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

module.exports = {
  listNoteFolders,
  listNotes,
  readNote,
  createNote,
  searchNotes,
  exportNoteAttachment,
  listAttachmentResources,
  readAttachmentResource
};
