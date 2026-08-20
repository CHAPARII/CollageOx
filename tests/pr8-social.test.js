const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = path.join(__dirname, '.tmp-pr8-social');
fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });
process.env.DB_FILE = path.join(temp, 'test.db');
process.env.OWNER_USERNAME = 'Pr8SocialOwner';
process.env.OWNER_INITIAL_PASSWORD = 'pr8-social-owner-password';
process.env.OWNER_EMAIL = 'socialowner@college.edu';
process.env.OWNER_NAME = 'PR8 Social Owner';

require('../src/runtime-enhancements');
require('../src/pr8');
const { server, db, ready } = require('../server');

let base;
let alice;
let bob;

async function request(url, options = {}) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function register(username, name) {
  const { response, data } = await request('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, username, email: `${username.replaceAll('.', '')}@college.edu`, password: 'student-secure-password' })
  });
  assert.equal(response.status, 201);
  return { cookie: response.headers.get('set-cookie').split(';')[0], user: data.user };
}

const jsonHeaders = cookie => ({ 'Content-Type': 'application/json', Cookie: cookie });

async function createPost(actor, payload) {
  const result = await request('/api/posts', { method: 'POST', headers: jsonHeaders(actor.cookie), body: JSON.stringify(payload) });
  assert.equal(result.response.status, 201);
  return result.data.post;
}

test.before(async () => {
  await ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  alice = await register('social.alice', 'Social Alice');
  bob = await register('social.bob', 'Social Bob');
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('single-choice public polls enforce one option and expose public voters', async () => {
  const post = await createPost(alice, {
    body: 'Pick a workshop', type: 'poll', tags: ['campus'],
    poll: { options: ['Robotics', 'Design'], choiceMode: 'single', voterVisibility: 'public', expiresAt: new Date(Date.now() + 86400000).toISOString() }
  });
  assert.equal(post.poll.choiceMode, 'single');
  assert.equal(post.poll.voterVisibility, 'public');

  const two = await request(`/api/polls/${post.poll.id}/vote`, {
    method: 'POST', headers: jsonHeaders(bob.cookie),
    body: JSON.stringify({ optionIds: post.poll.options.map(option => option.id) })
  });
  assert.equal(two.response.status, 400);

  const voted = await request(`/api/polls/${post.poll.id}/vote`, {
    method: 'POST', headers: jsonHeaders(bob.cookie),
    body: JSON.stringify({ optionIds: [post.poll.options[0].id] })
  });
  assert.equal(voted.response.status, 200);
  const selected = voted.data.poll.options.find(option => option.id === post.poll.options[0].id);
  assert.equal(selected.selected, true);
  assert.ok(selected.voters.some(voter => voter.id === bob.user.id));
});

test('multiple-choice anonymous polls accept multiple options without exposing voters', async () => {
  const post = await createPost(alice, {
    body: 'Which clubs interest you?', type: 'poll', tags: [],
    poll: { options: ['Music', 'Coding', 'Sports'], choiceMode: 'multiple', voterVisibility: 'anonymous', expiresAt: new Date(Date.now() + 86400000).toISOString() }
  });
  const optionIds = post.poll.options.slice(0, 2).map(option => option.id);
  const voted = await request(`/api/polls/${post.poll.id}/vote`, {
    method: 'POST', headers: jsonHeaders(bob.cookie), body: JSON.stringify({ optionIds })
  });
  assert.equal(voted.response.status, 200);
  assert.equal(voted.data.poll.options.filter(option => option.selected).length, 2);
  for (const option of voted.data.poll.options) assert.equal(Object.hasOwn(option, 'voters'), false);

  await db.run('UPDATE polls SET expires_at=? WHERE id=?', [new Date(Date.now() - 1000).toISOString(), post.poll.id]);
  const closed = await request(`/api/polls/${post.poll.id}/vote`, {
    method: 'POST', headers: jsonHeaders(bob.cookie), body: JSON.stringify({ optionIds: [optionIds[0]] })
  });
  assert.equal(closed.response.status, 409);
});

test('mentions notify and hashtags open privacy-aware hashtag pages', async () => {
  await db.run("DELETE FROM notifications WHERE user_id=? AND kind='mention'", [bob.user.id]);
  const post = await createPost(alice, {
    body: 'Building with @social.bob on #robotics this week', type: 'post', tags: ['robotics']
  });
  const mention = await db.get("SELECT * FROM notifications WHERE user_id=? AND kind='mention' AND entity_id=?", [bob.user.id, post.id]);
  assert.ok(mention);

  const tag = await request('/api/hashtags/robotics', { headers: { Cookie: bob.cookie } });
  assert.equal(tag.response.status, 200);
  assert.ok(tag.data.posts.some(item => item.id === post.id));
});

test('profiles have exactly one replaceable pinned post', async () => {
  const first = await createPost(alice, { body: 'First pin', type: 'post', tags: [] });
  const second = await createPost(alice, { body: 'Second pin', type: 'post', tags: [] });
  for (const post of [first, second]) {
    const pin = await request(`/api/pins/profile/${alice.user.id}`, {
      method: 'PUT', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ postId: post.id })
    });
    assert.equal(pin.response.status, 200);
  }
  const count = await db.get("SELECT COUNT(*) n FROM pinned_posts WHERE context_type='profile' AND context_id=?", [alice.user.id]);
  assert.equal(Number(count.n), 1);
  const summary = await request(`/api/profiles/${alice.user.username}/summary`, { headers: { Cookie: alice.cookie } });
  assert.equal(summary.data.pinnedPost.id, second.id);
});

test('bookmark collections can organize saved posts without duplicating collection membership', async () => {
  const post = await createPost(alice, { body: 'Save this resource', type: 'post', tags: [] });
  const collection = await request('/api/bookmark-collections', {
    method: 'POST', headers: jsonHeaders(bob.cookie), body: JSON.stringify({ name: 'Study' })
  });
  assert.equal(collection.response.status, 201);
  const collectionId = collection.data.collection.id;
  for (let index = 0; index < 2; index++) {
    const added = await request(`/api/bookmark-collections/${collectionId}/posts/${post.id}`, {
      method: 'PUT', headers: jsonHeaders(bob.cookie), body: '{}'
    });
    assert.equal(added.response.status, 200);
  }
  const row = await db.get('SELECT COUNT(*) n FROM bookmark_collection_posts WHERE collection_id=? AND post_id=?', [collectionId, post.id]);
  assert.equal(Number(row.n), 1);
});

test('post media accepts compressed image payloads and rejects more than four images', async () => {
  const post = await createPost(alice, { body: 'Image post', type: 'post', tags: [] });
  const image = { data: 'data:image/png;base64,aGVsbG8=', width: 10, height: 10 };
  const attached = await request(`/api/posts/${post.id}/media`, {
    method: 'PUT', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ images: [image] })
  });
  assert.equal(attached.response.status, 200, attached.data.error || JSON.stringify(attached.data));
  assert.equal(attached.data.media.length, 1);

  const fetched = await request(`/api/posts/${post.id}`, { headers: { Cookie: bob.cookie } });
  assert.equal(fetched.data.post.media.length, 1);

  const tooMany = await request(`/api/posts/${post.id}/media`, {
    method: 'PUT', headers: jsonHeaders(alice.cookie), body: JSON.stringify({ images: [image, image, image, image, image] })
  });
  assert.equal(tooMany.response.status, 400);
});

test('muting a club hides that club context from the feed and can be reversed', async () => {
  const club = await request('/api/clubs', {
    method: 'POST', headers: jsonHeaders(alice.cookie),
    body: JSON.stringify({ name: 'Muted Feed Club', description: 'Club mute regression', category: 'Community', accent: '#155eef' })
  });
  assert.equal(club.response.status, 201);
  const clubId = club.data.club.id;
  const update = await createPost(alice, {
    body: 'Muted Feed Club important update', type: 'update', tags: [], context: { type: 'club', id: clubId }
  });

  const before = await request('/api/posts?limit=50', { headers: { Cookie: bob.cookie } });
  assert.ok(before.data.posts.some(post => post.id === update.id));

  const muted = await request('/api/safety/mutes', {
    method: 'PATCH', headers: jsonHeaders(bob.cookie),
    body: JSON.stringify({ targetType: 'club', targetId: clubId, muted: true })
  });
  assert.equal(muted.response.status, 200);

  const hidden = await request('/api/posts?limit=50', { headers: { Cookie: bob.cookie } });
  assert.equal(hidden.data.posts.some(post => post.id === update.id), false);

  const listed = await request('/api/safety/mutes?targetType=club', { headers: { Cookie: bob.cookie } });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.data.mutes.some(item => item.id === clubId));

  await request('/api/safety/mutes', {
    method: 'PATCH', headers: jsonHeaders(bob.cookie),
    body: JSON.stringify({ targetType: 'club', targetId: clubId, muted: false })
  });
  const restored = await request('/api/posts?limit=50', { headers: { Cookie: bob.cookie } });
  assert.ok(restored.data.posts.some(post => post.id === update.id));
});
