/**
 * Local Email Client
 * Accesses Mail.app via AppleScript
 */

const { simpleParser } = require('mailparser');
const { runAppleScript, runJXA, escapeAppleScript, escapeJXA } = require('../utils/applescript');
const config = require('../config');

const NAMED_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

function decodeHtmlEntities(input) {
  if (!input) return '';

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    const lowered = entity.toLowerCase();

    if (lowered[0] === '#') {
      const isHex = lowered[1] === 'x';
      const codePoint = Number.parseInt(isHex ? lowered.slice(2) : lowered.slice(1), isHex ? 16 : 10);
      if (!Number.isNaN(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }

    return NAMED_HTML_ENTITIES[lowered] || match;
  });
}

function stripHtmlToPlainText(html) {
  if (html === undefined || html === null) return '';

  let text = String(html);

  // Remove non-content sections first so they do not pollute output.
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Preserve structure from common block elements before stripping tags.
  text = text.replace(/<\s*br\s*\/?>/gi, '\n');
  text = text.replace(/<\s*\/\s*(p|div|section|article|header|footer|aside|h[1-6]|pre|blockquote|tr|table|ul|ol)\s*>/gi, '\n');
  text = text.replace(/<\s*li\b[^>]*>/gi, '\n- ');

  // Drop all remaining tags.
  text = text.replace(/<[^>]+>/g, '');

  text = decodeHtmlEntities(text);

  // Normalize whitespace and emit CRLF line endings.
  text = text.replace(/\r\n|\r|\n/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text.replace(/\n/g, '\r\n');
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

async function fetchMessageById(emailId, folder = 'inbox') {
  const mailboxName = getMailboxName(folder);
  const script = `
    const mail = Application('Mail');
    const targetId = '${escapeJXA(String(emailId))}';
    const preferredMailbox = '${escapeJXA(String(mailboxName || ''))}';
    let found = null;

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function findInMessages(messages) {
      const list = asArray(messages);
      for (let i = 0; i < list.length; i += 1) {
        const msg = list[i];
        try {
          if (String(msg.id()) === targetId) {
            return msg;
          }
        } catch (e) {}
      }
      return null;
    }

    function serialize(msg) {
      return {
        id: msg.id(),
        subject: msg.subject(),
        from: msg.sender(),
        to: msg.toRecipients().map((r) => r.address()),
        cc: msg.ccRecipients().map((r) => r.address()),
        date: msg.dateReceived().toISOString(),
        body: msg.content(),
        source: msg.source(),
        read: msg.readStatus()
      };
    }

    const accounts = asArray(mail.accounts());
    for (let a = 0; a < accounts.length && !found; a += 1) {
      const account = accounts[a];
      try {
        if (preferredMailbox) {
          const mailbox = account.mailboxes.byName(preferredMailbox);
          found = findInMessages(mailbox.messages());
        }
      } catch (e) {}
    }

    if (!found) {
      try {
        found = findInMessages(mail.messages());
      } catch (e) {}
    }

    JSON.stringify(found ? serialize(found) : null);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : null;
}

async function getMessageSource(emailId, folder = 'inbox') {
  const parsed = await fetchMessageById(emailId, folder);
  return parsed?.source || null;
}

/**
 * List emails from a mailbox
 * @param {string} folder - Folder name (inbox, sent, drafts, etc.)
 * @param {number} count - Number of emails to retrieve
 * @returns {Promise<Array>} - List of emails
 */
async function listEmails(folder = 'inbox', count = 25) {
  const mailboxName = getMailboxName(folder);

  const script = `
    ObjC.import('Foundation');
    const mail = Application('Mail');
    const accounts = mail.accounts();
    let emails = [];

    for (let account of accounts) {
      try {
        const mailbox = account.mailboxes.byName('${escapeJXA(mailboxName)}');
        const messages = mailbox.messages();
        const limit = Math.min(${count}, messages.length);

        for (let i = 0; i < limit; i++) {
          const msg = messages[i];
          emails.push({
            id: msg.id(),
            subject: msg.subject(),
            from: msg.sender(),
            date: msg.dateReceived().toISOString(),
            read: msg.readStatus(),
            account: account.name()
          });
        }
      } catch (e) {
        // Mailbox might not exist in this account
      }
    }

    JSON.stringify(emails.slice(0, ${count}));
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Read a specific email
 * @param {string} emailId - Email ID
 * @returns {Promise<Object>} - Email content
 */
async function readEmail(emailId, folder = 'inbox') {
  const parsed = await fetchMessageById(emailId, folder);
  if (!parsed) return null;

  let attachments = [];
  let textBody = '';

  try {
    if (parsed.source) {
      const mime = await simpleParser(parsed.source);
      textBody = mime.text || '';
      attachments = (mime.attachments || []).map((item) => ({
        filename: item.filename || null,
        contentType: item.contentType || 'application/octet-stream',
        size: item.size || 0
      }));
    }
  } catch {
    // Fall back to AppleScript content only when MIME parsing fails.
  }

  return {
    ...parsed,
    text: textBody || parsed.body || '',
    attachments
  };
}

/**
 * Read an email attachment as MCP resource content.
 * @param {string} emailId - Mail message ID
 * @param {string} selector - Attachment filename or 1-based index
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Resource content payload
 */
async function readAttachmentResource(emailId, selector, options = {}) {
  const source = await getMessageSource(emailId, options.folderHint || 'inbox');
  if (!source) {
    throw new Error(`Message not found: ${emailId}`);
  }

  const parsed = await simpleParser(source);
  const attachments = parsed.attachments || [];
  if (attachments.length === 0) {
    throw new Error('Message has no attachments');
  }

  const selected = selectAttachment(attachments, selector);
  if (!selected) {
    throw new Error('Attachment not found');
  }

  const filename = selected.filename || `attachment-${selector || 1}`;
  const mimeType = selected.contentType || 'application/octet-stream';
  const safeId = encodeURIComponent(String(emailId));
  const safeSelector = encodeURIComponent(String(selector || filename));
  const uri = `mail-attachment://${safeId}/${safeSelector}`;
  const content = selected.content || Buffer.alloc(0);

  if (isLikelyText(content, mimeType)) {
    return {
      uri,
      mimeType,
      text: content.toString('utf8')
    };
  }

  return {
    uri,
    mimeType,
    blob: content.toString('base64')
  };
}

/**
 * Send an email
 * @param {Object} options - Email options
 * @returns {Promise<Object>} - Send result
 */
async function sendEmail({ to, cc, bcc, subject, body, isHtml = false  }) {
  const toRecipients = Array.isArray(to) ? to : [to];
  const ccRecipients = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const bccRecipients = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];

  
  const plainTextBody = isHtml ? stripHtmlToPlainText(body) : body;

  let script = `
    tell application "Mail"
      set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(subject)}", content:"${escapeAppleScript(plainTextBody)}", visible:false}
      tell newMessage
  `;

  // Mail.app may deny setting HTML content directly via AppleScript (-1723).
  // Keep delivery reliable by always sending the plain-text content.

  // Add To recipients
  for (const recipient of toRecipients) {
    script += `\n        make new to recipient with properties {address:"${escapeAppleScript(recipient)}"}`;
  }

  // Add CC recipients
  for (const recipient of ccRecipients) {
    script += `\n        make new cc recipient with properties {address:"${escapeAppleScript(recipient)}"}`;
  }

  // Add BCC recipients
  for (const recipient of bccRecipients) {
    script += `\n        make new bcc recipient with properties {address:"${escapeAppleScript(recipient)}"}`;
  }

  script += `
        send
      end tell
    end tell
    return "sent"
  `;

  await runAppleScript(script);
  return { success: true, message: 'Email sent successfully' };
}

/**
 * Search emails
 * @param {Object} options - Search options
 * @returns {Promise<Array>} - Matching emails
 */
async function searchEmails({ query, from, subject, folder = 'inbox', count = 25 }) {
  const mailboxName = getMailboxName(folder);

  let conditions = [];
  if (query) conditions.push(`(msg.subject().toLowerCase().includes("${escapeJXA(query.toLowerCase())}") || msg.content().toLowerCase().includes("${escapeJXA(query.toLowerCase())}"))`);
  if (from) conditions.push(`msg.sender().toLowerCase().includes("${escapeJXA(from.toLowerCase())}")`);
  if (subject) conditions.push(`msg.subject().toLowerCase().includes("${escapeJXA(subject.toLowerCase())}")`);

  const filterCondition = conditions.length > 0 ? conditions.join(' && ') : 'true';

  const script = `
    const mail = Application('Mail');
    const accounts = mail.accounts();
    let emails = [];

    for (let account of accounts) {
      try {
        const mailbox = account.mailboxes.byName('${escapeJXA(mailboxName)}');
        const messages = mailbox.messages();

        for (let i = 0; i < messages.length && emails.length < ${count}; i++) {
          const msg = messages[i];
          if (${filterCondition}) {
            emails.push({
              id: msg.id(),
              subject: msg.subject(),
              from: msg.sender(),
              date: msg.dateReceived().toISOString(),
              read: msg.readStatus(),
              account: account.name()
            });
          }
        }
      } catch (e) {}
    }

    JSON.stringify(emails);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Mark email as read/unread
 * @param {string} emailId - Email ID
 * @param {boolean} isRead - Read status
 * @returns {Promise<Object>} - Result
 */
async function markAsRead(emailId, isRead = true) {
  const script = `
    tell application "Mail"
      set theMessage to message id ${emailId}
      set read status of theMessage to ${isRead}
    end tell
    return "done"
  `;

  await runAppleScript(script);
  return { success: true, message: `Email marked as ${isRead ? 'read' : 'unread'}` };
}

/**
 * List mail folders/mailboxes
 * @returns {Promise<Array>} - List of folders
 */
async function listFolders() {
  const script = `
    const mail = Application('Mail');
    const accounts = mail.accounts();
    let folders = [];

    for (let account of accounts) {
      const mailboxes = account.mailboxes();
      for (let mb of mailboxes) {
        folders.push({
          name: mb.name(),
          account: account.name(),
          unreadCount: mb.unreadCount()
        });
      }
    }

    JSON.stringify(folders);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Delete an email
 * @param {string} emailId - Email ID
 * @returns {Promise<Object>} - Result
 */
async function deleteEmail(emailId) {
  const script = `
    tell application "Mail"
      set theMessage to message id ${emailId}
      delete theMessage
    end tell
    return "deleted"
  `;

  await runAppleScript(script);
  return { success: true, message: 'Email deleted' };
}

/**
 * Map folder names to Mail.app mailbox names
 */
function getMailboxName(folder) {
  const mapping = {
    'inbox': 'INBOX',
    'sent': 'Sent Messages',
    'drafts': 'Drafts',
    'trash': 'Deleted Messages',
    'archive': 'Archive',
    'junk': 'Junk'
  };
  return mapping[folder.toLowerCase()] || folder;
}

module.exports = {
  listEmails,
  readEmail,
  stripHtmlToPlainText,
  sendEmail,
  searchEmails,
  markAsRead,
  listFolders,
  deleteEmail,
  readAttachmentResource
};
