(() => {
  const coreToast = toast;
  const coreNavigate = navigate;
  const coreBindView = bindView;
  const corePostCard = postCard;
  const coreRenderProfile = renderProfile;
  const coreRenderEvents = renderEvents;
  const coreRenderProjects = renderProjects;
  const coreRenderClubs = renderClubs;
  const coreRenderAdmin = renderAdmin;
  const coreEnter = enter;

  let historyNavigation = false;
  let notificationTimer = null;

  toast = function enhancedToast(message, type = 'success') {
    const existing = [...document.querySelectorAll('#toasts .toast')].find(item => item.textContent === String(message));
    if (existing) {
      existing.classList.remove('toast-bump');
      void existing.offsetWidth;
      existing.classList.add('toast-bump');
      return;
    }
    coreToast(message, type);
  };

  function directPostLink(id) {
    return `${location.origin}/?post=${encodeURIComponent(id)}#feed`;
  }

  copyPost = async function enhancedCopyPost(button) {
    const id = button.closest('.post').dataset.post;
    const link = directPostLink(id);
    try {
      await navigator.clipboard.writeText(link);
      toast('Post link copied.');
    } catch {
      const input = document.createElement('textarea');
      input.value = link;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      toast(copied ? 'Post link copied.' : link, copied ? 'success' : 'error');
    }
  };

  async function refreshPostContext() {
    const shared = new URLSearchParams(location.search).get('post');
    if (shared) return showPermalink(shared);
    const hash = location.hash.slice(1);
    if (hash.startsWith('profile/')) return renderProfile(decodeURIComponent(hash.slice(8)));
    if (state.route === 'profile') return renderProfile(state.user.username);
    await loadFeed(true);
    renderFeed();
  }

  react = async function enhancedReact(button) {
    try {
      await api(`/api/posts/${button.closest('.post').dataset.post}/react`, { method: 'POST', body: '{}' });
      await refreshPostContext();
    } catch (error) { toast(error.message, 'error'); }
  };

  comment = async function enhancedComment(event, form) {
    event.preventDefault();
    const input = $('input', form), id = form.closest('.post').dataset.post;
    if (!input.value.trim()) return;
    try {
      await api(`/api/posts/${id}/comments`, { method: 'POST', body: JSON.stringify({ body: input.value }) });
      await refreshPostContext();
    } catch (error) { toast(error.message, 'error'); }
  };

  deletePost = async function enhancedDeletePost(button) {
    if (!confirm('Delete this post permanently?')) return;
    try {
      await api(`/api/posts/${button.closest('.post').dataset.post}`, { method: 'DELETE' });
      await refresh(false);
      if (new URLSearchParams(location.search).has('post')) {
        const next = new URL(location.href);
        next.searchParams.delete('post');
        history.replaceState({}, '', `${next.pathname}${next.search}#feed`);
        await navigate('feed');
      } else await refreshPostContext();
      toast('Post deleted.');
    } catch (error) { toast(error.message, 'error'); }
  };

  function ensureDialog(id, html) {
    let dialog = document.getElementById(id);
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = id;
      dialog.className = 'dialog';
      dialog.innerHTML = html;
      document.body.append(dialog);
      dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    }
    return dialog;
  }

  async function openPostEditor(postId) {
    let post = state.data.posts.find(item => item.id === postId) || state.profile?.posts?.find?.(item => item.id === postId);
    if (!post) post = (await api(`/api/posts/${postId}`)).post;
    const dialog = ensureDialog('edit-post-dialog', `<form class="dialog-card" id="edit-post-form"><header><div><span class="kicker">Your post</span><h3>Edit post</h3></div><button type="button" class="dialog-close">×</button></header><label>Post text<textarea id="edit-post-body" maxlength="1800" required></textarea></label><div class="two-fields"><label>Type<select id="edit-post-type"><option value="post">Post</option><option value="question">Question</option><option value="collab">Collaboration</option><option value="update">Update</option></select></label><label>Topics<input id="edit-post-tags" placeholder="Design, Coding"></label></div><footer><span>Changes will show an edited label.</span><button class="button primary" type="submit">Save changes</button></footer></form>`);
    $('#edit-post-body', dialog).value = post.body;
    $('#edit-post-type', dialog).value = post.type;
    $('#edit-post-tags', dialog).value = (post.tags || []).join(', ');
    $('.dialog-close', dialog).onclick = () => dialog.close();
    $('#edit-post-form', dialog).onsubmit = async event => {
      event.preventDefault();
      const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true;
      try {
        await api(`/api/posts/${postId}`, { method: 'PATCH', body: JSON.stringify({ body: $('#edit-post-body', dialog).value, type: $('#edit-post-type', dialog).value, tags: $('#edit-post-tags', dialog).value.split(',').map(value => value.trim()).filter(Boolean) }) });
        dialog.close(); await refreshPostContext(); toast('Post updated.');
      } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; }
    };
    dialog.showModal();
  }

  editPost = async button => { try { await openPostEditor(button.closest('.post').dataset.post); } catch (error) { toast(error.message, 'error'); } };

  async function loadAllComments(button) {
    const card = button.closest('.post'), id = card.dataset.post;
    try {
      const result = await api(`/api/posts/${id}/comments?limit=50`), box = $('.comments', card);
      box.innerHTML = `${result.comments.map(item => `<div class="comment">${avatar(item.author, 'avatar-sm')}<p><b>${esc(item.author.name)}</b>${esc(item.body)}</p></div>`).join('')}<form class="comment-form"><input maxlength="600" placeholder="Add a reply…"><button>Send</button></form>`;
      const form = $('.comment-form', box); form.onsubmit = event => comment(event, form);
    } catch (error) { toast(error.message, 'error'); }
  }

  function openReport(targetType, targetId, targetName = '') {
    const dialog = ensureDialog('report-dialog', `<form class="dialog-card" id="report-form"><header><div><span class="kicker">Campus safety</span><h3>Report</h3></div><button type="button" class="dialog-close">×</button></header><p class="enh-dialog-copy" id="report-target"></p><label>Reason<textarea id="report-reason" maxlength="600" required placeholder="Explain what management should review."></textarea></label><footer><span>Reports go to owner/management.</span><button class="button danger" type="submit">Submit report</button></footer></form>`);
    $('#report-target', dialog).textContent = targetName ? `Reporting ${targetName}` : `Reporting this ${targetType}`;
    $('#report-reason', dialog).value = '';
    $('.dialog-close', dialog).onclick = () => dialog.close();
    $('#report-form', dialog).onsubmit = async event => {
      event.preventDefault(); const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true;
      try { await api('/api/reports', { method: 'POST', body: JSON.stringify({ targetType, targetId, reason: $('#report-reason', dialog).value }) }); dialog.close(); toast('Report sent to management.'); }
      catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; }
    };
    dialog.showModal();
  }

  postCard = function enhancedPostCard(post) {
    let html = corePostCard(post);
    if (post.author.id !== state.user.id) html = html.replace('<button class="spacer save-post">', `<button class="report-post" data-report-post="${esc(post.id)}">! Report</button><button class="spacer save-post">`);
    if (post.commentCount > (post.comments || []).length) html = html.replace('<form class="comment-form">', `<button type="button" class="load-comments" data-comments-post="${esc(post.id)}">View all ${post.commentCount} replies</button><form class="comment-form">`);
    return html;
  };

  bindView = function enhancedBindView() {
    coreBindView();
    $$('.report-post', $('#view')).forEach(button => button.onclick = () => openReport('post', button.dataset.reportPost));
    $$('.load-comments', $('#view')).forEach(button => button.onclick = () => loadAllComments(button));
    $$('[data-profile]', $('#view')).forEach(button => button.onclick = () => navigate(`profile/${encodeURIComponent(button.dataset.profile)}`));
  };

  function openPasswordDialog() {
    const dialog = ensureDialog('password-dialog', `<form class="dialog-card" id="password-form"><header><div><span class="kicker">Security</span><h3>Change password</h3></div><button type="button" class="dialog-close">×</button></header><label>Current password<input id="password-current" type="password" required autocomplete="current-password"></label><label>New password<input id="password-new" type="password" minlength="10" required autocomplete="new-password"></label><footer><span>Other signed-in sessions will be closed.</span><button class="button primary" type="submit">Change password</button></footer></form>`);
    $('#password-current', dialog).value = ''; $('#password-new', dialog).value = ''; $('.dialog-close', dialog).onclick = () => dialog.close();
    $('#password-form', dialog).onsubmit = async event => { event.preventDefault(); const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true; try { await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#password-current', dialog).value, newPassword: $('#password-new', dialog).value }) }); dialog.close(); toast('Password changed. Other sessions were signed out.'); } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; } };
    dialog.showModal();
  }

  function openDeleteAccountDialog() {
    const dialog = ensureDialog('delete-account-dialog', `<form class="dialog-card" id="delete-account-form"><header><div><span class="kicker">Permanent action</span><h3>Delete account</h3></div><button type="button" class="dialog-close">×</button></header><p class="enh-dialog-copy">Your posts, memberships, owned communities and other account data may be removed. This cannot be undone.</p><label>Type your username<input id="delete-account-username" required></label><label>Password<input id="delete-account-password" type="password" required></label><footer><span>This action is permanent.</span><button class="button danger" type="submit">Delete my account</button></footer></form>`);
    $('#delete-account-username', dialog).value = ''; $('#delete-account-password', dialog).value = ''; $('.dialog-close', dialog).onclick = () => dialog.close();
    $('#delete-account-form', dialog).onsubmit = async event => { event.preventDefault(); if (!confirm('Permanently delete your College Ox account?')) return; const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true; try { await api('/api/account', { method: 'DELETE', body: JSON.stringify({ username: $('#delete-account-username', dialog).value, password: $('#delete-account-password', dialog).value }) }); dialog.close(); state.user = null; showAuth('Your account was deleted.'); } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; } };
    dialog.showModal();
  }

  renderProfile = async function enhancedRenderProfile(username) {
    await coreRenderProfile(username);
    const profile = state.profile; if (!profile?.user) return;
    if (profile.user.id === state.user.id) {
      const posts = $('.profile-posts'); if (posts) posts.insertAdjacentHTML('beforebegin', `<section class="account-settings surface"><div><span class="kicker">Account</span><h3>Security & account</h3><p>Change your password or permanently delete this account.</p></div><div class="account-actions"><button class="button" id="change-password-button">Change password</button><button class="button danger" id="delete-account-button">Delete account</button></div></section>`);
      $('#change-password-button')?.addEventListener('click', openPasswordDialog); $('#delete-account-button')?.addEventListener('click', openDeleteAccountDialog);
    } else {
      const actions = $('.profile-top-actions'); if (actions && !$('#report-user-button')) { const button = document.createElement('button'); button.id = 'report-user-button'; button.className = 'button ghost'; button.textContent = 'Report'; button.onclick = () => openReport('user', profile.user.id, `@${profile.user.username}`); actions.append(button); }
    }
  };

  function localDateInput(value) { const date = new Date(value), pad = number => String(number).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }

  function openEventEditor(item) {
    const dialog = ensureDialog('edit-event-dialog', `<form class="dialog-card" id="edit-event-form"><header><div><span class="kicker">Event</span><h3>Edit event</h3></div><button type="button" class="dialog-close">×</button></header><label>Event title<input id="edit-event-title" maxlength="100" required></label><label>Description<textarea id="edit-event-description" maxlength="800"></textarea></label><div class="two-fields"><label>Starts at<input id="edit-event-start" type="datetime-local" required></label><label>Capacity<input id="edit-event-capacity" type="number" min="2" max="5000" required></label></div><label>Location<input id="edit-event-location" maxlength="120"></label><footer><span>Attendees will receive an update.</span><button class="button primary" type="submit">Save event</button></footer></form>`);
    $('#edit-event-title', dialog).value = item.title; $('#edit-event-description', dialog).value = item.description || ''; $('#edit-event-start', dialog).value = localDateInput(item.starts_at); $('#edit-event-capacity', dialog).value = item.capacity; $('#edit-event-location', dialog).value = item.location || ''; $('.dialog-close', dialog).onclick = () => dialog.close();
    $('#edit-event-form', dialog).onsubmit = async event => { event.preventDefault(); const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true; try { await api(`/api/events/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: $('#edit-event-title', dialog).value, description: $('#edit-event-description', dialog).value, startsAt: $('#edit-event-start', dialog).value, capacity: $('#edit-event-capacity', dialog).value, location: $('#edit-event-location', dialog).value }) }); dialog.close(); await loadRouteData('events'); renderEvents(); toast('Event updated.'); } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; } };
    dialog.showModal();
  }

  async function cancelEvent(item) { if (!confirm(`Cancel “${item.title}”? Attendees will be notified.`)) return; try { await api(`/api/events/${item.id}`, { method: 'DELETE' }); await loadRouteData('events'); renderEvents(); toast('Event cancelled.'); } catch (error) { toast(error.message, 'error'); } }

  renderEvents = function enhancedRenderEvents() {
    coreRenderEvents();
    $$('.event-card', $('#view')).forEach((card, index) => { const item = state.data.events[index]; if (!item || (!item.isCreator && !['owner', 'management'].includes(state.user.role))) return; const tools = document.createElement('div'); tools.className = 'enh-entity-tools'; tools.innerHTML = '<button class="button ghost edit-event">Edit</button><button class="button ghost cancel-event">Cancel</button>'; $('.edit-event', tools).onclick = () => openEventEditor(item); $('.cancel-event', tools).onclick = () => cancelEvent(item); $('.entity-foot', card)?.insertAdjacentElement('beforebegin', tools); });
  };

  function openTransfer(kind, item) {
    const dialog = ensureDialog('transfer-dialog', `<form class="dialog-card" id="transfer-form"><header><div><span class="kicker">Ownership</span><h3>Transfer ownership</h3></div><button type="button" class="dialog-close">×</button></header><p class="enh-dialog-copy" id="transfer-copy"></p><label>New owner's username<input id="transfer-username" required placeholder="username"></label><footer><span>The new owner must already be a member.</span><button class="button primary" type="submit">Transfer</button></footer></form>`);
    $('#transfer-copy', dialog).textContent = `Transfer ${item.name} to another member.`; $('#transfer-username', dialog).value = ''; $('.dialog-close', dialog).onclick = () => dialog.close();
    $('#transfer-form', dialog).onsubmit = async event => { event.preventDefault(); const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true; try { await api(`/api/${kind}/${item.id}/transfer`, { method: 'POST', body: JSON.stringify({ username: $('#transfer-username', dialog).value }) }); dialog.close(); await loadRouteData(kind); kind === 'projects' ? renderProjects() : renderClubs(); toast('Ownership transferred.'); } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; } };
    dialog.showModal();
  }

  async function showArchived(kind) {
    try {
      const result = await api(`/api/archive?kind=${kind}`), items = result[kind] || [], singular = kind === 'projects' ? 'project' : 'club';
      $('#view').innerHTML = `${pageHead('Archive', `Archived ${kind}`, `Restore ${singular}s that you previously archived.`)}${items.length ? `<div class="grid-3">${items.map(item => `<article class="entity-card surface"><div class="symbol">${kind === 'projects' ? '◇' : '◎'}</div><h3>${esc(item.name)}</h3><p>${esc(item.pitch || item.description || '')}</p><div class="entity-foot"><span>${item.members || 0} members · @${esc(item.username)}</span><button class="button primary restore-entity" data-restore="${esc(item.id)}">Restore</button></div></article>`).join('')}</div>` : empty('↶', `No archived ${kind}`, 'Archived items you own will appear here.')}<button class="button archive-back" style="margin-top:18px">← Back to ${kind}</button>`;
      $$('.restore-entity').forEach(button => button.onclick = async () => { try { await api(`/api/${kind}/${button.dataset.restore}`, { method: 'PATCH', body: JSON.stringify({ status: kind === 'projects' ? 'recruiting' : 'active' }) }); await showArchived(kind); toast(`${singular[0].toUpperCase()}${singular.slice(1)} restored.`); } catch (error) { toast(error.message, 'error'); } });
      $('.archive-back')?.addEventListener('click', () => navigate(kind));
    } catch (error) { toast(error.message, 'error'); }
  }

  function addArchiveButton(kind) { const head = $('.page-head', $('#view')); if (!head || $('.show-archive', head)) return; const button = document.createElement('button'); button.className = 'button ghost show-archive'; button.textContent = 'Archived'; button.onclick = () => showArchived(kind); head.append(button); }

  renderProjects = function enhancedRenderProjects() { coreRenderProjects(); addArchiveButton('projects'); $$('.entity-card', $('#view')).forEach((card, index) => { const item = state.data.projects[index]; if (!item?.isOwner) return; const actions = $('.entity-actions', card); if (!actions) return; const button = document.createElement('button'); button.className = 'button ghost'; button.textContent = 'Transfer'; button.onclick = () => openTransfer('projects', item); actions.prepend(button); }); };
  renderClubs = function enhancedRenderClubs() { coreRenderClubs(); addArchiveButton('clubs'); $$('.entity-card', $('#view')).forEach((card, index) => { const item = state.data.clubs[index]; if (!item?.isOwner) return; const actions = $('.entity-actions', card); if (!actions) return; const button = document.createElement('button'); button.className = 'button ghost'; button.textContent = 'Transfer'; button.onclick = () => openTransfer('clubs', item); actions.prepend(button); }); };

  async function loadAdminUsers(query = '') { const box = $('#admin-user-results'); if (!box) return; box.innerHTML = '<p class="enh-muted">Loading users…</p>'; try { const result = await api(`/api/admin/users?limit=60&q=${encodeURIComponent(query)}`); box.innerHTML = result.users.length ? result.users.map(user => `<div class="admin-user">${avatar(user, 'avatar-sm')}<div><b>${esc(user.name)}</b><span>@${esc(user.username)}${user.department ? ` · ${esc(user.department)}` : ''}</span></div>${state.user.role === 'owner' ? `<select class="role-select" data-role-user="${user.id}" data-current-role="${user.role}"><option value="student" ${user.role === 'student' ? 'selected' : ''}>student</option><option value="faculty" ${user.role === 'faculty' ? 'selected' : ''}>faculty</option><option value="management" ${user.role === 'management' ? 'selected' : ''}>management</option><option value="owner" ${user.role === 'owner' ? 'selected' : ''}>owner</option></select>` : `<span class="pill">${esc(user.role)}</span>`}</div>`).join('') : '<p class="enh-muted">No users found.</p>'; $$('.role-select', box).forEach(select => select.onchange = () => changeRole(select)); } catch (error) { box.innerHTML = `<p class="enh-error">${esc(error.message)}</p>`; } }
  async function loadReports() { const box = $('#admin-report-results'); if (!box) return; try { const result = await api('/api/admin/reports?status=open'); box.innerHTML = result.reports.length ? result.reports.map(report => `<article class="admin-report" data-report-id="${esc(report.id)}"><div><b>${esc(report.target_type)} report</b><span>from @${esc(report.reporter_username)} · ${ago(report.created_at)}</span></div><p>${esc(report.reason)}</p><small>${report.target ? esc(report.target.body || `@${report.target.username}`) : 'Target no longer exists.'}</small><div><button class="button report-resolve">Resolve</button><button class="button ghost report-dismiss">Dismiss</button></div></article>`).join('') : '<p class="enh-muted">No open reports.</p>'; $$('.report-resolve', box).forEach(button => button.onclick = () => updateReport(button, 'resolved')); $$('.report-dismiss', box).forEach(button => button.onclick = () => updateReport(button, 'dismissed')); } catch (error) { box.innerHTML = `<p class="enh-error">${esc(error.message)}</p>`; } }
  async function updateReport(button, status) { const card = button.closest('.admin-report'); try { await api(`/api/admin/reports/${card.dataset.reportId}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadReports(); toast(`Report ${status}.`); } catch (error) { toast(error.message, 'error'); } }
  async function loadRoleAudit() { const box = $('#role-audit-results'); if (!box) return; try { const result = await api('/api/admin/role-audit'); box.innerHTML = result.changes.length ? result.changes.slice(0, 30).map(change => `<div class="audit-row"><b>@${esc(change.target_username || 'deleted')}</b><span>${esc(change.from_role)} → ${esc(change.to_role)}</span><small>by @${esc(change.actor_username || 'deleted')} · ${ago(change.created_at)}</small></div>`).join('') : '<p class="enh-muted">No role changes recorded yet.</p>'; } catch (error) { box.innerHTML = `<p class="enh-error">${esc(error.message)}</p>`; } }

  renderAdmin = async function enhancedRenderAdmin() { await coreRenderAdmin(); if (!$('#view') || $('#admin-enhancements')) return; $('#view').insertAdjacentHTML('beforeend', `<section id="admin-enhancements" class="admin-enhancements"><section class="admin-card surface"><div class="enh-section-head"><div><span class="kicker">Directory</span><h3>Manage all users</h3></div></div><form id="admin-user-search" class="enh-search"><input id="admin-user-query" placeholder="Search name, username or department"><button class="button" type="submit">Search</button></form><div id="admin-user-results"></div></section><section class="admin-card surface"><div class="enh-section-head"><div><span class="kicker">Moderation</span><h3>Open reports</h3></div></div><div id="admin-report-results"><p class="enh-muted">Loading reports…</p></div></section><section class="admin-card surface"><div class="enh-section-head"><div><span class="kicker">Audit</span><h3>Role history</h3></div></div><div id="role-audit-results"><p class="enh-muted">Loading history…</p></div></section></section>`); $('#admin-user-search').onsubmit = event => { event.preventDefault(); loadAdminUsers($('#admin-user-query').value); }; await Promise.all([loadAdminUsers(), loadReports(), loadRoleAudit()]); };

  async function renderNotifications() { $('#view').innerHTML = `${pageHead('Updates', 'Notifications', 'Likes, comments, followers, support replies and important activity.')}<section class="notification-list surface" id="notification-list"><p class="enh-muted">Loading notifications…</p></section>`; try { const result = await api('/api/notifications?limit=60'), box = $('#notification-list'); box.innerHTML = result.notifications.length ? result.notifications.map(item => `<article class="notification-row ${item.read_at ? '' : 'unread'}" data-note-id="${esc(item.id)}"><div class="notification-glyph">${item.kind === 'like' ? '♥' : item.kind === 'comment' ? '□' : item.kind === 'follow' ? '◉' : '△'}</div><div><b>${esc(item.text)}</b><span>${item.actor_username ? `@${esc(item.actor_username)} · ` : ''}${ago(item.created_at)}</span></div>${['like', 'comment'].includes(item.kind) ? `<button class="button ghost notification-open-post" data-post="${esc(item.entity_id)}">Open</button>` : ''}</article>`).join('') : empty('✓', 'You are all caught up', 'New activity will appear here.'); $$('.notification-open-post', box).forEach(button => button.onclick = async () => { await api('/api/notifications', { method: 'POST', body: JSON.stringify({ id: button.closest('.notification-row').dataset.noteId }) }); location.href = directPostLink(button.dataset.post); }); await api('/api/notifications', { method: 'POST', body: JSON.stringify({ all: true }) }); await updateNotificationBadge(); } catch (error) { toast(error.message, 'error'); } }
  async function updateNotificationBadge() { const badge = $('#notification-count'); if (!badge || !state.user) return; try { const result = await api('/api/notifications?limit=1'); badge.textContent = result.unread > 99 ? '99+' : String(result.unread); badge.hidden = result.unread === 0; } catch {} }

  routeMeta.notifications = ['Updates', 'Notifications'];
  navigate = async function enhancedNavigate(route) { historyNavigation = true; try { if (route === 'notifications') { state.route = 'notifications'; location.hash = 'notifications'; $('#route-eyebrow').textContent = 'Updates'; $('#route-title').textContent = 'Notifications'; $$('[data-route]').forEach(button => button.classList.toggle('active', button.dataset.route === 'notifications')); $('#sidebar').classList.remove('open'); await renderNotifications(); scrollTo({ top: 0 }); return; } if (route.startsWith('profile/')) { const username = decodeURIComponent(route.slice(8)); location.hash = route; $('#route-eyebrow').textContent = 'Campus member'; $('#route-title').textContent = `@${username}`; $$('[data-route]').forEach(button => button.classList.toggle('active', button.dataset.route === 'people')); $('#sidebar').classList.remove('open'); await renderProfile(username); scrollTo({ top: 0 }); return; } await coreNavigate(route); } finally { setTimeout(() => { historyNavigation = false; }, 0); } };
  enter = async function enhancedEnter(user) { await coreEnter(user); await updateNotificationBadge(); clearInterval(notificationTimer); notificationTimer = setInterval(() => updateNotificationBadge(), 60000); };
  window.addEventListener('hashchange', () => { if (historyNavigation || !state.user) return; const route = location.hash.slice(1) || 'feed'; navigate(route).catch(error => toast(error.message, 'error')); });

  function installNotificationNav() { if ($('#notification-nav')) return; const you = $$('#nav .nav-label').find(label => label.textContent.trim() === 'You'); if (!you) return; const button = document.createElement('button'); button.id = 'notification-nav'; button.dataset.route = 'notifications'; button.innerHTML = '<i>◌</i><span>Notifications</span><b id="notification-count" class="notification-count" hidden>0</b>'; button.onclick = () => navigate('notifications'); you.insertAdjacentElement('afterend', button); }
  function installAnnouncementAudiences() { const select = $('#announcement-audience'), form = $('#announcement-form'); if (!select || !form || select.dataset.enhanced) return; select.dataset.enhanced = '1'; select.insertAdjacentHTML('beforeend', '<option value="Management">Management</option><option value="Department">Department…</option>'); const label = document.createElement('label'); label.id = 'announcement-department-wrap'; label.hidden = true; label.innerHTML = 'Department<input id="announcement-department" maxlength="80" placeholder="CSE">'; select.closest('label').insertAdjacentElement('afterend', label); select.onchange = () => { label.hidden = select.value !== 'Department'; }; form.onsubmit = async event => { event.preventDefault(); const submit = $('button[type=submit]', form); let audience = select.value; if (audience === 'Department') { const department = $('#announcement-department').value.trim(); if (!department) { toast('Add the department name.', 'error'); return; } audience = `Department:${department}`; } submit.disabled = true; try { await api('/api/announcements', { method: 'POST', body: JSON.stringify({ title: $('#announcement-title').value, body: $('#announcement-body').value, audience }) }); form.reset(); label.hidden = true; closeDialog('announcement-dialog'); await loadRouteData('announcements'); render(); toast('Notice published.'); } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; } }; }

  async function compressedAvatar(file) { if (file.size > 5_000_000) throw new Error('Choose an image under 5 MB.'); const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = source; }); const max = 512, scale = Math.min(1, max / Math.max(image.width, image.height)), canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); let quality = .82, data = canvas.toDataURL('image/webp', quality); while (data.length > 300000 && quality > .45) { quality -= .08; data = canvas.toDataURL('image/webp', quality); } if (data.length > 600000) throw new Error('That image could not be compressed enough. Try a smaller image.'); return data; }
  readAvatar = async function enhancedReadAvatar(event) { const file = event.target.files[0]; if (!file) return; try { state.avatarDraft = await compressedAvatar(file); renderAvatarPreview(); } catch (error) { event.target.value = ''; toast(error.message || 'Could not process that image.', 'error'); } };

  installNotificationNav(); installAnnouncementAudiences(); if ($('#profile-avatar')) $('#profile-avatar').onchange = event => readAvatar(event);
})();
