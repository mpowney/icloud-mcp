/**
 * IMAP client wrapper for iCloud Mail (via ImapFlow)
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const config = require('../config');
const { getCredentials } = require('../auth');

/**
 * Create ImapFlow client
 */
function createClient() {
  const creds = getCredentials();

  return new ImapFlow({
    host: config.IMAP.HOST,
    port: config.IMAP.PORT,
    secure: config.IMAP.TLS,
    auth: {
      user: creds.email,
      pass: creds.password
    },
    logger: false,
    connectionTimeout: config.IMAP.CONN_TIMEOUT,
    greetingTimeout: config.IMAP.AUTH_TIMEOUT
  });
}

function isAuthError(err) {
  const message = err?.responseText || err?.message || '';
  return (
    err?.authenticationFailed === true ||
    message.includes('AUTHENTICATIONFAILED') ||
    message.includes('Invalid credentials')
  );
}

/**
 * Run an operation with connect + mailbox lock
 */
async function withMailbox(folder, readOnly, operation) {
  const client = createClient();

  try {
    await client.connect();
  } catch (err) {
    if (isAuthError(err)) {
      throw new Error('UNAUTHORIZED');
    }
    throw err;
  }

  try {
    const folderName = getFolderName(folder);
    const lock = await client.getMailboxLock(folderName, { readOnly });

    try {
      return await operation(client);
    } finally {
      lock.release();
    }
  } finally {
    if (client.usable) {
      await client.logout();
    }
  }
}

/**
 * Format envelope address list for display
 */
function formatAddresses(addresses) {
  if (!addresses?.length) {
    return '';
  }

  return addresses
    .map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address))
    .join(', ');
}

function mapListMessage(message) {
  return {
    uid: message.uid,
    seqno: message.seq,
    from: formatAddresses(message.envelope?.from),
    to: formatAddresses(message.envelope?.to),
    subject: message.envelope?.subject || '(No subject)',
    date: message.envelope?.date || '',
    flags: message.flags ? Array.from(message.flags) : []
  };
}

function selectAttachment(attachments, selector) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  if (typeof selector === 'string' && /^\d+$/.test(selector)) {
    const oneBasedIndex = Number(selector);
    if (!Number.isNaN(oneBasedIndex) && oneBasedIndex > 0 && oneBasedIndex <= attachments.length) {
      return attachments[oneBasedIndex - 1];
    }
  }

  if (typeof selector === 'string' && selector.trim()) {
    const wanted = selector.trim().toLowerCase();
    const byName = attachments.find((item) => (item.filename || '').toLowerCase() === wanted);
    if (byName) return byName;
  }

  return attachments[0];
}

function isLikelyText(buffer, mimeType) {
  if ((mimeType || '').startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'application/xml') return true;
  return !buffer.includes(0);
}

/**
 * Build ImapFlow search query from tool criteria
 */
function buildSearchQuery(criteria) {
  const query = {};

  if (criteria.from) {
    query.from = criteria.from;
  }
  if (criteria.subject) {
    query.subject = criteria.subject;
  }
  if (criteria.since) {
    query.since = new Date(criteria.since);
  }
  if (criteria.before) {
    query.before = new Date(criteria.before);
  }
  if (criteria.unseen) {
    query.seen = false;
  }
  if (criteria.text) {
    query.body = criteria.text;
  }

  return Object.keys(query).length > 0 ? query : { all: true };
}

/**
 * Get folder name from user-friendly name
 */
function getFolderName(folder) {
  const lower = (folder || 'inbox').toLowerCase();
  return config.EMAIL_FOLDERS[lower] || folder;
}

/**
 * List emails from a folder
 */
async function listEmails(folder = 'inbox', count = 25) {
  return withMailbox(folder, true, async (client) => {
    const total = client.mailbox.exists;
    if (!total) {
      return [];
    }

    const start = Math.max(1, total - count + 1);
    const emails = [];

    for await (const message of client.fetch(`${start}:*`, {
      envelope: true,
      flags: true,
      uid: true
    })) {
      emails.push(mapListMessage(message));
    }

    emails.sort((a, b) => new Date(b.date) - new Date(a.date));
    return emails;
  });
}

/**
 * Read full email content
 */
async function readEmail(uid, folder = 'inbox') {
  return withMailbox(folder, true, async (client) => {
    const message = await client.fetchOne(uid, { source: true }, { uid: true });

    if (!message?.source) {
      throw new Error(`Message not found: ${uid}`);
    }

    const parsed = await simpleParser(message.source);

    return {
      uid,
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      subject: parsed.subject || '(No subject)',
      date: parsed.date,
      text: parsed.text || '',
      html: parsed.html || '',
      attachments: (parsed.attachments || []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size
      }))
    };
  });
}

/**
 * Search emails
 */
async function searchEmails(criteria, folder = 'inbox', count = 25) {
  return withMailbox(folder, true, async (client) => {
    const query = buildSearchQuery(criteria);
    const uids = await client.search(query, { uid: true });

    if (!uids?.length) {
      return [];
    }

    const recentUids = uids.slice(-count);
    const emails = [];

    for await (const message of client.fetch(recentUids, {
      envelope: true,
      flags: true,
      uid: true
    }, { uid: true })) {
      emails.push(mapListMessage(message));
    }

    emails.sort((a, b) => new Date(b.date) - new Date(a.date));
    return emails;
  });
}

/**
 * Mark email as read/unread
 */
async function markAsRead(uid, folder = 'inbox', isRead = true) {
  return withMailbox(folder, false, async (client) => {
    if (isRead) {
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
    }
    return true;
  });
}

/**
 * List folders
 */
async function listFolders() {
  const client = createClient();

  try {
    await client.connect();
  } catch (err) {
    if (isAuthError(err)) {
      throw new Error('UNAUTHORIZED');
    }
    throw err;
  }

  try {
    const folders = [];
    const mailboxes = await client.list();

    for (const mailbox of mailboxes) {
      folders.push({
        name: mailbox.path,
        delimiter: mailbox.delimiter,
        flags: mailbox.flags ? Array.from(mailbox.flags) : []
      });
    }

    return folders;
  } finally {
    if (client.usable) {
      await client.logout();
    }
  }
}

async function readAttachmentResource(messageId, selector, options = {}) {
  const uid = Number(messageId);
  if (Number.isNaN(uid) || uid <= 0) {
    throw new Error('For IMAP mode, message-id in mail-attachment URI must be a numeric UID.');
  }

  const primaryFolder = options.folderHint || 'inbox';
  const folderCandidates = [
    primaryFolder,
    'inbox',
    'sent',
    'archive',
    'drafts',
    'trash',
    'junk'
  ].filter((value, index, arr) => value && arr.indexOf(value) === index);

  let parsed = null;
  let resolvedFolder = null;

  for (const folder of folderCandidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      parsed = await withMailbox(folder, true, async (client) => {
        const message = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!message?.source) return null;
        return simpleParser(message.source);
      });
      if (parsed) {
        resolvedFolder = folder;
        break;
      }
    } catch {
      // Ignore folder misses and continue trying candidates.
    }
  }

  if (!parsed) {
    throw new Error(`Message not found: ${uid}`);
  }

  const attachments = parsed.attachments || [];
  if (attachments.length === 0) {
    throw new Error('Message has no attachments');
  }

  const selected = selectAttachment(attachments, selector);
  if (!selected) {
    throw new Error('Attachment not found');
  }

  const mimeType = selected.contentType || 'application/octet-stream';
  const content = selected.content || Buffer.alloc(0);
  const safeUid = encodeURIComponent(String(uid));
  const safeSelector = encodeURIComponent(String(selector || selected.filename || 1));
  const uri = `mail-attachment://${safeUid}/${safeSelector}`;
  const base = {
    uri,
    mimeType,
    folder: resolvedFolder
  };

  if (isLikelyText(content, mimeType)) {
    return {
      ...base,
      text: content.toString('utf8')
    };
  }

  return {
    ...base,
    blob: content.toString('base64')
  };
}

module.exports = {
  listEmails,
  readEmail,
  searchEmails,
  markAsRead,
  listFolders,
  getFolderName,
  readAttachmentResource
};
