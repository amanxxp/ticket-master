#!/usr/bin/env bash
# Returns Postgres and Redis to a state the acceptance tests can assume.
#
# Needed because the per-user cap counts confirmed tickets: a previous run's
# bookings make a later run fail the cap assertions, which reads as a code
# regression when it is only leftover data. Seats are reset rather than reseeded
# so ticket ids stay stable across runs.
set -euo pipefail

cd "$(dirname "$0")/.."

docker-compose exec -T postgres psql -U ticketmaster -d ticketmaster -q <<'SQL'
TRUNCATE payments, booking_items, bookings, outbox RESTART IDENTITY;
UPDATE tickets SET status = 'available';
SQL

docker-compose exec -T redis redis-cli FLUSHALL > /dev/null

echo "reset: $(docker-compose exec -T postgres psql -U ticketmaster -d ticketmaster -tAc "SELECT count(*) FROM tickets WHERE status='available'") tickets available, 0 bookings, redis flushed"
