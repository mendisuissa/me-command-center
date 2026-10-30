'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'heartbeat.yml'), 'utf8');

test('heartbeat refreshes the dashboard and re-dispatches itself from main', () => {
  assert.match(workflow, /^\s+workflow_dispatch:/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  const steps = [...workflow.matchAll(/run: (.+)/g)].map(match => match[1]);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /gh workflow run publish\.yml --ref main/);
  assert.match(steps[1], /^sleep \d+$/);
  assert.match(steps[2], /gh workflow run heartbeat\.yml --ref main/);
  // A single failed dispatch must not end the chain.
  for (const step of [steps[0], steps[2]]) assert.match(step, /for i in .+; do .+ && exit 0; sleep \d+; done; exit 1/);
  assert.match(workflow, /if: always\(\)\n\s+run: .*heartbeat\.yml/);
});

test('heartbeat keeps the data under 75 minutes old and runs a single chain', () => {
  const sleep = Number(/sleep (\d+)/.exec(workflow)[1]);
  assert.ok(sleep / 60 <= 45, 'a tick plus queueing must stay well under the 75-minute limit');
  assert.match(workflow, /group: heartbeat\n\s+cancel-in-progress: false/);
  assert.match(workflow, /cron: '\d+ \* \* \* \*'/, 'the restart cron runs hourly');
  assert.ok(Number(/timeout-minutes: (\d+)/.exec(workflow)[1]) * 60 > sleep);
});

test('heartbeat holds no secrets and only the actions permission', () => {
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /^permissions: \{\}$/m);
  const granted = [...workflow.matchAll(/^\s{6}(\w[\w-]*): (read|write)$/gm)].map(match => match[1]);
  assert.deepEqual(granted, ['actions']);
});
