'use strict';

/**
 * Celar Chat — renderer. Talks to the main process only through the
 * window.celar bridge (see preload.js). All DOM insertion uses textContent,
 * so peer-controlled strings are inert.
 */

const $ = id => document.getElementById(id);

const state = {
  app: null, // last snapshot from main
  activeId: null,
  pendingMnemonic: null,
  replyTo: null, // record being replied to
};

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

// ------------------------------------------------------------------ helpers

const shortId = id => (id && id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id || '—');
const clockOf = ms => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const dayOf = ms => new Date(ms).toDateString();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(text, isError) {
  const t = $('toast');
  t.textContent = text;
  t.className = isError ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2200);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label || 'COPIED'} → CLIPBOARD`);
  } catch {
    toast('COPY FAILED', true);
  }
}

const MARQUEE_TEXT = 'ENCRYPTED BY DEFAULT — VERIFIED BY EVERYONE — SEEN BY NO ONE — ';
for (const id of ['marquee-onboard', 'marquee-main']) {
  const node = $(id);
  if (node) node.textContent = MARQUEE_TEXT.repeat(12);
}

// ------------------------------------------------------------------- views

function showView(name) {
  $('view-onboarding').hidden = name !== 'onboarding';
  $('view-main').hidden = name !== 'main';
}

async function refreshState() {
  state.app = await window.celar.getState();
  return state.app;
}

// ================================================================ onboarding

// One click creates the whole account and shows BChat ID + wallet + phrase.
$('btn-create-account').addEventListener('click', async () => {
  const btn = $('btn-create-account');
  const cta = $('create-cta');
  const errBox = $('choice-error');
  errBox.textContent = '';
  btn.disabled = true;
  cta.textContent = 'GENERATING…';
  try {
    const identity = await window.celar.createIdentity({});
    state.pendingMnemonic = identity.mnemonic;

    $('new-bchat-id').textContent = identity.bchatId;
    $('new-wallet').textContent = identity.walletAddress;
    const grid = $('phrase-grid');
    grid.replaceChildren();
    for (const word of identity.mnemonic.split(' ')) grid.appendChild(el('li', null, word));

    $('onboard-choice').hidden = true;
    $('onboard-account').hidden = false;
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false;
    cta.textContent = 'CREATE →';
  }
});

$('btn-choose-restore').addEventListener('click', () => {
  $('onboard-choice').hidden = true;
  $('onboard-restore').hidden = false;
  $('onboard-error').textContent = '';
  $('input-mnemonic').focus();
});

$('btn-onboard-back').addEventListener('click', () => {
  $('onboard-restore').hidden = true;
  $('onboard-choice').hidden = false;
});

$('onboard-restore').addEventListener('submit', async e => {
  e.preventDefault();
  const errBox = $('onboard-error');
  errBox.textContent = '';
  const go = $('btn-onboard-go');
  go.disabled = true;
  try {
    await window.celar.restoreIdentity({
      mnemonic: $('input-mnemonic').value,
      displayName: $('input-display-name').value.trim(),
    });
    await enterMain();
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    go.disabled = false;
  }
});

$('btn-copy-phrase').addEventListener('click', () => {
  if (state.pendingMnemonic) copyText(state.pendingMnemonic, 'PHRASE');
});

$('btn-phrase-done').addEventListener('click', async () => {
  state.pendingMnemonic = null;
  await enterMain();
});

// ================================================================ main view

async function enterMain() {
  showView('main');
  await refreshState();
  renderIdentityChip();
  renderConversations();
  renderStatus(state.app.status, state.app.poolSize);
  connect();
}

async function connect() {
  try {
    const res = await window.celar.connect();
    renderStatus(res.status, res.poolSize);
  } catch (err) {
    renderStatus('error', 0, err.message);
    toast(`NETWORK: ${err.message}`, true);
  }
}

function renderIdentityChip() {
  const id = state.app.identity && state.app.identity.bchatId;
  $('my-short-id').textContent = shortId(id);
}

function renderStatus(status, poolSize, detail) {
  const dot = $('status-dot');
  const label = $('status-text');
  dot.className = 'dot';
  if (status === 'online') {
    dot.classList.add('online');
    label.textContent = 'LIVE';
  } else if (status === 'connecting') {
    dot.classList.add('connecting');
    label.textContent = 'CONNECTING';
  } else if (status === 'error') {
    dot.classList.add('error');
    label.textContent = 'DEGRADED';
    if (detail) label.title = detail;
  } else {
    label.textContent = 'OFFLINE';
  }
  $('top-pool').replaceChildren('POOL ', Object.assign(el('b'), { textContent: poolSize ? `${poolSize} SNODES` : '—' }));
}

// ------------------------------------------------------------ conversations

function convoName(convo) {
  return convo.name || shortId(convo.id);
}

function renderConversations() {
  const list = $('convo-list');
  list.replaceChildren();
  const convos = (state.app && state.app.conversations) || [];

  if (!convos.length) {
    list.appendChild(
      el('div', 'convo-list-empty', 'NO CONVERSATIONS YET.\nSHARE YOUR ID, OR START ONE WITH + NEW.')
    );
    return;
  }

  convos.forEach(convo => {
    const btn = el('button', 'convo' + (convo.id === state.activeId ? ' active' : ''));
    const top = el('div', 'convo-top');
    const name = el('span', 'convo-name' + (convo.name ? '' : ' unnamed'), convoName(convo));
    const time = el('span', 'convo-time', convo.last ? clockOf(convo.last.at) : '');
    top.append(name, time);

    const bottom = el('div', 'convo-bottom');
    const preview = el(
      'span',
      'convo-preview',
      convo.last ? `${convo.last.direction === 'out' ? '→ ' : ''}${convo.last.text}` : 'no messages yet'
    );
    bottom.appendChild(preview);
    if (convo.unread > 0) bottom.appendChild(el('span', 'convo-unread', String(convo.unread)));
    btn.append(top, bottom);

    btn.addEventListener('click', () => openConversation(convo.id));
    list.appendChild(btn);
  });
}

async function openConversation(peerId) {
  if (state.activeId !== peerId) clearReplyTo();
  state.activeId = peerId;
  await refreshState();
  renderConversations();

  const convo = state.app.conversations.find(c => c.id === peerId);
  $('chat-empty').hidden = true;
  $('chat-pane').hidden = false;
  $('chat-peer-name').textContent = convo ? convoName(convo) : shortId(peerId);
  $('chat-peer-id').textContent = peerId;

  const records = await window.celar.listMessages(peerId);
  renderMessages(records);
  $('composer-input').focus();
}

function closeConversationPane() {
  state.activeId = null;
  $('chat-pane').hidden = true;
  $('chat-empty').hidden = false;
}

// ---------------------------------------------------------------- messages

/**
 * Two consecutive text messages from the same side within a minute share one
 * header line (like most messengers).
 */
const GROUP_WINDOW_MS = 60 * 1000;
let lastListRecord = null; // previous record in the rendered list, for appends

function shouldGroup(prev, record) {
  return (
    !!prev &&
    prev.kind === 'text' &&
    record.kind === 'text' &&
    prev.direction === record.direction &&
    Boolean(prev.synced) === Boolean(record.synced) &&
    record.at >= prev.at &&
    record.at - prev.at < GROUP_WINDOW_MS
  );
}

function renderMessages(records) {
  const box = $('messages');
  box.replaceChildren();
  let lastDay = '';
  let prev = null;
  for (const record of records) {
    const day = dayOf(record.at || Date.now());
    if (day !== lastDay) {
      lastDay = day;
      box.appendChild(el('div', 'day-divider', day.toUpperCase()));
      prev = null; // never group across a day divider
    }
    box.appendChild(messageNode(record, shouldGroup(prev, record)));
    prev = record.kind === 'text' ? record : null;
  }
  lastListRecord = prev;
  box.scrollTop = box.scrollHeight;
}

function appendMessageNode(record) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.appendChild(messageNode(record, shouldGroup(lastListRecord, record)));
  lastListRecord = record.kind === 'text' ? record : null;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function messageNode(record, grouped = false) {
  if (record.kind === 'system') {
    return el('div', 'msg-system', `· ${record.text} · ${clockOf(record.at)}`);
  }

  const wrap = el('div', `msg ${record.direction === 'out' ? 'out' : 'in'}`);
  wrap.dataset.id = record.id || '';
  // Delivery-state messages keep their meta even inside a group, so the
  // spinner / retry control never disappears.
  const pending = record.direction === 'out' && (record.status === 'sending' || record.status === 'failed');
  const showMeta = !grouped || pending;
  wrap.dataset.grouped = grouped ? '1' : '0';
  if (grouped) wrap.classList.add('grouped');

  if (showMeta) {
    const meta = el('div', 'msg-meta');
    if (!grouped) {
      const who = el('b', null, record.direction === 'out' ? (record.synced ? 'YOU · SYNC' : 'YOU') : peerLabel());
      meta.append(who, ` [${clockOf(record.at)}]`);
    }

    if (record.direction === 'out' && record.status === 'sending') {
      // Optimistically rendered; the spinner clears when the snode acks.
      meta.append(' ');
      meta.appendChild(el('span', 'msg-spinner'));
      wrap.classList.add('sending');
    } else if (record.direction === 'out' && record.status === 'failed') {
      meta.append(' ');
      const retryBtn = el('button', 'msg-retry', '✗ FAILED — RETRY');
      retryBtn.type = 'button';
      if (record.error) retryBtn.title = record.error;
      retryBtn.addEventListener('click', () => {
        window.celar.retry(state.activeId, record.id).catch(err => toast(err.message, true));
      });
      meta.appendChild(retryBtn);
      wrap.classList.add('failed');
    } else if (record.hash) {
      meta.append(` ⟦${record.hash}⟧`);
    }
    wrap.appendChild(meta);
  }

  if (record.quote && (record.quote.text || record.quote.author)) {
    wrap.appendChild(
      el('div', 'msg-quote', `↳ ${shortId(record.quote.author)}: ${record.quote.text || '(no text)'}`)
    );
  }

  if (record.attachment) {
    const a = record.attachment;
    const save = () =>
      window.celar
        .saveAttachment(state.activeId, record.id)
        .then(p => p && toast('SAVED'))
        .catch(err => toast(err.message, true));

    if (a.contentType && a.contentType.startsWith('image/') && a.dataB64) {
      const img = el('img', 'msg-image');
      img.src = `data:${a.contentType};base64,${a.dataB64}`;
      img.alt = a.fileName || 'image';
      img.title = 'Click to save';
      img.addEventListener('click', save);
      wrap.appendChild(img);
    } else {
      const card = el('button', 'msg-file');
      card.type = 'button';
      card.appendChild(el('span', 'msg-file-icon', '📄'));
      const body = el('span', 'msg-file-body');
      body.appendChild(el('span', 'msg-file-name', a.fileName || 'file'));
      body.appendChild(el('span', 'msg-file-meta', `${a.contentType || 'file'} · ${formatSize(a.size)}`));
      card.appendChild(body);
      card.appendChild(el('span', 'msg-file-save', 'SAVE ⇣'));
      card.addEventListener('click', save);
      wrap.appendChild(card);
    }
  }

  let bubble = null;
  if (record.text) {
    bubble = bubbleNode(record.text);
    wrap.appendChild(bubble);
  }

  for (const a of record.attachments || []) {
    const bits = ['[ATTACHMENT]', a.kind, a.fileName && `"${a.fileName}"`, a.size && `${(a.size / 1024).toFixed(1)} KB`]
      .filter(Boolean)
      .join(' ');
    wrap.appendChild(el('div', 'msg-extra', bits));
  }

  if (record.payment) {
    wrap.appendChild(
      el('div', 'msg-extra warn', `PAYMENT CLAIM ${record.payment.amount} BDX — UNVERIFIED, CHECK THE CHAIN`)
    );
  }

  if (record.preview && record.preview.url) {
    wrap.appendChild(previewNode(record.preview));
  } else if (record.direction === 'in' && !record.previewNone && composerFirstUrl(record.text)) {
    // Incoming bare link: previews are fetched only on explicit request
    // (or via the opt-in auto setting), since fetching reveals your IP.
    const loadBtn = el('button', 'msg-load-preview', record.previewLoading ? 'LOADING PREVIEW…' : '⇣ LOAD PREVIEW');
    loadBtn.type = 'button';
    loadBtn.disabled = Boolean(record.previewLoading);
    loadBtn.title = 'Fetches the page from this device — the linked site will see your IP address';
    loadBtn.addEventListener('click', () => {
      window.celar.unfurl(state.activeId, record.id).catch(err => toast(err.message, true));
    });
    wrap.appendChild(loadBtn);
  }

  if (record.reactions && record.reactions.length) {
    const row = reactionsNode(record);
    // Telegram-style: chips live inside the bubble; fall back to below it for
    // attachment-only or jumbo-emoji messages that have no regular bubble.
    if (bubble && !bubble.classList.contains('emoji-only')) bubble.appendChild(row);
    else wrap.appendChild(row);
  }
  wrap.appendChild(actionsNode(record));

  if (record.id && record.id === suppressActionsId) {
    wrap.classList.add('no-actions');
    wrap.addEventListener('mouseleave', () => {
      wrap.classList.remove('no-actions');
      if (suppressActionsId === record.id) suppressActionsId = null;
    });
  }

  // Right-click: message-specific menu (suppresses the native one here only;
  // the composer and plain selections keep the system menu).
  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    openMessageMenu(record, e.clientX, e.clientY);
  });

  return wrap;
}

/** Link preview card (sender-generated; clicking opens the system browser). */
function previewNode(preview) {
  const card = el('button', 'msg-preview');
  card.type = 'button';
  let domain = '';
  try {
    domain = new URL(preview.url).hostname;
  } catch {
    /* leave blank */
  }
  if (preview.siteName || domain) {
    card.appendChild(el('span', 'msg-preview-site', preview.siteName || domain));
  }
  card.appendChild(el('span', 'msg-preview-title', preview.title || preview.url));
  if (preview.description) card.appendChild(el('span', 'msg-preview-desc', preview.description));
  if (preview.imageB64) {
    const img = el('img', 'msg-preview-img');
    img.src = `data:image/jpeg;base64,${preview.imageB64}`;
    img.alt = '';
    card.appendChild(img);
  }
  if (domain) card.appendChild(el('span', 'msg-preview-domain', `↗ ${domain}`));
  card.title = preview.url;
  card.addEventListener('click', () => {
    window.celar.openExternal(preview.url).catch(err => toast(err.message, true));
  });
  return card;
}

/** The active peer's display name (or BNS/manual name), falling back to PEER. */
function peerLabel() {
  const convo =
    state.app && state.app.conversations
      ? state.app.conversations.find(c => c.id === state.activeId)
      : null;
  const name = convo && convo.name ? convo.name.slice(0, 24) : '';
  return name || 'PEER';
}

// -------------------------------------------------- message context menu

function closeMessageMenu() {
  $('msg-menu').hidden = true;
}

function openMessageMenu(record, x, y) {
  const menu = $('msg-menu');
  menu.replaceChildren();

  // Quick reactions row.
  const emojiRow = el('div', 'msg-menu-emojis');
  for (const emoji of REACTION_EMOJIS) {
    const btn = el('button', 'msg-menu-emoji', emoji);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      closeMessageMenu();
      toggleReaction(record, emoji);
    });
    emojiRow.appendChild(btn);
  }
  menu.appendChild(emojiRow);

  const item = (label, onClick) => {
    const btn = el('button', 'msg-menu-item', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      closeMessageMenu();
      onClick();
    });
    menu.appendChild(btn);
  };

  item('↳ REPLY', () => setReplyTo(record));
  const selection = String(window.getSelection() || '').trim();
  if (selection || record.text) {
    item(selection ? 'COPY SELECTION' : 'COPY TEXT', () =>
      copyText(selection || record.text, 'MESSAGE')
    );
  }
  if (record.preview && record.preview.url) {
    item('COPY LINK', () => copyText(record.preview.url, 'LINK'));
  }

  // Position, clamped to the viewport.
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

document.addEventListener('click', e => {
  const menu = $('msg-menu');
  if (!menu.hidden && !menu.contains(e.target)) closeMessageMenu();
});

/** Hover bar: reply only — reactions live in the right-click menu. */
function actionsNode(record) {
  const bar = el('div', 'msg-actions');
  const replyBtn = el('button', 'msg-act', '↳ REPLY');
  replyBtn.type = 'button';
  replyBtn.addEventListener('click', () => setReplyTo(record));
  bar.appendChild(replyBtn);
  return bar;
}

/** Chips under a message showing who reacted with what. */
function reactionsNode(record) {
  const row = el('div', 'msg-reactions');
  const byEmoji = new Map();
  for (const r of record.reactions) {
    const entry = byEmoji.get(r.emoji) || { count: 0, mine: false };
    entry.count++;
    if (r.from === 'you') entry.mine = true;
    byEmoji.set(r.emoji, entry);
  }
  for (const [emoji, entry] of byEmoji) {
    const chip = el('button', 'react-chip' + (entry.mine ? ' mine' : ''));
    chip.type = 'button';
    chip.appendChild(el('span', 'react-chip-emoji', emoji));
    chip.title = entry.mine ? 'Click to remove your reaction' : 'Click to react too';
    chip.addEventListener('click', e => {
      e.stopPropagation();
      toggleReaction(record, emoji);
    });
    row.appendChild(chip);
  }
  return row;
}

/** After picking a reaction, keep this message's hover bar hidden until the
 *  pointer leaves it — the chip appearing is the confirmation. */
let suppressActionsId = null;

async function toggleReaction(record, emoji) {
  if (!state.activeId) return;
  suppressActionsId = record.id;
  try {
    await window.celar.react(state.activeId, record.id, emoji);
  } catch (err) {
    toast(`REACTION FAILED: ${err.message}`, true);
  }
}

// ------------------------------------------------------------------ replies

function setReplyTo(record) {
  state.replyTo = record;
  $('reply-banner').hidden = false;
  $('reply-banner-text').textContent =
    `↳ REPLYING TO ${record.direction === 'out' ? 'YOURSELF' : 'PEER'}: ` +
    `${(record.text || '(no text)').replace(/\s+/g, ' ').slice(0, 80)}`;
  composerInput.focus();
}

function clearReplyTo() {
  state.replyTo = null;
  $('reply-banner').hidden = true;
}

$('btn-cancel-reply').addEventListener('click', clearReplyTo);

// ------------------------------------------------------------ code snippets

/**
 * Split a message into text and fenced-code segments. Code travels as plain
 * ```lang ... ``` text on the wire, so official clients render it verbatim.
 */
function parseSegments(text) {
  const segments = [];
  const fence = /```([A-Za-z0-9+#-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(text))) {
    if (m.index > last) segments.push({ type: 'text', text: text.slice(last, m.index) });
    segments.push({ type: 'code', lang: (m[1] || '').toUpperCase(), code: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
  return segments;
}

/** Render a text run, turning `inline code` spans into <code> elements. */
function appendInline(parent, text) {
  const parts = text.split(/`([^`\n]+)`/);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) parent.appendChild(el('code', 'inline-code', part));
    else appendFormatted(parent, part);
  });
}

/**
 * Inline formatting outside code spans: **bold**, *italic*, ~~strike~~ and
 * bare http(s) links. Underscore variants are deliberately unsupported so
 * snake_case identifiers survive untouched; markers travel as plain text on
 * the wire, so other clients simply show them verbatim.
 */
const INLINE_TOKEN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|https?:\/\/[^\s<>"'`]+)/;

function appendFormatted(parent, text) {
  const parts = text.split(INLINE_TOKEN);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 0) {
      parent.appendChild(document.createTextNode(part));
    } else if (part.startsWith('**')) {
      parent.appendChild(el('strong', null, part.slice(2, -2)));
    } else if (part.startsWith('~~')) {
      parent.appendChild(el('del', null, part.slice(2, -2)));
    } else if (part.startsWith('*')) {
      parent.appendChild(el('em', null, part.slice(1, -1)));
    } else {
      // A bare URL. Rendered as a link that opens in the system browser via
      // the main process — the window itself never navigates.
      const link = el('a', 'msg-link', part);
      link.href = '#';
      link.title = part;
      link.addEventListener('click', e => {
        e.preventDefault();
        window.celar.openExternal(part).catch(err => toast(err.message, true));
      });
      parent.appendChild(link);
    }
  });
}

function codeBlockNode(segment) {
  const block = el('div', 'msg-code');
  const head = el('div', 'msg-code-head');
  head.appendChild(el('span', null, segment.lang || 'CODE'));
  const copyBtn = el('button', 'msg-code-copy', 'COPY');
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', () => copyText(segment.code, 'SNIPPET'));
  head.appendChild(copyBtn);
  const pre = el('pre');
  pre.appendChild(el('code', null, segment.code));
  block.append(head, pre);
  return block;
}

function bubbleNode(text) {
  const bubble = el('div', 'msg-bubble');
  if (isEmojiOnly(text)) {
    bubble.classList.add('emoji-only');
    bubble.textContent = text.trim();
    return bubble;
  }
  for (const segment of parseSegments(text)) {
    if (segment.type === 'code') bubble.appendChild(codeBlockNode(segment));
    else appendInline(bubble, segment.text);
  }
  return bubble;
}

// ------------------------------------------------------------------- emoji

const EMOJI_CATEGORIES = [
  { label: 'SMILEYS', emojis: ['😀','😃','😄','😁','😆','😅','😂','🤣','🙂','😉','😊','😇','🥰','😍','🤩','😘','😜','🤪','😝','🤗','🤔','🤨','😐','😶','🙄','😏','😬','😌','😴','🤤','😷','🤒','🤕','🤢','🥵','🥶','🤯','🥳','😎','🤓','🧐','😕','🙁','😮','😯','😲','😳','🥺','😢','😭','😱','😖','😞','😓','😩','🥱','😤','😡','🤬','💀','👻','🤖','💩','😺'] },
  { label: 'GESTURES', emojis: ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🖖','👋','🤝','🙏','💪','👏','🙌','👐','🤲','✍️','🤷','🤦','👀'] },
  { label: 'HEARTS & FX', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💖','💯','💢','💥','💫','💦','💨','💬','💭','💤','✨','⭐','🌟','⚡','🔥','🌈','☀️','🌙','❄️','☔'] },
  { label: 'OBJECTS', emojis: ['🎉','🎊','🎁','🏆','🥇','⚽','🎮','🎲','🎯','🎵','🎶','🎤','🎧','📱','💻','⌨️','🖥️','💾','📷','🔋','💡','🔒','🔓','🔑','🛠️','⚙️','🚀','✈️','🚗','⏰','💰','💎','📌','📎','✂️','📝','📚','🔍','✅','❌','⚠️','❓','❗','☕','🍺','🍕','🐛','🏁'] },
];

/** :shortcode: → emoji, applied on send (outside code spans/blocks). */
const SHORTCODES = {
  smile: '😄', grin: '😁', joy: '😂', laughing: '😆', wink: '😉', blush: '😊',
  heart_eyes: '😍', cool: '😎', thinking: '🤔', shrug: '🤷', facepalm: '🤦',
  sob: '😭', cry: '😢', angry: '😡', skull: '💀', ghost: '👻', robot: '🤖',
  poop: '💩', eyes: '👀', wave: '👋', clap: '👏', pray: '🙏', muscle: '💪',
  ok_hand: '👌', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  heart: '❤️', broken_heart: '💔', '100': '💯', fire: '🔥', sparkles: '✨',
  star: '⭐', zap: '⚡', tada: '🎉', rocket: '🚀', check: '✅', x: '❌',
  warning: '⚠️', bulb: '💡', lock: '🔒', key: '🔑', gear: '⚙️',
  coffee: '☕', beer: '🍺', pizza: '🍕', bug: '🐛',
};

function convertShortcodes(text) {
  // Leave code fences and inline code untouched.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/:([a-z0-9_+-]+):/g, (m, name) => SHORTCODES[name] || m)
    )
    .join('');
}

/** True when a message is just emoji (rendered jumbo, without a bubble). */
function isEmojiOnly(text) {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  try {
    return (
      /\p{Extended_Pictographic}/u.test(t) &&
      new RegExp(
        '^(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|\\uFE0F|\\u200D|\\s)+$',
        'u'
      ).test(t)
    );
  } catch {
    return false;
  }
}

let emojiPanelBuilt = false;
function buildEmojiPanel() {
  if (emojiPanelBuilt) return;
  emojiPanelBuilt = true;
  const panel = $('emoji-panel');
  for (const category of EMOJI_CATEGORIES) {
    panel.appendChild(el('div', 'emoji-cat-label', category.label));
    const grid = el('div', 'emoji-grid');
    for (const emoji of category.emojis) {
      const btn = el('button', 'emoji-btn', emoji);
      btn.type = 'button';
      btn.addEventListener('click', () => insertAtCursor(emoji));
      grid.appendChild(btn);
    }
    panel.appendChild(grid);
  }
}

function insertAtCursor(text) {
  const input = composerInput;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const caret = start + text.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input'));
  input.focus();
}

function closeEmojiPanel() {
  $('emoji-panel').hidden = true;
}

// ---------------------------------------------------------------- composer

const composerInput = $('composer-input');

// A scroll under an open message menu would leave it floating over the
// wrong message.
$('messages').addEventListener('scroll', closeMessageMenu);

// ------------------------------------------------- live link unfurling

const unfurl = {
  url: null, // URL currently shown (or being fetched)
  data: null, // {url, title} once fetched
  dismissedUrl: null, // user said "no preview" for this URL
  seq: 0,
  timer: null,
};

/** First http(s) URL outside code spans/blocks — mirrors the main process. */
function composerFirstUrl(text) {
  const parts = String(text || '').split(/(```[\s\S]*?```|`[^`\n]*`)/);
  for (let i = 0; i < parts.length; i += 2) {
    const m = parts[i].match(/https?:\/\/[^\s<>"'`]+/);
    if (m) return m[0];
  }
  return null;
}

function hideComposerPreview() {
  $('composer-preview').hidden = true;
}

function showComposerPreview(info) {
  $('composer-preview-title').textContent = info.title;
  $('composer-preview-domain').textContent = info.domain;

  const desc = $('composer-preview-desc');
  desc.textContent = info.description || '';
  desc.hidden = !info.description;

  const thumb = $('composer-preview-thumb');
  if (info.imageB64) {
    thumb.src = `data:image/jpeg;base64,${info.imageB64}`;
    thumb.hidden = false;
  } else {
    thumb.removeAttribute('src');
    thumb.hidden = true;
  }
  $('composer-preview').hidden = false;
}

function resetUnfurl() {
  unfurl.url = null;
  unfurl.data = null;
  unfurl.dismissedUrl = null;
  unfurl.seq++;
  hideComposerPreview();
}

async function updateComposerUnfurl() {
  const url = composerFirstUrl(composerInput.value);

  if (!url) {
    unfurl.url = null;
    unfurl.data = null;
    unfurl.dismissedUrl = null;
    hideComposerPreview();
    return;
  }
  if (url === unfurl.dismissedUrl) {
    hideComposerPreview();
    return;
  }
  if (url === unfurl.url) {
    // Already fetched (or in flight) for this exact URL.
    if (unfurl.data) showComposerPreview(composerCardInfo(unfurl.data));
    return;
  }

  unfurl.url = url;
  unfurl.data = null;
  const mySeq = ++unfurl.seq;
  showComposerPreview({ title: 'Fetching preview…', domain: domainOf(url) });

  try {
    const data = await window.celar.fetchPreview(url);
    if (mySeq !== unfurl.seq || composerFirstUrl(composerInput.value) !== url) return; // stale
    if (data) {
      unfurl.data = data;
      showComposerPreview(composerCardInfo(data));
    } else {
      hideComposerPreview();
    }
  } catch {
    if (mySeq === unfurl.seq) hideComposerPreview();
  }
}

function composerCardInfo(data) {
  return {
    title: data.title,
    domain: domainOf(data.url),
    description: data.description,
    imageB64: data.imageB64,
  };
}

function domainOf(url) {
  try {
    return `↗ ${new URL(url).hostname}`;
  } catch {
    return '';
  }
}

$('btn-dismiss-preview').addEventListener('click', () => {
  unfurl.dismissedUrl = unfurl.url;
  hideComposerPreview();
  composerInput.focus();
});

$('btn-emoji').addEventListener('click', e => {
  e.stopPropagation();
  buildEmojiPanel();
  const panel = $('emoji-panel');
  panel.hidden = !panel.hidden;
});

// ---------------------------------------------------------- attachments

let pendingFile = null; // {name, type, size, dataB64}

function formatSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function clearPendingFile() {
  pendingFile = null;
  $('file-input').value = '';
  $('attach-banner').hidden = true;
}

$('btn-attach').addEventListener('click', () => $('file-input').click());
$('btn-remove-attach').addEventListener('click', clearPendingFile);

$('file-input').addEventListener('change', () => {
  const file = $('file-input').files[0];
  if (!file) return;

  const isImage = (file.type || '').startsWith('image/');
  if (!isImage && file.size > 45 * 1024) {
    toast('NON-IMAGE FILES ARE LIMITED TO 45 KB', true);
    $('file-input').value = '';
    return;
  }
  if (isImage && file.size > 25 * 1024 * 1024) {
    toast('IMAGE TOO LARGE', true);
    $('file-input').value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataB64 = String(reader.result).split(',')[1] || '';
    pendingFile = { name: file.name, type: file.type, size: file.size, dataB64 };
    $('attach-banner-text').textContent =
      `📎 ${file.name} · ${formatSize(file.size)}` + (isImage ? ' · WILL BE COMPRESSED' : '');
    $('attach-banner').hidden = false;
    composerInput.focus();
  };
  reader.onerror = () => toast('COULD NOT READ FILE', true);
  reader.readAsDataURL(file);
});

document.addEventListener('click', e => {
  const panel = $('emoji-panel');
  if (!panel.hidden && !panel.contains(e.target) && e.target !== $('btn-emoji')) closeEmojiPanel();
});

composerInput.addEventListener('input', () => {
  composerInput.style.height = 'auto';
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 160)}px`;
  clearTimeout(unfurl.timer);
  unfurl.timer = setTimeout(updateComposerUnfurl, 450);
});

composerInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', async e => {
  e.preventDefault();
  const text = convertShortcodes(composerInput.value);
  if (!state.activeId) return;
  closeEmojiPanel();

  // A pending attachment goes out with the text as its caption.
  if (pendingFile) {
    const sendBtnA = $('btn-send');
    sendBtnA.disabled = true;
    try {
      await window.celar.sendAttachment(state.activeId, pendingFile, text.trim());
      composerInput.value = '';
      composerInput.style.height = 'auto';
      clearPendingFile();
      clearReplyTo();
      resetUnfurl();
    } catch (err) {
      toast(`SEND FAILED: ${err.message}`, true);
    } finally {
      sendBtnA.disabled = false;
      composerInput.focus();
    }
    return;
  }

  if (!text.trim()) return;
  const sendBtn = $('btn-send');
  sendBtn.disabled = true;
  // Hand over whatever the composer already unfurled: the fetched preview,
  // null if the user dismissed it, or undefined to let the main process
  // fetch one in the background during delivery.
  const currentUrl = composerFirstUrl(text);
  let preview;
  if (currentUrl && currentUrl === unfurl.dismissedUrl) {
    preview = null;
  } else if (currentUrl && unfurl.data && unfurl.data.url.startsWith(currentUrl)) {
    // Keep the URL exactly as typed so it always matches the message body
    // (the fetcher may have normalized it, e.g. added a trailing slash).
    preview = { ...unfurl.data, url: currentUrl };
  }

  try {
    // The main process broadcasts an event for every appended record —
    // including this one — so the event handler does the rendering.
    await window.celar.sendMessage(state.activeId, text, state.replyTo ? state.replyTo.id : undefined, preview);
    composerInput.value = '';
    composerInput.style.height = 'auto';
    clearReplyTo();
    resetUnfurl();
  } catch (err) {
    toast(`SEND FAILED: ${err.message}`, true);
  } finally {
    sendBtn.disabled = false;
    composerInput.focus();
  }
});

// ------------------------------------------------------------- chat header

$('btn-copy-peer').addEventListener('click', () => {
  if (state.activeId) copyText(state.activeId, 'PEER ID');
});

$('btn-remove-convo').addEventListener('click', async () => {
  if (!state.activeId) return;
  await window.celar.removeConversation(state.activeId);
  closeConversationPane();
  await refreshState();
  renderConversations();
});

// ----------------------------------------------------------------- modals

function openModal(id) {
  $(id).hidden = false;
}
function closeModals() {
  for (const backdrop of document.querySelectorAll('.modal-backdrop')) backdrop.hidden = true;
}

document.addEventListener('click', e => {
  const target = e.target;
  if (target.matches('.modal-backdrop')) closeModals();
  if (target.matches('[data-close]')) closeModals();
  if (target.matches('[data-copy]')) {
    const source = $(target.getAttribute('data-copy'));
    if (source && !source.dataset.hidden) copyText(source.textContent, 'COPIED');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModals();
    clearReplyTo();
    closeEmojiPanel();
    closeMessageMenu();
  }
});

// Regaining focus marks the open conversation as read (clears its unread
// count and, through it, the dock badge).
window.addEventListener('focus', async () => {
  if (state.activeId) {
    await window.celar.listMessages(state.activeId);
    await refreshState();
    renderConversations();
  }
});

// new conversation
$('btn-add-convo').addEventListener('click', () => {
  $('add-error').textContent = '';
  $('input-peer').value = '';
  openModal('modal-add');
  $('input-peer').focus();
});
$('btn-empty-add').addEventListener('click', () => $('btn-add-convo').click());

$('form-add').addEventListener('submit', async e => {
  e.preventDefault();
  const errBox = $('add-error');
  errBox.textContent = '';
  try {
    const convo = await window.celar.addConversation($('input-peer').value);
    closeModals();
    await refreshState();
    renderConversations();
    openConversation(convo.id);
  } catch (err) {
    errBox.textContent = err.message;
  }
});

// identity modal
$('btn-my-id').addEventListener('click', async () => {
  const identity = state.app && state.app.identity;
  $('id-bchat').textContent = identity ? identity.bchatId : '—';
  $('id-wallet').textContent = identity ? identity.walletAddress : '—';
  const phrase = $('id-phrase');
  phrase.textContent = '••••• ••••• ••••• •••••';
  phrase.dataset.hidden = '1';
  $('btn-reveal-phrase').textContent = 'REVEAL';
  $('chk-auto-unfurl').checked = Boolean(state.app && state.app.settings && state.app.settings.autoUnfurl);
  $('input-settings-name').value = (state.app && state.app.displayName) || '';
  openModal('modal-id');
});

$('btn-save-name').addEventListener('click', async () => {
  try {
    const value = await window.celar.setDisplayName($('input-settings-name').value);
    await refreshState();
    toast(value ? `DISPLAY NAME → ${value}` : 'DISPLAY NAME CLEARED');
  } catch (err) {
    toast(err.message, true);
  }
});

$('chk-auto-unfurl').addEventListener('change', async e => {
  try {
    await window.celar.setSettings({ autoUnfurl: e.target.checked });
    await refreshState();
    toast(e.target.checked ? 'AUTO-UNFURL ON' : 'AUTO-UNFURL OFF');
  } catch (err) {
    toast(err.message, true);
  }
});

$('btn-reveal-phrase').addEventListener('click', async () => {
  const phrase = $('id-phrase');
  if (phrase.dataset.hidden === '1') {
    try {
      phrase.textContent = await window.celar.revealMnemonic();
      delete phrase.dataset.hidden;
      $('btn-reveal-phrase').textContent = 'HIDE';
    } catch (err) {
      toast(err.message, true);
    }
  } else {
    phrase.textContent = '••••• ••••• ••••• •••••';
    phrase.dataset.hidden = '1';
    $('btn-reveal-phrase').textContent = 'REVEAL';
  }
});

// ------------------------------------------------------------ event stream

window.celar.onEvent(async event => {
  if (event.type === 'status') {
    renderStatus(event.status, event.poolSize, event.detail);
    return;
  }

  if (event.type === 'conversations') {
    await refreshState();
    renderConversations();
    return;
  }

  if (event.type === 'toast') {
    toast(event.text, event.error);
    return;
  }

  if (event.type === 'focus-conversation') {
    // A system notification was clicked: jump to that conversation.
    openConversation(event.peerId);
    return;
  }

  if (event.type === 'message-updated') {
    if (event.peerId === state.activeId) {
      const existing = document.querySelector(`#messages [data-id="${event.record.id}"]`);
      if (existing) existing.replaceWith(messageNode(event.record, existing.dataset.grouped === '1'));
    }
    return;
  }

  if (event.type === 'message') {
    if (event.peerId === state.activeId && document.hasFocus()) {
      appendMessageNode(event.record);
      // Mark read (main resets the unread counter on list).
      window.celar.listMessages(event.peerId);
    } else if (event.peerId === state.activeId) {
      appendMessageNode(event.record);
    }
    await refreshState();
    renderConversations();
  }
});

// -------------------------------------------------------------------- boot

(async function boot() {
  const app = await refreshState();

  if (app.sdkError) {
    showView('onboarding');
    $('choice-error').textContent = app.sdkError;
    return;
  }

  if (app.hasIdentity) {
    await enterMain();
  } else {
    showView('onboarding');
  }
})();
