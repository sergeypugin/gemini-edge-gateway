import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const baselinePath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const migrationPath = fileURLToPath(new URL("../db/migrations/0001_v1_to_v2_split_log_timings.sql", import.meta.url));
const baseline = readFileSync(baselinePath, "utf8");
const migration = readFileSync(migrationPath, "utf8");

function getColumns(db) {
  return db.prepare("PRAGMA table_info(logs)").all().map(row => row.name);
}

test("db/schema.sql remains the idempotent v1 legacy baseline", () => {
  assert.match(baseline, /duration_ms INTEGER/);
  assert.doesNotMatch(baseline, /ttfb_ms|response_ms|ALTER TABLE|MIGRATIONS:/);
  assert.match(baseline, /CREATE TABLE IF NOT EXISTS logs/);
});

test("0001 adds nullable timing columns and drops duration_ms", () => {
  assert.deepEqual(
    migration.split(";").map(statement => statement.trim()).filter(Boolean),
    [
      "ALTER TABLE logs ADD COLUMN ttfb_ms INTEGER",
      "ALTER TABLE logs ADD COLUMN response_ms INTEGER",
      "ALTER TABLE logs DROP COLUMN duration_ms",
    ],
  );
});

test("baseline and migration preserve existing rows and leave new timings null", () => {
  const freshDb = new DatabaseSync(":memory:");
  freshDb.exec(baseline);
  const baselineColumns = getColumns(freshDb);
  assert.ok(baselineColumns.includes("duration_ms"));
  assert.ok(!baselineColumns.includes("ttfb_ms"));
  assert.ok(!baselineColumns.includes("response_ms"));

  freshDb.exec(migration);
  const finalColumns = getColumns(freshDb);
  assert.ok(!finalColumns.includes("duration_ms"));
  assert.ok(finalColumns.includes("ttfb_ms"));
  assert.ok(finalColumns.includes("response_ms"));
  assert.equal(freshDb.prepare("SELECT ttfb_ms, response_ms FROM logs").get(), undefined);
  freshDb.close();

  const legacyDb = new DatabaseSync(":memory:");
  legacyDb.exec(baseline);
  legacyDb.prepare(
    "INSERT INTO logs (timestamp, level, message, duration_ms, details) VALUES (?, ?, ?, ?, ?)",
  ).run("2025-01-01", "info", "historic", 83, null);
  const oldColumns = getColumns(legacyDb);
  legacyDb.exec(baseline);
  assert.deepEqual(getColumns(legacyDb), oldColumns);

  let row = legacyDb.prepare("SELECT * FROM logs").get();
  assert.equal(row.duration_ms, 83);
  assert.equal("ttfb_ms" in row, false);

  legacyDb.exec(migration);
  row = legacyDb.prepare("SELECT * FROM logs").get();
  assert.equal(row.id, 1);
  assert.equal(row.message, "historic");
  assert.equal(row.ttfb_ms, null);
  assert.equal(row.response_ms, null);
  assert.equal("duration_ms" in row, false);
  legacyDb.close();
});
