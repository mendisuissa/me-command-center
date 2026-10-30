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
  assert.deepEqual(steps, [
    'gh workflow run publish.yml --ref main',
    'sleep 1680',
    'gh workflow run heartbeat.yml --ref main',
  ]);
});

test('heartbeat keeps the data under 75 minutes old and runs a single chain', () => {
  const sleep = Number(/sleep (\d+)/.exec(workflow)[1]);
  assert.ok(sleep / 60 <= 45, 'a tick plus queueing must stay well under the 75-minute limit');
  assert.match(workflow, /group: heartbeat\n\s+cancel-in-progress: true/);
  assert.ok(Number(/timeout-minutes: (\d+)/.exec(workflow)[1]) * 60 > sleep);
});

test('heartbeat holds no secrets and only the actions permission', () => {
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /^permissions: \{\}$/m);
  const granted = [...workflow.matchAll(/^\s{6}(\w[\w-]*): (read|write)$/gm)].map(match => match[1]);
  assert.deepEqual(granted, ['actions']);
});
