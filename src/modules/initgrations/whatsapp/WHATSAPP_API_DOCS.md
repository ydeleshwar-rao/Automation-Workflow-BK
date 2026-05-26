# WhatsApp Engine — API Documentation

> Custom WhatsApp integration powered by Baileys.  
> Base URL: `{{YOUR_SERVER}}/whatsapp`  
> All endpoints require authentication header: `Authorization: Bearer <token>`

---

## Table of Contents

1. [Connection & QR Code](#1-connection--qr-code)
2. [Webhook Setup](#2-webhook-setup)
3. [Send Messages](#3-send-messages)
   - [Text](#31-text-message)
   - [Image](#32-image)
   - [Video](#33-video)
   - [Audio](#34-audio)
   - [Voice Note](#35-voice-note-ptt)
   - [Document](#36-document)
   - [Location](#37-location)
   - [Contact Card](#38-contact-card)
   - [Interactive Buttons](#39-interactive-buttons)
   - [Interactive List](#310-interactive-list)
   - [Bulk Messages](#311-bulk-messages)
4. [Groups](#4-groups)
5. [Status / Story](#5-status--story)
6. [Channels](#6-channels)
7. [Utilities](#7-utilities)
8. [Incoming Webhook Events](#8-incoming-webhook-events)
9. [Error Responses](#9-error-responses)
10. [Frontend Integration Flow](#10-frontend-integration-flow)

---

## 1. Connection & QR Code

### Connect WhatsApp
Starts a new WhatsApp session. User must scan the QR code.

```
POST /whatsapp/connect
```

**Request**
```http
POST /whatsapp/connect
Authorization: Bearer eyJhbGc...
```

**Response**
```json
{
  "success": true,
  "message": "WhatsApp connection initiated",
  "data": {
    "message": "WhatsApp session initiated. Poll GET /whatsapp/qr for the QR code."
  }
}
```

---

### Get QR Code
Poll this endpoint after `/connect`. Show the `qr` base64 image to the user.

```
GET /whatsapp/qr
```

**Response — QR Ready (user must scan)**
```json
{
  "success": true,
  "message": "QR code status",
  "data": {
    "status": "qr_ready",
    "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
    "phone_number": null,
    "message": "Scan this QR code in WhatsApp → Linked Devices"
  }
}
```

**Response — Already Connected**
```json
{
  "success": true,
  "data": {
    "status": "connected",
    "qr": null,
    "phone_number": "923001234567",
    "message": "Already connected"
  }
}
```

**Frontend — Show QR Image**
```jsx
// React example
const [qr, setQr] = useState(null);

// Poll every 3 seconds until connected
useEffect(() => {
  const interval = setInterval(async () => {
    const res = await fetch('/whatsapp/qr', { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();

    if (json.data.status === 'connected') {
      clearInterval(interval);
      setConnected(true);
    } else if (json.data.qr) {
      setQr(json.data.qr);
    }
  }, 3000);
  return () => clearInterval(interval);
}, []);

// Render
{qr && <img src={qr} alt="Scan QR Code" width={250} />}
```

> **Status values:** `connecting` → `qr_ready` → `connected`

---

### Connection Status

```
GET /whatsapp/status
```

**Response**
```json
{
  "success": true,
  "data": {
    "connected": true,
    "status": "connected",
    "phone_number": "923001234567",
    "webhook_url": "https://yourapp.com/wa-webhook",
    "has_webhook": true
  }
}
```

---

### Disconnect WhatsApp
Logs out the session and wipes stored credentials.

```
DELETE /whatsapp/disconnect
```

**Response**
```json
{
  "success": true,
  "message": "WhatsApp disconnected successfully",
  "data": { "disconnected": true }
}
```

---

## 2. Webhook Setup

Webhooks allow your server to receive incoming WhatsApp messages and events in real-time.

### Set Webhook

```
POST /whatsapp/webhook
```

**Request Body**
```json
{
  "webhook_url": "https://yourapp.com/api/wa-events",
  "webhook_secret": "my_secret_key_123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhook_url` | string | Yes | Your server URL to receive events |
| `webhook_secret` | string | No | Used to sign payload (HMAC-SHA256) |

**Response**
```json
{
  "success": true,
  "message": "Webhook configured successfully",
  "data": { "webhook_url": "https://yourapp.com/api/wa-events" }
}
```

---

### Get Webhook

```
GET /whatsapp/webhook
```

**Response**
```json
{
  "success": true,
  "data": { "webhook_url": "https://yourapp.com/api/wa-events" }
}
```

---

### Remove Webhook

```
DELETE /whatsapp/webhook
```

**Response**
```json
{
  "success": true,
  "data": { "removed": true }
}
```

---

## 3. Send Messages

> **`to` field format:** Phone number with country code, no `+` or spaces.  
> Example: Pakistan `923001234567`, India `919876543210`, UAE `971501234567`

---

### 3.1 Text Message

```
POST /whatsapp/messages/text
```

**Request**
```json
{
  "to": "923001234567",
  "message": "Hello! How can I help you today?"
}
```

**Response**
```json
{
  "success": true,
  "message": "Text message sent",
  "data": { "message_id": "3EB0A1B2C3D4E5F6A7B8" }
}
```

---

### 3.2 Image

```
POST /whatsapp/messages/image
```

**Request**
```json
{
  "to": "923001234567",
  "url": "https://example.com/photo.jpg",
  "caption": "Check out this photo!",
  "mimetype": "image/jpeg"
}
```

| Field | Type | Required |
|-------|------|----------|
| `to` | string | Yes |
| `url` | string | Yes |
| `caption` | string | No |
| `mimetype` | string | No (default: `image/jpeg`) |

---

### 3.3 Video

```
POST /whatsapp/messages/video
```

**Request**
```json
{
  "to": "923001234567",
  "url": "https://example.com/video.mp4",
  "caption": "Watch this!",
  "mimetype": "video/mp4"
}
```

---

### 3.4 Audio

```
POST /whatsapp/messages/audio
```

**Request**
```json
{
  "to": "923001234567",
  "url": "https://example.com/audio.mp3",
  "mimetype": "audio/mpeg"
}
```

---

### 3.5 Voice Note (PTT)
Sends audio as a voice note (plays in WhatsApp voice player).

```
POST /whatsapp/messages/voice
```

**Request**
```json
{
  "to": "923001234567",
  "url": "https://example.com/voice.ogg",
  "mimetype": "audio/ogg; codecs=opus"
}
```

---

### 3.6 Document

```
POST /whatsapp/messages/document
```

**Request**
```json
{
  "to": "923001234567",
  "url": "https://example.com/invoice.pdf",
  "filename": "Invoice_2024.pdf",
  "caption": "Please find your invoice attached.",
  "mimetype": "application/pdf"
}
```

| Field | Type | Required |
|-------|------|----------|
| `to` | string | Yes |
| `url` | string | Yes |
| `filename` | string | No |
| `caption` | string | No |
| `mimetype` | string | No |

---

### 3.7 Location

```
POST /whatsapp/messages/location
```

**Request**
```json
{
  "to": "923001234567",
  "lat": 24.8607,
  "lng": 67.0011,
  "name": "Karachi Office",
  "address": "I.I. Chundrigar Road, Karachi"
}
```

| Field | Type | Required |
|-------|------|----------|
| `to` | string | Yes |
| `lat` | number | Yes |
| `lng` | number | Yes |
| `name` | string | No |
| `address` | string | No |

---

### 3.8 Contact Card

```
POST /whatsapp/messages/contact
```

**Request**
```json
{
  "to": "923001234567",
  "name": "Ahmed Ali",
  "phone": "923009876543",
  "org": "ABC Company"
}
```

---

### 3.9 Interactive Buttons
Sends a message with clickable buttons (max 3 buttons).

```
POST /whatsapp/messages/buttons
```

**Request**
```json
{
  "to": "923001234567",
  "text": "Please select an option:",
  "footer": "Powered by our support team",
  "buttons": [
    { "id": "btn_yes", "text": "Yes, confirm" },
    { "id": "btn_no", "text": "No, cancel" },
    { "id": "btn_help", "text": "Need help" }
  ]
}
```

| Field | Type | Required | Max |
|-------|------|----------|-----|
| `to` | string | Yes | — |
| `text` | string | Yes | — |
| `footer` | string | No | — |
| `buttons` | array | Yes | 3 buttons |

**What user sees in WhatsApp:**
```
┌─────────────────────────────┐
│  Please select an option:   │
├─────────────────────────────┤
│  [ Yes, confirm ]           │
│  [ No, cancel   ]           │
│  [ Need help    ]           │
├─────────────────────────────┤
│  Powered by our support team│
└─────────────────────────────┘
```

---

### 3.10 Interactive List
Sends a message with a scrollable list of options.

```
POST /whatsapp/messages/list
```

**Request**
```json
{
  "to": "923001234567",
  "text": "Choose a service from the list below:",
  "title": "Our Services",
  "buttonText": "View Services",
  "footer": "Tap the button to open",
  "sections": [
    {
      "title": "Plumbing",
      "rows": [
        { "id": "plumb_001", "title": "Pipe Repair", "description": "Fix leaking pipes" },
        { "id": "plumb_002", "title": "Drain Cleaning", "description": "Unblock drains" }
      ]
    },
    {
      "title": "Electrical",
      "rows": [
        { "id": "elec_001", "title": "Wiring", "description": "New wiring installation" },
        { "id": "elec_002", "title": "Fuse Box", "description": "Fuse box repair" }
      ]
    }
  ]
}
```

---

### 3.11 Bulk Messages
Send messages to multiple recipients with optional delay.

```
POST /whatsapp/messages/bulk
```

**Request**
```json
{
  "messages": [
    {
      "to": "923001234567",
      "message": "Hi Ahmed, your job #1042 is confirmed.",
      "delay_ms": 1000
    },
    {
      "to": "923009876543",
      "message": "Hi Sara, your appointment is at 3 PM tomorrow.",
      "delay_ms": 1000
    },
    {
      "to": "923451234567",
      "message": "Hi Ali, your invoice is ready.",
      "delay_ms": 1000
    }
  ]
}
```

> `delay_ms` — milliseconds to wait between messages (recommended: 1000–3000ms to avoid spam detection)

**Response**
```json
{
  "success": true,
  "message": "Bulk messages processed",
  "data": {
    "total": 3,
    "sent": 3,
    "failed": 0,
    "results": [
      { "to": "923001234567", "status": "sent", "message_id": "3EB0A1..." },
      { "to": "923009876543", "status": "sent", "message_id": "3EB0A2..." },
      { "to": "923451234567", "status": "sent", "message_id": "3EB0A3..." }
    ]
  }
}
```

---

## 4. Groups

### Get All Groups

```
GET /whatsapp/groups
```

**Response**
```json
{
  "success": true,
  "data": [
    {
      "id": "120363012345678901@g.us",
      "name": "Team Alpha",
      "description": "Internal team group",
      "participant_count": 8,
      "participants": [
        { "jid": "923001234567@s.whatsapp.net", "role": "superadmin" },
        { "jid": "923009876543@s.whatsapp.net", "role": "admin" },
        { "jid": "923451234567@s.whatsapp.net", "role": "member" }
      ],
      "created_at": 1700000000
    }
  ]
}
```

---

### Create Group

```
POST /whatsapp/groups
```

**Request**
```json
{
  "name": "Project Phoenix Team",
  "participants": ["923001234567", "923009876543", "923451234567"]
}
```

**Response**
```json
{
  "success": true,
  "message": "Group created",
  "data": {
    "group_id": "120363099887766554@g.us",
    "name": "Project Phoenix Team",
    "participants": [...]
  }
}
```

---

### Get Group Info

```
GET /whatsapp/groups/:groupId
```

**Example**
```
GET /whatsapp/groups/120363012345678901@g.us
```

---

### Send Message to Group

```
POST /whatsapp/groups/:groupId/message
```

**Request**
```json
{
  "message": "Team meeting at 3 PM today. Please be on time."
}
```

---

### Add Participants to Group

```
POST /whatsapp/groups/:groupId/participants/add
```

**Request**
```json
{
  "participants": ["923001112222", "923003334444"]
}
```

---

### Remove Participants from Group

```
POST /whatsapp/groups/:groupId/participants/remove
```

**Request**
```json
{
  "participants": ["923001112222"]
}
```

---

### Promote to Admin

```
POST /whatsapp/groups/:groupId/participants/promote
```

**Request**
```json
{
  "participants": ["923001112222"]
}
```

---

### Demote from Admin

```
POST /whatsapp/groups/:groupId/participants/demote
```

**Request**
```json
{
  "participants": ["923001112222"]
}
```

---

### Update Group Name

```
PATCH /whatsapp/groups/:groupId/subject
```

**Request**
```json
{
  "subject": "Project Phoenix — Phase 2"
}
```

---

### Update Group Description

```
PATCH /whatsapp/groups/:groupId/description
```

**Request**
```json
{
  "description": "Official group for Phase 2 project updates."
}
```

---

### Get Group Invite Link

```
GET /whatsapp/groups/:groupId/invite
```

**Response**
```json
{
  "success": true,
  "data": {
    "invite_link": "https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv"
  }
}
```

---

### Leave Group

```
DELETE /whatsapp/groups/:groupId/leave
```

---

## 5. Status / Story

Post updates to your WhatsApp Status (visible to your contacts for 24 hours).

### Text Status

```
POST /whatsapp/status/text
```

**Request**
```json
{
  "text": "We are open for business! Contact us for a free quote.",
  "background_color": "#075E54"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Status text |
| `background_color` | string | No | Hex color (default: black) |

---

### Image Status

```
POST /whatsapp/status/image
```

**Request**
```json
{
  "image_url": "https://example.com/promo-banner.jpg",
  "caption": "Special offer — 20% off this weekend!"
}
```

---

### Video Status

```
POST /whatsapp/status/video
```

**Request**
```json
{
  "video_url": "https://example.com/promo-video.mp4",
  "caption": "Watch our latest product demo"
}
```

---

## 6. Channels

### Get Channels

```
GET /whatsapp/channels
```

**Response**
```json
{
  "success": true,
  "data": {
    "channels": []
  }
}
```

> Note: WhatsApp Channels support requires the latest Baileys version.

---

### Send Message to Channel

```
POST /whatsapp/channels/send
```

**Request**
```json
{
  "channel_jid": "120363999888777666@newsletter",
  "message": "New update available! Check our website for details."
}
```

---

## 7. Utilities

### Check if Number is on WhatsApp

```
GET /whatsapp/check/:phone
```

**Example**
```
GET /whatsapp/check/923001234567
```

**Response**
```json
{
  "success": true,
  "data": {
    "exists": true,
    "jid": "923001234567@s.whatsapp.net"
  }
}
```

> Use this before sending a message to verify the number exists.

---

### Get Profile Picture

```
GET /whatsapp/profile/:phone
```

**Example**
```
GET /whatsapp/profile/923001234567
```

**Response**
```json
{
  "success": true,
  "data": {
    "picture_url": "https://pps.whatsapp.net/v/t61.24694-24/..."
  }
}
```

---

## 8. Incoming Webhook Events

When someone sends you a WhatsApp message, the engine forwards it to your configured webhook URL.

### Webhook Request (POST to your server)

**Headers**
```
Content-Type: application/json
User-Agent: WhatsAppEngine/1.0
x-wa-event: message
x-wa-timestamp: 2024-01-15T10:30:00.000Z
x-wa-signature: sha256=a1b2c3d4e5f6...  (only if webhook_secret is set)
```

---

### Event: `message` — Incoming Message

```json
{
  "user_id": "user-uuid-here",
  "event": "message",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "data": {
    "id": "3EB0AABBCCDDEEFF1122",
    "from": "923001234567@s.whatsapp.net",
    "push_name": "Ahmed Ali",
    "is_group": false,
    "message_type": "conversation",
    "timestamp": 1705312200,
    "content": {
      "conversation": "Hello, I need help with my order."
    }
  }
}
```

**Group Message**
```json
{
  "user_id": "user-uuid-here",
  "event": "message",
  "data": {
    "id": "3EB0AABBCCDDEEFF1122",
    "from": "120363012345678901@g.us",
    "push_name": "Sara Khan",
    "is_group": true,
    "message_type": "conversation",
    "content": {
      "conversation": "When is the next meeting?"
    }
  }
}
```

---

### Event: `message_ack` — Message Delivery Status

```json
{
  "user_id": "user-uuid-here",
  "event": "message_ack",
  "data": {
    "id": "3EB0AABBCCDDEEFF1122",
    "to": "923001234567@s.whatsapp.net",
    "status": 4
  }
}
```

| Status Code | Meaning |
|-------------|---------|
| `1` | Pending (clock icon) |
| `2` | Sent to server (single tick) |
| `3` | Delivered to phone (double tick) |
| `4` | Read (blue double tick) |
| `5` | Played (audio) |

---

### Event: `connected`

```json
{
  "user_id": "user-uuid-here",
  "event": "connected",
  "data": { "phone_number": "923001234567" }
}
```

---

### Event: `disconnected`

```json
{
  "user_id": "user-uuid-here",
  "event": "disconnected",
  "data": { "status_code": 401, "logged_out": true }
}
```

---

### Event: `qr`

```json
{
  "user_id": "user-uuid-here",
  "event": "qr",
  "data": { "qr": "data:image/png;base64,iVBOR..." }
}
```

---

### Event: `group_update`

```json
{
  "user_id": "user-uuid-here",
  "event": "group_update",
  "data": {
    "group_jid": "120363012345678901@g.us",
    "action": "add",
    "participants": ["923001234567@s.whatsapp.net"]
  }
}
```

---

### Verifying Webhook Signature (Node.js)

```js
const crypto = require('crypto');

function verifyWebhook(req, secret) {
  const signature = req.headers['x-wa-signature'];
  if (!signature) return false;

  const body = JSON.stringify(req.body);
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// Express route
app.post('/wa-webhook', (req, res) => {
  if (!verifyWebhook(req, 'my_secret_key_123')) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { event, data } = req.body;

  switch (event) {
    case 'message':
      console.log('New message from:', data.from);
      console.log('Text:', data.content?.conversation);
      break;
    case 'connected':
      console.log('WhatsApp connected:', data.phone_number);
      break;
    case 'disconnected':
      console.log('WhatsApp disconnected');
      break;
  }

  res.status(200).json({ received: true });
});
```

---

## 9. Error Responses

All errors follow this format:

```json
{
  "success": false,
  "message": "Error description here",
  "statusCode": 400
}
```

| Status Code | Meaning |
|-------------|---------|
| `400` | Bad request — missing or invalid fields |
| `401` | Unauthorized — invalid or missing token |
| `429` | Rate limit exceeded — too many requests |
| `500` | Server error |

**Common Errors**

```json
// WhatsApp not connected
{
  "success": false,
  "message": "WhatsApp not connected. Call POST /whatsapp/connect first."
}

// Session connecting (QR not ready yet)
{
  "success": false,
  "message": "WhatsApp status is \"qr_ready\". Wait for the connection to open."
}
```

---

## 10. Frontend Integration Flow

### Complete Connection Flow (React)

```jsx
import { useState, useEffect } from 'react';

const API = '/whatsapp';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

export function WhatsAppConnect() {
  const [status, setStatus] = useState('disconnected'); // disconnected | connecting | qr_ready | connected
  const [qr, setQr] = useState(null);
  const [phone, setPhone] = useState(null);

  // Step 1: Initiate connection
  const handleConnect = async () => {
    setStatus('connecting');
    await fetch(`${API}/connect`, { method: 'POST', headers });
    startPolling();
  };

  // Step 2: Poll for QR code
  const startPolling = () => {
    const interval = setInterval(async () => {
      const res = await fetch(`${API}/qr`, { headers });
      const json = await res.json();
      const { status: s, qr: qrCode, phone_number } = json.data;

      setStatus(s);

      if (s === 'qr_ready' && qrCode) setQr(qrCode);

      if (s === 'connected') {
        setPhone(phone_number);
        setQr(null);
        clearInterval(interval);
      }
    }, 3000);
  };

  // Step 3: Disconnect
  const handleDisconnect = async () => {
    await fetch(`${API}/disconnect`, { method: 'DELETE', headers });
    setStatus('disconnected');
    setPhone(null);
    setQr(null);
  };

  return (
    <div>
      {status === 'disconnected' && (
        <button onClick={handleConnect}>Connect WhatsApp</button>
      )}

      {status === 'connecting' && (
        <p>Starting session...</p>
      )}

      {status === 'qr_ready' && qr && (
        <div>
          <p>Scan this QR code in WhatsApp → Linked Devices</p>
          <img src={qr} alt="WhatsApp QR Code" width={250} />
        </div>
      )}

      {status === 'connected' && (
        <div>
          <p>✅ Connected: +{phone}</p>
          <button onClick={handleDisconnect}>Disconnect</button>
        </div>
      )}
    </div>
  );
}
```

---

### Send Message (React)

```jsx
async function sendWhatsAppMessage(to, message) {
  const res = await fetch('/whatsapp/messages/text', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, message }),
  });
  const json = await res.json();

  if (!json.success) throw new Error(json.message);
  return json.data.message_id;
}

// Usage
await sendWhatsAppMessage('923001234567', 'Your job is confirmed!');
```

---

### Setup Webhook (one-time)

```js
await fetch('/whatsapp/webhook', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    webhook_url: 'https://yourapp.com/api/wa-events',
    webhook_secret: 'your_secret_here'
  })
});
```

---

## Quick Reference — All Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/whatsapp/connect` | Start WhatsApp session |
| GET | `/whatsapp/qr` | Get QR code (poll this) |
| GET | `/whatsapp/status` | Connection status |
| DELETE | `/whatsapp/disconnect` | Disconnect session |
| POST | `/whatsapp/webhook` | Set webhook URL |
| GET | `/whatsapp/webhook` | Get webhook config |
| DELETE | `/whatsapp/webhook` | Remove webhook |
| POST | `/whatsapp/messages/text` | Send text |
| POST | `/whatsapp/messages/image` | Send image |
| POST | `/whatsapp/messages/video` | Send video |
| POST | `/whatsapp/messages/audio` | Send audio |
| POST | `/whatsapp/messages/voice` | Send voice note |
| POST | `/whatsapp/messages/document` | Send document |
| POST | `/whatsapp/messages/location` | Send location |
| POST | `/whatsapp/messages/contact` | Send contact card |
| POST | `/whatsapp/messages/buttons` | Send button message |
| POST | `/whatsapp/messages/list` | Send list message |
| POST | `/whatsapp/messages/bulk` | Send bulk messages |
| GET | `/whatsapp/groups` | List all groups |
| POST | `/whatsapp/groups` | Create group |
| GET | `/whatsapp/groups/:groupId` | Get group info |
| POST | `/whatsapp/groups/:groupId/message` | Send to group |
| POST | `/whatsapp/groups/:groupId/participants/add` | Add members |
| POST | `/whatsapp/groups/:groupId/participants/remove` | Remove members |
| POST | `/whatsapp/groups/:groupId/participants/promote` | Make admin |
| POST | `/whatsapp/groups/:groupId/participants/demote` | Remove admin |
| PATCH | `/whatsapp/groups/:groupId/subject` | Update group name |
| PATCH | `/whatsapp/groups/:groupId/description` | Update description |
| GET | `/whatsapp/groups/:groupId/invite` | Get invite link |
| DELETE | `/whatsapp/groups/:groupId/leave` | Leave group |
| POST | `/whatsapp/status/text` | Post text status |
| POST | `/whatsapp/status/image` | Post image status |
| POST | `/whatsapp/status/video` | Post video status |
| GET | `/whatsapp/channels` | List channels |
| POST | `/whatsapp/channels/send` | Send to channel |
| GET | `/whatsapp/check/:phone` | Check number exists |
| GET | `/whatsapp/profile/:phone` | Get profile picture |

---

*WhatsApp Engine — Built with Baileys*
