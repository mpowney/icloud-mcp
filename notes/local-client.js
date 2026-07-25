/**
 * Local Notes Client
 * Accesses Notes.app via AppleScript
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { runAppleScript, runJXA, escapeAppleScript, escapeJXA } = require('../utils/applescript');

const ATTACHMENT_EXPORT_ROOT = path.join(os.tmpdir(), 'icloud-mcp', 'notes-attachments');
const attachmentResourceStore = new Map();

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
    size: typeof raw?.size === 'number' ? raw.size : null,
    available: false,
    exportHint: 'not_available'
  };

  const candidatePath = attachment.filePath || toAbsolutePathFromFileUrl(attachment.url);
  if (!candidatePath) {
    return attachment;
  }

  try {
    const stat = await fs.stat(candidatePath);
    if (stat.isFile()) {
      attachment.filePath = candidatePath;
      attachment.size = attachment.size ?? stat.size;
      attachment.available = true;
      attachment.exportHint = 'exportable';
      if (!attachment.name) {
        attachment.name = path.basename(candidatePath);
      }
      if (!attachment.mimeType) {
        attachment.mimeType = guessMimeTypeFromName(attachment.name);
      }
    }
  } catch {
    attachment.exportHint = 'metadata_only';
  }

  return attachment;
}

async function normalizeAttachments(rawAttachments, noteId, maxAttachments = 50) {
  if (!Array.isArray(rawAttachments)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  const cap = Math.max(1, Math.min(Number(maxAttachments) || 50, 500));

  for (let i = 0; i < rawAttachments.length && normalized.length < cap; i += 1) {
    const enriched = await enrichAttachment(rawAttachments[i], noteId, i);
    const dedupeKey = [enriched.scriptId || '', enriched.filePath || '', enriched.url || '', enriched.name || ''].join('|');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(enriched);
  }

  return normalized;
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

    // Sort by modification date (newest first)
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

  const script = `
    const notes = Application('Notes');
    const folders = notes.folders();
    let found = null;

    function valueFor(item, key) {
      try {
        if (!item) return null;
        const candidate = item[key];
        if (typeof candidate === 'function') {
          return candidate.call(item);
        }
        return candidate;
      } catch (e) {
        return null;
      }
    }

    function pushIfObject(target, raw, source) {
      if (!raw) return;

      const record = {
        source,
        scriptId: valueFor(raw, 'id'),
        name: valueFor(raw, 'name') || valueFor(raw, 'fileName') || valueFor(raw, 'filename'),
        url: valueFor(raw, 'url') || valueFor(raw, 'URL'),
        filePath: valueFor(raw, 'filePath') || valueFor(raw, 'path'),
        mimeType: valueFor(raw, 'mimeType') || valueFor(raw, 'contentType'),
        uti: valueFor(raw, 'uti') || valueFor(raw, 'uniformTypeIdentifier'),
        type: valueFor(raw, 'type') || valueFor(raw, 'kind'),
        size: valueFor(raw, 'size') || valueFor(raw, 'fileSize')
      };

      target.push(record);
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
      } catch (e) {
        // Best-effort only.
      }
    }

    function collectFromBody(body, output, limit) {
      try {
        const regex = /(?:src|href|data)=["']([^"']+)["']/gi;
        let match;

        while ((match = regex.exec(body)) && output.length < limit) {
          const url = match[1];
          output.push({
            source: 'body-html',
            url,
            filePath: (typeof url === 'string' && url.startsWith('file://')) ? decodeURIComponent(url.replace('file://', '')) : null,
            name: null,
            size: null,
            mimeType: null,
            uti: null,
            type: null,
            scriptId: null
          });
        }
      } catch (e) {
        // Best-effort only.
      }
    }

    for (let folder of folders) {
      if (found) break;
      try {
        const notesList = folder.notes();
        for (let note of notesList) {
          if (note.id() === "${escapeJXA(noteId)}") {
            // Get plain text by stripping HTML
            const body = note.body();
            const plaintext = note.plaintext();

            const attachments = [];
            if (${includeAttachments}) {
              const candidateMethods = ['attachments', 'mediaItems', 'objects', 'embeddedObjects', 'files'];
              for (let i = 0; i < candidateMethods.length && attachments.length < ${maxAttachments}; i += 1) {
                collectFromMethod(note, candidateMethods[i], attachments, ${maxAttachments});
              }
              if (attachments.length < ${maxAttachments}) {
                collectFromBody(body || '', attachments, ${maxAttachments});
              }
            }

            found = {
              id: note.id(),
              name: note.name(),
              body: body,
              plaintext: plaintext,
              creationDate: note.creationDate().toISOString(),
              modificationDate: note.modificationDate().toISOString(),
              folder: folder.name(),
              attachments
            };
            break;
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
    }
    return parsed;
  }

  const attachments = await normalizeAttachments(parsed.attachments || [], noteId, maxAttachments);
  return {
    ...parsed,
    attachments
  };
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

  await fs.mkdir(ATTACHMENT_EXPORT_ROOT, { recursive: true });

  const baseName = sanitizeFileName(attachment.name || path.basename(sourcePath) || `attachment-${attachmentId}`);
  const targetPath = path.join(ATTACHMENT_EXPORT_ROOT, `${Date.now()}-${baseName}`);

  await fs.copyFile(sourcePath, targetPath);
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
  // Notes uses HTML body, but we can pass plain text
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
