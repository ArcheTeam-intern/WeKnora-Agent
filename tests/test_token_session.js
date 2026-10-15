const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../web/assets/session.js');
const token = exp => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;

test('accepts externally issued credentials and preserves the workspace', () => {
  const value = session.normalize({ profile: { email: '15918868657@163.com', tenant_id: '2' }, token: token(2000) }, 1000);
  assert.equal(value.tenant_id, '2');
  assert.equal(value.expires_at, 2000);
  assert.equal(value.email, '15918868657@163.com');
});

test('expired JWT cannot be revived by a forged expires_at field', () => {
  assert.throws(() => session.normalize({ token: token(900), expires_at: 999999, profile: { tenant_id: '2' } }, 1000), /过期/);
});

test('invalid token and workspace are rejected before making requests', () => {
  assert.throws(() => session.normalize({ token: 'not-jwt', profile: { tenant_id: '2' } }, 1000), /Token/);
  assert.throws(() => session.normalize({ token: token(2000), profile: { tenant_id: '' } }, 1000), /空间/);
});

test('trace redacts credentials and uploaded bytes without hiding retrieval text', () => {
  const value = session.redact({ token: 'secret', password: 'password', request: { name: 'upload_file', arguments: { content: 'YWJj' } }, response: { content: 'actual source paragraph' } });
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.equal(value.request.arguments.content.includes('YWJj'), false);
  assert.equal(value.response.content, 'actual source paragraph');
});

test('auth failures in HTTP and SSE share the same classification', () => {
  assert.equal(session.isAuthError(401, {}), true);
  assert.equal(session.isAuthError(200, { error_code: 'UNAUTHORIZED' }), true);
  assert.equal(session.isAuthError(200, { http_status: 401 }), true);
  assert.equal(session.isAuthError(403, { error_code: 'FORBIDDEN' }), false);
});

test('late errors from an old token never invalidate its replacement', () => {
  assert.equal(session.canInvalidate('old', { token: 'new' }), false);
  assert.equal(session.canInvalidate('new', { token: 'new' }), true);
});
