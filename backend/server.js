const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'star_ocean_secret_key_2024';

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== 数据库初始化 ====================
let db;
const DB_PATH = path.join(__dirname, 'starocean.db');

const STAKE_TIERS = [
    { name: 'A档(体验仓)', min: 100, max: 300, dailyRate: 0.005, lockDays: 7, limitOnce: true },
    { name: 'B档(新手仓)', min: 500, max: 1500, dailyRate: 0.004, lockDays: 30, limitOnce: false },
    { name: 'C档(稳健仓)', min: 3000, max: 12000, dailyRate: 0.006, lockDays: 90, limitOnce: false },
    { name: 'D档(进阶仓)', min: 20000, max: 60000, dailyRate: 0.007, lockDays: 180, limitOnce: false },
    { name: 'S档(尊享仓)', min: 100000, max: Infinity, dailyRate: 0.01, lockDays: 420, limitOnce: false }
];

// 持久化函数：将数据库保存到文件
function saveDB() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

async function initDB() {
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    const originalPrepare = db.prepare.bind(db);
    const originalExec = db.exec.bind(db);

    db.run = function (sql, ...params) { /* 此部分保持不变，略 */ };
    db.prepare = function (sql) { /* 此部分保持不变，略 */ };
    db.exec = function (sql) { /* 此部分保持不变，略 */ };

    // 创建所有表（注意：users 表增加了 status 字段）
    const tables = [
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, nickname TEXT DEFAULT '', avatar TEXT DEFAULT '', balance REAL DEFAULT 0, total_staked REAL DEFAULT 0, invite_code TEXT UNIQUE NOT NULL, inviter_id INTEGER, level TEXT DEFAULT 'normal', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS stakes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, tier TEXT NOT NULL, amount REAL NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, daily_rate REAL NOT NULL, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS sign_records (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, stake_id INTEGER NOT NULL, period TEXT NOT NULL, sign_date TEXT NOT NULL, claimed INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, related_id INTEGER, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'admin', parent_id INTEGER, invite_code TEXT DEFAULT '', google_2fa_secret TEXT DEFAULT '', temp_2fa_secret TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS welfares (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, reward_amount REAL DEFAULT 0, max_claims INTEGER DEFAULT 0, claim_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS welfare_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, welfare_id INTEGER NOT NULL, claimed_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, trade_password TEXT DEFAULT '', real_name TEXT DEFAULT '', id_card TEXT DEFAULT '', real_status TEXT DEFAULT 'unverified')`,
        `CREATE TABLE IF NOT EXISTS withdraw_addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, coin TEXT NOT NULL, address TEXT NOT NULL, label TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS deposit_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL, status TEXT DEFAULT 'pending', admin_note TEXT DEFAULT '', reviewed_by INTEGER, reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS withdraw_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL, address TEXT NOT NULL, trade_password TEXT, status TEXT DEFAULT 'pending', admin_note TEXT DEFAULT '', reviewed_by INTEGER, reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS admin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, admin_username TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT DEFAULT '', target_id INTEGER, details TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`,
        `CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL, target_user_id INTEGER, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')))`
    ];
    for (const t of tables) {
        originalExec(t);
    }
    saveDB();

    // 默认管理员（只有初次运行时插入）
    const admin = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
    if (!admin) {
        const hashedPwd = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO admins (username, password, role, invite_code) VALUES (?, ?, ?, ?)').run('admin', hashedPwd, 'super', 'ADMIN001');
    }
    console.log('数据库初始化完成');
}

// ==================== 工具函数 ====================
function verifyTradePwd(userId, password) {
    const record = db.prepare('SELECT trade_password FROM user_settings WHERE user_id = ?').get(userId);
    if (!record || !record.trade_password) return false;
    return bcrypt.compareSync(password, record.trade_password);
}

// ==================== 用户系统 API ====================
app.post('/api/register', (req, res) => {
    const { username, password, inviteCode } = req.body;
    if (!username || !password) return res.json({ success: false, message: '用户名和密码不能为空' });
    try {
        const hashed = bcrypt.hashSync(password, 10);
        const myInviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        let inviterId = null;
        if (inviteCode) {
            const inviter = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(inviteCode);
            if (inviter) inviterId = inviter.id;
        }
        const result = db.prepare('INSERT INTO users (username, password, invite_code, inviter_id) VALUES (?, ?, ?, ?)').run(username, hashed, myInviteCode, inviterId);
        const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET);
        res.json({ success: true, message: '注册成功', data: { token, inviteCode: myInviteCode } });
    } catch (e) {
        res.json({ success: false, message: '用户名已存在或注册失败' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.json({ success: false, message: '用户名或密码错误' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.json({ success: true, message: '登录成功', data: { token, user: { ...user, password: undefined } } });
});

app.get('/api/user/info', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
        if (!user) return res.json({ success: false, message: '用户不存在' });
        const staked = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(user.id, 'active');
        const totalStaked = staked ? staked.total : 0;
        res.json({ success: true, data: { ...user, password: undefined, total_staked: totalStaked, available_balance: user.balance - totalStaked } });
    } catch (err) {
        res.json({ success: false, message: '登录已过期' });
    }
});

// ==================== 质押 API ====================
app.get('/api/stake/tiers', (req, res) => {
    res.json({ success: true, data: STAKE_TIERS });
});

app.post('/api/stake/create', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch (err) {
    return res.json({ success: false, message: '登录已过期' });
  }

  const { tierName, amount, tradePassword } = req.body;
  if (!tradePassword) return res.json({ success: false, message: '请输入交易密码' });
  if (!verifyTradePwd(userId, tradePassword)) return res.json({ success: false, message: '交易密码错误' });

  const tier = STAKE_TIERS.find(t => t.name === tierName);
  if (!tier) return res.json({ success: false, message: '质押档位不存在' });
  if (!amount || amount < tier.min) return res.json({ success: false, message: `最低质押金额为 ${tier.min} USDT` });

  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ success: false, message: '用户不存在' });

    // 计算可用余额 = 总资产 - 活跃质押总额
    const activeStake = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(userId, 'active');
    const availableBalance = user.balance - (activeStake?.total || 0);
    if (availableBalance < amount) return res.json({ success: false, message: '可用余额不足' });

    // 累计上限检查
    const currentTotal = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND tier = ? AND status = ?').get(userId, tierName, 'active');
    const totalAfter = (currentTotal?.total || 0) + amount;
    if (tier.max !== Infinity && totalAfter > tier.max) {
      return res.json({ success: false, message: `该档位累计上限 ${tier.max} USDT，您已质押 ${currentTotal.total} USDT` });
    }

    if (tier.limitOnce) {
      const exist = db.prepare('SELECT id FROM stakes WHERE user_id = ? AND tier = ?').get(userId, tierName);
      if (exist) return res.json({ success: false, message: 'A档体验仓每个账号终身限投1次' });
    }

    // 计算日期
    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + tier.lockDays);
    const formatDate = (d) => d.toISOString().slice(0, 10);

    // 插入质押记录（不再扣减 balance）
    const insertResult = db.prepare(`INSERT INTO stakes (user_id, tier, amount, start_date, end_date, daily_rate) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, tierName, amount, formatDate(startDate), formatDate(endDate), tier.dailyRate);

    // 获取刚插入的 stake ID：优先用 lastInsertRowid，否则查 MAX(id)
    let stakeId = insertResult.lastInsertRowid;
    if (!stakeId) {
      const maxRow = db.prepare('SELECT MAX(id) as id FROM stakes WHERE user_id = ?').get(userId);
      stakeId = maxRow?.id || null;
    }
    if (!stakeId) throw new Error('质押记录插入失败');

    // 记录流水（不再扣减 balance，仅记录）
    db.prepare('INSERT INTO transactions (user_id, type, amount, related_id, note) VALUES (?, ?, ?, ?, ?)').run(userId, 'stake', amount, stakeId, `质押${tierName}，锁仓${tier.lockDays}天`);

    res.json({ success: true, message: '质押成功', data: { id: stakeId, endDate: formatDate(endDate) } });
  } catch (e) {
    console.error('质押错误：', e);
    res.json({ success: false, message: '质押失败：' + e.message });
  }
});

app.get('/api/stake/list', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const stakes = db.prepare('SELECT * FROM stakes WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    res.json({ success: true, data: stakes });
});

// ==================== 签到与收益 API ====================
app.get('/api/sign/today', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const minute = now.getMinutes();
    let currentPeriod = null;
    if ((hour === 12 && minute >= 0) || (hour === 13 && minute === 0)) currentPeriod = 'morning';
    else if ((hour === 20 && minute >= 0) || (hour === 21 && minute === 0)) currentPeriod = 'afternoon';
    const stakes = db.prepare('SELECT * FROM stakes WHERE user_id = ? AND status = ?').all(userId, 'active');
    const signedRecords = db.prepare('SELECT stake_id, period FROM sign_records WHERE user_id = ? AND sign_date = ?').all(userId, today);
    const signedMap = {};
    signedRecords.forEach(r => { signedMap[r.stake_id + '_' + r.period] = true; });
    const result = stakes.map(s => ({
        id: s.id, tier: s.tier, amount: s.amount, daily_rate: s.daily_rate,
        daily_earnings: Math.floor(s.amount * s.daily_rate * 100) / 100,
        morning_signed: !!signedMap[s.id + '_morning'],
        afternoon_signed: !!signedMap[s.id + '_afternoon']
    }));
    res.json({ success: true, data: { currentPeriod, stakes: result } });
});

app.post('/api/sign', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { stakeId } = req.body;
    const stake = db.prepare('SELECT * FROM stakes WHERE id = ? AND user_id = ? AND status = ?').get(stakeId, userId, 'active');
    if (!stake) return res.json({ success: false, message: '质押不存在或已到期' });
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const today = now.toISOString().split('T')[0];
    let period = null;
    if (hour === 12 || (hour === 13 && minute === 0)) period = 'morning';
    else if (hour === 20 || (hour === 21 && minute === 0)) period = 'afternoon';
    else return res.json({ success: false, message: '当前不在签到时段' });
    const existing = db.prepare('SELECT id FROM sign_records WHERE user_id = ? AND stake_id = ? AND period = ? AND sign_date = ?').get(userId, stakeId, period, today);
    if (existing) return res.json({ success: false, message: '该时段已签到' });
    const earnings = Math.floor(stake.amount * stake.daily_rate * 100) / 100;
    db.prepare('INSERT INTO sign_records (user_id, stake_id, period, sign_date) VALUES (?, ?, ?, ?)').run(userId, stakeId, period, today);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(earnings, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, related_id, note) VALUES (?, ?, ?, ?, ?)').run(userId, 'earnings', earnings, stakeId, `${stake.tier} ${period === 'morning' ? '上午' : '下午'}签到收益`);
    res.json({ success: true, message: `签到成功，获得 ${earnings} USDT`, data: { earnings, period } });
});

// ==================== 充值提现 API ====================
app.post('/api/recharge', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.json({ success: false, message: '金额无效' });
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)').run(userId, 'recharge', amount, `充值 ${amount} USDT`);
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
    res.json({ success: true, message: '充值成功', data: { balance: user.balance } });
});

app.post('/api/withdraw', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { amount, address, tradePassword } = req.body;
    if (!amount || amount <= 0) return res.json({ success: false, message: '金额无效' });
    if (!address) return res.json({ success: false, message: '提款地址不能为空' });
    if (!tradePassword) return res.json({ success: false, message: '请输入交易密码' });
    if (!verifyTradePwd(userId, tradePassword)) return res.json({ success: false, message: '交易密码错误' });
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
const activeStake = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(userId, 'active');
const available = user.balance - (activeStake?.total || 0);
if (available < amount) return res.json({ success: false, message: '可用余额不足' });
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)').run(userId, 'withdraw', -amount, `提现 ${amount} USDT 至 ${address}`);
    res.json({ success: true, message: '提现申请已提交，待审核' });
});

// ==================== 交易记录 & 账变记录 API ====================
app.get('/api/transactions/trades', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const list = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND type IN (?, ?) ORDER BY created_at DESC').all(userId, 'stake', 'earnings');
    res.json({ success: true, data: list });
});

app.get('/api/transactions/bills', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const list = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    res.json({ success: true, data: list });
});

// ==================== 管理后台 API ====================
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '账号密码不能为空' });
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password)) return res.json({ success: false, message: '账号或密码错误' });
    const token = jwt.sign({ adminId: admin.id, role: admin.role }, JWT_SECRET);
    res.json({ success: true, message: '登录成功', data: { token, role: admin.role, username: admin.username } });
});

app.get('/api/admin/info', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const admin = db.prepare('SELECT id, username, role, parent_id FROM admins WHERE id = ?').get(decoded.adminId);
        if (!admin) return res.json({ success: false, message: '管理员不存在' });
        res.json({ success: true, data: admin });
    } catch (err) { res.json({ success: false, message: '登录已过期' }); }
});

app.post('/api/admin/create', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let parentId;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const parent = db.prepare('SELECT id, role FROM admins WHERE id = ?').get(decoded.adminId);
        if (!parent || parent.role !== 'super') return res.json({ success: false, message: '仅超级管理员可创建子管理员' });
        parentId = parent.id;
    } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: '账号密码不能为空' });
    try {
        const hashed = bcrypt.hashSync(password, 10);
        db.prepare('INSERT INTO admins (username, password, role, parent_id) VALUES (?, ?, ?, ?)').run(username, hashed, 'agent', parentId);
        res.json({ success: true, message: '子管理员创建成功' });
    } catch (err) { res.json({ success: false, message: '管理员账号已存在或创建失败' }); }
});

app.get('/api/admin/list', (req, res) => {
    const admins = db.prepare('SELECT id, username, role, parent_id, created_at FROM admins').all();
    res.json({ success: true, data: admins });
});

app.get('/api/admin/announcements', (req, res) => {
    const list = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all();
    res.json({ success: true, data: list });
});
app.post('/api/admin/announcements', (req, res) => {
    const { content } = req.body;
    if (!content) return res.json({ success: false, message: '内容不能为空' });
    db.prepare('INSERT INTO announcements (content) VALUES (?)').run(content);
    res.json({ success: true, message: '公告已发布' });
});
app.put('/api/admin/announcements/:id', (req, res) => {
    const { content, is_active } = req.body;
    if (content !== undefined) db.prepare('UPDATE announcements SET content = ?, updated_at = datetime("now","localtime") WHERE id = ?').run(content, req.params.id);
    if (is_active !== undefined) db.prepare('UPDATE announcements SET is_active = ?, updated_at = datetime("now","localtime") WHERE id = ?').run(is_active, req.params.id);
    res.json({ success: true, message: '公告已更新' });
});
app.delete('/api/admin/announcements/:id', (req, res) => {
    db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: '公告已删除' });
});

app.get('/api/admin/users', (req, res) => {
    const users = db.prepare('SELECT id, username, nickname, balance, total_staked, level, invite_code, created_at FROM users ORDER BY created_at DESC').all();
    res.json({ success: true, data: users });
});

app.get('/api/admin/welfares', (req, res) => {
    const list = db.prepare('SELECT * FROM welfares ORDER BY created_at DESC').all();
    res.json({ success: true, data: list });
});
app.post('/api/admin/welfares', (req, res) => {
    const { title, description, reward_amount, max_claims } = req.body;
    if (!title) return res.json({ success: false, message: '活动标题不能为空' });
    db.prepare('INSERT INTO welfares (title, description, reward_amount, max_claims) VALUES (?, ?, ?, ?)').run(title, description || '', reward_amount || 0, max_claims || 0);
    res.json({ success: true, message: '活动创建成功' });
});
app.put('/api/admin/welfares/:id', (req, res) => {
    const { title, description, reward_amount, max_claims, is_active } = req.body;
    if (title !== undefined) db.prepare('UPDATE welfares SET title = ? WHERE id = ?').run(title, req.params.id);
    if (description !== undefined) db.prepare('UPDATE welfares SET description = ? WHERE id = ?').run(description, req.params.id);
    if (reward_amount !== undefined) db.prepare('UPDATE welfares SET reward_amount = ? WHERE id = ?').run(reward_amount, req.params.id);
    if (max_claims !== undefined) db.prepare('UPDATE welfares SET max_claims = ? WHERE id = ?').run(max_claims, req.params.id);
    if (is_active !== undefined) db.prepare('UPDATE welfares SET is_active = ? WHERE id = ?').run(is_active, req.params.id);
    res.json({ success: true, message: '活动已更新' });
});
app.delete('/api/admin/welfares/:id', (req, res) => {
    db.prepare('DELETE FROM welfares WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: '活动已删除' });
});

app.get('/api/welfares', (req, res) => {
    const list = db.prepare('SELECT * FROM welfares WHERE is_active = 1 ORDER BY created_at DESC').all();
    const token = req.headers.authorization?.split(' ')[1];
    let userId = null;
    if (token) {
        try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (e) { }
    }
    const result = list.map(w => {
        let claimed = false;
        if (userId) {
            const claim = db.prepare('SELECT id FROM welfare_claims WHERE user_id = ? AND welfare_id = ?').get(userId, w.id);
            claimed = !!claim;
        }
        return { ...w, claimed };
    });
    res.json({ success: true, data: result });
});
app.post('/api/welfares/:id/claim', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '请先登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const welfareId = req.params.id;
    const welfare = db.prepare('SELECT * FROM welfares WHERE id = ?').get(welfareId);
    if (!welfare || !welfare.is_active) return res.json({ success: false, message: '活动不存在' });
    const exist = db.prepare('SELECT id FROM welfare_claims WHERE user_id = ? AND welfare_id = ?').get(userId, welfareId);
    if (exist) return res.json({ success: false, message: '已领取过该活动奖励' });
    if (welfare.max_claims > 0 && welfare.claim_count >= welfare.max_claims) return res.json({ success: false, message: '该活动奖励已被领完' });
    db.prepare('INSERT INTO welfare_claims (user_id, welfare_id) VALUES (?, ?)').run(userId, welfareId);
    db.prepare('UPDATE welfares SET claim_count = claim_count + 1 WHERE id = ?').run(welfareId);
    if (welfare.reward_amount > 0) {
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(welfare.reward_amount, userId);
        db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)').run(userId, 'welfare', welfare.reward_amount, `领取活动「${welfare.title}」奖励`);
    }
    res.json({ success: true, message: '领取成功' });
});

// ==================== 邀请与等级 API ====================
app.get('/api/team/direct', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const directs = db.prepare('SELECT id, username, nickname, level, total_staked, created_at FROM users WHERE inviter_id = ?').all(userId);
    res.json({ success: true, data: directs });
});

app.get('/api/user/level', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const directCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE inviter_id = ?').get(userId).count;
    function getTeamStake(uid, visited = new Set()) {
        if (visited.has(uid)) return 0;
        visited.add(uid);
        let total = 0;
        const children = db.prepare('SELECT id FROM users WHERE inviter_id = ?').all(uid);
        children.forEach(child => {
            const staked = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(child.id, 'active');
            total += (staked?.total || 0);
            total += getTeamStake(child.id, visited);
        });
        return total;
    }
    const teamStake = getTeamStake(userId);
    let newLevel = 'normal';
    if (directCount >= 3 && teamStake >= 5000) newLevel = '1star';
    const levelNames = { normal: '普通用户', '1star': '一星·共建会员', '2star': '二星·同行会员', '3star': '三星·领航会员', '4star': '四星·生态长老', '5star': '五星·荣誉董事' };
    db.prepare('UPDATE users SET level = ? WHERE id = ?').run(newLevel, userId);
    res.json({ success: true, data: { level: newLevel, levelName: levelNames[newLevel] || newLevel, directCount, teamStake } });
});

// ==================== 设置相关 API ====================
app.get('/api/user/settings', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    let settings = db.prepare('SELECT trade_password, real_name, id_card, real_status FROM user_settings WHERE user_id = ?').get(userId);
    if (!settings) {
        db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(userId);
        settings = { trade_password: '', real_name: '', id_card: '', real_status: 'unverified' };
    }
    const hasTradePwd = !!settings.trade_password;
    res.json({ success: true, data: { ...settings, trade_password: hasTradePwd ? '******' : '' } });
});

app.put('/api/user/trade-password', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { password } = req.body;
    if (!password || password.length !== 6 || isNaN(password)) return res.json({ success: false, message: '交易密码必须为6位数字' });
    const existing = db.prepare('SELECT trade_password FROM user_settings WHERE user_id = ?').get(userId);
    if (existing && existing.trade_password) return res.json({ success: false, message: '交易密码已设置，如需修改请联系客服' });
    const hashed = bcrypt.hashSync(password, 10);
    const s = db.prepare('SELECT user_id FROM user_settings WHERE user_id = ?').get(userId);
    if (s) db.prepare('UPDATE user_settings SET trade_password = ? WHERE user_id = ?').run(hashed, userId);
    else db.prepare('INSERT INTO user_settings (user_id, trade_password) VALUES (?, ?)').run(userId, hashed);
    res.json({ success: true, message: '交易密码设置成功' });
});

app.put('/api/admin/reset-trade-password/:userId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const admin = db.prepare('SELECT role FROM admins WHERE id = ?').get(decoded.adminId);
        if (!admin || admin.role !== 'super') return res.json({ success: false, message: '仅超级管理员可操作' });
    } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { password } = req.body;
    const hashed = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE user_settings SET trade_password = ? WHERE user_id = ?').run(hashed, req.params.userId);
    res.json({ success: true, message: '交易密码已重置' });
});

app.get('/api/withdraw/addresses', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const list = db.prepare('SELECT * FROM withdraw_addresses WHERE user_id = ?').all(userId);
    res.json({ success: true, data: list });
});

app.post('/api/withdraw/addresses', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { coin, address, label } = req.body;
    if (!coin || !address) return res.json({ success: false, message: '币种和地址不能为空' });
    const userExisting = db.prepare('SELECT id FROM withdraw_addresses WHERE user_id = ?').get(userId);
    if (userExisting) return res.json({ success: false, message: '您已绑定提款地址，如需修改请联系客服' });
    const addrUsed = db.prepare('SELECT id FROM withdraw_addresses WHERE address = ? AND user_id != ?').get(address, userId);
    if (addrUsed) return res.json({ success: false, message: '该地址已被其他用户绑定' });
    db.prepare('INSERT INTO withdraw_addresses (user_id, coin, address, label) VALUES (?, ?, ?, ?)').run(userId, coin, address, label || '');
    res.json({ success: true, message: '提款地址绑定成功' });
});

app.put('/api/user/update', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ success: false, message: '未登录' });
    let userId;
    try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; } catch (err) { return res.json({ success: false, message: '登录已过期' }); }
    const { nickname, avatar } = req.body;
    if (nickname === undefined && avatar === undefined) return res.json({ success: false, message: '没有要更新的内容' });
    if (nickname !== undefined) db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, userId);
    if (avatar !== undefined) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, userId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const staked = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(userId, 'active');
    const totalStaked = staked ? staked.total : 0;
    res.json({ success: true, message: '更新成功', data: { ...user, password: undefined, total_staked: totalStaked, available_balance: user.balance - totalStaked } });
});

// ==================== 行情 WebSocket & 定时拉取 ====================
let marketData = [];
async function fetchMarketData() {
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,polkadot,avalanche-2,matic-network,chainlink,uniswap,litecoin,shiba-inu,tron&vs_currencies=usd&include_24hr_change=true');
        const json = await res.json();
        const coins = [
            { id: 'bitcoin', name: 'BTC' }, { id: 'ethereum', name: 'ETH' }, { id: 'solana', name: 'SOL' },
            { id: 'binancecoin', name: 'BNB' }, { id: 'ripple', name: 'XRP' }, { id: 'cardano', name: 'ADA' },
            { id: 'dogecoin', name: 'DOGE' }, { id: 'polkadot', name: 'DOT' }, { id: 'avalanche-2', name: 'AVAX' },
            { id: 'matic-network', name: 'MATIC' }, { id: 'chainlink', name: 'LINK' }, { id: 'uniswap', name: 'UNI' },
            { id: 'litecoin', name: 'LTC' }, { id: 'shiba-inu', name: 'SHIB' }, { id: 'tron', name: 'TRX' }
        ];
        marketData = coins.map(c => ({ name: c.name, price: json[c.id]?.usd || 0, change: json[c.id]?.usd_24h_change || 0 }));
        wss.clients.forEach(client => { if (client.readyState === 1) client.send(JSON.stringify({ type: 'market', data: marketData })); });
        console.log('📈 行情已更新');
    } catch (e) { console.error('行情拉取失败', e.message); }
}
// ==================== 谷歌验证器 ====================

// 生成密钥和二维码（管理员绑定前调用）
app.get('/api/admin/generate-2fa', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let adminId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    adminId = decoded.adminId;
  } catch (err) { return res.json({ success: false, message: '登录已过期' }); }

  const secret = speakeasy.generateSecret({ length: 20, name: `星瀚资本:admin` });
  // 将临时密钥存到数据库（用临时字段，绑定确认后才正式启用）
  db.prepare('UPDATE admins SET temp_2fa_secret = ? WHERE id = ?').run(secret.base32, adminId);

  QRCode.toDataURL(secret.otpauth_url, (err, data_url) => {
    if (err) return res.json({ success: false, message: '二维码生成失败' });
    res.json({ success: true, data: { secret: secret.base32, qrcode: data_url } });
  });
});

// 确认绑定谷歌验证器
app.post('/api/admin/confirm-2fa', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let adminId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    adminId = decoded.adminId;
  } catch (err) { return res.json({ success: false, message: '登录已过期' }); }

  const { code } = req.body;
  if (!code) return res.json({ success: false, message: '请输入验证码' });

  const admin = db.prepare('SELECT temp_2fa_secret FROM admins WHERE id = ?').get(adminId);
  if (!admin || !admin.temp_2fa_secret) return res.json({ success: false, message: '请先生成密钥' });

  const verified = speakeasy.totp.verify({
    secret: admin.temp_2fa_secret,
    encoding: 'base32',
    token: code,
    window: 1  // 允许前后各一个时间窗口
  });

  if (!verified) return res.json({ success: false, message: '验证码错误' });

  // 正式启用：将临时密钥转为正式密钥
  db.prepare('UPDATE admins SET google_2fa_secret = temp_2fa_secret, temp_2fa_secret = NULL WHERE id = ?').run(adminId);
  res.json({ success: true, message: '谷歌验证器绑定成功' });
});

// 修改后的管理员登录接口（如果已绑定验证器，返回 require_2fa）
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.json({ success: false, message: '账号或密码错误' });
  }

  // 如果已绑定谷歌验证器，返回 require_2fa 标记
  if (admin.google_2fa_secret) {
    return res.json({ success: true, require_2fa: true, message: '请输入谷歌验证码', data: { tempToken: jwt.sign({ adminId: admin.id, step: '2fa' }, JWT_SECRET, { expiresIn: '5m' }) } });
  }

  // 未绑定验证器，直接登录
  const token = jwt.sign({ adminId: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ success: true, message: '登录成功', data: { token, role: admin.role, username: admin.username } });
});

// 管理员登录时验证谷歌验证码
app.post('/api/admin/verify-2fa-login', (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.json({ success: false, message: '参数不全' });
  try {
    const decoded = jwt.verify(tempToken, JWT_SECRET);
    if (decoded.step !== '2fa') return res.json({ success: false, message: '无效的临时凭证' });
    
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(decoded.adminId);
    if (!admin || !admin.google_2fa_secret) return res.json({ success: false, message: '验证器未绑定' });

    const verified = speakeasy.totp.verify({
      secret: admin.google_2fa_secret,
      encoding: 'base32',
      token: code,
      window: 1
    });
    if (!verified) return res.json({ success: false, message: '谷歌验证码错误' });

    const token = jwt.sign({ adminId: admin.id, role: admin.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, message: '登录成功', data: { token, role: admin.role, username: admin.username } });
  } catch (e) {
    res.json({ success: false, message: '临时凭证已过期，请重新登录' });
  }
});
app.put('/api/admin/change-password', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let adminId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    adminId = decoded.adminId;
  } catch (err) { return res.json({ success: false, message: '登录已过期' }); }

  const { oldPassword, newPassword, newPasswordConfirm, googleCode } = req.body;

  if (!oldPassword || !newPassword || !newPasswordConfirm) {
    return res.json({ success: false, message: '请填写所有密码字段' });
  }
  if (newPassword.length < 6) return res.json({ success: false, message: '新密码至少6位' });
  if (newPassword !== newPasswordConfirm) return res.json({ success: false, message: '两次输入的新密码不一致' });

  const admin = db.prepare('SELECT password FROM admins WHERE id = ?').get(adminId);
  if (!admin || !bcrypt.compareSync(oldPassword, admin.password)) {
    return res.json({ success: false, message: '旧密码错误' });
  }

  // 注意：如果后续加了谷歌验证器，再添加验证逻辑，现在先跳过

  const hashed = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hashed, adminId);
  res.json({ success: true, message: '密码修改成功，请重新登录' });
});
// ==================== 会员管理 API ====================

// 获取用户列表（支持搜索、状态筛选、分页）
app.get('/api/admin/users', (req, res) => {
  const { search, status, page = 1, limit = 20 } = req.query;
  let sql = 'SELECT id, username, nickname, balance, total_staked, level, status, invite_code, created_at FROM users WHERE 1=1';
  const params = [];
  if (search) {
    sql += ' AND (username LIKE ? OR nickname LIKE ? OR invite_code LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  const total = db.prepare(sql.replace('SELECT id, username...', 'SELECT COUNT(*) as count')).get(...params).count;
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, (page - 1) * limit);
  const users = db.prepare(sql).all(...params);
  res.json({ success: true, data: { users, total, page: Number(page), pages: Math.ceil(total / limit) } });
});

// 获取用户详情（含各维度数据）
app.get('/api/admin/users/:id', (req, res) => {
  const userId = req.params.id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.json({ success: false, message: '用户不存在' });
  const staked = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(userId, 'active');
  const totalStaked = staked?.total || 0;
  const rechargeTotal = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type = ?').get(userId, 'recharge')?.total || 0;
  const withdrawTotal = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type = ?').get(userId, 'withdraw')?.total || 0;
  const address = db.prepare('SELECT * FROM withdraw_addresses WHERE user_id = ?').get(userId);
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  res.json({ success: true, data: { ...user, password: undefined, totalStaked, rechargeTotal: Math.abs(rechargeTotal), withdrawTotal: Math.abs(withdrawTotal), withdrawAddress: address || null, realName: settings?.real_name || '', idCard: settings?.id_card || '', realStatus: settings?.real_status || 'unverified' } });
});

// 冻结/解冻/封禁用户
app.put('/api/admin/users/:id/status', (req, res) => {
  const { status } = req.body; // 'active', 'frozen', 'banned'
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  // 记录操作日志
  const admin = getAdminFromToken(req);
  db.prepare('INSERT INTO admin_logs (admin_id, admin_username, action, target_type, target_id, details) VALUES (?,?,?,?,?,?)').run(admin.id, admin.username, '修改用户状态', 'user', req.params.id, `状态改为${status}`);
  res.json({ success: true, message: '状态更新成功' });
});

// 删除用户（软删：设为 deleted 状态）
app.delete('/api/admin/users/:id', (req, res) => {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('deleted', req.params.id);
  const admin = getAdminFromToken(req);
  db.prepare('INSERT INTO admin_logs ...').run(admin.id, admin.username, '删除用户', 'user', req.params.id, '软删除');
  res.json({ success: true, message: '用户已删除' });
});

// 手动上分/扣分
app.post('/api/admin/users/:id/balance', (req, res) => {
  const { amount, note } = req.body;
  const userId = req.params.id;
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
  db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?,?,?,?)').run(userId, amount > 0 ? 'admin_credit' : 'admin_debit', amount, note || '管理员操作');
  const admin = getAdminFromToken(req);
  db.prepare('INSERT INTO admin_logs ...').run(admin.id, admin.username, '调整余额', 'user', userId, `${amount > 0 ? '+' : ''}${amount} USDT, 备注: ${note || ''}`);
  res.json({ success: true, message: '操作成功' });
});

// 重置用户登录密码
app.put('/api/admin/users/:id/reset-password', (req, res) => {
  const newPwd = req.body.password || '123456';
  const hashed = bcrypt.hashSync(newPwd, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.params.id);
  const admin = getAdminFromToken(req);
  db.prepare('INSERT INTO admin_logs ...').run(admin.id, admin.username, '重置登录密码', 'user', req.params.id);
  res.json({ success: true, message: `密码已重置为 ${newPwd}` });
});

// 重置交易密码
app.put('/api/admin/users/:id/reset-trade-password', (req, res) => {
  const newPwd = req.body.password || '123456';
  const hashed = bcrypt.hashSync(newPwd, 10);
  db.prepare('INSERT OR REPLACE INTO user_settings (user_id, trade_password) VALUES (?, ?)').run(req.params.id, hashed);
  const admin = getAdminFromToken(req);
  db.prepare('INSERT INTO admin_logs ...').run(admin.id, admin.username, '重置交易密码', 'user', req.params.id);
  res.json({ success: true, message: `交易密码已重置为 ${newPwd}` });
});

// 强制解绑提款地址
app.put('/api/admin/users/:id/reset-address', (req, res) => {
  db.prepare('DELETE FROM withdraw_addresses WHERE user_id = ?').run(req.params.id);
  const admin = getAdminFromToken(req);
  db.prepare('INSERT INTO admin_logs ...').run(admin.id, admin.username, '解绑提款地址', 'user', req.params.id);
  res.json({ success: true, message: '提款地址已强制解绑' });
});

// 辅助函数：从 token 获取管理员信息
function getAdminFromToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return db.prepare('SELECT id, username FROM admins WHERE id = ?').get(decoded.adminId);
  } catch (e) { return null; }
}
// ==================== 启动服务器 ====================
let wss;
initDB().then(() => {
    const server = app.listen(PORT, () => {
        console.log(`✅ 星瀚资本后端已启动：端口 ${PORT}`);
        console.log('🔑 默认管理员账号：admin / admin123');
    });

    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
        console.log('🔗 客户端已连接');
        if (marketData.length > 0) ws.send(JSON.stringify({ type: 'market', data: marketData }));
        ws.on('close', () => console.log('🔌 客户端断开'));
    });

    setInterval(fetchMarketData, 30000);
    fetchMarketData();
}).catch(err => {
    console.error('数据库初始化失败', err);
});