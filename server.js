'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { LineClient, verifyLineSignature } = require('./line-client');
const { PmhClient, PmhError, normalize } = require('./pmh-client');

const config = {
  port: Number(process.env.PORT || 3000),
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  pmhUrl: process.env.PMH_URL,
  pmhUser: process.env.PMH_USER,
  pmhPassword: process.env.PMH_PASSWORD,
  storeCode: process.env.PMH_STORE_CODE
};

for (const [key, value] of Object.entries(config)) {
  if (key !== 'port' && !value) throw new Error(`Thiếu biến môi trường bắt buộc: ${key}`);
}

const line = new LineClient(config.accessToken);
const pmh = new PmhClient({
  url: config.pmhUrl,
  username: config.pmhUser,
  password: config.pmhPassword,
  storeCode: config.storeCode
});

let queue = Promise.resolve();
const seenEvents = new Map();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function rememberEvent(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, time] of seenEvents) {
    if (now - time > 10 * 60 * 1000) seenEvents.delete(key);
  }
  if (seenEvents.has(id)) return true;
  seenEvents.set(id, now);
  return false;
}

function textMessage(text) {
  return { type: 'text', text: String(text).slice(0, 5000) };
}

function splitText(text, size = 4500) {
  const parts = [];
  let remaining = String(text);
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < Math.floor(size * 0.6)) cut = size;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining) parts.push(remaining);
  return parts.slice(0, 5).map(textMessage);
}

function helpText() {
  return [
    'HƯỚNG DẪN BOT PMH',
    '',
    '1. Gửi PMH để xem danh sách PMH còn phiếu.',
    '2. Gửi: Lấy PMH <tên PMH>',
    '3. Có thể gửi một phần tên để bot tìm kiếm.',
    '',
    'Ví dụ:',
    'Lấy PMH Máy lạnh (sản phẩm dưới 10tr) CT Roadshow trị giá 200.000đ'
  ].join('\n');
}

function catalogText(items, keyword = '') {
  const wanted = normalize(keyword);
  const filtered = wanted
    ? items.filter((item) => normalize(`${item.group} ${item.name}`).includes(wanted))
    : items;

  if (!filtered.length) return 'Không tìm thấy PMH phù hợp.';

  const groups = new Map();
  for (const item of filtered) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }

  const lines = ['DANH SÁCH PMH', ''];
  for (const [group, groupItems] of groups) {
    lines.push(`[${group}]`);
    for (const item of groupItems) {
      const stock = item.remaining > 0 ? `Còn ${item.remaining}` : 'Hết phiếu';
      lines.push(`- ${item.name} | ${stock}`);
    }
    lines.push('');
  }
  lines.push('Cú pháp lấy: Lấy PMH <tên PMH>');
  return lines.join('\n').trim();
}

function formatMatches(matches) {
  return [
    'Có nhiều PMH phù hợp. Hãy gửi đúng tên một PMH:',
    '',
    ...matches.map((item) => `- ${item.name}`)
  ].join('\n');
}

function codeText(result) {
  return [
    'CODE PMH:',
    result.code,
    '',
    `PMH: ${result.name}`,
    result.user ? `NV: ${result.user}` : '',
    result.time ? `Thời gian lấy: ${result.time}` : '',
    result.note ? `Ghi chú: ${result.note}` : ''
  ].filter(Boolean).join('\n');
}

function errorText(error) {
  if (error instanceof PmhError) {
    if (error.code === 'AMBIGUOUS') return formatMatches(error.matches || []);
    if (error.code === 'NOT_FOUND') return error.message;
    if (error.code === 'PMH_UNAVAILABLE') return error.message;
    if (error.code === 'LOGIN_FAILED') return 'Không đăng nhập được hệ thống PMH. Vui lòng kiểm tra tài khoản hoặc mật khẩu trên máy chủ bot.';
  }
  return 'Bot gặp lỗi khi lấy PMH. Vui lòng thử lại sau.';
}

function parseCommand(input) {
  const text = String(input || '').trim();
  const lower = normalize(text);

  if (!text) return { type: 'help' };
  if (lower === 'help' || lower === 'tro giup' || lower === 'huong dan') return { type: 'help' };
  if (lower === 'pmh') return { type: 'catalog', keyword: '' };
  if (lower.startsWith('pmh ')) return { type: 'catalog', keyword: text.slice(3).trim() };

  const takeMatch = text.match(/^\s*(?:🎫\s*)?(?:lấy|lay)\s+pmh\s+(.+)$/iu);
  if (takeMatch) return { type: 'take', query: takeMatch[1].trim() };

  return { type: 'help' };
}

async function processCommand(command) {
  if (command.type === 'help') return [textMessage(helpText())];

  if (command.type === 'catalog') {
    const items = await pmh.getCatalog();
    return splitText(catalogText(items, command.keyword));
  }

  if (command.type === 'take') {
    const result = await pmh.takeCodeWithRecovery(command.query);
    return [textMessage(codeText(result))];
  }

  return [textMessage(helpText())];
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message?.type !== 'text') return;
  if (rememberEvent(event.webhookEventId)) return;

  const sourceId = event.source?.userId;
  const command = parseCommand(event.message.text);

  // Trả lời ngay để LINE không hết thời gian chờ; kết quả dài do bot push tiếp.
  if (sourceId && command.type !== 'help') {
    await line.reply(event.replyToken, [textMessage('Đang xử lý yêu cầu PMH...')]);
    await enqueue(async () => {
      try {
        await line.push(sourceId, await processCommand(command));
      } catch (error) {
        console.error('[PMH]', error.message);
        await line.push(sourceId, [textMessage(errorText(error))]);
      }
    });
    return;
  }

  await enqueue(async () => {
    try {
      await line.reply(event.replyToken, await processCommand(command));
    } catch (error) {
      console.error('[PMH]', error.message);
      await line.reply(event.replyToken, [textMessage(errorText(error))]);
    }
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Payload quá lớn.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, service: 'pmh-line-bot' }));
    return;
  }

  if (request.method !== 'POST' || requestUrl.pathname !== '/callback') {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const body = await readBody(request);
  const signature = request.headers['x-line-signature'];
  if (!verifyLineSignature(body, signature, config.channelSecret)) {
    response.writeHead(401);
    response.end('Invalid signature');
    return;
  }

  response.writeHead(200);
  response.end('OK');

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }

  for (const event of payload.events || []) {
    void handleEvent(event).catch((error) => console.error('[LINE]', error.message));
  }
});

server.listen(config.port, () => {
  console.log(`PMH LINE bot listening on port ${config.port}`);
});

process.on('SIGTERM', async () => {
  await pmh.close().catch(() => {});
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  await pmh.close().catch(() => {});
  server.close(() => process.exit(0));
});
