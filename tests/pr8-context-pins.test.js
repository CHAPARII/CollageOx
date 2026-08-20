const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8-pins');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'PinOwner';
process.env.OWNER_INITIAL_PASSWORD = 'pin-owner-secure-password';
process.env.OWNER_EMAIL = 'pinowner@college.edu';
process.env.OWNER_NAME = 'Pin Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { server, db, ready } = require('../server');

let base;
let owner;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

const headers = cookie => ({ 'Content-Type': 'application/json', Cookie: cookie });

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'PinOwner', password: 'pin-owner-secure-password' })
  });
  assert.equal(login.response.status, 200);
  owner = { cookie: login.response.headers.get('set-cookie').split(';')[0], user: login.data.user };
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('current project pin can be read after pinning a project update', async () => {
  const project = await request('/api/projects', {
    method: 'POST', headers: headers(owner.cookie),
    body: JSON.stringify({ name: 'Pinned Project', pitch: 'Test pin', skills: [], capacity: 3 })
  });
  const projectId = project.data.project.id;
  const post = await request('/api/posts', {
    method: 'POST', headers: headers(owner.cookie),
    body: JSON.stringify({ body: 'Pinned project update', type: 'update', tags: [], context: { type: 'project', id: projectId } })
  });
  const pinned = await request(`/api/pins/project/${projectId}`, {
    method: 'PUT', headers: headers(owner.cookie), body: JSON.stringify({ postId: post.data.post.id })
  });
  assert.equal(pinned.response.status, 200);

  const current = await request(`/api/pins/project/${projectId}`, { headers: { Cookie: owner.cookie } });
  assert.equal(current.response.status, 200);
  assert.equal(current.data.post.id, post.data.post.id);
  assert.equal(current.data.post.body, 'Pinned project update');
});

test('current club pin can be read after pinning a club update', async () => {
  const club = await request('/api/clubs', {
    method: 'POST', headers: headers(owner.cookie),
    body: JSON.stringify({ name: 'Pinned Club', description: 'Test pin', category: 'Community', accent: '#155eef' })
  });
  const clubId = club.data.club.id;
  const post = await request('/api/posts', {
    method: 'POST', headers: headers(owner.cookie),
    body: JSON.stringify({ body: 'Pinned club update', type: 'update', tags: [], context: { type: 'club', id: clubId } })
  });
  const pinned = await request(`/api/pins/club/${clubId}`, {
    method: 'PUT', headers: headers(owner.cookie), body: JSON.stringify({ postId: post.data.post.id })
  });
  assert.equal(pinned.response.status, 200);

  const current = await request(`/api/pins/club/${clubId}`, { headers: { Cookie: owner.cookie } });
  assert.equal(current.response.status, 200);
  assert.equal(current.data.post.id, post.data.post.id);
  assert.equal(current.data.post.body, 'Pinned club update');
});
