'use strict';

/**
 * ChatService — everything between the IPC surface and @bdxi/bchat-sdk.
 *
 * Responsibilities:
 *   - identity lifecycle (create / restore / reload from the 25-word phrase)
 *   - one BchatSDK instance wired with the real BChat wire protocol
 *   - a polling receive loop that routes incoming envelopes to conversations
 *   - JSON persistence of conversations + message history in userData
 *
 * The account file stores only the mnemonic: everything else (BChat ID,
 * wallet address, both keypairs) re-derives from it, exactly like the SDK's
 * own chat example.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CelarProtocolEncryption, packStructured } = require('./celar-protocol');

const NETWORK = 'mainnet';
const NAMESPACE = 0;
const POLL_INTERVAL_MS = 5000;
const MAX_MESSAGES_PER_CONVO = 2000;

const DEFAULT_SEEDS = [
  'https://publicnode1.rpcnode.stream/',
  'https://publicnode2.rpcnode.stream/',
  'https://publicnode3.rpcnode.stream/',
  'https://publicnode4.rpcnode.stream/',
  'https://publicnode5.rpcnode.stream/',
];

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * Message bodies and display names are attacker-chosen bytes. Written to the
 * DOM they are inert, but strip C0/C1 control characters anyway (keep tab and
 * newline) so logs, clipboard copies, and exports stay safe too.
 */
function sanitize(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    const isControl = (c < 32 && c !== 9 && c !== 10) || (c >= 127 && c <= 159);
    out += isControl ? REPLACEMENT_CHAR : ch;
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------ link previews

const PREVIEW_MAX_BYTES = 96 * 1024;

/** First http(s) URL in a message, ignoring code spans and blocks. */
function firstUrl(text) {
  const parts = String(text || '').split(/(```[\s\S]*?```|`[^`\n]*`)/);
  for (let i = 0; i < parts.length; i += 2) {
    const m = parts[i].match(/https?:\/\/[^\s<>"'`]+/);
    if (m) return m[0];
  }
  return null;
}

function decodeEntities(s) {
  const map = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, m => map[m]);
}

/** <meta property|name="key" content="…"> in either attribute order. */
function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1] : undefined;
}

const cleanMeta = (value, max) =>
  sanitize(decodeEntities(String(value || '').replace(/\s+/g, ' ').trim())).slice(0, max);

/**
 * Bound an image to a chat-thumbnail budget: ≤640px wide, JPEG, and small
 * enough (≤60KB) that the whole sealed message stays under the storage-node
 * size limit. Returns base64, or undefined if the bytes are not an image or
 * cannot be squeezed under budget.
 */
function imageToBoundedJpegB64(buffer) {
  try {
    const { nativeImage } = require('electron');
    let img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return undefined;
    if (img.getSize().width > 640) img = img.resize({ width: 640 });
    for (const quality of [80, 65, 50, 40]) {
      const jpeg = img.toJPEG(quality);
      if (jpeg.length <= 60 * 1024) return jpeg.toString('base64');
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Download the preview image (bounded), return a budgeted JPEG base64. */
async function fetchPreviewImage(imageUrl) {
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) return undefined;
      if (!(res.headers.get('content-type') || '').startsWith('image/')) return undefined;
      const chunks = [];
      let received = 0;
      const reader = res.body.getReader();
      while (received < 4 * 1024 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.byteLength;
      }
      controller.abort();
      return imageToBoundedJpegB64(Buffer.concat(chunks));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

/**
 * Sender-side link unfurl: fetch the page (bounded in time and size) and pull
 * title, description, site name, and a compressed og:image thumbnail. The
 * result travels inside the sealed payload so the receiver never fetches
 * anything — no metadata leak on read.
 */
async function fetchLinkPreview(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let html = '';
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'text/html' },
      });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html')) return null;

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let received = 0;
      while (received < PREVIEW_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (/<\/head[\s>]/i.test(html)) break; // all the meta tags live in <head>
      }
      controller.abort(); // drop the rest of the body
    } finally {
      clearTimeout(timer);
    }

    const title = cleanMeta(
      metaContent(html, 'og:title') ||
        metaContent(html, 'twitter:title') ||
        (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1],
      120
    );
    if (!title) return null;

    const preview = { url: url.toString(), title };

    const description = cleanMeta(
      metaContent(html, 'og:description') ||
        metaContent(html, 'twitter:description') ||
        metaContent(html, 'description'),
      200
    );
    if (description) preview.description = description;

    const siteName = cleanMeta(metaContent(html, 'og:site_name'), 48);
    if (siteName) preview.siteName = siteName;

    const imageSrc =
      metaContent(html, 'og:image') ||
      metaContent(html, 'og:image:url') ||
      metaContent(html, 'twitter:image');
    if (imageSrc) {
      try {
        const resolved = new URL(decodeEntities(imageSrc), url).toString();
        const imageB64 = await fetchPreviewImage(resolved);
        if (imageB64) preview.imageB64 = imageB64;
      } catch {
        /* bad image URL — text-only preview */
      }
    }

    return preview;
  } catch {
    return null;
  }
}

class ChatService {
  constructor() {
    this.sdkModule = null;
    this.sdkLoadError = null;
    this.identity = null;
    this.sdk = null;
    this.status = 'offline'; // offline | connecting | online | error
    this.poolSize = 0;
    this.polling = false;
    this.emit = () => {};
    this.store = { displayName: '', conversations: {}, messages: {}, settings: { autoUnfurl: false } };
    this.saveTimer = null;
  }

  // ------------------------------------------------------------- lifecycle

  init(userDataDir, emit) {
    this.emit = emit;
    this.accountFile = path.join(userDataDir, 'account.json');
    this.cacheDir = path.join(userDataDir, 'bchat-cache');
    this.storeFile = path.join(userDataDir, 'conversations.json');

    this.loadSdkModule();
    this.loadStore();
  }

  loadSdkModule() {
    if (this.sdkModule || this.sdkLoadError) return this.sdkModule;
    try {
      this.sdkModule = require('@bdxi/bchat-sdk');
    } catch (e) {
      this.sdkLoadError =
        'Could not load @bdxi/bchat-sdk. Build it first: `npm run build` inside ' +
        'the bchat-sdk folder, then `npm install` here. (' +
        (e && e.message ? e.message.split('\n')[0] : e) +
        ')';
    }
    return this.sdkModule;
  }

  shutdown() {
    this.polling = false;
    this.flushStore();
  }

  // -------------------------------------------------------------- identity

  hasIdentity() {
    return fs.existsSync(this.accountFile);
  }

  async loadIdentity() {
    if (this.identity) return this.identity;
    const mod = this.requireSdk();
    const parsed = JSON.parse(fs.readFileSync(this.accountFile, 'utf8'));
    if (!parsed || !parsed.mnemonic) {
      throw new Error('account.json has no recovery phrase — delete it and create a new identity.');
    }
    this.identity = await mod.identityFromMnemonic(parsed.mnemonic, NETWORK);
    return this.identity;
  }

  async createIdentity(opts = {}) {
    const mod = this.requireSdk();
    if (this.hasIdentity()) {
      throw new Error('An identity already exists on this machine.');
    }
    const identity = await mod.createIdentity(NETWORK);
    // 0600, refuses to overwrite existing key material.
    mod.writeSecretFile(this.accountFile, JSON.stringify({ mnemonic: identity.mnemonic }, null, 2) + '\n');
    this.identity = identity;
    if (opts.displayName) {
      this.store.displayName = sanitize(String(opts.displayName)).slice(0, 32);
      this.scheduleSave();
    }
    return this.publicIdentity(true);
  }

  async restoreIdentity(opts = {}) {
    const mod = this.requireSdk();
    const phrase = String(opts.mnemonic || '').trim().replace(/\s+/g, ' ');
    if (phrase.split(' ').length !== 25) {
      throw new Error('A recovery phrase is 25 words.');
    }
    const identity = await mod.identityFromMnemonic(phrase, NETWORK); // throws on a bad phrase
    if (fs.existsSync(this.accountFile)) fs.unlinkSync(this.accountFile);
    mod.writeSecretFile(this.accountFile, JSON.stringify({ mnemonic: identity.mnemonic }, null, 2) + '\n');
    this.identity = identity;
    if (opts.displayName) {
      this.store.displayName = sanitize(String(opts.displayName)).slice(0, 32);
      this.scheduleSave();
    }
    return this.publicIdentity(false);
  }

  revealMnemonic() {
    if (!this.hasIdentity()) throw new Error('No identity yet.');
    const parsed = JSON.parse(fs.readFileSync(this.accountFile, 'utf8'));
    return parsed.mnemonic;
  }

  publicIdentity(includeMnemonic) {
    if (!this.identity) return null;
    const out = {
      bchatId: this.identity.bchatId,
      walletAddress: this.identity.walletAddress,
    };
    if (includeMnemonic) out.mnemonic = this.identity.mnemonic;
    return out;
  }

  // ------------------------------------------------------------ connection

  requireSdk() {
    const mod = this.loadSdkModule();
    if (!mod) throw new Error(this.sdkLoadError);
    return mod;
  }

  async connect() {
    const mod = this.requireSdk();
    if (!this.hasIdentity()) throw new Error('Create or restore an identity first.');
    if (this.status === 'online' || this.status === 'connecting') {
      return { status: this.status, poolSize: this.poolSize };
    }

    const account = await this.loadIdentity();
    this.setStatus('connecting');

    try {
      // The real BChat wire protocol: protobuf Content → 160-byte padding →
      // sealed-sender signature → Envelope → WebSocketMessage. Interoperable
      // with the official BChat clients in both directions.
      const encryption = new CelarProtocolEncryption({
        ed25519: account.ed25519,
        beldexAddress: account.walletAddress,
        network: NETWORK,
        displayName: this.store.displayName || undefined,
      });

      this.sdk = new mod.BchatSDK({
        seedNodes: DEFAULT_SEEDS,
        account: { x25519: account.x25519, ed25519: account.ed25519 },
        persistence: new mod.FileStore(this.cacheDir),
        encryption,
        // Storage nodes serve self-signed certificates by design; seed node
        // certificates are still fully verified.
        allowSelfSignedStorageNodes: true,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      const pool = await this.sdk.refreshSnodePool();
      this.poolSize = pool.length;
      this.setStatus('online');
      this.startPolling();
      return { status: this.status, poolSize: this.poolSize };
    } catch (e) {
      this.sdk = null;
      this.setStatus('error', e && e.message ? e.message : String(e));
      throw e;
    }
  }

  setStatus(status, detail) {
    this.status = status;
    this.emit({ type: 'status', status, poolSize: this.poolSize, detail });
  }

  // --------------------------------------------------------------- polling

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop();
  }

  async pollLoop() {
    const account = this.identity;
    let failures = 0;
    while (this.polling && this.sdk) {
      try {
        const messages = await this.sdk.getMessages({
          // Must be the same string form senders address us by ('bd' + hex):
          // storage nodes key the mailbox on the pubKey *string*.
          pubKey: account.bchatId,
          namespace: NAMESPACE,
          ed25519PrivHex: account.ed25519.privateKey,
          ed25519PubHex: account.ed25519.publicKey,
        });
        for (const message of messages) this.routeIncoming(message);
        if (failures > 0 || this.status !== 'online') {
          failures = 0;
          this.setStatus('online');
        }
      } catch (e) {
        failures++;
        if (failures === 3) {
          this.setStatus('error', `receive failed: ${e && e.message ? e.message : e}`);
        }
      }
      await sleep(Math.min(POLL_INTERVAL_MS * Math.max(1, failures), 30000));
    }
  }

  /** Decide what an incoming envelope means and file it under a conversation. */
  routeIncoming(message) {
    if (!message || !message.decrypted || !message.sender) return; // foreign / undecryptable

    // Our own message, mirrored from another device: render as outgoing
    // in the conversation with its real recipient.
    if (message.syncTarget) {
      const peerId = String(message.syncTarget).toLowerCase();
      if (message.kind === 'message' && message.plaintext) {
        const convo = this.ensureConversation(peerId);
        this.appendMessage(convo.id, {
          direction: 'out',
          kind: 'text',
          text: sanitize(message.plaintext),
          at: message.sentAt || Date.now(),
          synced: true,
        });
      }
      return;
    }

    const peerId = String(message.sender).toLowerCase();
    const convo = this.ensureConversation(peerId);

    // A sender-chosen display name upgrades an unnamed conversation.
    const peerName = sanitize(message.displayName || '').slice(0, 32);
    if (peerName && convo.nameSource !== 'manual' && convo.nameSource !== 'bns' && convo.name !== peerName) {
      convo.name = peerName;
      convo.nameSource = 'peer';
      this.scheduleSave();
      this.emit({ type: 'conversations' });
    }

    const at = message.sentAt || Date.now();
    const system = text => this.appendMessage(convo.id, { direction: 'in', kind: 'system', text, at });

    switch (message.kind) {
      case 'message': {
        if (message.isExpirationTimerUpdate) {
          const secs = Number(message.expireTimer || 0);
          system(secs > 0 ? `set disappearing messages to ${secs}s` : 'turned off disappearing messages');
          return;
        }
        const record = {
          direction: 'in',
          kind: 'text',
          text: sanitize(message.plaintext || ''),
          at,
        };
        if (message.quote) {
          record.quote = {
            author: sanitize(String(message.quote.author || '')),
            text: sanitize(message.quote.text || '').slice(0, 120),
          };
        }
        if (Array.isArray(message.attachments) && message.attachments.length) {
          // A Celar inline attachment carries its bytes; official-client
          // attachments are pointer metadata only (not downloadable here).
          const inline = message.attachments.find(
            a => typeof a._celarDataB64 === 'string' && a._celarDataB64.length <= 160000
          );
          if (inline) {
            let contentType = sanitize(inline.contentType || 'application/octet-stream').slice(0, 64);
            let dataB64;
            if (contentType.startsWith('image/')) {
              // Re-encode through nativeImage: proves the bytes are an image.
              dataB64 = imageToBoundedJpegB64(Buffer.from(inline._celarDataB64, 'base64'));
              contentType = 'image/jpeg';
            } else {
              dataB64 = inline._celarDataB64;
            }
            if (dataB64) {
              record.attachment = {
                fileName: sanitize(inline.fileName || 'file').slice(0, 64) || 'file',
                contentType,
                size: Buffer.from(dataB64, 'base64').length,
                dataB64,
              };
            }
          }
          const pointers = message.attachments.filter(a => !a._celarDataB64);
          if (pointers.length) {
            record.attachments = pointers.map(a => ({
              kind: a.isVoiceMessage ? 'voice message' : sanitize(a.contentType || 'file'),
              fileName: sanitize(a.fileName || '').slice(0, 48),
              size: a.size,
            }));
          }
        }
        if (message.payment) {
          record.payment = {
            amount: sanitize(message.payment.amount || '?').slice(0, 32),
            txnId: sanitize(message.payment.txnId || '').slice(0, 16),
          };
        }
        if (Array.isArray(message.previews) && message.previews.length) {
          // Sender-generated preview. Only trust it if the URL it claims to
          // describe actually appears in the message body — otherwise a
          // sender could attach a preview pointing anywhere.
          const p = message.previews[0] || {};
          const url = String(p.url || '');
          if (/^https?:\/\//i.test(url) && record.text.includes(url)) {
            record.preview = this.cleanPreviewFields(p);
          }
        }
        if (!record.text && !record.attachment && !record.attachments && !record.payment) {
          record.text = '(empty message)';
          record.kind = 'system';
        }
        this.appendMessage(convo.id, record, { unread: true });
        // Opt-in auto-unfurl: fetch a preview for bare links on arrival.
        // Off by default — the fetch exposes this machine's IP to the site.
        if (!record.preview && this.store.settings.autoUnfurl && firstUrl(record.text)) {
          void this.unfurlIncoming(convo.id, record.id).catch(() => {});
        }
        return;
      }
      case 'reaction': {
        const reaction = message.reaction || {};
        const emoji = sanitize(reaction.emoji || '').slice(0, 8);
        if (!emoji) return;
        // Reactions target the original message's DataMessage timestamp.
        const target = (this.store.messages[convo.id] || []).find(
          m => m.kind === 'text' && m.at === Number(reaction.messageTimestamp)
        );
        if (target) {
          this.applyReaction(convo.id, target, {
            emoji,
            from: 'peer',
            action: reaction.action === 1 ? 1 : 0,
          });
        } else {
          system(reaction.action === 1 ? `removed reaction ${emoji}` : `reacted ${emoji} to an earlier message`);
        }
        return;
      }
      case 'unsend':
        system('deleted a message');
        return;
      case 'dataExtraction':
        system(message.dataExtraction && message.dataExtraction.type === 1 ? 'took a screenshot' : 'saved media');
        return;
      case 'messageRequestResponse':
        system(
          message.messageRequestResponse && message.messageRequestResponse.isApproved
            ? 'accepted your message request'
            : 'declined your message request'
        );
        return;
      case 'call':
        system('started a call (not supported)');
        return;
      // Low-signal chatter: not persisted.
      case 'typing':
      case 'receipt':
      case 'configuration':
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ send

  /** Renderer-facing wrapper so the composer can unfurl links live. */
  fetchPreview(url) {
    return fetchLinkPreview(String(url || ''));
  }

  /**
   * Normalize a preview from any source (composer, wire) to safe bounds.
   * The thumbnail is re-encoded through nativeImage, which both proves the
   * bytes are a real image and normalizes them to a bounded JPEG.
   */
  cleanPreviewFields(preview) {
    const out = {
      url: sanitize(String(preview.url || '')).slice(0, 500),
      title: sanitize(String(preview.title || '')).slice(0, 120),
    };
    const description = sanitize(String(preview.description || '')).slice(0, 200);
    if (description) out.description = description;
    const siteName = sanitize(String(preview.siteName || '')).slice(0, 48);
    if (siteName) out.siteName = siteName;
    if (typeof preview.imageB64 === 'string' && preview.imageB64.length <= 400000) {
      try {
        const imageB64 = imageToBoundedJpegB64(Buffer.from(preview.imageB64, 'base64'));
        if (imageB64) out.imageB64 = imageB64;
      } catch {
        /* not an image — drop it */
      }
    }
    return out;
  }

  async sendMessage(peerId, text, replyToId, preview) {
    if (!this.sdk) throw new Error('Not connected yet.');
    const body = String(text || '');
    if (!body.trim()) throw new Error('Nothing to send.');
    const convo = this.store.conversations[peerId];
    if (!convo) throw new Error('Unknown conversation.');

    // The DataMessage timestamp is set explicitly and reused as the record's
    // `at`, so a peer's reaction (which targets that timestamp) can be matched
    // back to this exact message later.
    const timestamp = Date.now();

    let quote;
    if (replyToId) {
      const target = (this.store.messages[peerId] || []).find(m => m.id === replyToId);
      if (target) {
        quote = {
          messageTimestamp: target.at,
          author: target.direction === 'out' ? this.identity.bchatId : peerId,
          text: (target.text || '').slice(0, 120),
        };
      }
    }

    // Optimistic send: the record is appended (and broadcast to the renderer)
    // immediately with status 'sending'; delivery happens in the background
    // and resolves to 'sent' or 'failed' via a message-updated event.
    const record = this.appendMessage(peerId, {
      direction: 'out',
      kind: 'text',
      text: body,
      at: timestamp,
      quote: quote ? { author: quote.author, text: quote.text } : undefined,
      quoteTs: quote ? quote.messageTimestamp : undefined,
      status: 'sending',
    });

    // The composer may have already unfurled the link (or the user dismissed
    // the card — preview === null means "send without a preview").
    if (preview === null) {
      record.previewOptOut = true;
    } else if (
      preview &&
      typeof preview.url === 'string' &&
      /^https?:\/\//i.test(preview.url) &&
      body.includes(preview.url)
    ) {
      record.preview = this.cleanPreviewFields(preview);
    }

    void this.deliver(peerId, record, quote);
    return record;
  }

  /** Background network delivery for an optimistic record. */
  async deliver(peerId, record, quote) {
    try {
      // Generate a link preview for the first URL, if any. Best effort — a
      // slow or dead site must not delay the message beyond its own fetch cap.
      if (!record.preview && !record.previewOptOut) {
        const url = firstUrl(record.text);
        if (url) {
          const preview = await fetchLinkPreview(url);
          if (preview) record.preview = preview;
        }
      }

      const result = await this.sdk.sendMessage({
        recipientPubKey: peerId,
        payload: packStructured({
          timestamp: record.at,
          body: record.text,
          quote,
          preview: record.preview,
          attachment: record.attachment
            ? {
                fileName: record.attachment.fileName,
                contentType: record.attachment.contentType,
                dataB64: record.attachment.dataB64,
              }
            : undefined,
        }),
        namespace: NAMESPACE,
        timestampMs: record.at,
      });
      record.status = 'sent';
      record.hash = typeof result === 'string' ? result.slice(0, 12) : undefined;
      delete record.error;
    } catch (e) {
      record.status = 'failed';
      record.error = String((e && e.message) || e).slice(0, 200);
    }
    this.scheduleSave();
    this.emit({ type: 'message-updated', peerId, record });
  }

  /** Re-attempt delivery of a failed message. */
  retrySend(peerId, messageId) {
    if (!this.sdk) throw new Error('Not connected yet.');
    const record = (this.store.messages[peerId] || []).find(m => m.id === messageId);
    if (!record) throw new Error('Message not found.');
    if (record.status !== 'failed') return record;

    record.status = 'sending';
    delete record.error;
    this.scheduleSave();
    this.emit({ type: 'message-updated', peerId, record });

    const quote = record.quote
      ? { messageTimestamp: record.quoteTs, author: record.quote.author, text: record.quote.text }
      : undefined;
    void this.deliver(peerId, record, quote);
    return record;
  }

  /** Toggle our reaction on a message and notify the peer. */
  async react(peerId, messageId, emoji) {
    if (!this.sdk) throw new Error('Not connected yet.');
    const list = this.store.messages[peerId] || [];
    const target = list.find(m => m.id === messageId);
    if (!target) throw new Error('Message not found.');

    const existing = (target.reactions || []).some(r => r.from === 'you' && r.emoji === emoji);
    const action = existing ? 1 : 0; // 0 = react, 1 = remove

    const timestamp = Date.now();
    await this.sdk.sendMessage({
      recipientPubKey: peerId,
      payload: packStructured({
        timestamp,
        reaction: {
          messageTimestamp: target.at,
          author: target.direction === 'out' ? this.identity.bchatId : peerId,
          emoji,
          action,
        },
      }),
      namespace: NAMESPACE,
      timestampMs: timestamp,
    });

    this.applyReaction(peerId, target, { emoji, from: 'you', action });
    return target;
  }

  /**
   * Send a file inline. Images are recompressed to fit one sealed message;
   * anything else must already be small (the storage nodes cap message size).
   */
  async sendAttachment(peerId, file, caption) {
    if (!this.sdk) throw new Error('Not connected yet.');
    const convo = this.store.conversations[peerId];
    if (!convo) throw new Error('Unknown conversation.');

    const fileName = sanitize(String((file && file.name) || 'file')).slice(0, 64) || 'file';
    let contentType = String((file && file.type) || 'application/octet-stream').slice(0, 64);
    const buffer = Buffer.from(String((file && file.dataB64) || ''), 'base64');
    if (!buffer.length) throw new Error('Empty file.');

    let dataB64;
    if (contentType.startsWith('image/')) {
      dataB64 = imageToBoundedJpegB64(buffer);
      if (!dataB64) throw new Error('Could not read that image.');
      contentType = 'image/jpeg';
    } else {
      if (buffer.length > 45 * 1024) {
        throw new Error('Non-image files are limited to 45 KB (images are compressed automatically).');
      }
      dataB64 = buffer.toString('base64');
    }

    const timestamp = Date.now();
    const record = this.appendMessage(peerId, {
      direction: 'out',
      kind: 'text',
      text: sanitize(String(caption || '')),
      at: timestamp,
      status: 'sending',
      attachment: {
        fileName,
        contentType,
        size: Buffer.from(dataB64, 'base64').length,
        dataB64,
      },
    });

    void this.deliver(peerId, record, undefined);
    return { id: record.id, at: record.at };
  }

  /** Raw bytes of a stored attachment, for the save dialog. */
  getAttachmentData(peerId, messageId) {
    const record = (this.store.messages[peerId] || []).find(m => m.id === messageId);
    if (!record || !record.attachment || !record.attachment.dataB64) {
      throw new Error('Attachment not found.');
    }
    return { fileName: record.attachment.fileName || 'file', dataB64: record.attachment.dataB64 };
  }

  /**
   * Receiver-side unfurl for an incoming message that arrived without an
   * embedded preview. Explicitly user-triggered (or opted into via the
   * auto-unfurl setting) because the fetch reveals this machine's IP to the
   * linked site.
   */
  async unfurlIncoming(peerId, messageId) {
    const record = (this.store.messages[peerId] || []).find(m => m.id === messageId);
    if (!record) throw new Error('Message not found.');
    if (record.preview || record.previewLoading) return record;
    const url = firstUrl(record.text);
    if (!url) return record;

    record.previewLoading = true;
    this.emit({ type: 'message-updated', peerId, record });
    try {
      const preview = await fetchLinkPreview(url);
      delete record.previewLoading;
      if (preview) record.preview = this.cleanPreviewFields(preview);
      else record.previewNone = true; // nothing to show; stop offering the button
    } catch {
      delete record.previewLoading;
      record.previewNone = true;
    }
    this.scheduleSave();
    this.emit({ type: 'message-updated', peerId, record });
    return record;
  }

  /** Add or remove a reaction on a record and broadcast the update. */
  applyReaction(peerId, record, { emoji, from, action }) {
    record.reactions = (record.reactions || []).filter(r => !(r.from === from && r.emoji === emoji));
    if (action === 0) record.reactions.push({ emoji, from });
    if (!record.reactions.length) delete record.reactions;
    this.scheduleSave();
    this.emit({ type: 'message-updated', peerId, record });
  }

  // --------------------------------------------------------- conversations

  canonicalPeerId(value) {
    const mod = this.requireSdk();
    const trimmed = String(value || '').trim().toLowerCase();
    const bare = mod.normalizeX25519Hex(trimmed, 'BChat ID').toString('hex');
    // Incoming senders always surface as 'bd' + 64 hex, so canonicalize the
    // same way — otherwise one peer splits into two conversations.
    return trimmed.startsWith('05') ? trimmed : `bd${bare}`;
  }

  async addConversation(input) {
    const mod = this.requireSdk();
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Enter a BChat ID or BNS name.');

    let id;
    let name = '';
    let nameSource;
    if (mod.isBnsName(raw)) {
      if (!this.sdk) throw new Error('Connect to the network first — BNS names need a lookup.');
      const bns = mod.normalizeBnsName(raw);
      id = (await this.sdk.resolveBnsName(bns)).toLowerCase();
      name = bns;
      nameSource = 'bns';
    } else {
      id = this.canonicalPeerId(raw);
    }

    if (this.identity && id === this.identity.bchatId) {
      throw new Error('That is your own BChat ID.');
    }

    const convo = this.ensureConversation(id, { name, nameSource });
    return this.conversationSummary(convo);
  }

  removeConversation(peerId) {
    delete this.store.conversations[peerId];
    delete this.store.messages[peerId];
    this.scheduleSave();
    this.emit({ type: 'conversations' });
    return true;
  }

  ensureConversation(peerId, opts = {}) {
    let convo = this.store.conversations[peerId];
    if (!convo) {
      convo = {
        id: peerId,
        name: opts.name || '',
        nameSource: opts.nameSource,
        addedAt: Date.now(),
        unread: 0,
      };
      this.store.conversations[peerId] = convo;
      this.store.messages[peerId] = this.store.messages[peerId] || [];
      this.scheduleSave();
      this.emit({ type: 'conversations' });
    } else if (opts.name && !convo.name) {
      convo.name = opts.name;
      convo.nameSource = opts.nameSource;
      this.scheduleSave();
      this.emit({ type: 'conversations' });
    }
    return convo;
  }

  appendMessage(peerId, record, opts = {}) {
    const list = (this.store.messages[peerId] = this.store.messages[peerId] || []);
    record.id = `${record.at || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    list.push(record);
    if (list.length > MAX_MESSAGES_PER_CONVO) list.splice(0, list.length - MAX_MESSAGES_PER_CONVO);

    const convo = this.store.conversations[peerId];
    if (convo && opts.unread) convo.unread = (convo.unread || 0) + 1;
    this.scheduleSave();
    this.emit({ type: 'message', peerId, record, conversation: convo ? this.conversationSummary(convo) : null });
    return record;
  }

  listMessages(peerId) {
    const convo = this.store.conversations[peerId];
    if (convo && convo.unread) {
      convo.unread = 0;
      this.scheduleSave();
      this.emit({ type: 'conversations' });
    }
    return this.store.messages[peerId] || [];
  }

  conversationSummary(convo) {
    const list = this.store.messages[convo.id] || [];
    const lastText = [...list].reverse().find(m => m.kind === 'text');
    return {
      id: convo.id,
      name: convo.name || '',
      addedAt: convo.addedAt,
      unread: convo.unread || 0,
      last: lastText
        ? {
            text:
              lastText.text.slice(0, 80) ||
              (lastText.attachment ? `📎 ${lastText.attachment.fileName}` : ''),
            at: lastText.at,
            direction: lastText.direction,
          }
        : null,
    };
  }

  // ----------------------------------------------------------------- state

  getState() {
    const conversations = Object.values(this.store.conversations)
      .map(c => this.conversationSummary(c))
      .sort((a, b) => ((b.last && b.last.at) || b.addedAt) - ((a.last && a.last.at) || a.addedAt));

    return {
      sdkError: this.sdkLoadError,
      hasIdentity: this.hasIdentity(),
      identity: this.identity ? this.publicIdentity(false) : null,
      displayName: this.store.displayName || '',
      status: this.status,
      poolSize: this.poolSize,
      network: NETWORK,
      settings: { ...this.store.settings },
      conversations,
    };
  }

  /**
   * Set (or clear, with an empty string) the display name shown to peers.
   * When connected, the SDK validates and applies it to all subsequent
   * messages; offline, the same rules are enforced locally and the name is
   * picked up at the next connect.
   */
  setDisplayName(name) {
    const value = String(name == null ? '' : name).trim();
    if (this.sdk) {
      this.sdk.setDisplayName(value || undefined); // validates + applies live
    } else {
      if (sanitize(value) !== value) throw new Error('Display name must not contain control characters.');
      if (Buffer.byteLength(value, 'utf8') > 64) throw new Error('Display name must be at most 64 bytes.');
    }
    this.store.displayName = value;
    this.scheduleSave();
    return value;
  }

  setSettings(partial) {
    if (partial && typeof partial.autoUnfurl === 'boolean') {
      this.store.settings.autoUnfurl = partial.autoUnfurl;
    }
    this.scheduleSave();
    return { ...this.store.settings };
  }

  // ----------------------------------------------------------- persistence

  loadStore() {
    try {
      if (fs.existsSync(this.storeFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
        this.store = {
          displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
          conversations: parsed.conversations || {},
          messages: parsed.messages || {},
          settings: { autoUnfurl: false, ...(parsed.settings || {}) },
        };
      }
    } catch {
      // A corrupt store should not brick the app; start fresh.
      this.store = { displayName: '', conversations: {}, messages: {}, settings: { autoUnfurl: false } };
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushStore();
    }, 400);
  }

  flushStore() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const tmp = `${this.storeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store));
      fs.renameSync(tmp, this.storeFile);
    } catch {
      // Best effort; history is a cache of what the network delivered.
    }
  }
}

module.exports = { ChatService };
