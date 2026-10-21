'use strict';

const { chromium } = require('playwright');

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

class PmhError extends Error {
  constructor(message, code = 'PMH_ERROR', details = {}) {
    super(message);
    this.name = 'PmhError';
    this.code = code;
    Object.assign(this, details);
  }
}

class PmhClient {
  constructor({ url, username, password, storeCode }) {
    if (!url || !username || !password || !storeCode) {
      throw new Error('Thiếu PMH_URL, PMH_USER, PMH_PASSWORD hoặc PMH_STORE_CODE.');
    }

    this.url = url;
    this.username = username;
    this.password = password;
    this.storeCode = storeCode;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.authenticated = false;
  }

  get app() {
    if (!this.page) throw new Error('Trình duyệt PMH chưa được khởi tạo.');
    return this.page.frameLocator('#sandboxFrame').frameLocator('#userHtmlFrame');
  }

  async ensurePage() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext();
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      this.authenticated = false;
    }
  }

  async login(force = false) {
    await this.ensurePage();
    if (this.authenticated && !force) return;

    this.authenticated = false;
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    const app = this.app;
    const userField = app.locator('#loginUser');
    const passwordField = app.locator('#loginPass');
    const loginButton = app.getByRole('button', { name: 'Đăng nhập', exact: true });

    await userField.waitFor({ state: 'visible', timeout: 30_000 });
    await userField.fill(this.username);
    await passwordField.fill(this.password);
    await loginButton.click();

    try {
      await app.locator('#appBox').waitFor({ state: 'visible', timeout: 30_000 });
      await app.locator('#nhom option').nth(1).waitFor({ state: 'attached', timeout: 30_000 });
    } catch (error) {
      const message = await app.locator('#loginMessage').innerText().catch(() => '');
      throw new PmhError(
        message || 'Không đăng nhập được hệ thống PMH.',
        'LOGIN_FAILED',
        { cause: error }
      );
    }

    this.authenticated = true;
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.authenticated = false;
  }

  async getCatalog() {
    await this.login();
    const rows = await this.app.locator('#statsBody tr').all();
    const items = [];

    for (const row of rows) {
      const cells = await row.locator('td').allTextContents();
      if (cells.length < 6) continue;

      const usedTotal = cells[2].trim().match(/(\d+)\s*\/\s*(\d+)/);
      items.push({
        group: cells[0].trim(),
        name: cells[1].trim(),
        used: usedTotal ? Number(usedTotal[1]) : null,
        total: usedTotal ? Number(usedTotal[2]) : null,
        remaining: Number(cells[4].trim().replace(/[^0-9-]/g, '')) || 0,
        status: cells[5].trim()
      });
    }

    return items;
  }

  findMatches(items, query) {
    const wanted = normalize(query);
    if (!wanted) return [];

    const exact = items.filter((item) => normalize(item.name) === wanted);
    if (exact.length) return exact;

    return items.filter((item) => {
      const name = normalize(item.name);
      const group = normalize(item.group);
      return name.includes(wanted) || wanted.includes(name) || group.includes(wanted);
    });
  }

  async takeCode(query, storeCode = this.storeCode) {
    await this.login();
    const items = await this.getCatalog();
    const matches = this.findMatches(items, query);

    if (!matches.length) {
      throw new PmhError(`Không tìm thấy PMH phù hợp với: ${query}`, 'NOT_FOUND');
    }

    const exact = matches.filter((item) => normalize(item.name) === normalize(query));
    if (matches.length > 1 && exact.length !== 1) {
      throw new PmhError(
        'Có nhiều PMH phù hợp, vui lòng gửi đúng tên PMH.',
        'AMBIGUOUS',
        { matches: matches.slice(0, 10) }
      );
    }

    const item = exact[0] || matches[0];
    return this.takeExactCode(item, storeCode);
  }

  async takeExactCode(item, storeCode) {
    const app = this.app;

    await app.locator('#nhom').selectOption({ label: item.group });
    await app.locator('#ten').selectOption({ label: item.name });
    await app.locator('#maKho').fill(String(storeCode));

    // Ẩn kết quả cũ trước khi bấm lấy lần tiếp theo, tránh đọc nhầm code cũ
    // trong lúc google.script.run đang xử lý yêu cầu mới.
    await app.locator('#result').evaluate((element) => {
      element.style.display = 'none';
    });
    await app.locator('#message').evaluate((element) => {
      element.style.display = 'none';
    });

    await app.getByRole('button', { name: 'Lấy Code PMH', exact: true }).click();

    const result = app.locator('#result');
    const message = app.locator('#message');
    const deadline = Date.now() + 70_000;

    while (Date.now() < deadline) {
      if (await result.isVisible().catch(() => false)) {
        const text = await result.innerText();
        const codeMatch = text.match(/CODE PMH:\s*([^\s\n]+)/i);
        if (!codeMatch) {
          throw new PmhError('Hệ thống trả kết quả nhưng chưa đọc được mã PMH.', 'BAD_RESULT', { text });
        }

        const small = await result.locator('small').allTextContents();
        return {
          group: item.group,
          name: item.name,
          code: codeMatch[1].trim(),
          time: small[0] ? small[0].replace(/^Thời gian lấy:\s*/i, '').trim() : '',
          user: small[1] ? small[1].replace(/^User lấy:\s*/i, '').trim() : '',
          note: small[2] ? small[2].replace(/^Ghi chú:\s*/i, '').trim() : ''
        };
      }

      if (await message.isVisible().catch(() => false)) {
        const text = (await message.innerText()).trim();
        if (text) {
          if (/đăng nhập lại/i.test(text)) {
            throw new PmhError(text, 'SESSION_EXPIRED');
          }
          throw new PmhError(text, 'PMH_UNAVAILABLE');
        }
      }

      await this.page.waitForTimeout(250);
    }

    throw new PmhError('Hệ thống PMH phản hồi quá lâu.', 'TIMEOUT');
  }

  async takeCodeWithRecovery(query, storeCode = this.storeCode) {
    try {
      return await this.takeCode(query, storeCode);
    } catch (error) {
      if (!(error instanceof PmhError) || error.code !== 'SESSION_EXPIRED') throw error;
      await this.login(true);
      return this.takeCode(query, storeCode);
    }
  }
}

module.exports = { PmhClient, PmhError, normalize };
