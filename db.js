// db.js — MySQL persistence (balances + per-game bets + per-guild stats)
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 5,
  waitForConnections: true,
  namedPlaceholders: true
});

async function init() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id VARCHAR(32) PRIMARY KEY,
        balance INT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        user_id VARCHAR(32) NOT NULL,
        game VARCHAR(32) NOT NULL,
        amount INT NOT NULL,
        PRIMARY KEY (user_id, game),
        INDEX (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_stats (
        guild_id VARCHAR(32) NOT NULL,
        user_id  VARCHAR(32) NOT NULL,
        game     VARCHAR(32) NOT NULL,  -- 'slots','blackjack','dice','mines','roulette'
        wins     INT NOT NULL DEFAULT 0,
        losses   INT NOT NULL DEFAULT 0,
        pushes   INT NOT NULL DEFAULT 0,
        net      INT NOT NULL DEFAULT 0, -- total net credits from this game in this guild
        PRIMARY KEY (guild_id, user_id, game),
        INDEX (guild_id, game),
        INDEX (guild_id, wins),
        INDEX (guild_id, losses),
        INDEX (guild_id, net)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_bonus (
        user_id VARCHAR(32) PRIMARY KEY,
        last_claim BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

  } finally {
    conn.release();
  }
}

async function getUserBalance(userId, defaultBalance=200) {
  const [rows] = await pool.query("SELECT balance FROM users WHERE user_id=?", [String(userId)]);
  if (rows.length) return rows[0].balance;
  await pool.query("INSERT INTO users (user_id, balance) VALUES (?, ?)", [String(userId), defaultBalance]);
  return defaultBalance;
}
async function setUserBalance(userId, amount) {
  await pool.query(`
    INSERT INTO users (user_id, balance) VALUES (?, ?)
    ON DUPLICATE KEY UPDATE balance=VALUES(balance)
  `, [String(userId), amount]);
  return amount;
}
async function addUserBalance(userId, delta, defaultBalance=200) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT balance FROM users WHERE user_id=? FOR UPDATE", [String(userId)]);
    let bal = defaultBalance;
    if (rows.length) bal = rows[0].balance;
    else await conn.query("INSERT INTO users (user_id, balance) VALUES (?, ?)", [String(userId), defaultBalance]);
    bal += delta;
    await conn.query("UPDATE users SET balance=? WHERE user_id=?", [bal, String(userId)]);
    await conn.commit();
    return bal;
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_bonus (
        user_id VARCHAR(32) PRIMARY KEY,
        last_claim BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

  } finally {
    conn.release();
  }
}

async function getUserBet(userId, game, defaultAmount) {
  const [rows] = await pool.query("SELECT amount FROM user_bets WHERE user_id=? AND game=?", [String(userId), game]);
  if (rows.length) return rows[0].amount;
  await pool.query("INSERT INTO user_bets (user_id, game, amount) VALUES (?, ?, ?)", [String(userId), game, defaultAmount]);
  return defaultAmount;
}
async function setUserBet(userId, game, amount) {
  await pool.query(`
    INSERT INTO user_bets (user_id, game, amount) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE amount=VALUES(amount)
  `, [String(userId), game, amount]);
  return amount;
}

// ---- Stats helpers ----
async function recordResult({ guildId, userId, game, result, net }) {
  // result: 'win' | 'loss' | 'push'
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // upsert row
    await conn.query(`
      INSERT INTO user_stats (guild_id, user_id, game, wins, losses, pushes, net)
      VALUES (?, ?, ?, 0, 0, 0, 0)
      ON DUPLICATE KEY UPDATE net = net
    `, [String(guildId), String(userId), String(game)]);
    if (result === 'win') {
      await conn.query(`UPDATE user_stats SET wins = wins + 1, net = net + ? WHERE guild_id=? AND user_id=? AND game=?`, [net, String(guildId), String(userId), String(game)]);
    } else if (result === 'loss') {
      await conn.query(`UPDATE user_stats SET losses = losses + 1, net = net + ? WHERE guild_id=? AND user_id=? AND game=?`, [net, String(guildId), String(userId), String(game)]);
    } else {
      await conn.query(`UPDATE user_stats SET pushes = pushes + 1, net = net + ? WHERE guild_id=? AND user_id=? AND game=?`, [net, String(guildId), String(userId), String(game)]);
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_bonus (
        user_id VARCHAR(32) PRIMARY KEY,
        last_claim BIGINT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

  } finally {
    conn.release();
  }
}

// Leaderboards
async function lbBalance(guildId, limit=10) {
  // Show top balances among users who have any stats in this guild
  const [rows] = await pool.query(`
    SELECT u.user_id, u.balance
    FROM users u
    JOIN (SELECT DISTINCT user_id FROM user_stats WHERE guild_id=?) g
      ON g.user_id = u.user_id
    ORDER BY u.balance DESC
    LIMIT ?
  `, [String(guildId), limit]);
  return rows;
}

async function lbStats(guildId, game='all', metric='wins', limit=10) {
  // metric: 'wins' | 'losses' | 'winrate' | 'net'
  let rows;
  if (game === 'all') {
    const [r] = await pool.query(`
      SELECT user_id,
             SUM(wins)   AS wins,
             SUM(losses) AS losses,
             SUM(pushes) AS pushes,
             SUM(net)    AS net
      FROM user_stats
      WHERE guild_id = ?
      GROUP BY user_id
    `, [String(guildId)]);
    rows = r;
  } else {
    const [r] = await pool.query(`
      SELECT user_id, wins, losses, pushes, net
      FROM user_stats
      WHERE guild_id = ? AND game = ?
    `, [String(guildId), game]);
    rows = r;
  }
  // compute winrate in JS and sort
  rows.forEach(r => {
    const plays = (r.wins||0) + (r.losses||0);
    r.winrate = plays ? (r.wins / plays) : 0;
  });
  rows.sort((a,b)=>{
    if (metric==='wins') return (b.wins||0) - (a.wins||0);
    if (metric==='losses') return (b.losses||0) - (a.losses||0);
    if (metric==='winrate') return (b.winrate||0) - (a.winrate||0);
    if (metric==='net') return (b.net||0) - (a.net||0);
    return 0;
  });
  return rows.slice(0, limit);
}


// ---- 4h Bonus helpers ----
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
async function getLastBonus(userId){
  const [rows] = await pool.query("SELECT last_claim FROM user_bonus WHERE user_id=?", [String(userId)]);
  if (rows.length) return Number(rows[0].last_claim) || 0;
  await pool.query("INSERT INTO user_bonus (user_id, last_claim) VALUES (?, ?)", [String(userId), 0]);
  return 0;
}
async function canClaimBonus(userId){
  const last = await getLastBonus(userId);
  const now = Date.now();
  return now - last >= FOUR_HOURS_MS;
}
async function claimBonus(userId, amount=50){
  const now = Date.now();
  const conn = await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT last_claim FROM user_bonus WHERE user_id=? FOR UPDATE", [String(userId)]);
    let last = 0;
    if (rows.length){ last = Number(rows[0].last_claim) || 0; }
    else { await conn.query("INSERT INTO user_bonus (user_id, last_claim) VALUES (?, ?)", [String(userId), 0]); }
    if (now - last < FOUR_HOURS_MS){
      await conn.rollback();
      return { ok:false, nextAt: last + FOUR_HOURS_MS };
    }
    await conn.query("UPDATE user_bonus SET last_claim=? WHERE user_id=?", [now, String(userId)]);
    await conn.query(`
      INSERT INTO users (user_id, balance) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)
    `, [String(userId), amount]);
    await conn.commit();
    return { ok:true, credited: amount, nextAt: now + FOUR_HOURS_MS };
  } catch(e){
    try{ await conn.rollback(); }catch{}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  init,
  // balances & bets
  getUserBalance, setUserBalance, addUserBalance,
  getUserBet, setUserBet,
  // stats
  recordResult,
  lbBalance, lbStats,
  pool,
  // bonus
  canClaimBonus, claimBonus, getLastBonus
};
