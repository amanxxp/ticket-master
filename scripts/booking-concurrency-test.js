#!/usr/bin/env node
'use strict';

// Week 1 Day 2 acceptance tests for POST /bookings/confirm.
//
// Spawns the booking service itself, seeds fresh inventory per scenario, hammers
// it, then asserts against the DATABASE — not just the status tally. A run that
// only counts 201s would pass even if two booking_items rows existed for one
// ticket, which is the exact bug these tests exist to catch.
//
// Usage:
//   docker compose up -d postgres
//   psql ... -f db/schema.sql
//   node scripts/booking-concurrency-test.js
//
// Env: DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME (same defaults as seed.js)

const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const BOOKING_DIR = path.join(__dirname, '..', 'services', 'booking');
const PORT = Number(process.env.TEST_PORT) || 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'ticketmaster',
  password: process.env.DB_PASSWORD || 'ticketmaster',
  database: process.env.DB_NAME || 'ticketmaster',
};

// ---------------------------------------------------------------- server

function startServer(extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BOOKING_DIR,
    env: { ...process.env, ...dbEnv(), PORT: String(PORT), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write(`[booking] ${b}`));
  return child;
}

function dbEnv() {
  return {
    DB_HOST: dbConfig.host,
    DB_PORT: String(dbConfig.port),
    DB_USER: dbConfig.user,
    DB_PASSWORD: dbConfig.password,
    DB_NAME: dbConfig.database,
  };
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any routed response proves the listener and db pool are up; a 404 for a
      // nonexistent booking is a successful round trip through both.
      const res = await fetch(`${BASE}/bookings/0`);
      if (res.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error('booking service did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// ---------------------------------------------------------------- seeding

async function seed(client, { tickets, label }) {
  const venue = await client.query(
    `INSERT INTO venues (name, location, seat_map) VALUES ($1, 'Nowhere', $2) RETURNING id`,
    [`concurrency ${label}`, JSON.stringify({ sections: [] })]
  );
  const performer = await client.query(
    `INSERT INTO performers (name) VALUES ($1) RETURNING id`,
    [`concurrency ${label}`]
  );
  const event = await client.query(
    `INSERT INTO events (name, venue_id, performer_id, event_date, max_tickets_per_user)
     VALUES ($1, $2, $3, now() + interval '30 days', 20) RETURNING id`,
    [`concurrency ${label}`, venue.rows[0].id, performer.rows[0].id]
  );
  const eventId = event.rows[0].id;
  const seats = await client.query(
    `INSERT INTO tickets (event_id, seat, price)
     SELECT $1, 'S' || gs, 25.00 FROM generate_series(1, $2) AS gs
     RETURNING id`,
    [eventId, tickets]
  );
  const user = await client.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, 'x', 'user') RETURNING id`,
    [`concurrency-${label}-${eventId}@test.local`]
  );
  return { eventId, ticketIds: seats.rows.map((r) => r.id), userId: user.rows[0].id };
}

// ---------------------------------------------------------------- firing

async function confirm(userId, eventId, ticketIds) {
  try {
    const res = await fetch(`${BASE}/bookings/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': String(userId) },
      body: JSON.stringify({ eventId: String(eventId), ticketIds: ticketIds.map(String) }),
    });
    await res.text().catch(() => {});
    return String(res.status);
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

function tally(results) {
  const out = {};
  for (const r of results) out[r] = (out[r] || 0) + 1;
  return out;
}

// ---------------------------------------------------------------- assertions

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name} — ${detail}`);
    failures.push(name);
  }
}

// The invariant, straight from the database: no ticket may appear in more than
// one booking_items row, and a booked ticket must have exactly one.
async function assertNoDoubleBook(client, ticketIds, label) {
  const { rows } = await client.query(
    `SELECT ticket_id, count(*)::int AS n
     FROM booking_items WHERE ticket_id = ANY($1::bigint[])
     GROUP BY ticket_id HAVING count(*) > 1`,
    [ticketIds]
  );
  check(`${label}: zero tickets in >1 booking`, rows.length === 0, JSON.stringify(rows));
}

async function bookedCount(client, ticketIds) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM tickets
     WHERE id = ANY($1::bigint[]) AND status = 'booked'`,
    [ticketIds]
  );
  return rows[0].n;
}

async function bookingItemCount(client, ticketIds) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM booking_items WHERE ticket_id = ANY($1::bigint[])`,
    [ticketIds]
  );
  return rows[0].n;
}

// ---------------------------------------------------------------- scenarios

async function scenario50Concurrent(client) {
  console.log('\n[1] 50 concurrent confirms at ONE ticket');
  const { eventId, ticketIds, userId } = await seed(client, { tickets: 1, label: '50x1' });
  const results = await Promise.all(
    Array.from({ length: 50 }, () => confirm(userId, eventId, ticketIds))
  );
  const t = tally(results);
  console.log(`  tally ${JSON.stringify(t)}`);
  check('exactly 1x 201', t['201'] === 1, `got ${t['201']}`);
  check('other 49 are 409', t['409'] === 49, `got ${t['409']}`);
  check('ticket booked exactly once', (await bookedCount(client, ticketIds)) === 1, 'status wrong');
  check('exactly 1 booking_items row', (await bookingItemCount(client, ticketIds)) === 1, 'row count wrong');
  await assertNoDoubleBook(client, ticketIds, '50x1');
}

async function scenarioOverlappingSets(client) {
  console.log('\n[2] overlapping multi-ticket {A,B} vs {B,C} — all-or-nothing');
  const { eventId, ticketIds, userId } = await seed(client, { tickets: 3, label: 'ABC' });
  const [A, B, C] = ticketIds;
  const results = await Promise.all([
    confirm(userId, eventId, [A, B]),
    confirm(userId, eventId, [B, C]),
  ]);
  const t = tally(results);
  console.log(`  tally ${JSON.stringify(t)}`);
  check('exactly one winner', t['201'] === 1, `got ${JSON.stringify(t)}`);
  check('exactly one loser (409)', t['409'] === 1, `got ${JSON.stringify(t)}`);
  // The loser must leave nothing behind: 2 booked, not 3, and never just B.
  const booked = await bookedCount(client, ticketIds);
  check('winner booked both its seats, loser booked none', booked === 2, `${booked} tickets booked`);
  const items = await bookingItemCount(client, ticketIds);
  check('booking_items matches booked tickets', items === 2, `${items} items`);
  await assertNoDoubleBook(client, ticketIds, 'ABC');
}

async function scenarioOppositeOrder(client) {
  console.log('\n[3] opposite seat order — no deadlock');
  const { eventId, ticketIds, userId } = await seed(client, { tickets: 2, label: 'order' });
  const [A, B] = ticketIds;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      confirm(userId, eventId, i % 2 === 0 ? [A, B] : [B, A])
    )
  );
  const t = tally(results);
  console.log(`  tally ${JSON.stringify(t)}`);
  // A 500 here is the tell: 40P01 deadlock escaping as an unmapped error.
  check('no 500s (deadlock would surface here)', !t['500'], `got ${t['500']} 500s`);
  check('exactly one winner', t['201'] === 1, `got ${t['201']}`);
  await assertNoDoubleBook(client, ticketIds, 'order');
}

// Proves the backstop is real, not decorative: with the CAS guard disabled, only
// UNIQUE(ticket_id) stands between 50 racers and a double-book.
async function scenarioGuardRemoved(client, restart) {
  console.log('\n[4] guard-removal: UNIQUE(ticket_id) alone must hold');
  await restart({ BOOKING_DISABLE_ROWCOUNT_GUARD: 'true' });
  const { eventId, ticketIds, userId } = await seed(client, { tickets: 1, label: 'noguard' });
  const results = await Promise.all(
    Array.from({ length: 50 }, () => confirm(userId, eventId, ticketIds))
  );
  const t = tally(results);
  console.log(`  tally ${JSON.stringify(t)}`);
  check('still exactly 1x 201', t['201'] === 1, `got ${t['201']}`);
  check('49 rejected by the constraint (409)', t['409'] === 49, `got ${JSON.stringify(t)}`);
  check('still exactly 1 booking_items row', (await bookingItemCount(client, ticketIds)) === 1, 'row count wrong');
  await assertNoDoubleBook(client, ticketIds, 'noguard');
  await restart({});
  console.log('  guard re-enabled');
}

// ---------------------------------------------------------------- main

async function main() {
  const client = new Client(dbConfig);
  await client.connect();

  let server;
  const restart = async (extraEnv) => {
    await stopServer(server);
    server = startServer(extraEnv);
    await waitForReady();
  };

  try {
    await restart({});
    await scenario50Concurrent(client);
    await scenarioOverlappingSets(client);
    await scenarioOppositeOrder(client);
    await scenarioGuardRemoved(client, restart);
  } finally {
    await stopServer(server);
    await client.end();
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
