'use strict';

/**
 * CelarProtocolEncryption — extends the SDK's BchatProtocolEncryption with
 * outgoing quotes (replies) and reactions.
 *
 * The SDK's provider only puts a text body in the DataMessage, so structured
 * sends are smuggled through sdk.sendMessage() as a JSON payload carrying a
 * magic key. This class intercepts those, builds the DataMessage protobuf
 * itself (body + quote field 8 / reaction field 11 / profile field 101), and
 * then pads, signs, and seals exactly like the parent — so the result is
 * byte-compatible with what official BChat clients expect.
 *
 * Ordinary string payloads fall through to the parent untouched.
 */

const sodium = require('libsodium-wrappers-sumo');
const {
  BchatProtocolEncryption,
  ProtoWriter,
  addMessagePadding,
  removeMessagePadding,
  encodeEnvelope,
  decodeEnvelope,
  wrapEnvelope,
  unwrapEnvelope,
  decodeFields,
  EnvelopeType,
  normalizeX25519Hex,
} = require('@bdxi/bchat-sdk');

// Local protobuf field helpers over decodeFields' Map<number, ProtoValue[]>.
const firstBytesOf = (fields, n) => {
  const v = (fields.get(n) || [])[0];
  return v instanceof Uint8Array ? v : undefined;
};
const firstStringOf = (fields, n) => {
  const v = firstBytesOf(fields, n);
  return v ? Buffer.from(v).toString('utf8') : undefined;
};

/**
 * Custom Preview fields, chosen well clear of the official ones (url = 1,
 * title = 2, image-as-AttachmentPointer = 3). Protobuf parsers skip unknown
 * fields, so official clients still render url + title and ignore the rest.
 */
const PREVIEW_FIELD_DESCRIPTION = 12;
const PREVIEW_FIELD_SITE_NAME = 13;
const PREVIEW_FIELD_IMAGE_JPEG = 15;

/**
 * Inline attachment, Celar-to-Celar: a custom DataMessage field far outside
 * the official numbering, skipped by other clients. Sub-fields:
 * fileName = 1, contentType = 2, data = 3.
 */
const DATA_FIELD_CELAR_ATTACHMENT = 200;

/** Magic key marking a JSON payload as ours. */
const MAGIC_KEY = '@celar';
const MAGIC_VERSION = 1;

/** Wrap a structured send so sendMessage() can carry it as a plain string. */
function packStructured(data) {
  return JSON.stringify({ [MAGIC_KEY]: MAGIC_VERSION, ...data });
}

function parseStructured(plaintextBytes) {
  let text;
  try {
    text = Buffer.from(plaintextBytes).toString('utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('{')) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && obj[MAGIC_KEY] === MAGIC_VERSION) return obj;
  } catch {
    /* not JSON — treat as an ordinary body */
  }
  return null;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

class CelarProtocolEncryption extends BchatProtocolEncryption {
  async encryptForRecipient(plaintext, recipientX25519Hex) {
    const structured = parseStructured(plaintext);
    if (!structured) return super.encryptForRecipient(plaintext, recipientX25519Hex);

    await sodium.ready;
    const recipient = normalizeX25519Hex(recipientX25519Hex, 'recipient BChat ID');
    const timestamp = Number(structured.timestamp) || Date.now();

    // DataMessage: body = 1, timestamp = 7, quote = 8, reaction = 11, profile = 101.
    const data = new ProtoWriter();
    if (structured.body) data.string(1, structured.body);
    data.uint(7, timestamp);
    if (structured.quote) {
      data.message(
        8,
        new ProtoWriter()
          .uint(1, structured.quote.messageTimestamp)
          .string(2, structured.quote.author)
          .string(3, structured.quote.text)
      );
    }
    if (structured.preview && structured.preview.url) {
      // DataMessage.Preview: url = 1, title = 2, plus our custom fields for
      // description, site name, and an inline JPEG thumbnail. All of it is
      // sender-generated, so the receiver never has to fetch anything.
      const preview = new ProtoWriter()
        .string(1, structured.preview.url)
        .string(2, structured.preview.title);
      if (structured.preview.description) {
        preview.string(PREVIEW_FIELD_DESCRIPTION, structured.preview.description);
      }
      if (structured.preview.siteName) {
        preview.string(PREVIEW_FIELD_SITE_NAME, structured.preview.siteName);
      }
      if (structured.preview.imageB64) {
        preview.bytes(PREVIEW_FIELD_IMAGE_JPEG, Buffer.from(structured.preview.imageB64, 'base64'));
      }
      data.message(10, preview);
    }
    if (structured.attachment && structured.attachment.dataB64) {
      data.message(
        DATA_FIELD_CELAR_ATTACHMENT,
        new ProtoWriter()
          .string(1, structured.attachment.fileName || 'file')
          .string(2, structured.attachment.contentType || 'application/octet-stream')
          .bytes(3, Buffer.from(structured.attachment.dataB64, 'base64'))
      );
    }
    if (structured.reaction) {
      data.message(
        11,
        new ProtoWriter()
          .uint(1, structured.reaction.messageTimestamp)
          .string(2, structured.reaction.author)
          .string(3, structured.reaction.emoji)
          .uint(4, structured.reaction.action ? 1 : 0)
      );
    }
    // These fields are TypeScript-private on the parent, which only exists at
    // compile time — at runtime they are ordinary properties.
    if (this.displayName) {
      data.message(101, new ProtoWriter().string(1, this.displayName));
    }

    const content = new ProtoWriter().message(1, data).finish();

    // Identical to the parent from here on: pad → prepend wallet address →
    // sealed-sender signature → seal → Envelope → WebSocketMessage.
    const padded = addMessagePadding(content);
    const withAddress = concat(this.beldexAddress, padded);
    const verificationData = concat(withAddress, this.edPublicKey, recipient);
    const signature = sodium.crypto_sign_detached(verificationData, this.edPrivateKey);
    const plaintextWithMetadata = concat(withAddress, this.edPublicKey, signature);
    const ciphertext = sodium.crypto_box_seal(plaintextWithMetadata, recipient);

    return wrapEnvelope(
      encodeEnvelope({ type: EnvelopeType.BCHAT_MESSAGE, timestamp, content: ciphertext })
    );
  }

  /**
   * The SDK's decoder only surfaces url + title from a Preview. After the
   * parent has decrypted and verified the envelope, re-open the sealed box
   * and pull our custom preview fields (description, site name, thumbnail)
   * out of the raw protobuf. Best effort: any failure just means the plain
   * preview is shown.
   */
  async decryptEnvelope(payload, accountX25519PrivHex, accountX25519PubHex) {
    const decoded = await super.decryptEnvelope(payload, accountX25519PrivHex, accountX25519PubHex);
    if (!decoded || decoded.kind !== 'message') return decoded;
    try {
      await sodium.ready;
      const envelope = decodeEnvelope(unwrapEnvelope(payload));
      const ourPub = normalizeX25519Hex(accountX25519PubHex, 'account x25519 pubkey');
      const ourPriv = normalizeX25519Hex(accountX25519PrivHex, 'account x25519 privkey');
      // blob = walletAddress ‖ padded content ‖ senderEdPub(32) ‖ signature(64)
      const blob = sodium.crypto_box_seal_open(envelope.content, ourPub, ourPriv);
      const padded = blob.slice(this.addressLength, blob.length - 96);
      const content = removeMessagePadding(padded);
      const dataBytes = firstBytesOf(decodeFields(content), 1); // Content.dataMessage
      if (!dataBytes) return decoded;
      const dataFields = decodeFields(dataBytes);

      // Extra preview fields (description / site name / thumbnail).
      const previewBytes = firstBytesOf(dataFields, 10); // DataMessage.preview
      if (previewBytes && decoded.previews && decoded.previews.length) {
        const fields = decodeFields(previewBytes);
        const image = firstBytesOf(fields, PREVIEW_FIELD_IMAGE_JPEG);
        decoded.previews[0] = {
          ...decoded.previews[0],
          description: firstStringOf(fields, PREVIEW_FIELD_DESCRIPTION),
          siteName: firstStringOf(fields, PREVIEW_FIELD_SITE_NAME),
          imageB64: image && image.length ? Buffer.from(image).toString('base64') : undefined,
        };
      }

      // Inline Celar attachment. Piggybacks on the attachments array, which
      // the SDK passes through to the caller by reference.
      const attachmentBytes = firstBytesOf(dataFields, DATA_FIELD_CELAR_ATTACHMENT);
      if (attachmentBytes) {
        const fields = decodeFields(attachmentBytes);
        const bytes = firstBytesOf(fields, 3);
        if (bytes && bytes.length) {
          const entry = {
            fileName: firstStringOf(fields, 1),
            contentType: firstStringOf(fields, 2),
            size: bytes.length,
            _celarDataB64: Buffer.from(bytes).toString('base64'),
          };
          decoded.attachments = [...(decoded.attachments || []), entry];
        }
      }
    } catch {
      /* best effort — fall back to what the SDK decoded */
    }
    return decoded;
  }
}

module.exports = { CelarProtocolEncryption, packStructured };
