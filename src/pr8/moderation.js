const { db, now, id, clean, readBody, requireUser, httpError, pageLimit } = require('./common');
const { conversationRow } = require('./dm');
const { emit } = require('./event-hub');

const TARGET_TYPES = new Set(['post', 'user', 'marketplace', 'lostfound', 'question', 'answer', 'dm']);

async function targetExists(type, targetId, reporterId) {
  if (type === 'post') return !!(await db.get('SELECT id FROM posts WHERE id=?', [targetId]));
  if (type === 'user') return targetId !== reporterId && !!(await db.get('SELECT id FROM users WHERE id=?', [targetId]));
  if (type === 'marketplace') return !!(await db.get('SELECT id FROM marketplace_listings WHERE id=?', [targetId]));
  if (type === 'lostfound') return !!(await db.get('SELECT id FROM lost_found_entries WHERE id=?', [targetId]));
  if (type === 'question') return !!(await db.get('SELECT id FROM questions WHERE id=?', [targetId]));
  if (type === 'answer') return !!(await db.get('SELECT id FROM answers WHERE id=?', [targetId]));
  if (type === 'dm') return !!(await conversationRow(targetId, reporterId));
  return false;
}

async function serializeTarget(report) {
  if (report.target_type === 'post') {
    const row = await db.get(`SELECT p.body,u.username,u.name FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?`, [report.target_id]);
    return row ? { type: 'post', body: clean(row.body, 300), username: row.username, name: row.name } : null;
  }
  if (report.target_type === 'user') {
    const row = await db.get('SELECT username,name,role FROM users WHERE id=?', [report.target_id]);
    return row ? { type: 'user', ...row } : null;
  }
  if (report.target_type === 'marketplace') {
    const row = await db.get('SELECT title,description,status,owner_id FROM marketplace_listings WHERE id=?', [report.target_id]);
    return row ? { type: 'marketplace', title: row.title, body: clean(row.description, 300), status: row.status, ownerId: row.owner_id } : null;
  }
  if (report.target_type === 'lostfound') {
    const row = await db.get('SELECT name,description,status,reporter_id FROM lost_found_entries WHERE id=?', [report.target_id]);
    return row ? { type: 'lostfound', title: row.name, body: clean(row.description, 300), status: row.status, reporterId: row.reporter_id } : null;
  }
  if (report.target_type === 'question') {
    const row = await db.get('SELECT title,body,anonymous,author_id FROM questions WHERE id=?', [report.target_id]);
    return row ? { type: 'question', title: row.title, body: clean(row.body, 300), anonymous: !!row.anonymous, authorId: row.author_id } : null;
  }
  if (report.target_type === 'answer') {
    const row = await db.get('SELECT body,author_id,question_id FROM answers WHERE id=?', [report.target_id]);
    return row ? { type: 'answer', body: clean(row.body, 300), authorId: row.author_id, questionId: row.question_id } : null;
  }
  if (report.target_type === 'dm') {
    const conversation = await db.get('SELECT user_low_id,user_high_id FROM dm_conversations WHERE id=?', [report.target_id]);
    if (!conversation) return null;
    const evidence = await db.all(
      `SELECT m.id,m.sender_id,m.body,m.created_at,u.username,u.name
       FROM report_dm_evidence e JOIN dm_messages m ON m.id=e.message_id JOIN users u ON u.id=m.sender_id
       WHERE e.report_id=? ORDER BY m.created_at ASC`,
      [report.id]
    );
    return {
      type: 'dm',
      participants: [conversation.user_low_id, conversation.user_high_id],
      evidence: evidence.map(row => ({ id: row.id, senderId: row.sender_id, username: row.username, name: row.name, body: row.body, createdAt: row.created_at }))
    };
  }
  return null;
}

function registerRoutes(registerRoute) {
  registerRoute('POST', '/api/reports', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req, 30000);
    const targetType = TARGET_TYPES.has(input.targetType) ? input.targetType : null;
    const targetId = clean(input.targetId, 120);
    const reason = clean(input.reason, 600);
    if (!targetType || !targetId || !reason) throw httpError(400, 'Choose what you are reporting and add a reason.');
    if (!(await targetExists(targetType, targetId, user.id))) throw httpError(404, 'Reported item not found.');
    const duplicate = await db.get("SELECT id FROM reports WHERE reporter_id=? AND target_type=? AND target_id=? AND status='open'", [user.id, targetType, targetId]);
    if (duplicate) throw httpError(409, 'You already have an open report for this item.');
    const reportId = id('report');
    const timestamp = now();
    await db.transaction(async tx => {
      await tx.run(
        'INSERT INTO reports (id,reporter_id,target_type,target_id,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [reportId, user.id, targetType, targetId, reason, 'open', timestamp, timestamp]
      );
      if (targetType === 'dm') {
        const messageIds = [...new Set((Array.isArray(input.messageIds) ? input.messageIds : []).map(value => clean(value, 120)).filter(Boolean))].slice(0, 20);
        if (!messageIds.length) throw httpError(400, 'Select at least one message to include with a DM report.');
        for (const messageId of messageIds) {
          const message = await tx.get('SELECT id FROM dm_messages WHERE id=? AND conversation_id=?', [messageId, targetId]);
          if (!message) throw httpError(400, 'A selected message does not belong to this conversation.');
          await tx.run('INSERT INTO report_dm_evidence (report_id,message_id) VALUES (?,?)', [reportId, messageId]);
        }
      }
    });
    emit('report', { id: reportId }, null);
    res.json({ ok: true, id: reportId }, 201);
    return true;
  });

  registerRoute('GET', '/api/admin/reports', async ({ req, res, url }) => {
    const user = await requireUser(req);
    if (!['owner', 'management'].includes(user.role)) throw httpError(403, 'Management access required.');
    const status = ['open', 'resolved', 'dismissed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
    const limit = pageLimit(url.searchParams.get('limit'), 100, 200);
    const reports = await db.all(
      `SELECT r.*,u.username reporter_username,u.name reporter_name
       FROM reports r JOIN users u ON u.id=r.reporter_id
       WHERE r.status=? ORDER BY r.created_at DESC LIMIT ${limit}`,
      [status]
    );
    for (const report of reports) report.target = await serializeTarget(report);
    res.json({ reports });
    return true;
  });

  registerRoute('PATCH', /^\/api\/admin\/reports\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    if (!['owner', 'management'].includes(user.role)) throw httpError(403, 'Management access required.');
    const report = await db.get('SELECT * FROM reports WHERE id=?', [decodeURIComponent(match[1])]);
    if (!report) throw httpError(404, 'Report not found.');
    const input = await readBody(req);
    const status = ['open', 'resolved', 'dismissed'].includes(input.status) ? input.status : report.status;
    await db.run(
      'UPDATE reports SET status=?,review_note=?,reviewed_by=?,updated_at=? WHERE id=?',
      [status, clean(input.reviewNote, 600), user.id, now(), report.id]
    );
    res.json({ ok: true, status });
    return true;
  });
}

module.exports = { registerRoutes, TARGET_TYPES, serializeTarget, targetExists };
