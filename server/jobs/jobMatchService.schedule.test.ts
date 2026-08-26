/**
 * DB-backed tests for the configurable country-search schedule: which
 * countries run on which day of the week, and how many opportunities to
 * shortlist per country per day. Runs against a real Postgres connection
 * (like applyService.dedup.test.ts) since the schedule is a real table, not
 * a pure function.
 *
 * The schedule is a global, single-row-per-entry config table (not scoped to
 * a test-specific foreign key), so this suite snapshots whatever is
 * currently configured before mutating it, and restores that snapshot in
 * `after()` — the real dev/admin-configured schedule must survive a test run.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, client } from '../db.js';
import { countrySchedule, type CountrySchedule } from '../../shared/schema.js';
import { getCountrySchedule, saveCountrySchedule, SUPPORTED_COUNTRIES } from './jobMatchService.js';

let snapshot: CountrySchedule[] = [];

before(async () => {
  snapshot = await db.select().from(countrySchedule);
});

after(async () => {
  await db.transaction(async (tx) => {
    await tx.delete(countrySchedule);
    if (snapshot.length > 0) {
      await tx.insert(countrySchedule).values(snapshot.map((r) => ({
        dayOfWeek: r.dayOfWeek, country: r.country, shortlistCount: r.shortlistCount,
      })));
    }
  });
  await client.end({ timeout: 5 }).catch(() => {});
});

describe('SUPPORTED_COUNTRIES', () => {
  it('includes the original 7 rotation countries plus the 5 newly added ones', () => {
    for (const c of ['Malaysia', 'Australia', 'New Zealand', 'Ireland', 'Switzerland', 'Sweden', 'Poland']) {
      assert.ok(SUPPORTED_COUNTRIES.includes(c), `missing original country: ${c}`);
    }
    for (const c of ['Luxembourg', 'Netherlands', 'Spain', 'Germany', 'Norway']) {
      assert.ok(SUPPORTED_COUNTRIES.includes(c), `missing new country: ${c}`);
    }
    assert.ok(SUPPORTED_COUNTRIES.includes('India'), 'missing India');
  });
});

describe('getCountrySchedule (default seeding)', () => {
  it('seeds the built-in one-country-per-day default when the table is empty', async () => {
    await db.delete(countrySchedule);
    const rows = await getCountrySchedule();
    assert.equal(rows.length, 7, 'one row per day of the week');
    const days = rows.map((r) => r.dayOfWeek).sort((a, b) => a - b);
    assert.deepEqual(days, [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(rows.every((r) => r.shortlistCount === 10), 'default shortlist count is 10');
    assert.equal(rows.find((r) => r.dayOfWeek === 0)?.country, 'Malaysia', 'Sunday defaults to Malaysia');
  });

  it('does not re-seed once the table has been configured at all', async () => {
    await saveCountrySchedule([{ dayOfWeek: 2, country: 'Germany', shortlistCount: 15 }]);
    const rows = await getCountrySchedule();
    assert.equal(rows.length, 1, 'a deliberately minimal schedule must not be padded back out to 7 defaults');
    assert.equal(rows[0].country, 'Germany');
  });
});

describe('saveCountrySchedule', () => {
  it('supports multiple countries on the same day', async () => {
    const saved = await saveCountrySchedule([
      { dayOfWeek: 1, country: 'Netherlands', shortlistCount: 10 },
      { dayOfWeek: 1, country: 'Spain', shortlistCount: 10 },
    ]);
    const monday = saved.filter((r) => r.dayOfWeek === 1);
    assert.equal(monday.length, 2);
    assert.deepEqual(monday.map((r) => r.country).sort(), ['Netherlands', 'Spain']);
  });

  it('supports the SAME country appearing on multiple different days', async () => {
    const saved = await saveCountrySchedule([
      { dayOfWeek: 0, country: 'Norway', shortlistCount: 10 },
      { dayOfWeek: 3, country: 'Norway', shortlistCount: 10 },
    ]);
    const norwayDays = saved.filter((r) => r.country === 'Norway').map((r) => r.dayOfWeek).sort();
    assert.deepEqual(norwayDays, [0, 3]);
  });

  it('the documented "increase to 2 countries / 20 per day" scenario round-trips exactly', async () => {
    const saved = await saveCountrySchedule([
      { dayOfWeek: 4, country: 'Switzerland', shortlistCount: 10 },
      { dayOfWeek: 4, country: 'Luxembourg', shortlistCount: 10 },
    ]);
    const thursday = saved.filter((r) => r.dayOfWeek === 4);
    assert.equal(thursday.length, 2);
    assert.equal(thursday.reduce((sum, r) => sum + r.shortlistCount, 0), 20);
  });

  it('silently drops rows with an unsupported country, an out-of-range day, or an out-of-range count', async () => {
    const saved = await saveCountrySchedule([
      { dayOfWeek: 1, country: 'Atlantis', shortlistCount: 10 },   // unsupported country
      { dayOfWeek: 9, country: 'Germany', shortlistCount: 10 },    // invalid day (0-6 only)
      { dayOfWeek: 2, country: 'Spain', shortlistCount: 0 },       // below the 1-50 bound
      { dayOfWeek: 2, country: 'Norway', shortlistCount: 999 },    // above the 1-50 bound
      { dayOfWeek: 2, country: 'Germany', shortlistCount: 20 },    // the one valid row
    ] as any);
    assert.deepEqual(saved.map((r) => ({ dayOfWeek: r.dayOfWeek, country: r.country, shortlistCount: r.shortlistCount })), [
      { dayOfWeek: 2, country: 'Germany', shortlistCount: 20 },
    ]);
  });

  it('replaces the entire schedule — an empty array clears every day', async () => {
    await saveCountrySchedule([{ dayOfWeek: 5, country: 'Sweden', shortlistCount: 10 }]);
    const cleared = await saveCountrySchedule([]);
    assert.deepEqual(cleared, []);
  });
});
