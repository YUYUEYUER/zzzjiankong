import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUpstreams, worstStatus } from '../server/upstreams.js';

test('upstream aggregation reports balance, status, real accounts and incidents', () => {
  const upstreams = [{ id: 'up-1', name: 'NewCLI' }, { id: 'up-2', name: '空上游' }];
  const accounts = [
    { id: 'acct-1', upstreamId: 'up-1', type: 'newapi', baseUrl: 'https://newapi.example.com', convertedCny: 179.89, status: 'healthy', demo: false, lastSyncAt: '2026-07-13T00:00:00.000Z' },
    { id: 'acct-2', upstreamId: 'up-1', type: 'newapi', baseUrl: 'https://newapi.example.com', convertedCny: 10, status: 'warning', demo: true, lastSyncAt: '2026-07-13T01:00:00.000Z' },
  ];
  const incidents = [{ id: 'inc-1', accountId: 'acct-2', state: 'open' }];
  const result = aggregateUpstreams(upstreams, accounts, incidents);

  assert.equal(result[0].accountCount, 2);
  assert.equal(result[0].realAccountCount, 1);
  assert.equal(result[0].demoAccountCount, 1);
  assert.equal(result[0].totalCny, 189.89);
  assert.equal(result[0].status, 'warning');
  assert.equal(result[0].openIncidents, 1);
  assert.deepEqual(result[0].platforms, ['newapi']);
  assert.deepEqual(result[0].baseUrls, ['https://newapi.example.com']);
  assert.equal(result[1].status, 'empty');
});

test('worstStatus prioritizes connection failures over low balance', () => {
  assert.equal(worstStatus([{ status: 'warning' }, { status: 'error' }, { status: 'healthy' }]), 'error');
  assert.equal(worstStatus([]), 'empty');
});
