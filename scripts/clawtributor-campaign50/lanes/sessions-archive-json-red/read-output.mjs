import assert from "node:assert/strict";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function archiveFact(row, entry) {
  const archived = entry.archivedAt !== undefined;
  const actual = {
    hasArchived: own(row, "archived"),
    ...(row.archived !== undefined ? { archived: row.archived } : {}),
    hasArchivedAt: own(row, "archivedAt"),
    ...(row.archivedAt !== undefined ? { archivedAt: row.archivedAt } : {}),
  };
  return {
    expected: { archived, ...(archived ? { archivedAt: entry.archivedAt } : {}) },
    actual,
    matches:
      actual.hasArchived &&
      actual.archived === archived &&
      actual.hasArchivedAt === archived &&
      (!archived || actual.archivedAt === entry.archivedAt),
  };
}

export function checkSnapshot(snapshot, cases, initial) {
  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.closed, true);
  assert.deepEqual(
    snapshot.targets.map((row) => row.agentId),
    cases.agents,
  );
  assert.equal(snapshot.rows.length, cases.entries.length);
  assert.equal(snapshot.projected.length, cases.entries.length);
  assert.equal(new Set(snapshot.rows.map((row) => row.key)).size, cases.entries.length);
  for (const authored of cases.entries) {
    const row = snapshot.rows.find((row) => row.key === authored.key);
    assert(row && row.agentId === authored.agentId);
    for (const [key, value] of Object.entries(authored.entry))
      assert.deepEqual(row.entry[key], value, key);
    assert.equal(own(row.entry, "archivedAt"), own(authored.entry, "archivedAt"));
  }
  if (initial) {
    assert.deepEqual(snapshot.targets, initial.targets);
    assert.deepEqual(snapshot.rows, initial.rows, "Read-only inventory changed canonical rows");
  }
  return cases.entries.map((entry) => {
    const projected = snapshot.projected.find((row) => row.key === entry.key);
    assert(projected && projected.agentId === entry.agentId);
    return { key: entry.key, ...archiveFact(projected.row, entry.entry) };
  });
}

export function checkCli(test, stdout, stderr, cases, snapshot, startedMs, finishedMs) {
  assert.equal(stderr.trim(), "", "Unexpected CLI stderr");
  const payload = JSON.parse(stdout);
  const expected = cases.entries.filter((row) => test.agents.includes(row.agentId));
  assert.equal(payload.count, expected.length);
  assert.equal(payload.totalCount, expected.length);
  assert.equal(payload.limitApplied, null);
  assert.equal(payload.hasMore, false);
  assert.equal(payload.activeMinutes, null);
  const targets = snapshot.targets.filter((row) => test.agents.includes(row.agentId));
  if (test.id === "single-agent") {
    assert.equal(payload.path, targets[0].sqlitePath);
    assert.equal(own(payload, "allAgents"), false);
    assert.equal(own(payload, "stores"), false);
  } else {
    assert.equal(payload.path, null);
    assert.equal(payload.allAgents, true);
    assert.deepEqual(
      payload.stores,
      targets.map((row) => ({ agentId: row.agentId, path: row.sqlitePath })),
    );
  }
  assert.deepEqual(
    payload.sessions.map((row) => row.key),
    expected.map((row) => row.key),
  );
  const facts = payload.sessions.map((row, index) => {
    const authored = expected[index];
    for (const key of [
      "sessionId",
      "updatedAt",
      "label",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "totalTokensFresh",
      "totalTokensVersion",
      "thinkingLevel",
      "verboseLevel",
    ])
      assert.deepEqual(row[key], authored.entry[key], key);
    assert.equal(row.modelProvider, "openai");
    assert.equal(row.model, authored.expectedModel);
    assert.equal(row.agentId, authored.agentId);
    assert.equal(row.acpRuntime, false);
    assert.equal(row.kind, "direct");
    assert(
      row.agentRuntime && typeof row.agentRuntime.id === "string" && row.agentRuntime.id.length > 0,
    );
    assert(
      typeof row.contextTokens === "number" &&
        Number.isFinite(row.contextTokens) &&
        row.contextTokens > 0,
    );
    assert.equal(own(row, "runtimeLabel"), false);
    assert.equal(own(row, "displayModelRef"), false);
    assert(Number.isFinite(row.ageMs));
    assert(
      row.ageMs >= startedMs - row.updatedAt && row.ageMs <= finishedMs - row.updatedAt,
      "Age must be derived within the real command interval",
    );
    return { key: row.key, ...archiveFact(row, authored.entry) };
  });
  return { payload, facts };
}

export function acceptBaseline(facts) {
  assert(facts.length > 0);
  for (const fact of facts) {
    assert.equal(fact.matches, false, "Baseline must exhibit the specified projection defect");
    assert.equal(
      fact.actual.hasArchived,
      false,
      "Baseline is a missing projection, not a wrong-value case",
    );
    assert.equal(fact.actual.hasArchivedAt, false, "Baseline must omit the timestamp");
  }
  return { intendedViolations: facts.length, facts };
}
