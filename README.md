# Celar Chat

Encrypted desktop messenger built on [`@bdxi/bchat-sdk`](../bchat-sdk), styled after [celar.network](https://celar.network). Messages are padded, signed, and sealed-box encrypted to the recipient's key before leaving your machine, and travel over the BChat storage-node network — interoperable with the official BChat clients in both directions.

## Prerequisites

Node `^20.19` or `>=22.12`, plus a built copy of the SDK (this app depends on it as a local folder):

```bash
cd ../bchat-sdk
npm install
npm run build
```

## Run

```bash
cd celar-chat
npm install
npm start
```

On first launch you either mint a new identity (a 25-word recovery phrase that derives both your BChat ID and Beldex wallet address) or restore an existing one. The phrase is stored with `0600` permissions in Electron's `userData` directory — it is the only thing to back up, and the only thing that can decrypt messages sealed to you.

## Using it

Share your BChat ID (`bd` + 64 hex; click the status chip in the top bar to copy it). Start a conversation with **+ NEW** using a peer's BChat ID or a BNS name (`name.bdx`). Messages from unknown senders open a new conversation automatically. Enter sends; Shift+Enter inserts a newline.

## Architecture

Everything Node-side lives in the Electron main process; the renderer is sandboxed and talks only through a `contextBridge` API.

- `main.js` — window + IPC surface
- `sdk-service.js` — identity lifecycle, one `BchatSDK` instance wired with `BchatProtocolEncryption` (the real BChat wire protocol), a 5-second polling receive loop, and JSON persistence of conversations in `userData`
- `preload.js` — the `window.celar` bridge
- `renderer/` — vanilla HTML/CSS/JS, Celar design language, all DOM insertion via `textContent`

## Security notes (inherited from the SDK)

Message bodies are end-to-end encrypted; metadata is not private against a network observer (no onion routing, storage nodes not yet authenticated). There is no forward secrecy — the recovery phrase decrypts all past traffic. Storage-node certificates are self-signed by design and accepted (`allowSelfSignedStorageNodes`); seed-node certificates are fully verified. Payment notifications in messages are sender-asserted claims — never treat them as proof of a transfer.
