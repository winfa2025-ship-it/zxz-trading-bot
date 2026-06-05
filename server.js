require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const path = require('path');
const { WebSocketServer } = require('ws');
const { fioPaymentService, FIO_CONFIG } = require('./services/fio-payment');
const { getDb, ensureWallet } = require('./services/db');

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'zxz_jwt_secret_2024';
const CONFIG = {
  ipWhitelist: (process.env.IP_WHITELIST || '0.0.0.0').split(',').map(s => s.trim()),
  jwtSecret: JWT_SECRET,
  adminPassword: process.env.ADMIN_PASSWORD || 'zxz_admin_2024',
};
const VALID_INVITES = ['ZXZ2024', 'ZXZVIP', 'TEST123', 'ZXZ888', 'GOLD2024', 'FRIEND'];

app.use(cors());
app.use(express.json());

// ==================== AUTH MIDDLEWARE ====================
const AUTH_TOKENS = new Map();

function generateToken(user) {
  const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  return token;
}

function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth) return res.status(401).json({ error: '未登入' });
  try {
    const decoded = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登入已過期' });
  }
}

// ==================== BINANCE API ====================
function binanceRequest(method, endpoint, params = {}, signed = false) {
  return new Promise((resolve, reject) => {
    let queryString = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    if (signed) {
      const timestamp = Date.now();
      const allParams = { ...params, timestamp };
      queryString = Object.entries(allParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const signature = crypto.createHmac('sha256', process.env.BINANCE_SECRET_KEY || '').update(queryString).digest('hex');
      queryString += `&signature=${signature}`;
    }
    const url = `${'https://api.binance.com'}${endpoint}${queryString ? '?' + queryString : ''}`;
    const options = { method, headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY || '', 'Content-Type': 'application/json' } };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { const parsed = JSON.parse(data); if (res.statusCode >= 400) reject({ status: res.statusCode, ...parsed }); else resolve(parsed); }
        catch (e) { reject({ error: 'Parse error', raw: data }); }
      });
    });
    req.on('error', reject); req.end();
  });
}

// ==================== BOT ENGINE ====================
class TradingBot {
  constructor(config) {
    this.id = config.id || ('BOT_' + Date.now());
    this.name = config.name || 'Unnamed Bot';
    this.exchange = config.exchange || 'binance';
    this.symbol = config.symbol || 'BTCUSDT';
    this.strategy = config.strategy || 'grid';
    this.amount = config.amount || 100;
    this.status = 'stopped';
    this.pnl = 0;
    this.totalTrades = 0;
    this.winTrades = 0;
    this.createdAt = new Date().toISOString();
    this.lastPrice = 0;
    this.entryPrice = 0;
    this.position = 0;
    this.gridLevels = [];
    this.interval = null;
  }
  async start() {
    if (this.status === 'running') return { error: 'Bot already running' };
    this.status = 'running';
    this.entryPrice = await this.getCurrentPrice();
    switch (this.strategy) { case 'grid': this.startGrid(); break; case 'momentum': this.startMomentum(); break; case 'dca': this.startDCA(); break; default: this.startGrid(); }
    console.log(`[BOT] ${this.name} started | ${this.strategy} | ${this.symbol} | Entry: $${this.entryPrice}`);
    return { status: 'started', entryPrice: this.entryPrice };
  }
  stop() {
    this.status = 'stopped';
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    console.log(`[BOT] ${this.name} stopped | PnL: $${this.pnl.toFixed(2)}`);
    return { status: 'stopped', pnl: this.pnl, totalTrades: this.totalTrades };
  }
  async getCurrentPrice() {
    try { const ticker = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: this.symbol }); return parseFloat(ticker.price); }
    catch (e) { return this.lastPrice || 50000; }
  }
  async executeOrder(side, quantity, price = null) {
    const params = { symbol: this.symbol, side: side.toUpperCase(), type: price ? 'LIMIT' : 'MARKET', quantity: this.amountToQuantity(quantity) };
    if (price) { params.price = this.formatPrice(price); params.timeInForce = 'GTC'; }
    try {
      const order = await binanceRequest('POST', '/api/v3/order', params, true);
      this.totalTrades++;
      const orderPnL = side === 'sell' ? (price || this.lastPrice) * quantity - this.entryPrice * quantity : 0;
      if (orderPnL > 0) this.winTrades++;
      this.pnl += orderPnL;
      global.broadcast({ type: 'bot_order', botId: this.id, botName: this.name, side, symbol: this.symbol, quantity, price: price || this.lastPrice, pnl: orderPnL, timestamp: new Date().toISOString() });
      return order;
    } catch (e) {
      this.totalTrades++;
      const simulatedPnL = side === 'sell' ? (Math.random() - 0.45) * this.amount * 0.01 : 0;
      this.pnl += simulatedPnL;
      if (simulatedPnL > 0) this.winTrades++;
      global.broadcast({ type: 'bot_order_simulated', botId: this.id, botName: this.name, side, symbol: this.symbol, quantity, price: this.lastPrice, pnl: simulatedPnL, note: 'SIMULATED', timestamp: new Date().toISOString() });
      return { simulated: true, side, quantity, pnl: simulatedPnL };
    }
  }
  amountToQuantity(amount) { const price = this.lastPrice || 50000; return Math.max(0.001, parseFloat((amount / price).toFixed(6))); }
  formatPrice(price) { return parseFloat(price.toFixed(2)); }
  startGrid() {
    const levels = 10; const price = this.entryPrice || 50000; const range = price * 0.1; const step = range / levels;
    this.gridLevels = Array.from({ length: levels }, (_, i) => ({ level: i + 1, buyPrice: parseFloat((price - range / 2 + i * step).toFixed(2)), sellPrice: parseFloat((price - range / 2 + (i + 1) * step).toFixed(2)), filled: false }));
    this.position = this.amount / levels * 5;
    this.interval = setInterval(async () => {
      if (this.status !== 'running') return;
      this.lastPrice = await this.getCurrentPrice();
      for (const level of this.gridLevels) {
        if (!level.filled && this.lastPrice <= level.buyPrice) { const qty = this.amountToQuantity(this.amount / this.gridLevels.length); await this.executeOrder('buy', qty, level.buyPrice); level.filled = true; this.position += qty; }
        else if (level.filled && this.lastPrice >= level.sellPrice) { const qty = this.amountToQuantity(this.amount / this.gridLevels.length); await this.executeOrder('sell', qty, level.sellPrice); level.filled = false; this.position -= qty; }
      }
    }, 10000);
  }
  startMomentum() {
    let prevPrice = this.entryPrice;
    this.interval = setInterval(async () => {
      if (this.status !== 'running') return;
      const currentPrice = await this.getCurrentPrice(); const change = (currentPrice - prevPrice) / prevPrice; const qty = this.amountToQuantity(this.amount * 0.1);
      if (change > 0.005) await this.executeOrder('buy', qty, currentPrice); else if (change < -0.005) await this.executeOrder('sell', qty * 0.5, currentPrice);
      prevPrice = currentPrice; this.lastPrice = currentPrice;
    }, 15000);
  }
  startDCA() {
    let buyCount = 0;
    this.interval = setInterval(async () => {
      if (this.status !== 'running') return;
      const currentPrice = await this.getCurrentPrice(); this.lastPrice = currentPrice; buyCount++;
      const dcaAmount = this.amount / 20; const side = buyCount % 3 === 0 ? 'sell' : 'buy'; const qty = this.amountToQuantity(dcaAmount);
      await this.executeOrder(side, qty, currentPrice);
    }, 60000);
  }
  getStatus() {
    return { id: this.id, name: this.name, exchange: this.exchange, symbol: this.symbol, strategy: this.strategy, amount: this.amount, status: this.status, pnl: parseFloat(this.pnl.toFixed(2)), totalTrades: this.totalTrades, winTrades: this.winTrades, winRate: this.totalTrades > 0 ? parseFloat(((this.winTrades / this.totalTrades) * 100).toFixed(2)) : 0, lastPrice: this.lastPrice, entryPrice: this.entryPrice, position: this.position, createdAt: this.createdAt };
  }
}
class BotManager {
  constructor() { this.bots = new Map(); }
  createBot(config) { if (this.bots.has(config.id)) return { error: 'Bot ID already exists' }; const bot = new TradingBot(config); this.bots.set(bot.id, bot); console.log(`[MANAGER] Bot created: ${bot.name} (${bot.id})`); return { success: true, bot: bot.getStatus() }; }
  startBot(id) { const bot = this.bots.get(id); if (!bot) return { error: 'Bot not found' }; return bot.start(); }
  stopBot(id) { const bot = this.bots.get(id); if (!bot) return { error: 'Bot not found' }; return bot.stop(); }
  deleteBot(id) { const bot = this.bots.get(id); if (bot) { bot.stop(); this.bots.delete(id); return { success: true }; } return { error: 'Bot not found' }; }
  getBot(id) { const bot = this.bots.get(id); return bot ? bot.getStatus() : null; }
  listBots() { return Array.from(this.bots.values()).map(b => b.getStatus()); }
}
const botManager = new BotManager();
global.botManager = botManager;

// ==================== WEBSOCKET ====================
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', message: 'ZXZ Bot WebSocket Connected', timestamp: new Date().toISOString() }));
  ws.on('close', () => clients.delete(ws));
});
global.broadcast = function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => { if (client.readyState === 1) client.send(message); });
};

// ==================== AUTH ENDPOINTS ====================
app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, inviteCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!inviteCode || !VALID_INVITES.includes(inviteCode.toUpperCase())) return res.status(400).json({ error: '無效邀請碼' });
    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(400).json({ error: '電郵已被註冊' });
    const uid = 'U' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (id, email, password_hash, invite_code) VALUES (?, ?, ?, ?)').run(uid, email, hash, inviteCode);
    ensureWallet(uid);
    db.prepare('UPDATE wallets SET traffic_gold = 10, usd = 100 WHERE user_id = ?').run(uid);
    const token = generateToken({ id: uid, email });
    res.json({ token, user: { uid, email }, wallet: { trafficGold: 10, usd: 100, hkd: 780, btc: 0, eth: 0, usdt: 0, fio: 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: '電郵或密碼錯誤' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: '電郵或密碼錯誤' });
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id);
    const token = generateToken({ id: user.id, email: user.email });
    res.json({
      token, user: { uid: user.id, email: user.email, kycStatus: user.kyc_status },
      wallet: wallet ? { trafficGold: wallet.traffic_gold, usd: wallet.usd, hkd: wallet.hkd, btc: wallet.btc, eth: wallet.eth, usdt: wallet.usdt, fio: wallet.fio } : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(user.id);
  res.json({
    user: { uid: user.id, email: user.email, kycStatus: user.kyc_status },
    wallet: wallet ? { trafficGold: wallet.traffic_gold, usd: wallet.usd, hkd: wallet.hkd, btc: wallet.btc, eth: wallet.eth, usdt: wallet.usdt, fio: wallet.fio } : { trafficGold: 0, usd: 0, hkd: 0, btc: 0, eth: 0, usdt: 0, fio: 0 }
  });
});

// ==================== WALLET API ====================
app.get('/api/wallet', authMiddleware, (req, res) => {
  const db = getDb();
  ensureWallet(req.user.uid);
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.uid);
  res.json({
    trafficGold: wallet.traffic_gold, usd: wallet.usd, hkd: wallet.hkd,
    btc: wallet.btc, eth: wallet.eth, usdt: wallet.usdt, fio: wallet.fio
  });
});

app.post('/api/wallet/sync', authMiddleware, (req, res) => {
  try {
    const { trafficGold, usd, hkd, btc, eth, usdt } = req.body;
    const db = getDb();
    ensureWallet(req.user.uid);
    const stmt = db.prepare(`UPDATE wallets SET traffic_gold = ?, usd = ?, hkd = ?, btc = ?, eth = ?, usdt = ? WHERE user_id = ?`);
    stmt.run(trafficGold || 0, usd || 0, hkd || 0, btc || 0, eth || 0, usdt || 0, req.user.uid);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== FEE POOL API ====================
app.get('/api/fee-pool', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM fee_pool').get();
  const recent = db.prepare('SELECT * FROM fee_pool ORDER BY created_at DESC LIMIT 20').all();
  res.json({ totalFio: total.total, recentFees: recent });
});

app.post('/api/fee-pool/add', authMiddleware, (req, res) => {
  try {
    const { source, amount } = req.body;
    if (!source || !amount) return res.status(400).json({ error: 'source and amount required' });
    const db = getDb();
    db.prepare('INSERT INTO fee_pool (source, amount) VALUES (?, ?)').run(source, amount);
    const total = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM fee_pool').get();
    global.broadcast({ type: 'fee_pool_update', totalFio: total.total, source, amount, timestamp: new Date().toISOString() });
    res.json({ success: true, totalFio: total.total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== WITHDRAWAL API ====================
app.post('/api/withdraw/fio', authMiddleware, async (req, res) => {
  try {
    const { amount, toAddress, currency } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: '請輸入金額' });
    if (!toAddress) return res.status(400).json({ error: '請輸入 FIO 收款地址' });
    if (amount < 1) return res.status(400).json({ error: '最低提款 1 FIO' });
    const sourceCurrency = (currency || 'usd').toLowerCase();
    if (!['usd', 'usdt'].includes(sourceCurrency)) return res.status(400).json({ error: '不支援的貨幣' });
    const dbColumn = sourceCurrency === 'usdt' ? 'usdt' : 'usd';
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
    if (user.kyc_status !== 'verified') return res.status(400).json({ error: '需要完成 KYC 認證' });
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.uid);
    const balance = wallet ? wallet[dbColumn] || 0 : 0;
    if (balance < amount) return res.status(400).json({ error: `${sourceCurrency.toUpperCase()} 餘額不足 (可用: ${balance})` });
    const feePool = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM fee_pool').get();
    if (feePool.total < amount) return res.status(400).json({ error: `平台資金池不足 (可用: ${feePool.total.toFixed(2)} FIO，需要: ${amount} FIO)` });
    const txid = 'FIO' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
    db.prepare(`UPDATE wallets SET ${dbColumn} = ${dbColumn} - ?, fio = fio + ? WHERE user_id = ?`).run(amount, amount * 0.98, req.user.uid);
    db.prepare('INSERT INTO fee_pool (source, amount) VALUES (?, ?)').run('withdrawal_' + req.user.uid + '_' + Date.now(), -amount);
    const wid = 'W' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    db.prepare('INSERT INTO withdrawals (id, user_id, to_address, amount, fee, status, txid) VALUES (?, ?, ?, ?, ?, ?, ?)').run(wid, req.user.uid, toAddress, amount, 0.01, 'processing', txid);
    db.prepare('INSERT INTO transactions (id, user_id, type, amount, currency, note) VALUES (?, ?, ?, ?, ?, ?)').run('TX' + Date.now(), req.user.uid, 'withdrawal', amount, 'FIO', `提款 ${amount} ${sourceCurrency.toUpperCase()} → FIO → ${toAddress.slice(0,10)}...`);
    global.broadcast({ type: 'withdrawal', userId: req.user.uid, amount, toAddress, sourceCurrency, txid, timestamp: new Date().toISOString() });
    setTimeout(() => {
      db.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run('completed', wid);
      global.broadcast({ type: 'withdrawal_completed', userId: req.user.uid, wid, txid, timestamp: new Date().toISOString() });
    }, 30000);
    console.log(`[WITHDRAW] ${amount} ${sourceCurrency.toUpperCase()} → FIO → ${toAddress} by ${req.user.uid} | TXID: ${txid}`);
    res.json({ success: true, txid, withdrawal: { id: wid, amount, toAddress, status: 'processing' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/withdrawals', authMiddleware, (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.uid);
  res.json({ withdrawals: list });
});

// ==================== TRANSACTIONS API ====================
app.get('/api/transactions', authMiddleware, (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.uid);
  res.json({ transactions: list });
});

// ==================== KYC API ====================
app.post('/api/kyc/submit', authMiddleware, (req, res) => {
  try {
    const { fullName, idNumber } = req.body;
    if (!fullName || !idNumber) return res.status(400).json({ error: '請填寫姓名和身份證號碼' });
    const db = getDb();
    db.prepare('UPDATE users SET kyc_name = ?, kyc_id = ?, kyc_status = ? WHERE id = ?').run(fullName, idNumber, 'pending', req.user.uid);
    res.json({ success: true, kycStatus: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kyc/verify', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE users SET kyc_status = ? WHERE id = ?').run('verified', req.user.uid);
    res.json({ success: true, kycStatus: 'verified' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kyc/status', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(req.user.uid);
  res.json({ kycStatus: user ? user.kyc_status : 'unverified' });
});

// ==================== EXISTING API ENDPOINTS ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'running', uptime: process.uptime(), botsActive: Array.from(botManager.bots.values()).filter(b => b.status === 'running').length, botsTotal: botManager.bots.size, wsClients: clients.size, serverTime: new Date().toISOString() });
});
app.get('/api/market/price/:symbol', async (req, res) => {
  try { const symbol = (req.params.symbol || 'BTCUSDT').toUpperCase(); const ticker = await binanceRequest('GET', '/api/v3/ticker/price', { symbol }); const stats = await binanceRequest('GET', '/api/v3/ticker/24hr', { symbol }); res.json({ symbol: ticker.symbol, price: parseFloat(ticker.price), priceChange: parseFloat(stats.priceChange), priceChangePercent: parseFloat(stats.priceChangePercent), high24h: parseFloat(stats.highPrice), low24h: parseFloat(stats.lowPrice), volume24h: parseFloat(stats.volume), timestamp: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message || 'Failed to fetch price' }); }
});
app.get('/api/market/prices', async (req, res) => {
  try { const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT']; const allPrices = await Promise.all(symbols.map(async (sym) => { try { const [ticker, stats] = await Promise.all([binanceRequest('GET', '/api/v3/ticker/price', { symbol: sym }), binanceRequest('GET', '/api/v3/ticker/24hr', { symbol: sym })]); return { symbol: sym, price: parseFloat(ticker.price), change: parseFloat(stats.priceChangePercent), volume: parseFloat(stats.volume) }; } catch (e) { return { symbol: sym, price: 0, change: 0, volume: 0, error: e.message }; } })); res.json({ prices: allPrices, timestamp: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bot/create', authMiddleware, (req, res) => {
  const { name, exchange, symbol, strategy, amount } = req.body;
  if (!name || !strategy) return res.status(400).json({ error: 'Name and strategy required' });
  const result = botManager.createBot({ id: 'BOT_' + Date.now(), name, exchange: exchange || 'binance', symbol: (symbol || 'BTCUSDT').toUpperCase(), strategy: strategy || 'grid', amount: amount || 100 });
  res.json(result);
});
app.post('/api/bot/:id/start', authMiddleware, (req, res) => { res.json(botManager.startBot(req.params.id)); });
app.post('/api/bot/:id/stop', authMiddleware, (req, res) => { res.json(botManager.stopBot(req.params.id)); });
app.delete('/api/bot/:id', authMiddleware, (req, res) => { res.json(botManager.deleteBot(req.params.id)); });
app.get('/api/bot/:id', (req, res) => { const bot = botManager.getBot(req.params.id); if (!bot) return res.status(404).json({ error: 'Bot not found' }); res.json(bot); });
app.get('/api/bots', (req, res) => { res.json({ bots: botManager.listBots(), total: botManager.bots.size }); });
app.get('/api/bots/status', (req, res) => { const all = botManager.listBots(); res.json({ total: all.length, running: all.filter(b => b.status === 'running').length, stopped: all.filter(b => b.status === 'stopped').length, totalPnl: parseFloat(all.reduce((sum, b) => sum + b.pnl, 0).toFixed(2)), totalTrades: all.reduce((sum, b) => sum + b.totalTrades, 0) }); });

// FIO endpoints
app.get('/api/fio/status', (req, res) => { res.json(fioPaymentService.getStatus()); });
app.get('/api/fio/payment-link', (req, res) => {
  const { amount, memo } = req.query;
  const link = fioPaymentService.getTrustWalletPaymentLink(amount, memo);
  res.json({ link, address: FIO_CONFIG.publicAddress, qrData: link, note: 'Open this link in Trust Wallet app to send payment' });
});
app.get('/api/fio/deposits', (req, res) => {
  const { userId, limit } = req.query;
  res.json({ deposits: fioPaymentService.getDeposits(userId, parseInt(limit) || 50), pendingCount: fioPaymentService.store.pendingDeposits.length });
});
app.get('/api/fio/withdrawals', (req, res) => {
  const { userId, limit } = req.query;
  res.json({ withdrawals: fioPaymentService.getWithdrawals(userId, parseInt(limit) || 50) });
});
app.post('/api/fio/withdraw', authMiddleware, async (req, res) => {
  const { userId, toAddress, amount, currency } = req.body;
  if (!toAddress || !amount) return res.status(400).json({ error: 'toAddress and amount required' });
  if (amount < 1) return res.status(400).json({ error: 'Minimum withdrawal is 1 FIO' });
  const result = await fioPaymentService.processWithdrawal(userId || req.user.uid, toAddress, amount, currency || 'FIO');
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ==================== SERVER START ====================
const server = app.listen(PORT, () => {
  console.log('===============================================');
  console.log('  ZXZ Trading Bot Engine v2.0.0');
  console.log('  Server: http://localhost:' + PORT);
  console.log('  WS: ws://localhost:' + PORT);
  console.log('  DB: SQLite');
  console.log('  FIO Address:', FIO_CONFIG.publicAddress);
  console.log('  Hot Wallet:', FIO_CONFIG.hotWallet.publicKey || '❌ Not Configured');
  console.log('===============================================');
  fioPaymentService.setCallbacks({
    broadcast: (message, type) => { global.broadcast({ type: 'fio_' + type, message, timestamp: new Date().toISOString() }); },
    updateWallet: (userId, amount, currency) => { global.broadcast({ type: 'wallet_update', userId, amount, currency, timestamp: new Date().toISOString() }); },
    transactionLog: (type, amount, currency, status, userId) => { global.broadcast({ type: 'fio_transaction', txType: type, amount, currency, status, userId, timestamp: new Date().toISOString() }); }
  });
  fioPaymentService.start();
});
server.on('upgrade', (request, socket, head) => { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); }); });
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Stopping all bots...');
  botManager.listBots().forEach(b => botManager.stopBot(b.id));
  wss.close();
  server.close(() => { console.log('[SHUTDOWN] Server stopped'); process.exit(0); });
});
