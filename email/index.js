/**
 * Email module for iCloud MCP
 * Provides email tools via IMAP/SMTP
 */

const config = require('../config');
const useLocal = config.USE_LOCAL_MODE && config.IS_MACOS;
const emailClient = useLocal ? require('./local-client') : require('./imap-client');
const { listEmails, readEmail, searchEmails, markAsRead, listFolders } = emailClient;
const { sendEmail } = useLocal ? require('./local-client') : require('./smtp-client');
const { formatSuccess, formatError, withErrorHandler } = require('../utils/error-handler');
const { formatDate, formatRelative } = require('../utils/date-utils');

const messageFolderHintStore = new Map();
const attachmentResourceStore = new Map();

function rememberMessageFolder(messageId, folder) {
  if (!messageId || !folder) return;
  messageFolderHintStore.set(String(messageId), String(folder));
}

function encodeMailAttachmentUri(messageId, selector) {
  return `mail-attachment://${encodeURIComponent(String(messageId))}/${encodeURIComponent(String(selector))}`;
}

function parseMailAttachmentUri(uri) {
  const prefix = 'mail-attachment://';
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) {
    return null;
  }

  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;

  const encodedMessageId = rest.slice(0, slash).trim();
  const encodedSelector = rest.slice(slash + 1).trim();
  if (!encodedMessageId || !encodedSelector) return null;

  try {
    return {
      messageId: decodeURIComponent(encodedMessageId),
      selector: decodeURIComponent(encodedSelector)
    };
  } catch {
    return null;
  }
}

function indexAttachmentsForResources(message, folder) {
  if (!message) return;

  const messageId = String(message.uid || message.id || '');
  if (!messageId) return;

  if (folder) {
    rememberMessageFolder(messageId, folder);
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (let i = 0; i < attachments.length; i += 1) {
    const attachment = attachments[i] || {};
    const attachmentNumber = String(i + 1);
    const filename = attachment.filename || null;
    const mimeType = attachment.contentType || 'application/octet-stream';
    const selectors = filename ? [attachmentNumber, filename] : [attachmentNumber];

    for (const selector of selectors) {
      const uri = encodeMailAttachmentUri(messageId, selector);
      attachmentResourceStore.set(uri, {
        uri,
        messageId,
        selector,
        filename,
        mimeType,
        folder: folder || null
      });
    }
  }
}

function buildAttachmentResourceRefs(message) {
  const messageId = String(message?.uid || message?.id || '');
  if (!messageId) return [];

  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const rows = [];

  for (let i = 0; i < attachments.length; i += 1) {
    const attachment = attachments[i] || {};
    const attachmentNumber = String(i + 1);
    const filename = attachment.filename || null;

    rows.push({
      index: attachmentNumber,
      filename,
      byIndexUri: encodeMailAttachmentUri(messageId, attachmentNumber),
      byFilenameUri: filename ? encodeMailAttachmentUri(messageId, filename) : null,
      contentType: attachment.contentType || 'application/octet-stream',
      size: attachment.size || 0
    });
  }

  return rows;
}

/**
 * Handler: List emails
 */
async function handleListEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);

  const emails = await listEmails(folder, count);
  for (const email of emails) {
    rememberMessageFolder(email.uid || email.id, folder);
  }

  if (emails.length === 0) {
    return formatSuccess(`No emails found in ${folder}.`);
  }

  const lines = emails.map((email, i) => {
    const unread = email.flags ? !email.flags.includes('\\Seen') : !email.read;
    const date = formatRelative(new Date(email.date));
    const id = email.uid || email.id;
    return `${i + 1}. ${unread ? '[UNREAD] ' : ''}${email.subject}\n   From: ${email.from}\n   Date: ${date}\n   UID: ${id}`;
  });

  return formatSuccess(`Emails in ${folder} (${emails.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Read email
 */
async function handleReadEmail(args) {
  if (!args.uid) {
    return formatError(new Error('Email UID is required'));
  }

  const folder = args.folder || 'inbox';
  const email = await readEmail(args.uid, folder);
  indexAttachmentsForResources(email, folder);

  let body = email.text || email.body || '';
  if (body.length > config.DEFAULTS.EMAIL_BODY_MAX_LENGTH) {
    body = body.substring(0, config.DEFAULTS.EMAIL_BODY_MAX_LENGTH) + '\n... (truncated)';
  }

  const attachments = email.attachments || [];
  const attachmentRefs = buildAttachmentResourceRefs(email);
  const attachmentInfo = attachments.length > 0
    ? `\n\nAttachments (${attachments.length}):\n${attachmentRefs.map((a) => {
      const displayName = a.filename || `attachment-${a.index}`;
      const sizeKb = Math.round((a.size || 0) / 1024);
      const byFilename = a.byFilenameUri ? `\n  URI (filename): ${a.byFilenameUri}` : '';
      return `- ${displayName} (${a.contentType}, ${sizeKb}KB)\n  URI (index): ${a.byIndexUri}${byFilename}`;
    }).join('\n')}`
    : '';

  return formatSuccess(
    `Subject: ${email.subject}
From: ${email.from}
To: ${email.to}${email.cc ? `\nCC: ${email.cc}` : ''}
Date: ${formatDate(email.date)}
UID: ${email.uid || email.id}

---

${body}${attachmentInfo}`
  );
}

/**
 * Handler: Send email
 */
async function handleSendEmail(args) {
  if (!args.to) {
    return formatError(new Error('Recipient (to) is required'));
  }
  if (!args.subject) {
    return formatError(new Error('Subject is required'));
  }
  if (!args.body) {
    return formatError(new Error('Body is required'));
  }

  const result = await sendEmail({
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    isHtml: args.isHtml || false
  });

  if (result.success) {
    return formatSuccess(
      `Email sent successfully!\n\nTo: ${args.to}${args.cc ? `\nCC: ${args.cc}` : ''}\nSubject: ${args.subject}\nMessage ID: ${result.messageId}`
    );
  } else {
    return formatError(new Error('Failed to send email'));
  }
}

/**
 * Handler: Search emails
 */
async function handleSearchEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);

  const criteria = {};
  if (args.from) criteria.from = args.from;
  if (args.subject) criteria.subject = args.subject;
  if (args.query) criteria.text = args.query;
  if (args.unreadOnly) criteria.unseen = true;

  const emails = await searchEmails(criteria, folder, count);
  for (const email of emails) {
    rememberMessageFolder(email.uid || email.id, folder);
  }

  if (emails.length === 0) {
    return formatSuccess(`No emails found matching your search criteria in ${folder}.`);
  }

  const lines = emails.map((email, i) => {
    const unread = email.flags ? !email.flags.includes('\\Seen') : !email.read;
    const date = formatRelative(new Date(email.date));
    const id = email.uid || email.id;
    return `${i + 1}. ${unread ? '[UNREAD] ' : ''}${email.subject}\n   From: ${email.from}\n   Date: ${date}\n   UID: ${id}`;
  });

  return formatSuccess(`Search results in ${folder} (${emails.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Mark as read
 */
async function handleMarkAsRead(args) {
  if (!args.uid) {
    return formatError(new Error('Email UID is required'));
  }

  const folder = args.folder || 'inbox';
  const isRead = args.isRead !== false;

  await markAsRead(args.uid, folder, isRead);

  return formatSuccess(`Email ${args.uid} marked as ${isRead ? 'read' : 'unread'}.`);
}

/**
 * Handler: List folders
 */
async function handleListFolders() {
  const folders = await listFolders();

  const lines = folders.map(f => `- ${f.name}`);

  return formatSuccess(`Email folders:\n\n${lines.join('\n')}`);
}

// Tool definitions
const emailTools = [
  {
    name: 'list-emails',
    description: 'Lists emails from a folder (default: inbox)',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Email folder (inbox, sent, drafts, trash, archive, junk)'
        },
        count: {
          type: 'number',
          description: 'Number of emails to retrieve (default: 25, max: 50)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleListEmails, 'list-emails')
  },
  {
    name: 'read-email',
    description: 'Reads the full content of an email by UID',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'The UID of the email to read'
        },
        folder: {
          type: 'string',
          description: 'Email folder (default: inbox)'
        }
      },
      required: ['uid']
    },
    handler: withErrorHandler(handleReadEmail, 'read-email')
  },
  {
    name: 'send-email',
    description: 'Composes and sends an email',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address(es), comma-separated'
        },
        cc: {
          type: 'string',
          description: 'CC recipient(s), comma-separated'
        },
        bcc: {
          type: 'string',
          description: 'BCC recipient(s), comma-separated'
        },
        subject: {
          type: 'string',
          description: 'Email subject'
        },
        body: {
          type: 'string',
          description: 'Email body content'
        },
        isHtml: {
          type: 'boolean',
          description: 'Whether the body is HTML (default: false)'
        }
      },
      required: ['to', 'subject', 'body']
    },
    handler: withErrorHandler(handleSendEmail, 'send-email')
  },
  {
    name: 'search-emails',
    description: 'Search for emails by criteria',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search in email content'
        },
        from: {
          type: 'string',
          description: 'Filter by sender'
        },
        subject: {
          type: 'string',
          description: 'Filter by subject'
        },
        folder: {
          type: 'string',
          description: 'Email folder to search (default: inbox)'
        },
        unreadOnly: {
          type: 'boolean',
          description: 'Only show unread emails'
        },
        count: {
          type: 'number',
          description: 'Max results (default: 25, max: 50)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleSearchEmails, 'search-emails')
  },
  {
    name: 'mark-as-read',
    description: 'Marks an email as read or unread',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'The UID of the email'
        },
        folder: {
          type: 'string',
          description: 'Email folder (default: inbox)'
        },
        isRead: {
          type: 'boolean',
          description: 'Mark as read (true) or unread (false). Default: true'
        }
      },
      required: ['uid']
    },
    handler: withErrorHandler(handleMarkAsRead, 'mark-as-read')
  },
  {
    name: 'list-folders',
    description: 'Lists all email folders',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: withErrorHandler(handleListFolders, 'list-folders')
  }
];

const emailResources = {
  async list() {
    return Array.from(attachmentResourceStore.values()).map((entry) => ({
      uri: entry.uri,
      name: entry.filename || `Attachment ${entry.selector}`,
      mimeType: entry.mimeType,
      description: `Mail attachment from message ${entry.messageId}`
    }));
  },

  async read(uri) {
    const parsed = parseMailAttachmentUri(uri);
    if (!parsed) return null;

    if (typeof emailClient.readAttachmentResource !== 'function') {
      throw new Error('Attachment resource reading is not supported by this email mode.');
    }

    const folderHint = messageFolderHintStore.get(String(parsed.messageId))
      || attachmentResourceStore.get(uri)?.folder
      || 'inbox';

    const content = await emailClient.readAttachmentResource(parsed.messageId, parsed.selector, { folderHint });

    // Keep resource discoverable after a direct read even if it was not pre-indexed.
    const existing = attachmentResourceStore.get(uri);
    if (!existing) {
      attachmentResourceStore.set(uri, {
        uri,
        messageId: parsed.messageId,
        selector: parsed.selector,
        filename: /^\d+$/.test(parsed.selector) ? null : parsed.selector,
        mimeType: content.mimeType || 'application/octet-stream',
        folder: folderHint
      });
    }

    return {
      uri,
      mimeType: content.mimeType || 'application/octet-stream',
      text: content.text,
      blob: content.blob
    };
  }
};

module.exports = {
  emailTools,
  emailResources,
  handleListEmails,
  handleReadEmail,
  handleSendEmail,
  handleSearchEmails,
  handleMarkAsRead,
  handleListFolders
};
