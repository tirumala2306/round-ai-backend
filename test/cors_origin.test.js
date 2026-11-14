import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCorsOrigin } from '../src/server.js';

test('cors: wildcard passthrough', () => {
  assert.equal(resolveCorsOrigin('https://a.example', '*'), '*');
});

test('cors: reflects matching origin from comma list', () => {
  const cfg = 'https://admin.example,https://app.example,http://localhost:5173';
  assert.equal(resolveCorsOrigin('https://app.example', cfg), 'https://app.example');
  assert.equal(resolveCorsOrigin('http://localhost:5173', cfg), 'http://localhost:5173');
});

test('cors: unknown origin falls back to first allow-list entry', () => {
  const cfg = 'https://admin.example,https://app.example';
  assert.equal(resolveCorsOrigin('https://evil.example', cfg), 'https://admin.example');
});
