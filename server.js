"use strict";

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const dayjs = require("dayjs");

const app = express();

// ── CORS: allow GitHub Pages + localhost ──────────────────────
app.use(cors({
  origin: [
    /\.github\.io$/,
    /localhost/,
    /127\.0\.0\.1/,
    /railway\.app$/
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// ── DATABASE CONNECTION ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") || process.env.DATABASE_URL?.includes("supabase")
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => console.error("DB pool error:", err));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ── AUTO-MIGRATE: create tables if they don't exist ──────────
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS holdings (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        issuer            TEXT NOT NULL,
        instrument_type   TEXT NOT NULL,
        isin              TEXT,
        face_value        NUMERIC NOT NULL,
        coupon_rate       NUMERIC NOT NULL DEFAULT 0,
        coupon_frequency  INTEGER DEFAULT 2,
        maturity_date     DATE,
        purchase_date     DATE NOT NULL,
        purchase_price    NUMERIC NOT NULL,
        purchase_yield    NUMERIC NOT NULL,
        current_price     NUMERIC,
        current_yield     NUMERIC,
        currency          TEXT DEFAULT 'PKR',
        rating            TEXT,
        sector            TEXT,
        custodian         TEXT,
        is_funded         BOOLEAN DEFAULT FALSE,
        repo_rate         NUMERIC,
        accrual_days      INTEGER DEFAULT 0,
        status            TEXT DEFAULT 'active',
        notes             TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS prices (
        id            BIGSERIAL PRIMARY KEY,
        holding_id    TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
        price_date    DATE NOT NULL,
        clean_price   NUMERIC NOT NULL,
        ytm           NUMERIC,
        source        TEXT DEFAULT 'manual',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(holding_id, price_date)
      );

      CREATE TABLE IF NOT EXISTS nav_history (
        id            BIGSERIAL PRIMARY KEY,
        nav_date      DATE NOT NULL UNIQUE,
        portfolio_nav NUMERIC NOT NULL,
        total_mv      NUMERIC NOT NULL,
        total_cost    NUMERIC NOT NULL,
        total_income  NUMERIC DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS revaluations (
        id              BIGSERIAL PRIMARY KEY,
        reval_date      DATE NOT NULL,
        holding_id      TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
        market_value    NUMERIC NOT NULL,
        cost_value      NUMERIC NOT NULL,
        clean_price     NUMERIC NOT NULL,
        ytm             NUMERIC NOT NULL,
        duration        NUMERIC,
        modified_dur    NUMERIC,
        pvbp            NUMERIC,
        accrued_income  NUMERIC,
        unrealized_pnl  NUMERIC,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(reval_date, holding_id)
      );

      CREATE TABLE IF NOT EXISTS risk_limits (
        id              BIGSERIAL PRIMARY KEY,
        limit_name      TEXT NOT NULL UNIQUE,
        limit_value     NUMERIC NOT NULL,
        limit_unit      TEXT,
        alert_threshold NUMERIC,
        is_active       BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id          BIGSERIAL PRIMARY KEY,
        action      TEXT NOT NULL,
        table_name  TEXT,
        record_id   TEXT,
        old_value   JSONB,
        new_value   JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_prices_holding  ON prices(holding_id);
      CREATE INDEX IF NOT EXISTS idx_prices_date     ON prices(price_date DESC);
      CREATE INDEX IF NOT EXISTS idx_reval_date      ON revaluations(reval_date DESC);
      CREATE INDEX IF NOT EXISTS idx_holdings_status ON holdings(status);

      INSERT INTO risk_limits (limit_name, limit_value, limit_unit, alert_threshold) VALUES
        ('max_duration',      2.5,     'years',   2.2),
        ('max_pvbp',          3000000, 'PKR',     2500000),
        ('max_concentration', 20,      'percent', 15),
        ('max_sub_inv_grade', 5,       'percent', 3)
      ON CONFLICT (limit_name) DO NOTHING;
    `);
    console.log("✓ Database schema ready");
  } finally {
    client.release();
  }
}

// ── FIXED INCOME ENGINE ───────────────────────────────────────
const FI = {
  bondPrice(F, c, y, T, m = 2) {
    if (T <= 0) return F;
    const n = Math.round(T * m);
    const C = (F * c) / m;
    const r = y / m;
    if (r === 0) return F + C * n;
    let pv = 0;
    for (let t = 1; t <= n; t++) pv += C / Math.pow(1 + r, t);
    return pv + F / Math.pow(1 + r, n);
  },

  macDur(F, c, y, T, m = 2) {
    if (T <= 0) return 0;
    const n = Math.round(T * m);
    const C = (F * c) / m;
    const r = y / m;
    let wt = 0, pv = 0;
    for (let t = 1; t <= n; t++) {
      const cf = C / Math.pow(1 + r, t);
      wt += (t / m) * cf;
      pv += cf;
    }
    const fvPV = F / Math.pow(1 + r, n);
    return (wt + T * fvPV) / (pv + fvPV);
  },

  modDur(mac, y, m = 2) { return mac / (1 + y / m); },

  pvbp(mv, md) { return mv * md * 0.0001; },

  accInt(F, c, days, m = 2) {
    return (F * c / m) * (days / (365 / m));
  },

  yearsTo(dateStr) {
    if (!dateStr) return 0.5;
    return Math.max(0.01, (new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24 * 365));
  },

  reval(h, price, ytm) {
    const F = parseFloat(h.face_value);
    const c = parseFloat(h.coupon_rate);
    const y = parseFloat(ytm);
    const p = parseFloat(price);
    const m = parseInt(h.coupon_frequency) || 2;
    const T = this.yearsTo(h.maturity_date);
    const MV = F * (p / 100);
    const CV = F * (parseFloat(h.purchase_price) / 100);
    let dur = 0, md = 0, pv = 0;

    if (["Placement", "Mutual Fund"].includes(h.instrument_type)) {
      dur = h.instrument_type === "Placement" ? T * 0.5 : 0.08;
      md = dur / (1 + y / 2);
      pv = this.pvbp(MV, md);
    } else if (h.instrument_type === "T-Bill") {
      dur = T; md = T / (1 + y); pv = this.pvbp(MV, md);
    } else {
      dur = this.macDur(F, c, y, T, m);
      md = this.modDur(dur, y, m);
      pv = this.pvbp(MV, md);
    }

    const days = parseInt(h.accrual_days) || 0;
    const ai = !["T-Bill", "Mutual Fund"].includes(h.instrument_type)
      ? this.accInt(F, c || y, days, m) : 0;

    return {
      marketValue: MV, costValue: CV,
      unrealizedPnL: MV - CV,
      unrealizedPnLPct: ((MV - CV) / CV) * 100,
      duration: dur, modifiedDuration: md, pvbp: pv,
      accruedIncome: ai, ytm: y,
    };
  },

  portfolio(holdings) {
    const totalMV = holdings.reduce((s, h) => s + h.marketValue, 0);
    if (!totalMV) return {};
    return {
      totalMV,
      totalCost:       holdings.reduce((s, h) => s + h.costValue, 0),
      weightedYield:   holdings.reduce((s, h) => s + h.ytm * h.marketValue, 0) / totalMV,
      weightedDuration:holdings.reduce((s, h) => s + h.duration * h.marketValue, 0) / totalMV,
      totalPVBP:       holdings.reduce((s, h) => s + h.pvbp, 0),
      totalUnrealized: holdings.reduce((s, h) => s + h.unrealizedPnL, 0),
      totalIncome:     holdings.reduce((s, h) => s + h.accruedIncome, 0),
    };
  }
};

// ── HELPERS ───────────────────────────────────────────────────
function genId() { return "H" + Date.now().toString().slice(-8); }

async function audit(action, table, id, oldVal, newVal) {
  await pool.query(
    `INSERT INTO audit_log (action, table_name, record_id, old_value, new_value)
     VALUES ($1,$2,$3,$4,$5)`,
    [action, table, id, oldVal ? JSON.stringify(oldVal) : null,
     newVal ? JSON.stringify(newVal) : null]
  );
}

// ── ROUTES ────────────────────────────────────────────────────

// GET /api/holdings
app.get("/api/holdings", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.*,
        COALESCE(p.clean_price, h.current_price, h.purchase_price) AS latest_price,
        COALESCE(p.ytm,         h.current_yield,  h.purchase_yield) AS latest_ytm,
        p.price_date AS last_price_date,
        p.source AS price_source
      FROM holdings h
      LEFT JOIN LATERAL (
        SELECT * FROM prices
        WHERE holding_id = h.id
        ORDER BY price_date DESC LIMIT 1
      ) p ON TRUE
      WHERE h.status = 'active'
      ORDER BY h.instrument_type, h.name
    `);

    const enriched = rows.map(h => ({
      ...h,
      ...FI.reval(h, h.latest_price, h.latest_ytm),
    }));

    res.json({ holdings: enriched, portfolio: FI.portfolio(enriched) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/holdings/:id
app.get("/api/holdings/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM holdings WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const h = rows[0];
    const { rows: prices } = await pool.query(
      "SELECT * FROM prices WHERE holding_id=$1 ORDER BY price_date DESC LIMIT 90", [h.id]
    );
    const latestPrice = prices[0]?.clean_price || h.current_price || h.purchase_price;
    const latestYtm   = prices[0]?.ytm         || h.current_yield  || h.purchase_yield;
    res.json({ holding: { ...h, ...FI.reval(h, latestPrice, latestYtm) }, priceHistory: prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/holdings
app.post("/api/holdings", async (req, res) => {
  const b = req.body;
  const id = genId();
  try {
    await pool.query(`
      INSERT INTO holdings (
        id, name, issuer, instrument_type, isin, face_value, coupon_rate,
        coupon_frequency, maturity_date, purchase_date, purchase_price,
        purchase_yield, current_price, current_yield, currency, rating,
        sector, custodian, is_funded, repo_rate, accrual_days, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    `, [
      id, b.name, b.issuer, b.instrument_type, b.isin || null,
      b.face_value, b.coupon_rate || 0, b.coupon_frequency || 2,
      b.maturity_date || null, b.purchase_date, b.purchase_price,
      b.purchase_yield, b.current_price || b.purchase_price,
      b.current_yield || b.purchase_yield, b.currency || "PKR",
      b.rating || null, b.sector || null, b.custodian || null,
      b.is_funded || false, b.repo_rate || null, b.accrual_days || 0,
      b.notes || null
    ]);
    // Insert opening price
    await pool.query(`
      INSERT INTO prices (holding_id, price_date, clean_price, ytm, source)
      VALUES ($1, $2, $3, $4, 'manual')
      ON CONFLICT (holding_id, price_date) DO NOTHING
    `, [id, b.purchase_date, b.purchase_price, b.purchase_yield]);
    await audit("INSERT", "holdings", id, null, b);
    res.status(201).json({ id, message: "Holding created" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/holdings/:id
app.put("/api/holdings/:id", async (req, res) => {
  const b = req.body;
  try {
    const { rows: old } = await pool.query("SELECT * FROM holdings WHERE id=$1", [req.params.id]);
    if (!old.length) return res.status(404).json({ error: "Not found" });
    await pool.query(`
      UPDATE holdings SET
        name             = COALESCE($1, name),
        issuer           = COALESCE($2, issuer),
        instrument_type  = COALESCE($3, instrument_type),
        face_value       = COALESCE($4, face_value),
        coupon_rate      = COALESCE($5, coupon_rate),
        maturity_date    = COALESCE($6, maturity_date),
        current_price    = COALESCE($7, current_price),
        current_yield    = COALESCE($8, current_yield),
        rating           = COALESCE($9, rating),
        sector           = COALESCE($10, sector),
        custodian        = COALESCE($11, custodian),
        is_funded        = COALESCE($12, is_funded),
        repo_rate        = COALESCE($13, repo_rate),
        accrual_days     = COALESCE($14, accrual_days),
        notes            = COALESCE($15, notes),
        updated_at       = NOW()
      WHERE id = $16
    `, [
      b.name, b.issuer, b.instrument_type, b.face_value, b.coupon_rate,
      b.maturity_date, b.current_price, b.current_yield, b.rating,
      b.sector, b.custodian,
      b.is_funded !== undefined ? b.is_funded : null,
      b.repo_rate, b.accrual_days, b.notes,
      req.params.id
    ]);
    await audit("UPDATE", "holdings", req.params.id, old[0], b);
    res.json({ message: "Updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/holdings/:id
app.delete("/api/holdings/:id", async (req, res) => {
  try {
    await pool.query("UPDATE holdings SET status='sold', updated_at=NOW() WHERE id=$1", [req.params.id]);
    await audit("DELETE", "holdings", req.params.id, null, null);
    res.json({ message: "Removed" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/prices  — update a price (recalculates YTM)
app.post("/api/prices", async (req, res) => {
  const { holding_id, price_date, clean_price, source } = req.body;
  try {
    const { rows } = await pool.query("SELECT * FROM holdings WHERE id=$1", [holding_id]);
    if (!rows.length) return res.status(404).json({ error: "Holding not found" });
    const h = rows[0];
    const T = FI.yearsTo(h.maturity_date);
    // Approximate YTM from new price
    const calc = FI.reval(h, clean_price, h.current_yield || h.purchase_yield);
    const date = price_date || dayjs().format("YYYY-MM-DD");
    await pool.query(`
      INSERT INTO prices (holding_id, price_date, clean_price, ytm, source)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (holding_id, price_date)
      DO UPDATE SET clean_price=$3, ytm=$4, source=$5
    `, [holding_id, date, clean_price, calc.ytm, source || "manual"]);
    // Also update the live price on the holding
    await pool.query(
      "UPDATE holdings SET current_price=$1, current_yield=$2, updated_at=NOW() WHERE id=$3",
      [clean_price, calc.ytm, holding_id]
    );
    res.json({ message: "Price updated", ytm: calc.ytm });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/revalue  — run full portfolio revaluation
app.post("/api/revalue", async (req, res) => {
  const date = req.body.date || dayjs().format("YYYY-MM-DD");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: holdings } = await client.query(
      "SELECT * FROM holdings WHERE status='active'"
    );
    const results = [];
    for (const h of holdings) {
      const price = parseFloat(h.current_price || h.purchase_price);
      const ytm   = parseFloat(h.current_yield  || h.purchase_yield);
      const calc  = FI.reval(h, price, ytm);
      await client.query(`
        INSERT INTO revaluations
          (reval_date, holding_id, market_value, cost_value, clean_price, ytm,
           duration, modified_dur, pvbp, accrued_income, unrealized_pnl)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (reval_date, holding_id)
        DO UPDATE SET
          market_value=$3, cost_value=$4, clean_price=$5, ytm=$6,
          duration=$7, modified_dur=$8, pvbp=$9,
          accrued_income=$10, unrealized_pnl=$11
      `, [date, h.id, calc.marketValue, calc.costValue, price, ytm,
          calc.duration, calc.modifiedDuration, calc.pvbp,
          calc.accruedIncome, calc.unrealizedPnL]);
      results.push(calc);
    }
    const port = FI.portfolio(results);
    const nav = port.totalCost > 0
      ? 100 + ((port.totalMV - port.totalCost) / port.totalCost * 100) : 100;
    await client.query(`
      INSERT INTO nav_history (nav_date, portfolio_nav, total_mv, total_cost, total_income)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (nav_date)
      DO UPDATE SET portfolio_nav=$2, total_mv=$3, total_cost=$4, total_income=$5
    `, [date, nav, port.totalMV, port.totalCost, port.totalIncome || 0]);
    await client.query("COMMIT");
    res.json({ date, holdings_revalued: results.length, portfolio: port });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/nav?days=90
app.get("/api/nav", async (req, res) => {
  try {
    const days = parseInt(req.query.days || 90);
    const { rows } = await pool.query(
      "SELECT * FROM nav_history ORDER BY nav_date DESC LIMIT $1", [days]
    );
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/risk
app.get("/api/risk", async (req, res) => {
  try {
    const { rows: limits } = await pool.query("SELECT * FROM risk_limits WHERE is_active=TRUE");
    const { rows: revals } = await pool.query(`
      SELECT r.*, h.name, h.instrument_type, h.sector, h.rating
      FROM revaluations r JOIN holdings h ON h.id=r.holding_id
      WHERE r.reval_date=(SELECT MAX(reval_date) FROM revaluations)
    `);
    const totalMV    = revals.reduce((s, r) => s + parseFloat(r.market_value), 0);
    const wDur       = revals.reduce((s, r) => s + parseFloat(r.duration||0) * parseFloat(r.market_value), 0) / (totalMV||1);
    const totalPVBP  = revals.reduce((s, r) => s + parseFloat(r.pvbp||0), 0);
    const maxConc    = totalMV ? Math.max(...revals.map(r => parseFloat(r.market_value)/totalMV*100)) : 0;
    const checks = limits.map(l => {
      let cur = 0;
      if (l.limit_name === "max_duration")      cur = wDur;
      if (l.limit_name === "max_pvbp")          cur = totalPVBP;
      if (l.limit_name === "max_concentration") cur = maxConc;
      return { ...l, current_value: cur,
        status: cur > l.limit_value ? "BREACH" : cur > l.alert_threshold ? "WATCH" : "OK" };
    });
    res.json({ metrics: { wDur, totalPVBP, totalMV, maxConc }, limits: checks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit
app.get("/api/audit", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scenario
app.post("/api/scenario", async (req, res) => {
  const { shift_bps } = req.body;
  try {
    const { rows: holdings } = await pool.query("SELECT * FROM holdings WHERE status='active'");
    const shift = shift_bps / 10000;
    const results = holdings.map(h => {
      const y  = parseFloat(h.current_yield || h.purchase_yield);
      const ny = y + shift;
      const T  = FI.yearsTo(h.maturity_date);
      const F  = parseFloat(h.face_value);
      const c  = parseFloat(h.coupon_rate);
      const oldMV = F * (parseFloat(h.current_price || h.purchase_price) / 100);
      let newPrice = parseFloat(h.current_price || h.purchase_price);
      if (!["Placement","Mutual Fund"].includes(h.instrument_type)) {
        newPrice = FI.bondPrice(F, c, ny, T) / F * 100;
      }
      const newMV = F * (newPrice / 100);
      return { id: h.id, name: h.name, oldMV, newMV,
        mvChange: newMV - oldMV, pctChange: ((newMV - oldMV) / oldMV) * 100 };
    });
    const oldTotal = results.reduce((s, r) => s + r.oldMV, 0);
    const newTotal = results.reduce((s, r) => s + r.newMV, 0);
    res.json({
      shift_bps,
      portfolio_mv_change: newTotal - oldTotal,
      portfolio_pct_change: ((newTotal - oldTotal) / oldTotal) * 100,
      by_holding: results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NCGCL FI API running on port ${PORT}`);
      console.log(`DATABASE_URL set: ${!!process.env.DATABASE_URL}`);
    });
  })
  .catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
