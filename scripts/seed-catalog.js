#!/usr/bin/env node
'use strict';

// Populates a browsable catalog for the frontend to render — this is the
// "admin ticket push" the frontend has no UI for. There is deliberately no
// admin screen in ticket-master-frontend: organizer writes (POST /events,
// ticket generation) are gated to MANAGER_ROLES at the gateway, and building
// that UI was out of scope for a *user*-facing app. This script is the
// replacement — the same job a real admin panel would do, run once against
// the database directly.
//
// Usage:
//   DB_HOST=localhost DB_PORT=5432 DB_USER=ticketmaster DB_PASSWORD=ticketmaster DB_NAME=ticketmaster \
//     node scripts/seed-catalog.js
//
// Deliberately not idempotent, same as scripts/seed.js — re-running adds a
// second copy of the catalog rather than upserting. Fine for a demo database
// you're happy to reset (`npm run reset`) between runs.

const { Client } = require('pg');

async function venue(client, name, location) {
  const { rows } = await client.query(
    `INSERT INTO venues (name, location, seat_map) VALUES ($1, $2, $3) RETURNING id`,
    [name, location, JSON.stringify({ sections: [] })]
  );
  return rows[0].id;
}

async function performer(client, name) {
  const { rows } = await client.query(`INSERT INTO performers (name) VALUES ($1) RETURNING id`, [name]);
  return rows[0].id;
}

async function event(client, { name, description, venueId, performerId, eventDate, maxTicketsPerUser, queueMode, saleOpensAt }) {
  const { rows } = await client.query(
    `INSERT INTO events
       (name, description, venue_id, performer_id, event_date, max_tickets_per_user, queue_mode, sale_opens_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [name, description, venueId, performerId, eventDate, maxTicketsPerUser, queueMode ?? 'fifo', saleOpensAt ?? null]
  );
  return rows[0].id;
}

// `rows` × `cols` seats named A1..A20, B1..B20, ... — `priceByRow(rowIndex)`
// lets the front rows cost more, which is the one thing that makes a seed
// catalog look like real inventory instead of a uniform test fixture.
async function tickets(client, eventId, { rows, cols, priceByRow, bookedFraction = 0 }) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const values = [];
  const params = [eventId];
  let i = 2;

  for (let r = 0; r < rows; r++) {
    const price = priceByRow(r);
    for (let c = 1; c <= cols; c++) {
      const seat = `${letters[r]}${c}`;
      // A deterministic-looking but scattered "already booked" fraction, so a
      // partially-sold event doesn't render as one suspiciously solid block.
      const booked = bookedFraction > 0 && (r * cols + c) % Math.round(1 / bookedFraction) === 0;
      values.push(`($1, $${i++}, $${i++}, ${booked ? "'booked'" : "'available'"})`);
      params.push(seat, price.toFixed(2));
    }
  }

  await client.query(
    `INSERT INTO tickets (event_id, seat, price, status) VALUES ${values.join(', ')}`,
    params
  );
  return rows * cols;
}

function daysFromNow(days, hour = 19) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'ticketmaster',
    password: process.env.DB_PASSWORD || 'ticketmaster',
    database: process.env.DB_NAME || 'ticketmaster',
  });
  await client.connect();

  const created = [];

  // ---- 1. Standard on-sale event, mid-size venue, tiered pricing ----------
  {
    const venueId = await venue(client, 'NSCI Dome', 'Mumbai');
    const performerId = await performer(client, 'Arctic Monkeys');
    const eventId = await event(client, {
      name: 'Arctic Monkeys — Live in Concert',
      description: 'One night only. Doors at 6 PM, support act at 7.',
      venueId,
      performerId,
      eventDate: daysFromNow(45),
      maxTicketsPerUser: 6,
    });
    const count = await tickets(client, eventId, {
      rows: 10,
      cols: 20,
      priceByRow: (r) => 8000 - r * 500, // front row 8000, back row 3500
    });
    created.push({ eventId, name: 'Arctic Monkeys — Live in Concert', note: `${count} seats, on sale now` });
  }

  // ---- 2. Small venue, low price, mostly available ------------------------
  {
    const venueId = await venue(client, 'The Comedy Store', 'Mumbai');
    const performerId = await performer(client, 'Vir Das');
    const eventId = await event(client, {
      name: 'Mumbai Comedy Nights ft. Vir Das',
      description: 'An hour of new material, work-in-progress set.',
      venueId,
      performerId,
      eventDate: daysFromNow(10),
      maxTicketsPerUser: 4,
    });
    const count = await tickets(client, eventId, {
      rows: 6,
      cols: 10,
      priceByRow: () => 999,
      bookedFraction: 0.2,
    });
    created.push({ eventId, name: 'Mumbai Comedy Nights ft. Vir Das', note: `${count} seats, ~20% already booked` });
  }

  // ---- 3. Fully sold out — exercises the waitlist ------------------------
  {
    const venueId = await venue(client, 'Wankhede Stadium', 'Mumbai');
    const performerId = await performer(client, 'IPL Final — Watch Party');
    const eventId = await event(client, {
      name: 'IPL Final Watch Party',
      description: 'Big screen, stadium sound, zero seats left.',
      venueId,
      performerId,
      eventDate: daysFromNow(20),
      maxTicketsPerUser: 4,
    });
    const count = await tickets(client, eventId, {
      rows: 4,
      cols: 10,
      priceByRow: () => 1500,
      bookedFraction: 1, // every seat booked
    });
    created.push({ eventId, name: 'IPL Final Watch Party', note: `${count} seats, SOLD OUT — join the waitlist` });
  }

  // ---- 4. Lottery mode, registration window still open --------------------
  {
    const venueId = await venue(client, 'Aamby Valley', 'Lonavala');
    const performerId = await performer(client, 'Neon Nights Collective');
    const eventId = await event(client, {
      name: 'Neon Nights — Electronic Music Festival',
      description: 'Three stages, sunrise set. Registration closes when the sale opens.',
      venueId,
      performerId,
      eventDate: daysFromNow(60),
      maxTicketsPerUser: 8,
      queueMode: 'lottery',
      saleOpensAt: minutesFromNow(10),
    });
    const count = await tickets(client, eventId, {
      rows: 20,
      cols: 25,
      priceByRow: (r) => (r < 3 ? 6000 : 2500),
    });
    created.push({
      eventId,
      name: 'Neon Nights — Electronic Music Festival',
      note: `${count} seats, LOTTERY MODE — sale opens in 10 minutes, register now`,
    });
  }

  // ---- 5. Premium tier, small capacity -------------------------------------
  {
    const venueId = await venue(client, 'NCPA', 'Mumbai');
    const performerId = await performer(client, 'Zubin Mehta');
    const eventId = await event(client, {
      name: 'Sunburn Classical — Zubin Mehta Conducts',
      description: 'An evening of Beethoven and Mahler.',
      venueId,
      performerId,
      eventDate: daysFromNow(75),
      maxTicketsPerUser: 4,
    });
    const count = await tickets(client, eventId, {
      rows: 8,
      cols: 10,
      priceByRow: (r) => 5000 - r * 300,
    });
    created.push({ eventId, name: 'Sunburn Classical — Zubin Mehta Conducts', note: `${count} seats, premium pricing` });
  }

  // ---- 6. Standard tour date ------------------------------------------------
  {
    const venueId = await venue(client, 'Phoenix Marketcity', 'Pune');
    const performerId = await performer(client, 'Zakir Khan');
    const eventId = await event(client, {
      name: 'Stand-Up India Tour — Zakir Khan',
      description: 'The Pune leg of the national tour.',
      venueId,
      performerId,
      eventDate: daysFromNow(30),
      maxTicketsPerUser: 6,
    });
    const count = await tickets(client, eventId, {
      rows: 12,
      cols: 15,
      priceByRow: (r) => 2000 - r * 60,
      bookedFraction: 0.1,
    });
    created.push({ eventId, name: 'Stand-Up India Tour — Zakir Khan', note: `${count} seats, ~10% already booked` });
  }

  await client.end();

  console.log('\nCatalog seeded:\n');
  for (const row of created) {
    console.log(`  event ${row.eventId}  ${row.name}`);
    console.log(`    ${row.note}`);
  }
  console.log('\nBrowse them at http://localhost:<frontend-port>/events/<id>\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
