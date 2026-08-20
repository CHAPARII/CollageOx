const { db, now, id, clean, json, readBody, requireUser, httpError } = require('./common');
const { notify, emitNotificationCount } = require('./notifications');
const { emit } = require('./event-hub');

const PROJECT_ROLES = new Set(['Lead', 'Developer', 'Designer', 'Researcher', 'Member']);

async function projectRow(projectId) {
  return await db.get('SELECT * FROM projects WHERE id=?', [projectId]);
}

async function canManageProject(user, project) {
  return project.owner_id === user.id || ['owner', 'management'].includes(user.role);
}

async function listProjects(userId) {
  const rows = await db.all(
    `SELECT p.*,u.username,u.name owner_name
     FROM projects p JOIN users u ON u.id=p.owner_id
     WHERE p.status<>'archived' ORDER BY p.created_at DESC`
  );
  const output = [];
  for (const row of rows) {
    const [count, member, application, role] = await Promise.all([
      db.get('SELECT COUNT(*) n FROM project_members WHERE project_id=?', [row.id]),
      db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [row.id, userId]),
      db.get("SELECT id,status,message,created_at FROM project_applications WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1", [row.id, userId]),
      db.get('SELECT role FROM project_member_roles WHERE project_id=? AND user_id=?', [row.id, userId])
    ]);
    output.push({
      id: row.id,
      name: row.name,
      pitch: row.pitch,
      skills: json(row.skills, []),
      capacity: Number(row.capacity),
      status: row.status,
      ownerId: row.owner_id,
      username: row.username,
      ownerName: row.owner_name,
      members: Number(count.n),
      joined: !!member,
      isOwner: row.owner_id === userId,
      memberRole: row.owner_id === userId ? 'Lead' : (role?.role || (member ? 'Member' : null)),
      application: application ? { id: application.id, status: application.status, message: application.message, createdAt: application.created_at } : null,
      createdAt: row.created_at
    });
  }
  return output;
}

async function applyToProject(user, projectId, message) {
  const project = await projectRow(projectId);
  if (!project) throw httpError(404, 'Project not found.');
  if (!['recruiting', 'active'].includes(project.status)) throw httpError(409, 'This project is not accepting applications.');
  if (project.owner_id === user.id) throw httpError(409, 'You already own this project.');
  if (await db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [project.id, user.id])) throw httpError(409, 'You are already a project member.');
  const body = clean(message, 300);
  if (!body) throw httpError(400, 'Add a short application message.');
  const pending = await db.get("SELECT id FROM project_applications WHERE project_id=? AND user_id=? AND status='pending'", [project.id, user.id]);
  if (pending) throw httpError(409, 'Your application is already pending.');
  const applicationId = id('papp');
  const timestamp = now();
  await db.run(
    `INSERT INTO project_applications (id,project_id,user_id,message,status,reviewed_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [applicationId, project.id, user.id, body, 'pending', null, timestamp, timestamp]
  );
  await notify({
    userId: project.owner_id,
    actorId: user.id,
    kind: 'project_application',
    entityId: project.id,
    text: `${user.name} applied to join ${project.name}.`,
    category: 'projects',
    dedupeKey: project.id
  });
  emitNotificationCount([project.owner_id]);
  emit('project_application', { projectId: project.id, applicationId }, [project.owner_id]);
  return { id: applicationId, projectId: project.id, message: body, status: 'pending', createdAt: timestamp };
}

async function reviewApplication(user, projectId, applicationId, decision) {
  const accepted = decision === 'accepted';
  if (!accepted && decision !== 'rejected') throw httpError(400, 'Choose accepted or rejected.');
  let applicantId = null;
  let projectName = '';
  await db.transaction(async tx => {
    const suffix = db.kind === 'postgres' ? ' FOR UPDATE' : '';
    const project = await tx.get(`SELECT * FROM projects WHERE id=?${suffix}`, [projectId]);
    if (!project) throw httpError(404, 'Project not found.');
    if (!(await canManageProject(user, project))) throw httpError(403, 'Only the project owner can review applications.');
    const application = await tx.get('SELECT * FROM project_applications WHERE id=? AND project_id=?', [applicationId, project.id]);
    if (!application) throw httpError(404, 'Application not found.');
    if (application.status !== 'pending') throw httpError(409, 'This application has already been reviewed.');
    applicantId = application.user_id;
    projectName = project.name;
    if (accepted) {
      const existing = await tx.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [project.id, application.user_id]);
      if (!existing) {
        const count = await tx.get('SELECT COUNT(*) n FROM project_members WHERE project_id=?', [project.id]);
        if (Number(count.n) >= Number(project.capacity)) throw httpError(409, 'This team is full.');
        await tx.run('INSERT INTO project_members (project_id,user_id,joined_at) VALUES (?,?,?)', [project.id, application.user_id, now()]);
      }
      await tx.run(
        `INSERT INTO project_member_roles (project_id,user_id,role,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
        [project.id, application.user_id, 'Member', now()]
      );
    }
    await tx.run('UPDATE project_applications SET status=?,reviewed_by=?,updated_at=? WHERE id=?', [decision, user.id, now(), application.id]);
  });
  await notify({
    userId: applicantId,
    actorId: user.id,
    kind: accepted ? 'project_application_accepted' : 'project_application_rejected',
    entityId: projectId,
    text: accepted ? `Your application to ${projectName} was accepted.` : `Your application to ${projectName} was not accepted.`,
    category: 'projects'
  });
  emitNotificationCount([applicantId]);
  emit('project', { id: projectId, membershipChanged: accepted }, [applicantId]);
  return decision;
}

async function projectMembers(projectId) {
  const project = await projectRow(projectId);
  if (!project) throw httpError(404, 'Project not found.');
  const rows = await db.all(
    `SELECT u.id,u.username,u.name,u.role,u.avatar,u.accent,u.department,m.joined_at,r.role project_role
     FROM project_members m JOIN users u ON u.id=m.user_id
     LEFT JOIN project_member_roles r ON r.project_id=m.project_id AND r.user_id=m.user_id
     WHERE m.project_id=? ORDER BY m.joined_at ASC`,
    [projectId]
  );
  return rows.map(row => ({
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    avatar: row.avatar || '',
    accent: row.accent || '#155eef',
    department: row.department || '',
    projectRole: row.id === project.owner_id ? 'Lead' : (row.project_role || 'Member'),
    joinedAt: row.joined_at
  }));
}

function registerRoutes(registerRoute) {
  registerRoute('GET', '/api/projects', async ({ req, res }) => {
    const user = await requireUser(req);
    res.json({ projects: await listProjects(user.id) });
    return true;
  });

  registerRoute('POST', /^\/api\/projects\/([^/]+)\/applications$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const application = await applyToProject(user, decodeURIComponent(match[1]), input.message);
    res.json({ application }, 201);
    return true;
  });

  registerRoute('POST', /^\/api\/projects\/([^/]+)\/join$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const projectId = decodeURIComponent(match[1]);
    const project = await projectRow(projectId);
    if (!project) throw httpError(404, 'Project not found.');
    const member = await db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [projectId, user.id]);
    if (member) {
      if (project.owner_id === user.id) throw httpError(409, 'The project owner cannot leave their own project.');
      await db.transaction(async tx => {
        await tx.run('DELETE FROM project_member_roles WHERE project_id=? AND user_id=?', [projectId, user.id]);
        await tx.run('DELETE FROM project_members WHERE project_id=? AND user_id=?', [projectId, user.id]);
      });
      emit('project', { id: projectId, membershipChanged: true });
      return res.json({ joined: false });
    }
    const input = await readBody(req);
    const application = await applyToProject(user, projectId, input.message);
    res.json({ joined: false, application }, 202);
    return true;
  });

  registerRoute('GET', /^\/api\/projects\/([^/]+)\/applications$/, async ({ req, res, url, match }) => {
    const user = await requireUser(req);
    const project = await projectRow(decodeURIComponent(match[1]));
    if (!project) throw httpError(404, 'Project not found.');
    if (!(await canManageProject(user, project))) throw httpError(403, 'Only the project owner can view applications.');
    const status = ['pending', 'accepted', 'rejected', 'cancelled'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
    const rows = await db.all(
      `SELECT a.*,u.username,u.name,u.role,u.avatar,u.accent,u.department
       FROM project_applications a JOIN users u ON u.id=a.user_id
       WHERE a.project_id=? AND a.status=? ORDER BY a.created_at ASC`,
      [project.id, status]
    );
    res.json({ applications: rows.map(row => ({
      id: row.id,
      message: row.message,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      user: { id: row.user_id, username: row.username, name: row.name, role: row.role, avatar: row.avatar || '', accent: row.accent || '#155eef', department: row.department || '' }
    })) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/projects\/([^/]+)\/applications\/([^/]+)$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const input = await readBody(req);
    const status = await reviewApplication(user, decodeURIComponent(match[1]), decodeURIComponent(match[2]), input.status);
    res.json({ status });
    return true;
  });

  registerRoute('DELETE', /^\/api\/projects\/([^/]+)\/applications\/mine$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const result = await db.run(
      "UPDATE project_applications SET status='cancelled',updated_at=? WHERE project_id=? AND user_id=? AND status='pending'",
      [now(), decodeURIComponent(match[1]), user.id]
    );
    if (!result.rowCount) throw httpError(404, 'Pending application not found.');
    res.json({ status: 'cancelled' });
    return true;
  });

  registerRoute('GET', /^\/api\/projects\/([^/]+)\/members$/, async ({ req, res, match }) => {
    await requireUser(req);
    res.json({ members: await projectMembers(decodeURIComponent(match[1])) });
    return true;
  });

  registerRoute('PATCH', /^\/api\/projects\/([^/]+)\/members\/([^/]+)\/role$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const projectId = decodeURIComponent(match[1]);
    const targetId = decodeURIComponent(match[2]);
    const project = await projectRow(projectId);
    if (!project) throw httpError(404, 'Project not found.');
    if (!(await canManageProject(user, project))) throw httpError(403, 'Only the project owner can assign roles.');
    if (targetId === project.owner_id) throw httpError(409, 'The project owner is always Lead.');
    const member = await db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [projectId, targetId]);
    if (!member) throw httpError(404, 'Project member not found.');
    const input = await readBody(req);
    const role = PROJECT_ROLES.has(input.role) && input.role !== 'Lead' ? input.role : null;
    if (!role) throw httpError(400, 'Choose Developer, Designer, Researcher, or Member.');
    await db.run(
      `INSERT INTO project_member_roles (project_id,user_id,role,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
      [projectId, targetId, role, now()]
    );
    emit('project', { id: projectId, rolesChanged: true });
    res.json({ role });
    return true;
  });

  registerRoute('POST', /^\/api\/projects\/([^/]+)\/transfer$/, async ({ req, res, match }) => {
    const user = await requireUser(req);
    const projectId = decodeURIComponent(match[1]);
    const project = await projectRow(projectId);
    if (!project) throw httpError(404, 'Project not found.');
    if (!(await canManageProject(user, project))) throw httpError(403, 'Only the project owner or management can transfer ownership.');
    const input = await readBody(req);
    const target = await db.get('SELECT id,username,name FROM users WHERE LOWER(username)=LOWER(?)', [clean(input.username, 24)]);
    if (!target) throw httpError(404, 'New owner not found.');
    const member = await db.get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [projectId, target.id]);
    if (!member) throw httpError(409, 'The new owner must already be a project member.');
    await db.transaction(async tx => {
      await tx.run('UPDATE projects SET owner_id=? WHERE id=?', [target.id, projectId]);
      await tx.run(
        `INSERT INTO project_member_roles (project_id,user_id,role,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
        [projectId, target.id, 'Lead', now()]
      );
      if (project.owner_id !== target.id) {
        await tx.run(
          `INSERT INTO project_member_roles (project_id,user_id,role,updated_at) VALUES (?,?,?,?)
           ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
          [projectId, project.owner_id, 'Member', now()]
        );
      }
    });
    await notify({ userId: target.id, actorId: user.id, kind: 'project_owner', entityId: projectId, text: `You are now the owner of ${project.name}.`, category: 'projects' });
    emit('project', { id: projectId, ownershipChanged: true });
    res.json({ ok: true, owner: target });
    return true;
  });
}

module.exports = {
  registerRoutes,
  listProjects,
  applyToProject,
  reviewApplication,
  projectMembers,
  PROJECT_ROLES
};
