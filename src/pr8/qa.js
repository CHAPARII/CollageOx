const { db, now, id, clean, readBody, requireUser, httpError, publicUser, bool } = require('./common');
const { indexTextMentionsAndHashtags } = require('./social');
const { isBlocked } = require('./safety');
const { notify } = require('./notifications');
const { emit } = require('./event-hub');

function joinedAuthor(row) {
  return { ...publicUser(row), id: row.author_user_id };
}

async function serializeQuestion(row, viewer, includeAnswers = false, moderation = false) {
  const anonymous = !!row.anonymous;
  const canIdentify = moderation && ['owner', 'management'].includes(viewer.role);
  const author = anonymous && !canIdentify ? null : joinedAuthor(row);
  const answerCount = await db.get('SELECT COUNT(*) n FROM answers WHERE question_id=?', [row.id]);
  const result = {
    id: row.id,
    title: row.title,
    body: row.body,
    anonymous,
    author,
    acceptedAnswerId: row.accepted_answer_id || null,
    answerCount: Number(answerCount.n),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mine: row.author_id === viewer.id
  };
  if (includeAnswers) {
    const answers = await db.all(
      `SELECT a.*,u.id author_user_id,u.username,u.name,u.role,u.avatar,u.accent,u.profile_visibility
       FROM answers a JOIN users u ON u.id=a.author_id
       WHERE a.question_id=? ORDER BY a.created_at ASC`,
      [row.id]
    );
    result.answers = [];
    for (const answer of answers) {
      if (await isBlocked(viewer.id, answer.author_id)) continue;
      const [votes, voted] = await Promise.all([
        db.get('SELECT COUNT(*) n FROM answer_votes WHERE answer_id=?', [answer.id]),
        db.get('SELECT 1 FROM answer_votes WHERE answer_id=? AND user_id=?', [answer.id, viewer.id])
      ]);
      result.answers.push({
        id: answer.id,
        body: answer.body,
        author: joinedAuthor(answer),
        votes: Number(votes.n),
        voted: !!voted,
        accepted: row.accepted_answer_id === answer.id,
        createdAt: answer.created_at,
        updatedAt: answer.updated_at
      });
    }
  }
  return result;
}

async function questionRow(questionId) {
  return await db.get(
    `SELECT q.*,u.id author_user_id,u.username,u.name,u.role,u.avatar,u.accent,u.profile_visibility
     FROM questions q JOIN users u ON u.id=q.author_id WHERE q.id=?`,
    [questionId]
  );
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/questions', async ({ req, res, url }) => {
    const user = await requireUser(req);
    const mine = url.searchParams.get('mine') === '1';
    const q = clean(url.searchParams.get('q'), 100).toLowerCase();
    const rows = await db.all(
      `SELECT q.*,u.id author_user_id,u.username,u.name,u.role,u.avatar,u.accent,u.profile_visibility
       FROM questions q JOIN users u ON u.id=q.author_id
       ${mine ? 'WHERE q.author_id=?' : ''}
       ORDER BY q.created_at DESC LIMIT 120`,
      mine ? [user.id] : []
    );
    const items = [];
    for (const row of rows) {
      if (row.author_id !== user.id && await isBlocked(user.id, row.author_id)) continue;
      if (q && !`${row.title} ${row.body}`.toLowerCase().includes(q)) continue;
      items.push(await serializeQuestion(row, user, false, false));
    }
    res.json({ questions: items });
    return true;
  });

  registerRoute('POST', '/api/questions', async ({ req, res }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const title = clean(input.title, 140);
    const body = clean(input.body, 2400);
    if (!title || !body) throw httpError(400, 'Add a question title and details.');
    const questionId = id('question');
    const timestamp = now();
    await db.run(
      `INSERT INTO questions (id,author_id,title,body,anonymous,accepted_answer_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [questionId, user.id, title, body, bool(input.anonymous) ? 1 : 0, null, timestamp, timestamp]
    );
    await indexTextMentionsAndHashtags({ sourceType: 'question', sourceId: questionId, authorId: user.id, text: `${title}\n${body}` });
    emit('question', { id: questionId, action: 'created' });
    res.json({ question: await serializeQuestion(await questionRow(questionId), user, false, false) }, 201);
    return true;
  });

  registerRoute('GET', /^\/api\/questions\/([^/]+)$/, async ({ req, res, url, match }) => {
    const user = await requireUser(req);
    const row = await questionRow(decodeURIComponent(match[1]));
    if (!row || (row.author_id !== user.id && await isBlocked(user.id, row.author_id))) throw httpError(404, 'Question not found.');
    const moderation = url.searchParams.get('moderation') === '1';
    res.json({ question: await serializeQuestion(row, user, true, moderation) });
    return true;
  });

  registerRoute('POST', /^\/api\/questions\/([^/]+)\/answers$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const row = await questionRow(decodeURIComponent(match[1]));
    if (!row || (row.author_id !== user.id && await isBlocked(user.id, row.author_id))) throw httpError(404, 'Question not found.');
    const input = await readBody(req);
    const body = clean(input.body, 2400);
    if (!body) throw httpError(400, 'Answer cannot be empty.');
    const answerId = id('answer');
    const timestamp = now();
    await db.run(
      'INSERT INTO answers (id,question_id,author_id,body,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [answerId, row.id, user.id, body, timestamp, timestamp]
    );
    await indexTextMentionsAndHashtags({ sourceType: 'answer', sourceId: answerId, authorId: user.id, text: body });
    await notify({ userId: row.author_id, actorId: user.id, kind: 'qa_answer', entityId: row.id, text: `${user.name} answered your question.`, category: 'social' });
    emit('question', { id: row.id, answerId });
    res.json({ answer: { id: answerId, body, author: publicUser(user), votes: 0, voted: false, accepted: false, createdAt: timestamp } }, 201);
    return true;
  });

  registerRoute('POST', /^\/api\/answers\/([^/]+)\/vote$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const answerId = decodeURIComponent(match[1]);
    const answer = await db.get('SELECT * FROM answers WHERE id=?', [answerId]);
    if (!answer) throw httpError(404, 'Answer not found.');
    if (answer.author_id !== user.id && await isBlocked(user.id, answer.author_id)) throw httpError(404, 'Answer not found.');
    const existing = await db.get('SELECT 1 FROM answer_votes WHERE answer_id=? AND user_id=?', [answerId, user.id]);
    if (existing) await db.run('DELETE FROM answer_votes WHERE answer_id=? AND user_id=?', [answerId, user.id]);
    else await db.run('INSERT INTO answer_votes (answer_id,user_id,created_at) VALUES (?,?,?)', [answerId, user.id, now()]);
    const count = await db.get('SELECT COUNT(*) n FROM answer_votes WHERE answer_id=?', [answerId]);
    emit('question', { id: answer.question_id, votesChanged: true });
    res.json({ questionId: answer.question_id, voted: !existing, votes: Number(count.n) });
    return true;
  });

  registerRoute('POST', /^\/api\/questions\/([^/]+)\/accept\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const questionId = decodeURIComponent(match[1]);
    const answerId = decodeURIComponent(match[2]);
    const question = await db.get('SELECT * FROM questions WHERE id=?', [questionId]);
    if (!question) throw httpError(404, 'Question not found.');
    if (question.author_id !== user.id) throw httpError(403, 'Only the question author can accept an answer.');
    const answer = await db.get('SELECT * FROM answers WHERE id=? AND question_id=?', [answerId, questionId]);
    if (!answer) throw httpError(404, 'Answer not found.');
    await db.run('UPDATE questions SET accepted_answer_id=?,updated_at=? WHERE id=?', [answerId, now(), questionId]);
    await notify({ userId: answer.author_id, actorId: user.id, kind: 'qa_accepted', entityId: questionId, text: 'Your answer was accepted.', category: 'social' });
    emit('question', { id: questionId, acceptedAnswerId: answerId });
    res.json({ acceptedAnswerId: answerId });
    return true;
  });
}

module.exports = { registerRoutes, serializeQuestion, questionRow, joinedAuthor };
