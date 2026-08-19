const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-privacy');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'PrivacyOwner';
process.env.OWNER_INITIAL_PASSWORD = 'privacy-owner-secure-password';
process.env.OWNER_EMAIL = 'privacy-owner@college.edu';
process.env.OWNER_NAME = 'Privacy Owner';

const { server, db, ready } = require('../server');
let base;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  return { response, data: await response.json() };
}

async function login(login, password) {
  const { response } = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('management notes are hidden from the ticket reporter', async () => {
  let result = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Ticket Student',
      username: 'ticket.student',
      email: 'ticket.student@college.edu',
      password: 'student-secure-password'
    })
  });
  assert.equal(result.response.status, 201);
  const studentCookie = result.response.headers.get('set-cookie').split(';')[0];

  result = await request('/api/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: studentCookie },
    body: JSON.stringify({ subject: 'Private note check', description: 'Test ticket', category: 'Account' })
  });
  assert.equal(result.response.status, 201);
  const issueId = result.data.id;

  const ownerCookie = await login('PrivacyOwner', 'privacy-owner-secure-password');
  result = await request(`/api/issues/${issueId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ status: 'in_progress', adminNote: 'Internal management context only' })
  });
  assert.equal(result.response.status, 200);

  result = await request('/api/issues', { headers: { cookie: studentCookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.issues.length, 1);
  assert.equal(Object.hasOwn(result.data.issues[0], 'admin_note'), false);
  assert.equal(result.data.issues[0].status, 'in_progress');

  result = await request('/api/issues', { headers: { cookie: ownerCookie } });
  assert.equal(result.response.status, 200);
  const ownerIssue = result.data.issues.find(issue => issue.id === issueId);
  assert.equal(ownerIssue.admin_note, 'Internal management context only');
});
