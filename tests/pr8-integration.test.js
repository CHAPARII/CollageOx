const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'PrEightOwner';
process.env.OWNER_INITIAL_PASSWORD = 'pr8-owner-secure-password';
process.env.OWNER_EMAIL = 'pr8owner@college.edu';
process.env.OWNER_NAME = 'PR Eight Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { enhancedIndex } = require('../src/static-enhancements');
const { server, db, ready } = require('../server');

let base;
let owner;
let student;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function ownerCookie() {
  const { response } = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'PrEightOwner', password: 'pr8-owner-secure-password' })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function login(login, password) {
  const { response, data } = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password })
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

async function register(username) {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: username.replace('.', ' '),
      username,
      email: `${username.replaceAll('.', '')}@college.edu`,
      password: 'long-secure-password'
    })
  });
  assert.equal(response.status, 201);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

function jsonHeaders(cookie) {
  return { 'Content-Type': 'application/json', Cookie: cookie };
}

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('PrEightOwner', 'pr8-owner-secure-password');
  student = await register('pr8.student');
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('migration v3 and PR8 forward migrations are applied', async () => {
  const v3 = await db.get('SELECT version,name FROM schema_migrations WHERE version=?', [3]);
  assert.equal(v3.version, 3);
  assert.equal(v3.name, 'stability_and_core_features');
  const rows = await db.all('SELECT version FROM schema_migrations WHERE version>=4 ORDER BY version');
  assert.deepEqual(rows.map(row => Number(row.version)), [4, 5, 6, 7, 8, 9]);
});

test('production shell loads the PR8 frontend assets', () => {
  const html = enhancedIndex();
  assert.match(html, /pr8\.css\?v=1/);
  assert.match(html, /pr8\.js\?v=1/);
  assert.match(html, /app\.js\?v=3&build=pr8/);
  assert.match(html, /styles\.css\?v=3&build=pr8/);
});

test('project list keeps project name separate from owner name', async () => {
  const created = await request('/api/projects', {
    method: 'POST',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ name: 'Campus Robotics', pitch: 'Build small robots', skills: ['Robotics'], capacity: 4 })
  });
  assert.equal(created.response.status, 201);
  assert.ok(created.data.project?.id);

  const listed = await request('/api/projects', { headers: { Cookie: owner.cookie } });
  assert.equal(listed.response.status, 200);
  const project = listed.data.projects.find(item => item.id === created.data.project.id);
  assert.ok(project);
  assert.equal(project.name, 'Campus Robotics');
  assert.equal(project.ownerName, 'PR Eight Owner');
});

test('project join requires an application message and owner approval', async () => {
  const created = await request('/api/projects', {
    method: 'POST',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ name: 'Design Lab', pitch: 'Make campus tools', skills: ['Design'], capacity: 3 })
  });
  assert.equal(created.response.status, 201);
  const projectId = created.data.project.id;

  const noMessage = await request(`/api/projects/${projectId}/join`, {
    method: 'POST',
    headers: jsonHeaders(student.cookie),
    body: JSON.stringify({})
  });
  assert.equal(noMessage.response.status, 400);

  const applied = await request(`/api/projects/${projectId}/join`, {
    method: 'POST',
    headers: jsonHeaders(student.cookie),
    body: JSON.stringify({ message: 'I can help with interface design.' })
  });
  assert.equal(applied.response.status, 202);
  assert.equal(applied.data.application.status, 'pending');

  const applications = await request(`/api/projects/${projectId}/applications`, { headers: { Cookie: owner.cookie } });
  assert.equal(applications.response.status, 200);
  assert.equal(applications.data.applications.length, 1);

  const applicationId = applications.data.applications[0].id;
  const accepted = await request(`/api/projects/${projectId}/applications/${applicationId}`, {
    method: 'PATCH',
    headers: jsonHeaders(owner.cookie),
    body: JSON.stringify({ status: 'accepted' })
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.status, 'accepted');

  const members = await request(`/api/projects/${projectId}/members`, { headers: { Cookie: student.cookie } });
  assert.equal(members.response.status, 200);
  assert.ok(members.data.members.some(member => member.id === student.user.id));
});

test('global search ranks exact project matches and includes marketplace category support', async () => {
  const search = await request('/api/search?q=Campus%20Robotics&type=all', { headers: { Cookie: student.cookie } });
  assert.equal(search.response.status, 200);
  assert.ok(search.data.items.length > 0);
  assert.equal(search.data.items[0].title, 'Campus Robotics');
  assert.ok(search.data.items.some(item => item.type === 'projects'));

  const marketplace = await request('/api/search?q=Campus&type=marketplace', { headers: { Cookie: student.cookie } });
  assert.equal(marketplace.response.status, 200);
  assert.ok(Array.isArray(marketplace.data.items));
});
