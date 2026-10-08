import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const baselinePath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const migrationPath = fileURLToPath(new URL("../db/migrations/0001_v1_to_v2_split_log_timings.sql", import.meta.url));
const baseline = readFileSync(baselinePath, "utf8");
const migration = readFileSync(migrationPath, "utf8");

const sqliteTest = String.raw`
import json
import sqlite3
import sys

payload = json.load(sys.stdin)
baseline = payload["baseline"]
migration = payload["migration"]

def columns(connection):
    return [row["name"] for row in connection.execute("PRAGMA table_info(logs)")]

def migrate_fresh_database():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(baseline)
    baseline_columns = columns(connection)
    assert "duration_ms" in baseline_columns
    assert "ttfb_ms" not in baseline_columns
    assert "response_ms" not in baseline_columns
    connection.executescript(migration)
    final_columns = columns(connection)
    assert "duration_ms" not in final_columns
    assert "ttfb_ms" in final_columns
    assert "response_ms" in final_columns
    assert connection.execute("SELECT ttfb_ms, response_ms FROM logs").fetchone() is None
    connection.close()

def migrate_legacy_database():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(baseline)
    connection.execute(
        "INSERT INTO logs (timestamp, level, message, duration_ms, details) VALUES (?, ?, ?, ?, ?)",
        ("2025-01-01", "info", "historic", 83, None),
    )
    old_columns = columns(connection)
    connection.executescript(baseline)
    assert columns(connection) == old_columns
    row = connection.execute("SELECT * FROM logs").fetchone()
    assert row["duration_ms"] == 83
    assert "ttfb_ms" not in row.keys()
    connection.executescript(migration)
    row = connection.execute("SELECT * FROM logs").fetchone()
    assert row["id"] == 1
    assert row["message"] == "historic"

    assert row["ttfb_ms"] is None
    assert row["response_ms"] is None
    assert "duration_ms" not in row.keys()
    connection.close()

migrate_fresh_database()
migrate_legacy_database()
`;

function runSqliteTest(t) {
  const candidates = process.platform == "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const executable of candidates) {
    const availability = spawnSync(executable, ["-c", "import sqlite3"], { encoding: "utf8" });
    if (availability.error || availability.status != 0) continue;

    const result = spawnSync(executable, ["-c", sqliteTest], {
      encoding: "utf8",
      input: JSON.stringify({ baseline, migration }),
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return;
  }

  t.skip("Python 3 with sqlite3 is unavailable for executing the SQL files");
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

test("baseline and migration preserve existing rows and leave new timings null", t => {
  runSqliteTest(t);
});
