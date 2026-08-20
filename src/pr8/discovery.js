const { db, json, requireUser, now, publicUser } = require('./common');
const { blockedSet } = require('./search');
const { listSkills } = require('./profile');

function overlap(a, b) {
  const other = new Set((b || []).map(value => String(value).toLowerCase()));
  return (a || []).filter(value => other.has(String(value).toLowerCase()));
}

async function peopleRecommendations(user) {
  const blocked = await blockedSet(user.id);
  const skills = await listSkills(user.id);
  const interests = json(user.interests, []);
  const rows = await db.all(
    `SELECT id,username,name,role,avatar,accent,department,interests,profile_visibility,created_at
     FROM users WHERE id<>? AND profile_visibility<>'private' ORDER BY created_at DESC LIMIT 250`,
    [user.id]
  );
  const items = [];
  for (const candidate of rows) {
    if (blocked.has(candidate.id)) continue;
    const candidateSkills = await listSkills(candidate.id);
    const sharedSkills = overlap(skills, candidateSkills);
    const sharedInterests = overlap(interests, json(candidate.interests, []));
    const mutual = await db.get(
      `SELECT COUNT(*) n FROM follows mine JOIN follows theirs ON mine.following_id=theirs.follower_id
       WHERE mine.follower_id=? AND theirs.following_id=?`,
      [user.id, candidate.id]
    );
    const sharedClubs = await db.get(
      `SELECT COUNT(*) n FROM club_members a JOIN club_members b ON a.club_id=b.club_id
       WHERE a.user_id=? AND b.user_id=?`,
      [user.id, candidate.id]
    );
    const sharedProjects = await db.get(
      `SELECT COUNT(*) n FROM project_members a JOIN project_members b ON a.project_id=b.project_id
       WHERE a.user_id=? AND b.user_id=?`,
      [user.id, candidate.id]
    );
    let score = 0;
    const reasons = [];
    if (user.department && candidate.department && user.department.toLowerCase() === candidate.department.toLowerCase()) { score += 24; reasons.push('same department'); }
    if (sharedSkills.length) { score += Math.min(30, sharedSkills.length * 10); reasons.push(`${sharedSkills.slice(0, 2).join(', ')} skills`); }
    if (sharedInterests.length) { score += Math.min(24, sharedInterests.length * 8); reasons.push(`${sharedInterests.slice(0, 2).join(', ')} interests`); }
    if (Number(mutual.n)) { score += Math.min(24, Number(mutual.n) * 8); reasons.push(`${mutual.n} mutual connection${Number(mutual.n) === 1 ? '' : 's'}`); }
    if (Number(sharedClubs.n)) { score += Math.min(16, Number(sharedClubs.n) * 8); reasons.push('shared club'); }
    if (Number(sharedProjects.n)) { score += Math.min(16, Number(sharedProjects.n) * 8); reasons.push('shared project'); }
    if (!score) continue;
    items.push({ user: publicUser(candidate), score, reason: reasons.slice(0, 2).join(' · ') });
  }
  return items.sort((a, b) => b.score - a.score || a.user.name.localeCompare(b.user.name)).slice(0, 20);
}

async function clubRecommendations(user) {
  const blocked = await blockedSet(user.id);
  const interests = json(user.interests, []).map(value => String(value).toLowerCase());
  const skills = (await listSkills(user.id)).map(value => value.toLowerCase());
  const joined = new Set((await db.all('SELECT club_id FROM club_members WHERE user_id=?', [user.id])).map(row => row.club_id));
  const rows = await db.all(
    `SELECT c.*,u.username,COALESCE(s.status,'active') status,COALESCE(j.join_mode,'open') join_mode
     FROM clubs c JOIN users u ON u.id=c.owner_id
     LEFT JOIN club_settings s ON s.club_id=c.id LEFT JOIN club_join_settings j ON j.club_id=c.id
     WHERE COALESCE(s.status,'active')='active' ORDER BY c.created_at DESC LIMIT 200`
  );
  const items = [];
  for (const club of rows) {
    if (joined.has(club.id) || blocked.has(club.owner_id)) continue;
    const haystack = `${club.name} ${club.description} ${club.category}`.toLowerCase();
    const matches = [...interests, ...skills].filter(term => term && haystack.includes(term));
    const shared = await db.get(
      `SELECT COUNT(*) n FROM club_members cm
       WHERE cm.club_id=? AND cm.user_id IN (SELECT following_id FROM follows WHERE follower_id=?)`,
      [club.id, user.id]
    );
    let score = Math.min(40, matches.length * 12) + Math.min(30, Number(shared.n) * 10);
    if (!score) continue;
    const reason = matches.length ? `Matches ${matches.slice(0, 2).join(', ')}` : `${shared.n} connection${Number(shared.n) === 1 ? '' : 's'} here`;
    items.push({
      id: club.id, name: club.name, description: club.description, category: club.category, accent: club.accent,
      joinMode: club.join_mode, score, reason
    });
  }
  return items.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 16);
}

async function projectRecommendations(user) {
  const blocked = await blockedSet(user.id);
  const interests = json(user.interests, []).map(value => String(value).toLowerCase());
  const skills = (await listSkills(user.id)).map(value => value.toLowerCase());
  const joined = new Set((await db.all('SELECT project_id FROM project_members WHERE user_id=?', [user.id])).map(row => row.project_id));
  const rows = await db.all(
    `SELECT p.*,u.username FROM projects p JOIN users u ON u.id=p.owner_id
     WHERE p.status IN ('recruiting','active') ORDER BY p.created_at DESC LIMIT 200`
  );
  const items = [];
  for (const project of rows) {
    if (joined.has(project.id) || blocked.has(project.owner_id)) continue;
    const count = await db.get('SELECT COUNT(*) n FROM project_members WHERE project_id=?', [project.id]);
    if (Number(count.n) >= Number(project.capacity)) continue;
    const projectSkills = json(project.skills, []).map(value => String(value).toLowerCase());
    const sharedSkills = skills.filter(skill => projectSkills.includes(skill));
    const haystack = `${project.name} ${project.pitch}`.toLowerCase();
    const interestMatches = interests.filter(term => term && haystack.includes(term));
    const score = Math.min(50, sharedSkills.length * 15) + Math.min(30, interestMatches.length * 10);
    if (!score) continue;
    items.push({
      id: project.id, name: project.name, pitch: project.pitch, skills: json(project.skills, []), status: project.status,
      members: Number(count.n), capacity: Number(project.capacity), score,
      reason: sharedSkills.length ? `Needs ${sharedSkills.slice(0, 2).join(', ')}` : `Matches ${interestMatches.slice(0, 2).join(', ')}`
    });
  }
  return items.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 16);
}

async function trending() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = await db.all(
    `SELECT tag,source_type,source_id,created_at FROM content_hashtags
     WHERE created_at>? ORDER BY created_at DESC LIMIT 1000`,
    [since]
  );
  const map = new Map();
  for (const row of rows) {
    let item = map.get(row.tag);
    if (!item) item = { tag: row.tag, sources: new Set(), activity: 0, latest: row.created_at, participants: new Set() };
    item.sources.add(`${row.source_type}:${row.source_id}`);
    item.activity += 3;
    if (row.created_at > item.latest) item.latest = row.created_at;
    if (row.source_type === 'post') {
      const post = await db.get('SELECT author_id FROM posts WHERE id=?', [row.source_id]);
      if (post) item.participants.add(post.author_id);
      const reactions = await db.get('SELECT COUNT(*) n FROM reactions WHERE post_id=?', [row.source_id]);
      const comments = await db.get('SELECT COUNT(*) n FROM comments WHERE post_id=?', [row.source_id]);
      item.activity += Number(reactions.n) * 1.5 + Number(comments.n) * 2;
    }
    map.set(row.tag, item);
  }
  return [...map.values()].map(item => {
    const ageDays = Math.max(0, (Date.now() - new Date(item.latest).getTime()) / 86400000);
    const score = item.activity + item.sources.size * 2 + item.participants.size * 3 + Math.max(0, 8 - ageDays);
    return { tag: item.tag, uses: item.sources.size, participants: item.participants.size, score: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag)).slice(0, 12);
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/discovery/people', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ items: await peopleRecommendations(user) });
    return true;
  });
  registerRoute('GET', '/api/discovery/clubs', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ items: await clubRecommendations(user) });
    return true;
  });
  registerRoute('GET', '/api/discovery/projects', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ items: await projectRecommendations(user) });
    return true;
  });
  registerRoute('GET', '/api/trending', async ({ req, res }) => {
    await requireUser(req);
    res.json({ items: await trending() });
    return true;
  });
}

module.exports = { registerRoutes, peopleRecommendations, clubRecommendations, projectRecommendations, trending, overlap };
