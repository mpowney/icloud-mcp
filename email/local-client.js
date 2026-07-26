/**
 * Local Email Client
 * Accesses Mail.app via AppleScript
 */

const { simpleParser } = require('mailparser');
const { runAppleScript, runJXA, escapeAppleScript, escapeJXA } = require('../utils/applescript');
const config = require('../config');

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

async function getMessageSource(emailId) {
  const script = `
    const mail = Application('Mail');
    const msg = mail.messages.byId(${emailId});
    JSON.stringify({
      id: msg.id(),
      source: msg.source()
    });
  `;

  const result = await runJXA(script);
  const parsed = result ? JSON.parse(result) : null;
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
async function readEmail(emailId) {
  const script = `
    const mail = Application('Mail');
    const msg = mail.messages.byId(${emailId});

    JSON.stringify({
      id: msg.id(),
      subject: msg.subject(),
      from: msg.sender(),
      to: msg.toRecipients().map(r => r.address()),
      cc: msg.ccRecipients().map(r => r.address()),
      date: msg.dateReceived().toISOString(),
      body: msg.content(),
      read: msg.readStatus()
    });
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : null;
}

/**
 * Read an email attachment as MCP resource content.
 * @param {string} emailId - Mail message ID
 * @param {string} selector - Attachment filename or 1-based index
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Resource content payload
 */
async function readAttachmentResource(emailId, selector, options = {}) {
  const source = await getMessageSource(emailId);
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
async function sendEmail({ to, cc, bcc, subject, body }) {
  const toRecipients = Array.isArray(to) ? to : [to];
  const ccRecipients = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const bccRecipients = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];

  let script = `
    tell application "Mail"
      set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(subject)}", content:"${escapeAppleScript(body)}", visible:false}
      tell newMessage
  `;

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
  sendEmail,
  searchEmails,
  markAsRead,
  listFolders,
  deleteEmail,
  readAttachmentResource
};
