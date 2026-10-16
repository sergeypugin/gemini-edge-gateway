import test from "node:test";
import assert from "node:assert/strict";
import { getAnalyticsSnapshot } from "../src/lib/analytics.js";
import { DAY_HOURS_MS } from "../src/lib/utils.js";

function createEnv(states) {
  return {
    DB: {
      prepare(sql) {
        const statement = {
          async first() {
            return null;
          },
          async all() {
            if (sql.includes("FROM matrix_state")) {
              return { results: states };
            }
            return { results: [] };
          },
        };
        return {
          ...statement,
          bind() {
            return statement;
          },
        };
      },
    },
  };
}

test("newer pair results override an older model-wide cooldown", async () => {
  const model = "gemini-3.8-flash";
  const updatedAt = Date.now();
  const discovery = {
    smart: [model],
    lite: [],
    validatedKeys: [],
    rawModels: [model],
    lastUpdated: new Date().toISOString(),
  };
  const snapshot = await getAnalyticsSnapshot(discovery, [{ id: "KEY_1" }, { id: "KEY_2" }], createEnv([
    { model, key_id: "KEY_1", status: "200", updated_at: updatedAt },
    { model, key_id: "KEY_2", status: "503", updated_at: updatedAt - 1000 },
  ]));

  assert.equal(snapshot.matrix[model].KEY_1.status, "200");
  assert.equal(snapshot.matrix[model].KEY_2.status, "503");
});

test("newer distinct pair error overrides an older model-wide timeout", async () => {
  const model = "gemini-3.8-flash";
  const updatedAt = Date.now();
  const discovery = {
    smart: [model],
    lite: [],
    validatedKeys: [],
    rawModels: [model],
    lastUpdated: new Date().toISOString(),
  };
  const snapshot = await getAnalyticsSnapshot(discovery, [{ id: "KEY_1" }, { id: "KEY_2" }], createEnv([
    { model, key_id: "KEY_1", status: "RPM", updated_at: updatedAt },
    { model, key_id: "KEY_2", status: "TIMEOUT", updated_at: updatedAt - 1000 },
  ]));

  assert.equal(snapshot.matrix[model].KEY_1.status, "RPM");
  assert.equal(snapshot.matrix[model].KEY_2.status, "TIMEOUT");
});

test("matrix expires stale model-wide 404 statuses after 24 hours", async () => {
  const model = "gemini-2.5-flash-lite";
  const keys = [{ id: "KEY_1" }, { id: "KEY_2" }];
  const discovery = {
    smart: [],
    lite: [model],
    validatedKeys: [],
    rawModels: [model],
    lastUpdated: new Date().toISOString(),
  };
  const staleEnv = createEnv([{
    model,
    key_id: "KEY_1",
    status: "404",
    updated_at: Date.now() - DAY_HOURS_MS - 1,
  }]);

  const staleSnapshot = await getAnalyticsSnapshot(discovery, keys, staleEnv);
  assert.equal(staleSnapshot.matrix[model].KEY_1.status, "-");
  assert.equal(staleSnapshot.matrix[model].KEY_2.status, "-");

  const activeEnv = createEnv([{
    model,
    key_id: "KEY_1",
    status: "404",
    updated_at: Date.now(),
  }]);
  const activeSnapshot = await getAnalyticsSnapshot(discovery, keys, activeEnv);
  assert.equal(activeSnapshot.matrix[model].KEY_1.status, "404", JSON.stringify(activeSnapshot.matrix[model]));
  assert.equal(activeSnapshot.matrix[model].KEY_2.status, "404");
});
