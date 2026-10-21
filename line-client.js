'use strict';

const crypto = require('node:crypto');

function verifyLineSignature(body, signature, channelSecret) {
  if (!body || !signature || !channelSecret) return false;

  const digest = crypto
    .createHmac('sha256', channelSecret)
    .update(body)
    .digest('base64');

  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(String(signature), 'utf8');

  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

class LineClient {
  constructor(accessToken) {
    if (!accessToken) throw new Error('Thiếu LINE_CHANNEL_ACCESS_TOKEN.');
    this.accessToken = accessToken;
    this.baseUrl = 'https://api.line.me/v2/bot';
  }

  async request(path, payload) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LINE API ${response.status}: ${detail.slice(0, 300)}`);
    }
  }

  async reply(replyToken, messages) {
    return this.request('/message/reply', { replyToken, messages });
  }

  async push(to, messages) {
    return this.request('/message/push', { to, messages });
  }
}

module.exports = { LineClient, verifyLineSignature };
