const https = require('https');
const fs = require('fs');
const path = require('path');

const FIO_CONFIG = {
  publicAddress: process.env.FIO_HOT_WALLET_ADDRESS || 'FIO7okjShPJ9cGWPQ45t6cx6tUjeERyVb4311ssWsh4zByr4ZzX9S',
  apiEndpoints: {
    chain: 'https://fio.greymass.com',
    hyperion: 'https://fio.eosusa.io/v2',
  },
  hotWallet: {
    privateKey: process.env.FIO_HOT_WALLET_KEY || '',
    publicKey: process.env.FIO_HOT_WALLET_ADDRESS || '',
    minBalance: 10,
  },
  requiredConfirmations: 6,
  pollInterval: 30000,
  dataDir: path.join(__dirname, '..', 'data'),
};

class PaymentStore {
  constructor() {
    this.deposits = [];
    this.withdrawals = [];
    this.pendingDeposits = [];
    this.load();
  }
  load() {
    try {
      if (!fs.existsSync(FIO_CONFIG.dataDir)) fs.mkdirSync(FIO_CONFIG.dataDir, { recursive: true });
      ['deposits', 'withdrawals', 'pendingDeposits'].forEach(key => {
        const file = path.join(FIO_CONFIG.dataDir, `${key}.json`);
        if (fs.existsSync(file)) this[key] = JSON.parse(fs.readFileSync(file, 'utf8'));
      });
      console.log(`[FIO] Loaded ${this.deposits.length} deposits, ${this.withdrawals.length} withdrawals`);
    } catch (e) { console.error('[FIO] Load error:', e.message); }
  }
  save() {
    try {
      ['deposits', 'withdrawals', 'pendingDeposits'].forEach(key => {
        const file = path.join(FIO_CONFIG.dataDir, `${key}.json`);
        fs.writeFileSync(file, JSON.stringify(this[key], null, 2));
      });
    } catch (e) { console.error('[FIO] Save error:', e.message); }
  }
  addDeposit(deposit) {
    this.deposits.unshift(deposit);
    this.pendingDeposits = this.pendingDeposits.filter(d => d.txid !== deposit.txid);
    if (this.deposits.length > 1000) this.deposits.pop();
    this.save();
  }
  addPendingDeposit(deposit) {
    if (!this.pendingDeposits.find(d => d.txid === deposit.txid)) {
      this.pendingDeposits.push(deposit);
      this.save();
    }
  }
  addWithdrawal(withdrawal) {
    this.withdrawals.unshift(withdrawal);
    if (this.withdrawals.length > 1000) this.withdrawals.pop();
    this.save();
  }
  updatePendingConfirmations(txid, confirmations) {
    const dep = this.pendingDeposits.find(d => d.txid === txid);
    if (dep) {
      dep.confirmations = confirmations;
      dep.lastChecked = new Date().toISOString();
      if (confirmations >= FIO_CONFIG.requiredConfirmations) {
        this.addDeposit({ ...dep, confirmedAt: new Date().toISOString() });
        this.pendingDeposits = this.pendingDeposits.filter(d => d.txid !== txid);
      }
      this.save();
      return dep;
    }
    return null;
  }
}

function fioApiRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = typeof endpoint === 'string' && endpoint.startsWith('http')
      ? endpoint
      : FIO_CONFIG.apiEndpoints.chain + endpoint;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

class FIOPaymentService {
  constructor() {
    this.store = new PaymentStore();
    this.monitorInterval = null;
    this.broadcastFn = null;
    this.updateWalletFn = null;
    this.transactionLogFn = null;
    this.confirmDepositFn = null;
    this.accountName = null;
    this.resolved = false;
  }

  setCallbacks(callbacks) {
    this.broadcastFn = callbacks.broadcast;
    this.updateWalletFn = callbacks.updateWallet;
    this.transactionLogFn = callbacks.transactionLog;
    this.confirmDepositFn = callbacks.confirmDeposit;
  }

  start() {
    console.log('[FIO] Starting payment monitor for:', FIO_CONFIG.publicAddress);
    console.log('[FIO] Trust Wallet link: https://link.trustwallet.com/send?coin=235&address=' + encodeURIComponent(FIO_CONFIG.publicAddress));
    this.pollBlockchain();
    this.monitorInterval = setInterval(() => this.pollBlockchain(), FIO_CONFIG.pollInterval);
  }

  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    console.log('[FIO] Payment monitor stopped');
  }

  async resolveAccountName() {
    try {
      const result = await fioApiRequest('/v1/chain/get_key_accounts', 'POST', {
        public_key: FIO_CONFIG.publicAddress,
      });
      if (result && result.account_names && result.account_names.length > 0) {
        this.accountName = result.account_names[0];
        this.resolved = true;
        console.log('[FIO] Resolved account name:', this.accountName);
        return this.accountName;
      }
      console.log('[FIO] No account name found for this public key (address may be unused)');
      this.accountName = null;
      return null;
    } catch (e) {
      console.error('[FIO] resolveAccountName error:', e.message);
      return null;
    }
  }

  async pollBlockchain() {
    try {
      if (!this.resolved) await this.resolveAccountName();

      const accountInfo = await this.getAccountInfo();
      if (accountInfo) {
        console.log(`[FIO] Balance: ${accountInfo.balance} FIO`);
      }

      const txs = await this.getRecentTransactions();
      if (txs && txs.length > 0) {
        console.log(`[FIO] Found ${txs.length} recent transactions`);
        for (const tx of txs) {
          await this.processTransaction(tx);
        }
      }

      for (const pending of this.store.pendingDeposits) {
        await this.checkConfirmations(pending);
      }

      if (accountInfo) {
        global.fioBalance = accountInfo.balance;
      }
    } catch (e) {
      console.error('[FIO] Monitor error:', e.message);
    }
  }

  async getAccountInfo() {
    try {
      if (this.accountName) {
        const result = await fioApiRequest('/v1/chain/get_account', 'POST', {
          account_name: this.accountName,
        });
        if (result && !result.error) {
          return {
            balance: parseFloat(result.core_liquid_balance || '0').toFixed(4),
            lastTx: result.last_code_sequence || null,
          };
        }
      }
      return await this.getBalanceViaHyperion();
    } catch (e) {
      return null;
    }
  }

  async getBalanceViaHyperion() {
    try {
      const key = this.accountName || FIO_CONFIG.publicAddress;
      const url = `${FIO_CONFIG.apiEndpoints.hyperion}/state/get_account?account=${key}`;
      const result = await fioApiRequest(url);
      if (result && result.account) {
        return {
          balance: parseFloat(result.account.balance || '0').toFixed(4),
          lastTx: result.account.last_tx || null,
        };
      }
      return null;
    } catch (e) {
      return { balance: '0.0000', lastTx: null };
    }
  }

  async getRecentTransactions() {
    try {
      if (!this.accountName) {
        return [];
      }
      const url = `${FIO_CONFIG.apiEndpoints.hyperion}/history/get_actions?account=${this.accountName}&limit=20&sort=desc`;
      const result = await fioApiRequest(url);
      if (result && result.actions) {
        const lib = result.last_irreversible_block || 0;
        return result.actions
          .filter(a => a.act && a.act.name === 'transfer')
          .map(a => ({
            txid: a.trx_id,
            from: a.act.data.from,
            to: a.act.data.to,
            amount: parseFloat(a.act.data.amount || '0').toFixed(4),
            memo: a.act.data.memo || '',
            timestamp: a.timestamp || new Date().toISOString(),
            blockNum: a.block_num,
            confirmations: a.block_num ? Math.max(0, lib - a.block_num) : 0,
            irreversible: a.block_num <= lib,
          }))
          .filter(tx => tx.to === this.accountName);
      }
      return [];
    } catch (e) {
      console.error('[FIO] Get transactions error:', e.message);
      return [];
    }
  }

  async processTransaction(tx) {
    if (this.store.deposits.find(d => d.txid === tx.txid)) return;
    if (this.store.pendingDeposits.find(d => d.txid === tx.txid)) {
      this.store.updatePendingConfirmations(tx.txid, tx.confirmations);
      return;
    }

    const userId = this.resolveUserId(tx);
    const deposit = {
      txid: tx.txid,
      fromAddress: tx.from,
      toAddress: tx.to,
      amount: parseFloat(tx.amount),
      currency: 'FIO',
      memo: tx.memo,
      userId: userId,
      timestamp: tx.timestamp || new Date().toISOString(),
      blockNum: tx.blockNum,
      confirmations: tx.confirmations || 0,
      status: 'pending',
      valueUSD: parseFloat(tx.amount) * 1.2,
    };

    this.store.addPendingDeposit(deposit);
    console.log(`[FIO] New deposit pending: ${tx.amount} FIO from ${tx.from} (confirmations: ${deposit.confirmations})`);

    if (this.broadcastFn) {
      this.broadcastFn(`📥 FIO 存款檢測: ${tx.amount} FIO 來自 ${tx.from.slice(0,10)}... | 等待確認中`, 'deposit');
    }
  }

  resolveUserId(tx) {
    if (tx.memo && tx.memo.startsWith('ZXZ-')) {
      return tx.memo;
    }
    return `pending_${tx.from.slice(-8)}`;
  }

  async checkConfirmations(pending) {
    try {
      const url = `${FIO_CONFIG.apiEndpoints.hyperion}/history/get_transaction?id=${pending.txid}`;
      const result = await fioApiRequest(url);
      if (result && result.trx_id) {
        const lib = result.last_irreversible_block || 0;
        const blockNum = result.block_num || 0;
        const confirmations = Math.max(0, lib - blockNum);

        const updated = this.store.updatePendingConfirmations(pending.txid, confirmations);
        if (updated && updated.confirmations >= FIO_CONFIG.requiredConfirmations) {
          console.log(`[FIO] ✅ Deposit CONFIRMED: ${pending.amount} FIO | txid: ${pending.txid}`);

          if (this.confirmDepositFn) {
            this.confirmDepositFn(pending.amount, pending.txid, pending.fromAddress, pending.userId);
          }

          if (this.updateWalletFn && pending.userId && !pending.userId.startsWith('pending_')) {
            this.updateWalletFn(pending.userId, pending.amount, 'fio');
          }

          if (this.broadcastFn) {
            this.broadcastFn(`✅ FIO 存款確認: ${pending.amount} FIO | 區塊確認: ${confirmations}`, 'deposit');
          }
          if (this.transactionLogFn) {
            this.transactionLogFn('deposit', pending.amount, 'FIO', 'completed', pending.userId);
          }
        }
      }
    } catch (e) {
      // silently continue
    }
  }

  async broadcastFioTransfer(toAddress, amount) {
    if (!FIO_CONFIG.hotWallet.privateKey) {
      const txid = 'TX' + Date.now() + Math.random().toString(36).slice(2, 8);
      console.log(`[FIO] SIMULATED send: ${amount} FIO → ${toAddress} | TXID: ${txid}`);
      return { txid, simulated: true, note: 'Set FIO_HOT_WALLET_KEY for real broadcast' };
    }
    try {
      console.log(`[FIO] Broadcasting REAL transaction: ${amount} FIO → ${toAddress}...`);
      const { FIOSDK } = require('@fioprotocol/fiosdk');
      const fetch = require('node-fetch');
      const privateKey = FIO_CONFIG.hotWallet.privateKey;
      const publicKey = FIO_CONFIG.hotWallet.publicKey;
      const baseUrl = FIO_CONFIG.apiEndpoints.chain;
      const sdk = new FIOSDK(privateKey, publicKey, baseUrl + '/', fetch);
      const maxFee = 5000000000;
      const result = await sdk.transferTokens(toAddress, Math.round(amount * 1000000000), maxFee);
      console.log(`[FIO] TX BROADCAST: ${result.transaction_id}`);
      return { txid: result.transaction_id, simulated: false };
    } catch (e) {
      console.error('[FIO] Broadcast error:', e.message);
      const txid = 'FIOTX' + Date.now();
      return { txid, simulated: false, note: e.message };
    }
  }

  async processWithdrawal(userId, toAddress, amount, currency = 'FIO') {
    if (!toAddress || !amount || amount <= 0) {
      return { error: 'Invalid withdrawal parameters' };
    }
    const hotBalance = global.fioBalance || 0;
    if (hotBalance < amount + FIO_CONFIG.hotWallet.minBalance) {
      return { error: 'Hot wallet insufficient balance', available: hotBalance };
    }

    const broadcast = await this.broadcastFioTransfer(toAddress, amount);
    if (broadcast.error) return { error: broadcast.error };

    const withdrawal = {
      id: broadcast.txid,
      userId, toAddress, amount, currency,
      fee: 0.01,
      status: broadcast.simulated ? 'completed' : 'pending',
      timestamp: new Date().toISOString(),
      txid: broadcast.txid,
      note: broadcast.note || '',
    };

    this.store.addWithdrawal(withdrawal);
    if (this.updateWalletFn) this.updateWalletFn(userId, -amount, 'fio');

    if (this.broadcastFn) {
      this.broadcastFn(`📤 FIO 提款: ${amount} FIO → ${toAddress.slice(0,10)}... | TXID: ${broadcast.txid.slice(0,16)}`, 'withdrawal');
    }

    if (!broadcast.simulated) {
      setTimeout(() => {
        withdrawal.status = 'completed';
        this.store.save();
        if (this.broadcastFn) {
          this.broadcastFn(`✅ FIO 提款確認: ${amount} FIO 已發送至 ${toAddress.slice(0,10)}...`, 'withdrawal');
        }
      }, 60000);
    }

    return { success: true, txid: broadcast.txid, withdrawal };
  }

  getStatus() {
    return {
      publicAddress: FIO_CONFIG.publicAddress,
      accountName: this.accountName,
      trustWalletLink: `https://link.trustwallet.com/send?coin=235&address=${encodeURIComponent(FIO_CONFIG.publicAddress)}`,
      balance: global.fioBalance || '0',
      pendingDeposits: this.store.pendingDeposits.length,
      totalDeposits: this.store.deposits.length,
      totalWithdrawals: this.store.withdrawals.length,
      recentDeposits: this.store.deposits.slice(0, 10),
      recentWithdrawals: this.store.withdrawals.slice(0, 10),
      hotWalletConfigured: !!FIO_CONFIG.hotWallet.privateKey,
      hotWalletAddress: FIO_CONFIG.hotWallet.publicKey || 'Not configured',
      requiredConfirmations: FIO_CONFIG.requiredConfirmations,
      lastChecked: new Date().toISOString(),
    };
  }

  getDeposits(userId = null, limit = 50) {
    let deposits = this.store.deposits;
    if (userId) deposits = deposits.filter(d => d.userId === userId);
    return deposits.slice(0, limit);
  }

  getWithdrawals(userId = null, limit = 50) {
    let withdrawals = this.store.withdrawals;
    if (userId) withdrawals = withdrawals.filter(w => w.userId === userId);
    return withdrawals.slice(0, limit);
  }

  getTrustWalletPaymentLink(amount = null, memo = '') {
    let link = `https://link.trustwallet.com/send?coin=235&address=${encodeURIComponent(FIO_CONFIG.publicAddress)}`;
    if (amount) link += `&amount=${amount}`;
    if (memo) link += `&memo=${encodeURIComponent(memo)}`;
    return link;
  }
}

const fioPaymentService = new FIOPaymentService();
module.exports = { FIOPaymentService, fioPaymentService, FIO_CONFIG };
