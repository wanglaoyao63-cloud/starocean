const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');
const app = express();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');

// 确保上传目录存在
const uploadsDir = path.join(__dirname, 'uploads', 'avatars');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 配置 multer 存储
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + '.jpg';
    cb(null, uniqueName);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只允许上传图片文件'));
  }
});

// 静态文件服务：让上传的图片可通过 URL 访问
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const PORT = 3000;
const JWT_SECRET = 'star_ocean_secret_key_2024';

app.use(cors());
app.use(express.json());

// 数据库初始化，自动生成数据库文件 starocean.db
const db = new Database('starocean.db');
db.pragma('journal_mode = WAL');

// 建所有核心表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    balance REAL DEFAULT 0,
    total_staked REAL DEFAULT 0,
    invite_code TEXT UNIQUE NOT NULL,
    inviter_id INTEGER,
    level TEXT DEFAULT 'normal',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS stakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tier TEXT NOT NULL,
    amount REAL NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    daily_rate REAL NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS sign_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stake_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    sign_date TEXT NOT NULL,
    claimed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    related_id INTEGER,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    parent_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS welfares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    reward_amount REAL DEFAULT 0,
    max_claims INTEGER DEFAULT 0,
    claim_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS welfare_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    welfare_id INTEGER NOT NULL,
    claimed_at TEXT DEFAULT (datetime('now','localtime'))
  );
    CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    trade_password TEXT DEFAULT '',
    real_name TEXT DEFAULT '',
    id_card TEXT DEFAULT '',
    real_status TEXT DEFAULT 'unverified'
  );

  CREATE TABLE IF NOT EXISTS withdraw_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    coin TEXT NOT NULL,
    address TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// 注册接口
app.post('/api/register', (req, res) => {
  const { username, password, inviteCode } = req.body;
  if (!username || !password) {
    return res.json({ success: false, message: '用户名和密码不能为空' });
  }
  
  try {
    const hashedPassword = bcrypt.hashSync(password, 10);
    const myInviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    let inviterId = null;
    if (inviteCode) {
      const inviter = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(inviteCode);
      if (inviter) inviterId = inviter.id;
    }
    
    const stmt = db.prepare('INSERT INTO users (username, password, invite_code, inviter_id) VALUES (?, ?, ?, ?)');
    const result = stmt.run(username, hashedPassword, myInviteCode, inviterId);
    
    const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET);
    res.json({ success: true, message: '注册成功', data: { token, inviteCode: myInviteCode } });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      res.json({ success: false, message: '用户名已存在' });
    } else {
      res.json({ success: false, message: '注册失败，请重试' });
    }
  }
});

// 登录接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.json({ success: false, message: '用户名或密码错误' });
  }
  
  const token = jwt.sign({ userId: user.id }, JWT_SECRET);
  res.json({ success: true, message: '登录成功', data: { token, user: { ...user, password: undefined } } });
});

// 获取用户信息（升级版：拆分可用余额和质押总额）
app.get('/api/user/info', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.json({ success: false, message: '用户不存在' });
    
    // 计算当前有效质押总额
    const staked = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(user.id, 'active');
    const totalStaked = staked ? staked.total : 0;
    
    res.json({ 
      success: true, 
      data: { 
        ...user, 
        password: undefined,
        total_staked: totalStaked,
        available_balance: user.balance - totalStaked
      } 
    });
  } catch (err) {
    res.json({ success: false, message: '登录已过期' });
  }
});
// ==================== 质押 API ====================

// 质押档位配置
const STAKE_TIERS = [
  { name: 'A档(体验仓)', min: 100, max: 300, dailyRate: 0.005, lockDays: 7, limitOnce: true },
  { name: 'B档(新手仓)', min: 500, max: 1500, dailyRate: 0.004, lockDays: 30, limitOnce: false },
  { name: 'C档(稳健仓)', min: 3000, max: 12000, dailyRate: 0.006, lockDays: 90, limitOnce: false },
  { name: 'D档(进阶仓)', min: 20000, max: 60000, dailyRate: 0.007, lockDays: 180, limitOnce: false },
  { name: 'S档(尊享仓)', min: 100000, max: Infinity, dailyRate: 0.01, lockDays: 420, limitOnce: false }
];
// 获取质押档位列表
app.get('/api/stake/tiers', (req, res) => {
  res.json({ success: true, data: STAKE_TIERS });
});

// 用户质押
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
  if (amount < tier.min) return res.json({ success: false, message: `最低质押金额为 ${tier.min} USDT` });
  // 检查该档位累计质押总额是否超过上限
  const currentTotal = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND tier = ? AND status = ?').get(userId, tierName, 'active');
  const totalAfter = (currentTotal?.total || 0) + amount;
  if (tier.max !== Infinity && totalAfter > tier.max) {
    return res.json({ success: false, message: `该档位累计上限 ${tier.max} USDT，您已质押 ${currentTotal.total} USDT，最多还可质押 ${(tier.max - currentTotal.total).toFixed(2)} USDT` });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (user.balance < amount) return res.json({ success: false, message: '余额不足' });
  
  // A档终身只能投一次
  if (tier.limitOnce) {
    const existing = db.prepare('SELECT id FROM stakes WHERE user_id = ? AND tier = ?').get(userId, tierName);
    if (existing) return res.json({ success: false, message: 'A档体验仓每个账号终身限投1次' });
  }
  
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + tier.lockDays);
  
  const formatDate = (d) => d.toISOString().split('T')[0];
  
  // 扣减余额
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, userId);
  
  // 创建质押订单
  const stmt = db.prepare('INSERT INTO stakes (user_id, tier, amount, start_date, end_date, daily_rate) VALUES (?, ?, ?, ?, ?, ?)');
  const result = stmt.run(userId, tierName, amount, formatDate(startDate), formatDate(endDate), tier.dailyRate);
  
  // 记录流水
  db.prepare('INSERT INTO transactions (user_id, type, amount, related_id, note) VALUES (?, ?, ?, ?, ?)').run(
    userId, 'stake', -amount, result.lastInsertRowid, `质押${tierName}，锁仓${tier.lockDays}天`
  );
  
  res.json({ success: true, message: '质押成功', data: { id: result.lastInsertRowid, endDate: formatDate(endDate) } });
});

// 获取用户质押列表
app.get('/api/stake/list', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch (err) {
    return res.json({ success: false, message: '登录已过期' });
  }
  
  const stakes = db.prepare('SELECT * FROM stakes WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  res.json({ success: true, data: stakes });
});
// ==================== 充值提现 API ====================

// 充值（简化版：直接到账，可后续加审核）
app.post('/api/recharge', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch (err) {
    return res.json({ success: false, message: '登录已过期' });
  }
  
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.json({ success: false, message: '金额无效' });
  
  // 增加余额
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
  // 记录流水
  db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)').run(
    userId, 'recharge', amount, `充值 ${amount} USDT`
  );
  
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  res.json({ success: true, message: '充值成功', data: { balance: user.balance } });
});

// 提现（生成待审核记录，扣减余额）
app.post('/api/withdraw', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch (err) {
    return res.json({ success: false, message: '登录已过期' });
  }
  
    const { amount, address, tradePassword } = req.body;
  if (!tradePassword) return res.json({ success: false, message: '请输入交易密码' });
  if (!verifyTradePwd(userId, tradePassword)) return res.json({ success: false, message: '交易密码错误' });
  if (!amount || amount <= 0) return res.json({ success: false, message: '金额无效' });
  if (!address) return res.json({ success: false, message: '提款地址不能为空' });
  
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  if (user.balance < amount) return res.json({ success: false, message: '余额不足' });
  
  // 扣减余额
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, userId);
  // 记录流水，类型为withdraw，状态待审核（我们暂时记录为pending，后续管理后台处理）
  db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)').run(
    userId, 'withdraw', -amount, `提现 ${amount} USDT 至 ${address}`
  );
  
  res.json({ success: true, message: '提现申请已提交，待审核' });
});
// ==================== 签到与收益 API ====================

// 获取今日签到状态（使用服务器时间判断）
app.get('/api/sign/today', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  // 使用服务器当前时间
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const hour = now.getHours();
  const minute = now.getMinutes();
  
  // 判断当前时段（服务器时间）
  let currentPeriod = null;
  if ((hour === 12 && minute >= 0) || (hour === 13 && minute === 0)) {
    currentPeriod = 'morning';
  } else if ((hour === 20 && minute >= 0) || (hour === 21 && minute === 0)) {
    currentPeriod = 'afternoon';
  }
  
  // 获取用户所有有效质押
  const stakes = db.prepare('SELECT * FROM stakes WHERE user_id = ? AND status = ?').all(userId, 'active');
  
  // 查询今天已签到记录
  const signedRecords = db.prepare('SELECT stake_id, period FROM sign_records WHERE user_id = ? AND sign_date = ?').all(userId, today);
  const signedMap = {};
  signedRecords.forEach(r => { signedMap[r.stake_id + '_' + r.period] = true; });
  
  const result = stakes.map(s => ({
    id: s.id,
    tier: s.tier,
    amount: s.amount,
    daily_rate: s.daily_rate,
    daily_earnings: Math.floor(s.amount * s.daily_rate * 100) / 100,
    morning_signed: !!signedMap[s.id + '_morning'],
    afternoon_signed: !!signedMap[s.id + '_afternoon']
  }));
  
  res.json({ success: true, data: { currentPeriod, stakes: result } });
});

// 签到（严格使用服务器时间，拒绝客户端伪造）
app.post('/api/sign', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  const { stakeId } = req.body;
  if (!stakeId) return res.json({ success: false, message: '缺少质押ID' });
  
  // 验证质押属于当前用户且有效
  const stake = db.prepare('SELECT * FROM stakes WHERE id = ? AND user_id = ? AND status = ?').get(stakeId, userId, 'active');
  if (!stake) return res.json({ success: false, message: '质押不存在或已到期' });
  
  // 完全使用服务器时间，拒绝客户端任何时间信息
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const today = now.toISOString().split('T')[0];
  
  let period = null;
  if (hour === 12 || (hour === 13 && minute === 0)) period = 'morning';
  else if (hour === 20 || (hour === 21 && minute === 0)) period = 'afternoon';
  else return res.json({ success: false, message: '当前不在签到时段' });
  
  // 检查今天此时段是否已签到
  const existing = db.prepare('SELECT id FROM sign_records WHERE user_id = ? AND stake_id = ? AND period = ? AND sign_date = ?').get(userId, stakeId, period, today);
  if (existing) return res.json({ success: false, message: '该时段已签到，不可重复领取' });
  
  // 计算收益
  const earnings = Math.floor(stake.amount * stake.daily_rate * 100) / 100;
  
  // 记录签到
  db.prepare('INSERT INTO sign_records (user_id, stake_id, period, sign_date) VALUES (?, ?, ?, ?)').run(userId, stakeId, period, today);
  
  // 增加余额
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(earnings, userId);
  
  // 记录流水
  db.prepare('INSERT INTO transactions (user_id, type, amount, related_id, note) VALUES (?, ?, ?, ?, ?)').run(
    userId, 'earnings', earnings, stakeId, `${stake.tier} ${period === 'morning' ? '上午' : '下午'}签到收益`
  );
  
  res.json({ success: true, message: `签到成功，获得 ${earnings} USDT`, data: { earnings, period } });
});
// ==================== 邀请与等级 API ====================

// 获取用户的直推列表
app.get('/api/team/direct', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  const directs = db.prepare('SELECT id, username, nickname, level, total_staked, created_at FROM users WHERE inviter_id = ?').all(userId);
  res.json({ success: true, data: directs });
});

// 获取团队统计（直推人数 + 团队总质押）
app.get('/api/team/stats', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  // 直推人数
  const directCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE inviter_id = ?').get(userId).count;
  
  // 递归计算团队总质押（当前用户的所有下级）
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
  
  res.json({ success: true, data: { directCount, teamStake } });
});

// 获取当前用户的等级信息
app.get('/api/user/level', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  const user = db.prepare('SELECT level, inviter_id FROM users WHERE id = ?').get(userId);
  if (!user) return res.json({ success: false, message: '用户不存在' });
  
  // 计算当前等级
  const directCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE inviter_id = ?').get(userId).count;
  
  // 递归获取团队总质押
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
  
  // 统计下级各级别数量（用于判断升级条件）
  function countLevel(uid, level, visited = new Set()) {
    if (visited.has(uid)) return 0;
    visited.add(uid);
    let count = 0;
    const children = db.prepare('SELECT id, level FROM users WHERE inviter_id = ?').all(uid);
    children.forEach(child => {
      if (child.level === level) count++;
      count += countLevel(child.id, level, visited);
    });
    return count;
  }
  
  let newLevel = 'normal';
  if (directCount >= 3 && teamStake >= 5000) newLevel = '1star';
  if (directCount >= 6 && teamStake >= 50000 && countLevel(userId, '1star') >= 1) newLevel = '2star';
  if (directCount >= 10 && teamStake >= 150000 && countLevel(userId, '2star') >= 2) newLevel = '3star';
  if (directCount >= 15 && teamStake >= 600000 && countLevel(userId, '3star') >= 3) newLevel = '4star';
  if (directCount >= 20 && teamStake >= 2000000 && countLevel(userId, '4star') >= 3) newLevel = '5star';
  
  // 更新等级
  if (newLevel !== user.level) {
    db.prepare('UPDATE users SET level = ? WHERE id = ?').run(newLevel, userId);
  }
  
  const levelNames = { normal: '普通用户', '1star': '一星·共建会员', '2star': '二星·同行会员', '3star': '三星·领航会员', '4star': '四星·生态长老', '5star': '五星·荣誉董事' };
  
  res.json({ success: true, data: { level: newLevel, levelName: levelNames[newLevel] || newLevel, directCount, teamStake } });
});
// ==================== 管理后台 API ====================

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: '账号密码不能为空' });
  
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.json({ success: false, message: '账号或密码错误' });
  }
  
  const token = jwt.sign({ adminId: admin.id, role: admin.role }, JWT_SECRET);
  res.json({ success: true, message: '登录成功', data: { token, role: admin.role, username: admin.username } });
});

// 管理员信息
app.get('/api/admin/info', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const admin = db.prepare('SELECT id, username, role, parent_id FROM admins WHERE id = ?').get(decoded.adminId);
    if (!admin) return res.json({ success: false, message: '管理员不存在' });
    res.json({ success: true, data: admin });
  } catch (err) {
    res.json({ success: false, message: '登录已过期' });
  }
});

// 创建子管理员（仅超级管理员）
app.post('/api/admin/create', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let parentId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const parent = db.prepare('SELECT id, role FROM admins WHERE id = ?').get(decoded.adminId);
    if (!parent || parent.role !== 'super') return res.json({ success: false, message: '仅超级管理员可创建子管理员' });
    parentId = parent.id;
  } catch (err) {
    return res.json({ success: false, message: '登录已过期' });
  }
  
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: '账号密码不能为空' });
  
  try {
    const hashedPwd = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO admins (username, password, role, parent_id) VALUES (?, ?, ?, ?)').run(username, hashedPwd, 'agent', parentId);
    res.json({ success: true, message: '子管理员创建成功' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      res.json({ success: false, message: '管理员账号已存在' });
    } else {
      res.json({ success: false, message: '创建失败' });
    }
  }
});

// 获取管理员列表
app.get('/api/admin/list', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  const admins = db.prepare('SELECT id, username, role, parent_id, created_at FROM admins').all();
  res.json({ success: true, data: admins });
});

// ==================== 公告管理 ====================

// 获取全部公告
app.get('/api/admin/announcements', (req, res) => {
  const list = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all();
  res.json({ success: true, data: list });
});

// 添加公告
app.post('/api/admin/announcements', (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ success: false, message: '内容不能为空' });
  db.prepare('INSERT INTO announcements (content) VALUES (?)').run(content);
  res.json({ success: true, message: '公告已发布' });
});

// 更新公告
app.put('/api/admin/announcements/:id', (req, res) => {
  const { content, is_active } = req.body;
  db.prepare('UPDATE announcements SET content = COALESCE(?, content), is_active = COALESCE(?, is_active), updated_at = datetime("now","localtime") WHERE id = ?').run(content, is_active, req.params.id);
  res.json({ success: true, message: '公告已更新' });
});

// 删除公告
app.delete('/api/admin/announcements/:id', (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: '公告已删除' });
});

// ==================== 用户管理 ====================

app.get('/api/admin/users', (req, res) => {
  const users = db.prepare('SELECT id, username, nickname, balance, total_staked, level, invite_code, created_at FROM users ORDER BY created_at DESC').all();
  res.json({ success: true, data: users });
});

// ==================== 代理线子管理员查看自己下级用户 ====================
app.get('/api/admin/my-users', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let admin;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(decoded.adminId);
  } catch (err) {
    return res.json({ success: false, message: '登录已过期' });
  }
  
  if (admin.role === 'super') {
    // 超级管理员看全部用户
    const users = db.prepare('SELECT id, username, nickname, balance, total_staked, level, invite_code FROM users ORDER BY created_at DESC').all();
    return res.json({ success: true, data: users });
  }
  
  // 代理管理员：需要根据业务逻辑关联用户（这里简化：展示所有用户，实际可按inviter链条过滤）
  const users = db.prepare('SELECT id, username, nickname, balance, total_staked, level, invite_code FROM users ORDER BY created_at DESC').all();
  res.json({ success: true, data: users });
});
// ==================== 福利活动 API ====================

// 管理后台：获取所有活动
app.get('/api/admin/welfares', (req, res) => {
  const list = db.prepare('SELECT * FROM welfares ORDER BY created_at DESC').all();
  res.json({ success: true, data: list });
});

// 管理后台：创建活动
app.post('/api/admin/welfares', (req, res) => {
  const { title, description, reward_amount, max_claims } = req.body;
  if (!title) return res.json({ success: false, message: '活动标题不能为空' });
  db.prepare('INSERT INTO welfares (title, description, reward_amount, max_claims) VALUES (?, ?, ?, ?)').run(
    title,
    description || '',
    reward_amount || 0,
    max_claims || 0
  );
  res.json({ success: true, message: '活动创建成功' });
});

// 管理后台：更新活动
app.put('/api/admin/welfares/:id', (req, res) => {
  const { title, description, reward_amount, max_claims, is_active } = req.body;
  db.prepare('UPDATE welfares SET title = COALESCE(?, title), description = COALESCE(?, description), reward_amount = COALESCE(?, reward_amount), max_claims = COALESCE(?, max_claims), is_active = COALESCE(?, is_active) WHERE id = ?')
    .run(title, description, reward_amount, max_claims, is_active, req.params.id);
  res.json({ success: true, message: '活动已更新' });
});

// 管理后台：删除活动
app.delete('/api/admin/welfares/:id', (req, res) => {
  db.prepare('DELETE FROM welfares WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: '活动已删除' });
});

// 用户端：获取所有有效活动
app.get('/api/welfares', (req, res) => {
  const list = db.prepare('SELECT * FROM welfares WHERE is_active = 1 ORDER BY created_at DESC').all();
  // 检查每个活动当前用户是否已领取
  const token = req.headers.authorization?.split(' ')[1];
  let userId = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
    } catch (e) {}
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

// 用户端：领取活动奖励
app.post('/api/welfares/:id/claim', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '请先登录' });
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch (err) {
    return res.json({ success: false, message: '登录已过期' });
  }

  const welfareId = req.params.id;
  const welfare = db.prepare('SELECT * FROM welfares WHERE id = ?').get(welfareId);
  if (!welfare || !welfare.is_active) return res.json({ success: false, message: '活动不存在' });

  // 检查是否已领取
  const exist = db.prepare('SELECT id FROM welfare_claims WHERE user_id = ? AND welfare_id = ?').get(userId, welfareId);
  if (exist) return res.json({ success: false, message: '已领取过该活动奖励' });

  // 检查领取次数上限
  if (welfare.max_claims > 0 && welfare.claim_count >= welfare.max_claims) {
    return res.json({ success: false, message: '该活动奖励已被领完' });
  }

  // 记录领取
  db.prepare('INSERT INTO welfare_claims (user_id, welfare_id) VALUES (?, ?)').run(userId, welfareId);
  db.prepare('UPDATE welfares SET claim_count = claim_count + 1 WHERE id = ?').run(welfareId);
  
  // 如果有奖励金额，加到余额
  if (welfare.reward_amount > 0) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(welfare.reward_amount, userId);
    db.prepare('INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)').run(
      userId, 'welfare', welfare.reward_amount, `领取活动「${welfare.title}」奖励`
    );
  }

  res.json({ success: true, message: '领取成功' });
});
// ==================== 交易记录 & 账变记录 API ====================

// 交易记录（质押 + 收益）
app.get('/api/transactions/trades', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  const list = db.prepare('SELECT * FROM transactions WHERE user_id = ? AND type IN (?, ?) ORDER BY created_at DESC').all(userId, 'stake', 'earnings');
  res.json({ success: true, data: list });
});

// 账变记录（所有流水）
app.get('/api/transactions/bills', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  const list = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  res.json({ success: true, data: list });
});
// ==================== 交易密码相关 ====================

// 内部验证函数
function verifyTradePwd(userId, password) {
  const record = db.prepare('SELECT trade_password FROM user_settings WHERE user_id = ?').get(userId);
  if (!record || !record.trade_password) return false;
  return bcrypt.compareSync(password, record.trade_password);
}

// 获取用户设置（含交易密码状态）
app.get('/api/user/settings', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }

  let settings = db.prepare('SELECT trade_password, real_name, id_card, real_status FROM user_settings WHERE user_id = ?').get(userId);
  if (!settings) {
    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(userId);
    settings = { trade_password: '', real_name: '', id_card: '', real_status: 'unverified' };
  }
  const hasTradePwd = !!settings.trade_password;
  res.json({ success: true, data: { ...settings, trade_password: hasTradePwd ? '******' : '' } });
});

// 设置交易密码（仅限首次）
app.put('/api/user/trade-password', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }

  const { password } = req.body;
  if (!password || password.length !== 6 || isNaN(password)) {
    return res.json({ success: false, message: '交易密码必须为6位数字' });
  }

  const existing = db.prepare('SELECT trade_password FROM user_settings WHERE user_id = ?').get(userId);
  if (existing && existing.trade_password) {
    return res.json({ success: false, message: '交易密码已设置，如需修改请联系客服' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO user_settings (user_id, trade_password) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET trade_password = ?').run(userId, hashed, hashed);
  res.json({ success: true, message: '交易密码设置成功' });
});

// 管理员重置交易密码
app.put('/api/admin/reset-trade-password/:userId', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let admin;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    admin = db.prepare('SELECT role FROM admins WHERE id = ?').get(decoded.adminId);
    if (!admin || admin.role !== 'super') return res.json({ success: false, message: '仅超级管理员可操作' });
  } catch (err) { return res.json({ success: false, message: '登录已过期' }); }

  const { password } = req.body;
  if (!password || password.length !== 6 || isNaN(password)) {
    return res.json({ success: false, message: '密码必须为6位数字' });
  }
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE user_settings SET trade_password = ? WHERE user_id = ?').run(hashed, req.params.userId);
  res.json({ success: true, message: '交易密码已重置' });
});

// ==================== 提款地址（每人仅1个，不可解绑，全局唯一地址） ====================

app.get('/api/withdraw/addresses', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  const list = db.prepare('SELECT * FROM withdraw_addresses WHERE user_id = ?').all(userId);
  res.json({ success: true, data: list });
});

app.post('/api/withdraw/addresses', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }

  const { coin, address, label } = req.body;
  if (!coin || !address) return res.json({ success: false, message: '币种和地址不能为空' });

  const userExisting = db.prepare('SELECT id FROM withdraw_addresses WHERE user_id = ?').get(userId);
  if (userExisting) return res.json({ success: false, message: '您已绑定提款地址，如需修改请联系客服' });

  const addrUsed = db.prepare('SELECT id FROM withdraw_addresses WHERE address = ? AND user_id != ?').get(address, userId);
  if (addrUsed) return res.json({ success: false, message: '该地址已被其他用户绑定' });

  db.prepare('INSERT INTO withdraw_addresses (user_id, coin, address, label) VALUES (?, ?, ?, ?)').run(userId, coin, address, label || '');
  res.json({ success: true, message: '提款地址绑定成功' });
});
// ==================== 设置相关 API ====================

// 更新用户信息（昵称、头像等）
app.put('/api/user/update', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  const { nickname, avatar } = req.body;
  
  // 至少更新一个字段
  if (nickname === undefined && avatar === undefined) {
    return res.json({ success: false, message: '没有要更新的内容' });
  }
  
  // 动态构建更新语句
  const updates = [];
  const values = [];
  if (nickname !== undefined) { updates.push('nickname = ?'); values.push(nickname); }
  if (avatar !== undefined) { updates.push('avatar = ?'); values.push(avatar); }
  values.push(userId);
  
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  
  // 返回更新后的用户信息
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const staked = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE user_id = ? AND status = ?').get(userId, 'active');
  const totalStaked = staked ? staked.total : 0;
  
  res.json({ 
    success: true, 
    message: '更新成功',
    data: { 
      ...user, 
      password: undefined,
      total_staked: totalStaked,
      available_balance: user.balance - totalStaked
    } 
  });
});
// ==================== 头像上传 API ====================

app.post('/api/user/upload-avatar', upload.single('avatar'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ success: false, message: '未登录' });
  
  let userId;
  try { const decoded = jwt.verify(token, JWT_SECRET); userId = decoded.userId; }
  catch (err) { return res.json({ success: false, message: '登录已过期' }); }
  
  if (!req.file) return res.json({ success: false, message: '没有上传文件' });
  
  try {
    // 用 sharp 压缩并裁剪为正方形头像（200x200）
    const compressedPath = req.file.path.replace('.jpg', '_thumb.jpg');
    await sharp(req.file.path)
      .resize(200, 200, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(compressedPath);
    
    // 删除原文件，重命名压缩文件
    fs.unlinkSync(req.file.path);
    fs.renameSync(compressedPath, req.file.path);
    
    // 构建可访问的 URL
    const avatarUrl = '/uploads/avatars/' + req.file.filename;
    
    // 更新用户头像字段
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, userId);
    
    res.json({ success: true, message: '头像上传成功', data: { avatar: avatarUrl } });
  } catch (e) {
    console.error('头像处理失败:', e);
    res.json({ success: false, message: '头像处理失败，请重试' });
  }
});
// ==================== 启动 HTTP + WebSocket ====================
const server = app.listen(PORT, () => {
  console.log(`✅ 星瀚资本后端已启动：http://localhost:${PORT}`);
  
  const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get('admin');
  if (!adminExists) {
    db.prepare('INSERT INTO admins (username, password, role) VALUES (?, ?, ?)').run(
      'admin', bcrypt.hashSync('admin123', 10), 'super'
    );
    console.log('🔑 默认管理员账号：admin / admin123');
  }
});

// 启动 WebSocket 服务
const wss = new WebSocketServer({ server });

// 行情数据缓存
let marketData = [];

// 拉取 CoinGecko 免费 API
async function fetchMarketData() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple,cardano&vs_currencies=usd&include_24hr_change=true'
    );
    const json = await res.json();
    const coins = [
      { id: 'bitcoin', name: 'BTC' },
      { id: 'ethereum', name: 'ETH' },
      { id: 'solana', name: 'SOL' },
      { id: 'binancecoin', name: 'BNB' },
      { id: 'ripple', name: 'XRP' },
      { id: 'cardano', name: 'ADA' },
      { id: 'dogecoin', name: 'DOGE' },
      { id: 'polkadot', name: 'DOT' },
      { id: 'avalanche-2', name: 'AVAX' },
      { id: 'matic-network', name: 'MATIC' },
      { id: 'chainlink', name: 'LINK' },
      { id: 'uniswap', name: 'UNI' },
      { id: 'litecoin', name: 'LTC' },
      { id: 'shiba-inu', name: 'SHIB' },
      { id: 'tron', name: 'TRX' },
      { id: 'ethereum-classic', name: 'ETC' },
      { id: 'monero', name: 'XMR' },
      { id: 'cosmos', name: 'ATOM' },
    ];
    marketData = coins.map(c => ({
      name: c.name,
      price: json[c.id]?.usd || 0,
      change: json[c.id]?.usd_24h_change || 0
    }));
    // 广播给所有连接的客户端
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: 'market', data: marketData }));
      }
    });
    console.log('📈 行情已更新', new Date().toLocaleTimeString());
  } catch (e) {
    console.error('行情拉取失败:', e.message);
  }
}

// 每30秒拉取一次行情并广播
setInterval(fetchMarketData, 30000);
fetchMarketData(); // 启动时先拉一次

// WebSocket 连接管理
wss.on('connection', (ws) => {
  console.log('🔗 客户端已连接');
  // 发送当前缓存数据
  if (marketData.length > 0) {
    ws.send(JSON.stringify({ type: 'market', data: marketData }));
  }
  ws.on('close', () => console.log('🔌 客户端断开'));
});