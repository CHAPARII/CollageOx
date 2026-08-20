(() => {
  const $8 = (selector, root = document) => root.querySelector(selector);
  const $$8 = (selector, root = document) => [...root.querySelectorAll(selector)];
  const routeInfo = {
    messages: ['Private conversations', 'Messages'],
    projects: ['Build together', 'Projects'],
    clubs: ['Belong somewhere', 'Clubs'],
    events: ['Plan your time', 'Events'],
    profile: ['Your campus identity', 'Profile'],
    marketplace: ['Campus exchange', 'Marketplace'],
    lostfound: ['Help things get home', 'Lost & Found'],
    qa: ['Ask campus', 'Campus Q&A'],
    collections: ['Saved for later', 'Bookmark collections'],
    discover: ['Made for you', 'Discover']
  };
  const managedRoutes = new Set(Object.keys(routeInfo));
  let activeRoute = null;
  let activeProfileUsername = null;
  let me = null;
  let activeConversationId = null;
  let pr8Stream = null;
  let searchTimer = null;
  let searchType = 'all';
  let typingTimer = null;
  let coreNavigate = null;
  let coreRefreshCurrent = null;
  let coreRenderProfile = null;
  let corePostCard = null;

  const esc8 = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const ago8 = value => {
    if (!value) return 'offline';
    const diff = Math.max(0, Date.now() - new Date(value).getTime());
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hr ago`;
    if (diff < 172800000) return 'yesterday';
    return `${Math.floor(diff / 86400000)} days ago`;
  };
  const date8 = value => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '';
  const money8 = value => value == null ? '' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
  const initials8 = user => (user?.name || user?.username || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
  const avatar8 = (user, cls = 'avatar-sm') => user?.avatar
    ? `<span class="avatar ${cls}" style="--accent:${esc8(user.accent || '#155eef')}"><img src="${esc8(user.avatar)}" alt=""></span>`
    : `<span class="avatar ${cls}" style="--accent:${esc8(user?.accent || '#155eef')}">${esc8(initials8(user))}</span>`;

  async function api8(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: options.body instanceof FormData ? { ...(options.headers || {}) } : { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function toast8(message, type = 'success') {
    if (typeof window.toast === 'function') return window.toast(message, type);
    const host = $8('#toasts');
    if (!host) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    host.append(item);
    setTimeout(() => item.remove(), 3500);
  }

  function pageHead8(kicker, title, text, action = '') {
    return `<header class="page-head"><div><span class="kicker">${esc8(kicker)}</span><h1>${esc8(title)}</h1><p>${esc8(text)}</p></div>${action}</header>`;
  }

  function loading8() {
    const view = $8('#view');
    if (view) view.innerHTML = '<div class="pr8-card pr8-loading">Loading…</div>';
  }

  function empty8(title, text) {
    return `<div class="pr8-card pr8-empty"><h3>${esc8(title)}</h3><p>${esc8(text)}</p></div>`;
  }

  function setChrome8(route) {
    const meta = routeInfo[route] || ['Campus', 'College Ox'];
    const eyebrow = $8('#route-eyebrow');
    const title = $8('#route-title');
    if (eyebrow) eyebrow.textContent = meta[0];
    if (title) title.textContent = meta[1];
    $$8('[data-route], [data-pr8-route]').forEach(button => {
      button.classList.toggle('active', button.dataset.pr8Route === route || button.dataset.route === route);
    });
    $8('#sidebar')?.classList.remove('open');
  }

  function insertNav() {
    const nav = $8('#nav');
    if (!nav || $8('[data-pr8-route="messages"]', nav)) return;
    const notices = $8('[data-route="announcements"]', nav);
    const holder = document.createElement('div');
    holder.className = 'pr8-nav-links';
    holder.innerHTML = `
      <button data-pr8-route="messages"><i>✉</i><span>Messages</span><b class="pr8-nav-count" id="pr8-dm-count" hidden>0</b></button>
      <button data-pr8-route="marketplace"><i>¤</i><span>Marketplace</span></button>
      <button data-pr8-route="lostfound"><i>⌖</i><span>Lost & Found</span></button>
      <button data-pr8-route="qa"><i>?</i><span>Campus Q&A</span></button>
    `;
    if (notices) notices.after(holder);
    else nav.prepend(holder);
    const profileButton = $8('[data-route="profile"]', nav);
    const saved = document.createElement('button');
    saved.dataset.pr8Route = 'collections';
    saved.innerHTML = '<i>◆</i><span>Collections</span>';
    profileButton?.after(saved);
    $$8('[data-pr8-route]').forEach(button => button.addEventListener('click', () => navigate8(button.dataset.pr8Route)));
  }

  function richText8(text) {
    return esc8(text)
      .replace(/(^|\s)#([A-Za-z0-9_-]{1,50})/g, '$1<button class="text-button" data-pr8-tag="$2">#$2</button>')
      .replace(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]{2,24})/g, '$1<button class="text-button" data-pr8-profile="$2">@$2</button>');
  }

  function pollMarkup8(poll) {
    if (!poll) return '';
    const totalVotes = poll.options.reduce((sum, option) => sum + Number(option.votes || 0), 0);
    return `<div class="pr8-poll" data-poll="${esc8(poll.id)}">${poll.options.map(option => {
      const pct = totalVotes ? Math.round(Number(option.votes || 0) / totalVotes * 100) : 0;
      return `<button type="button" class="pr8-poll-option ${option.selected ? 'selected' : ''}" data-pr8-poll-option="${esc8(option.id)}" data-pr8-poll="${esc8(poll.id)}" ${poll.expired ? 'disabled' : ''}><span class="fill" style="width:${pct}%"></span><span>${esc8(option.label)} · ${pct}%${option.selected ? ' · selected' : ''}</span></button>`;
    }).join('')}<span class="pr8-muted">${poll.totalVoters} voter${poll.totalVoters === 1 ? '' : 's'} · ${poll.choiceMode === 'multiple' ? 'multiple choice' : 'single choice'} · ${poll.voterVisibility} · ${poll.expired ? 'closed' : `closes ${date8(poll.expiresAt)}`}</span></div>`;
  }

  function mediaMarkup8(media = []) {
    if (!media.length) return '';
    return `<div class="pr8-media-grid ${media.length === 1 ? 'one' : ''}">${media.map(item => `<img src="${esc8(item.src)}" alt="Post image" loading="lazy" data-pr8-lightbox="${esc8(item.src)}">`).join('')}</div>`;
  }

  function postCard8(post) {
    const mine = me && post.author?.id === me.id;
    const staff = me && ['owner', 'management'].includes(me.role);
    const canDelete = mine || staff;
    return `<article class="post surface" data-post="${esc8(post.id)}"><div class="post-head">${avatar8(post.author)}<button class="post-author" data-profile="${esc8(post.author.username)}"><b>${esc8(post.author.name)}</b><span>@${esc8(post.author.username)} · ${ago8(post.createdAt)}${post.editedAt ? ' · edited' : ''}</span></button><div class="post-menu">${mine ? '<button class="edit-post" title="Edit post">Edit</button>' : ''}${canDelete ? '<button class="delete-post" title="Delete post">Delete</button>' : ''}</div></div><span class="post-kind">${esc8(post.type)}</span><div class="post-body">${richText8(post.body)}</div><div class="tags">${(post.tags || []).map(tag => `<button class="tag" data-pr8-tag="${esc8(tag)}">#${esc8(tag)}</button>`).join('')}</div>${mediaMarkup8(post.media || [])}${pollMarkup8(post.poll)}<div class="post-actions"><button class="react ${post.reacted ? 'active' : ''}" data-kind="like">♥ ${Number(post.reactionCount || 0)}</button><button class="comment-toggle">□ ${Number(post.commentCount || 0)}</button><button class="copy-post">↗ Share</button><button class="save-post">${post.saved ? '◆ Saved' : '◇ Save'}</button><button type="button" data-pr8-collection="${esc8(post.id)}">＋ Collection</button>${mine ? `<button type="button" data-pr8-pin-profile="${esc8(post.id)}">⌖ Pin</button>` : ''}</div><div class="comments" hidden>${(post.comments || []).map(comment => `<div class="comment">${avatar8(comment.author)}<p><b>${esc8(comment.author.name)}</b>${richText8(comment.body)}</p></div>`).join('')}<form class="comment-form"><input maxlength="600" placeholder="Add a reply…"><button>Send</button></form></div></article>`;
  }

  async function navigate8(route, options = {}) {
    if (!managedRoutes.has(route)) {
      activeRoute = null;
      return coreNavigate?.(route);
    }
    activeRoute = route;
    if (route === 'profile' && options.username) activeProfileUsername = options.username;
    location.hash = route === 'profile' && activeProfileUsername && me && activeProfileUsername !== me.username ? `profile:${activeProfileUsername}` : route;
    setChrome8(route);
    loading8();
    try {
      await renderRoute8(route);
    } catch (error) {
      toast8(error.message, 'error');
      const view = $8('#view');
      if (view) view.innerHTML = empty8('Could not load this section', error.message);
    }
    scrollTo({ top: 0 });
  }

  async function renderRoute8(route) {
    if (route === 'messages') return renderMessages8();
    if (route === 'projects') return renderProjects8();
    if (route === 'clubs') return renderClubs8();
    if (route === 'events') return renderEvents8();
    if (route === 'profile') return renderProfile8(activeProfileUsername || me?.username);
    if (route === 'marketplace') return renderMarketplace8();
    if (route === 'lostfound') return renderLostFound8();
    if (route === 'qa') return renderQa8();
    if (route === 'collections') return renderCollections8();
    if (route === 'discover') return renderDiscover8();
  }

  async function refreshDmCount8() {
    if (!me) return;
    try {
      const data = await api8('/api/dm/conversations');
      const count = data.conversations.reduce((sum, conversation) => sum + Number(conversation.unread || 0), 0);
      const badge = $8('#pr8-dm-count');
      if (badge) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = count === 0;
      }
    } catch {}
  }

  function conversationListMarkup8(conversations) {
    if (!conversations.length) return '<div class="pr8-empty">No conversations yet.</div>';
    return conversations.map(conversation => `<button class="pr8-dm-item ${activeConversationId === conversation.id ? 'active' : ''}" data-pr8-conversation="${esc8(conversation.id)}">${avatar8(conversation.other)}<span class="meta"><b>${esc8(conversation.other.name)} ${conversation.unread ? `<span class="pr8-badge blue">${conversation.unread}</span>` : ''}</b><span>${esc8(conversation.latestMessage?.body || 'Start a conversation')}</span><span class="pr8-presence ${conversation.presence?.online ? 'online' : ''}">${conversation.presence?.online ? 'Online' : `Active ${ago8(conversation.presence?.lastSeenAt)}`}</span></span></button>`).join('');
  }

  async function renderMessages8() {
    const data = await api8('/api/dm/conversations');
    if (!activeConversationId && data.conversations[0]) activeConversationId = data.conversations[0].id;
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Private conversations', 'Messages', 'One-to-one campus messaging with Seen, typing status, mute, block, and presence.', '<button class="button" id="pr8-new-message">New message</button>')}<section class="pr8-dm-layout"><aside class="pr8-dm-list" id="pr8-dm-list">${conversationListMarkup8(data.conversations)}</aside><div class="pr8-dm-pane" id="pr8-dm-pane"><div class="pr8-empty">Choose a conversation.</div></div></section>`;
    $8('#pr8-new-message').onclick = async () => {
      const username = prompt('Username to message');
      if (!username?.trim()) return;
      try {
        const created = await api8('/api/dm/conversations', { method: 'POST', body: JSON.stringify({ username: username.trim() }) });
        activeConversationId = created.conversation.id;
        await renderMessages8();
      } catch (error) { toast8(error.message, 'error'); }
    };
    $$8('[data-pr8-conversation]').forEach(button => button.onclick = async () => {
      activeConversationId = button.dataset.pr8Conversation;
      await openConversation8(activeConversationId);
      $$8('[data-pr8-conversation]').forEach(item => item.classList.toggle('active', item.dataset.pr8Conversation === activeConversationId));
    });
    if (activeConversationId) await openConversation8(activeConversationId);
  }

  async function openConversation8(conversationId) {
    const data = await api8(`/api/dm/${encodeURIComponent(conversationId)}/messages?limit=80`);
    const other = data.conversation.other;
    const presence = data.conversation.presence || {};
    const pane = $8('#pr8-dm-pane');
    if (!pane) return;
    const current = (await api8('/api/dm/conversations')).conversations.find(item => item.id === conversationId);
    pane.innerHTML = `<header class="pr8-dm-head"><div class="person-row">${avatar8(other)}<div><b>${esc8(other.name)}</b><span>@${esc8(other.username)} · <span class="pr8-presence ${presence.online ? 'online' : ''}">${presence.online ? 'Online' : `Active ${ago8(presence.lastSeenAt)}`}</span></span></div></div><div class="pr8-actions"><button type="button" id="pr8-dm-mute">${current?.muted ? 'Unmute' : 'Mute'}</button><button type="button" class="danger" id="pr8-dm-block">Block</button></div></header><div class="pr8-dm-messages" id="pr8-dm-messages">${data.messages.map(message => `<div class="pr8-bubble ${message.senderId === me.id ? 'mine' : ''}">${esc8(message.body)}<small>${date8(message.createdAt)}${message.senderId === me.id && message.seenAt ? ' · Seen' : ''}</small></div>`).join('')}<div id="pr8-typing" class="pr8-muted"></div></div><form class="pr8-dm-compose" id="pr8-dm-compose"><input maxlength="2000" autocomplete="off" placeholder="Message @${esc8(other.username)}"><button class="button primary">Send</button></form>`;
    const messages = $8('#pr8-dm-messages');
    if (messages) messages.scrollTop = messages.scrollHeight;
    await api8(`/api/dm/${encodeURIComponent(conversationId)}/seen`, { method: 'POST', body: '{}' }).catch(() => {});
    $8('#pr8-dm-compose').onsubmit = async event => {
      event.preventDefault();
      const input = $8('input', event.currentTarget);
      const body = input.value.trim();
      if (!body) return;
      input.value = '';
      try {
        await api8(`/api/dm/${encodeURIComponent(conversationId)}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
        await openConversation8(conversationId);
        refreshDmCount8();
      } catch (error) { toast8(error.message, 'error'); }
    };
    $8('input', $8('#pr8-dm-compose')).oninput = () => {
      api8('/api/dm/typing', { method: 'POST', body: JSON.stringify({ conversationId, active: true }) }).catch(() => {});
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => api8('/api/dm/typing', { method: 'POST', body: JSON.stringify({ conversationId, active: false }) }).catch(() => {}), 1200);
    };
    $8('#pr8-dm-mute').onclick = async () => {
      const muted = !current?.muted;
      await api8(`/api/dm/${encodeURIComponent(conversationId)}/settings`, { method: 'PATCH', body: JSON.stringify({ muted }) });
      toast8(muted ? 'Conversation muted.' : 'Conversation unmuted.');
      renderMessages8();
    };
    $8('#pr8-dm-block').onclick = async () => {
      if (!confirm(`Block @${other.username}? You will no longer be able to interact.`)) return;
      await api8(`/api/safety/blocks/${encodeURIComponent(other.id)}`, { method: 'PUT', body: '{}' });
      activeConversationId = null;
      toast8('User blocked.');
      renderMessages8();
    };
  }

  async function renderProjects8() {
    const data = await api8('/api/projects');
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Build together', 'Projects', 'Every project uses applications. Owners review applicants before anyone joins.', '<button class="button" data-open="project-dialog">New project</button>')}<div class="pr8-grid">${data.projects.map(project => `<article class="pr8-card"><div class="pr8-card-head"><div><h3>${esc8(project.name)}</h3><span class="pr8-muted">by @${esc8(project.username)} · ${project.members}/${project.capacity} members</span></div><span class="pr8-badge">${esc8(project.memberRole || project.status)}</span></div><p>${esc8(project.pitch)}</p><div class="pr8-skill-list">${(project.skills || []).map(skill => `<span class="pr8-badge yellow">${esc8(skill)}</span>`).join('')}</div><div class="pr8-actions">${project.isOwner ? `<button data-pr8-project-apps="${esc8(project.id)}">Applications</button><button data-pr8-project-team="${esc8(project.id)}">Team</button><button data-pr8-project-update="${esc8(project.id)}">Post update</button>` : project.joined ? `<button data-pr8-project-leave="${esc8(project.id)}">Leave project</button>` : project.application?.status === 'pending' ? '<span class="pr8-badge blue">Application pending</span>' : `<button class="primary" data-pr8-project-apply="${esc8(project.id)}">Apply</button>`}</div></article>`).join('')}</div>`;
    bindDialogOpeners8();
  }

  async function renderClubs8() {
    const data = await api8('/api/clubs');
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Belong somewhere', 'Clubs', 'Club owners choose Open Join, Approval Required, or Invite Only.', '<button class="button" data-open="club-dialog">Start a club</button>')}<div class="pr8-grid">${data.clubs.map(club => `<article class="pr8-card" style="border-top:4px solid ${esc8(club.accent || '#155eef')}"><div class="pr8-card-head"><div><h3>${esc8(club.name)}</h3><span class="pr8-muted">${club.members} members · @${esc8(club.username)}</span></div><span class="pr8-badge">${esc8(club.joinMode)}</span></div><p>${esc8(club.description)}</p><div class="pr8-status-row"><span class="pr8-badge yellow">${esc8(club.category)}</span>${club.memberRole ? `<span class="pr8-badge blue">${esc8(club.memberRole)}</span>` : ''}${club.request?.status === 'pending' ? '<span class="pr8-badge">Request pending</span>' : ''}</div><div class="pr8-actions">${club.isOwner ? `<button data-pr8-club-mode="${esc8(club.id)}">Join settings</button><button data-pr8-club-requests="${esc8(club.id)}">Requests</button><button data-pr8-club-invite="${esc8(club.id)}">Invite</button><button data-pr8-club-team="${esc8(club.id)}">Roles</button><button data-pr8-club-event="${esc8(club.id)}">Create event</button>` : club.joined ? `<button data-pr8-club-leave="${esc8(club.id)}">Leave</button>` : `<button class="primary" data-pr8-club-join="${esc8(club.id)}" data-mode="${esc8(club.joinMode)}">${club.joinMode === 'invite' ? (club.invite?.status === 'pending' ? 'Accept invite' : 'Invite only') : club.joinMode === 'approval' ? 'Request to join' : 'Join'}</button>`}</div></article>`).join('')}</div>`;
    bindDialogOpeners8();
  }

  async function renderEvents8() {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    const data = await api8(`/api/events/calendar?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
    const days = [];
    for (let day = 1; day <= new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate(); day++) {
      const items = data.events.filter(event => new Date(event.startsAt).getDate() === day);
      days.push(`<div class="pr8-day"><small>${day}</small>${items.map(event => `<button class="pr8-event-dot" data-pr8-event="${esc8(event.id)}">${esc8(event.title)}</button>`).join('')}</div>`);
    }
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Plan your time', 'Events', 'Month view with RSVP-aware reminders. Reminder delivery catches up when the app reconnects.', '<button class="button" data-open="event-dialog">New event</button>')}<div class="pr8-toolbar"><b>${new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(start)}</b><button id="pr8-agenda-toggle">Agenda view</button></div><section id="pr8-calendar-view" class="pr8-calendar">${days.join('')}</section><section id="pr8-agenda-view" class="pr8-stack" hidden>${data.events.map(event => eventCard8(event)).join('') || empty8('No events this month', 'Create an event or check back later.')}</section>`;
    $8('#pr8-agenda-toggle').onclick = event => {
      const calendar = $8('#pr8-calendar-view');
      const agenda = $8('#pr8-agenda-view');
      const showingAgenda = !agenda.hidden;
      agenda.hidden = showingAgenda;
      calendar.hidden = !showingAgenda;
      event.currentTarget.textContent = showingAgenda ? 'Agenda view' : 'Month view';
    };
    $$8('[data-pr8-event]').forEach(button => button.onclick = () => showEventModal8(data.events.find(item => item.id === button.dataset.pr8Event)));
    bindDialogOpeners8();
  }

  function eventCard8(event) {
    return `<article class="pr8-card"><div class="pr8-card-head"><div><h3>${esc8(event.title)}</h3><span class="pr8-muted">${date8(event.startsAt)} · ${esc8(event.location || 'Location TBA')}</span></div><span class="pr8-badge ${event.going ? 'blue' : ''}">${event.attendees}/${event.capacity}</span></div><p>${esc8(event.description || '')}</p><div class="pr8-actions"><button class="primary" data-pr8-event="${esc8(event.id)}">Details</button></div></article>`;
  }

  function showEventModal8(event) {
    if (!event) return;
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><div><span class="kicker">Campus event</span><h2>${esc8(event.title)}</h2></div><button class="pr8-close" data-pr8-close>×</button></div><p>${esc8(event.description || '')}</p><p class="pr8-muted">${date8(event.startsAt)} · ${esc8(event.location || 'Location TBA')} · ${event.attendees}/${event.capacity} attending</p><div class="pr8-actions"><button class="primary" data-pr8-rsvp="${esc8(event.id)}">${event.going ? 'Leave RSVP' : 'RSVP'}</button>${event.going ? `<button data-pr8-reminder="${esc8(event.id)}" data-minutes="60">1 hour reminder</button><button data-pr8-reminder="${esc8(event.id)}" data-minutes="1440">1 day reminder</button><button data-pr8-reminder="${esc8(event.id)}" data-minutes="10080">1 week reminder</button><button data-pr8-reminder-remove="${esc8(event.id)}">Remove reminder</button>` : ''}</div></div>`;
    modal.hidden = false;
  }

  async function renderProfile8(username) {
    if (!username) return;
    activeProfileUsername = username;
    const [summary, legacy] = await Promise.all([
      api8(`/api/profiles/${encodeURIComponent(username)}/summary`),
      api8(`/api/profiles/${encodeURIComponent(username)}`).catch(() => ({ posts: [] }))
    ]);
    const user = summary.user;
    const self = me?.id === user.id;
    const view = $8('#view');
    const controls = self
      ? '<button class="button" data-open="profile-dialog">Edit base profile</button>'
      : `<button class="button primary" data-pr8-message-user="${esc8(user.username)}">Message</button><button class="button" data-pr8-mute-user="${esc8(user.id)}">Mute</button><button class="button danger" data-pr8-block-user="${esc8(user.id)}">Block</button>`;
    view.innerHTML = `${pageHead8('Your campus identity', user.name, `@${user.username}`, controls)}<section class="pr8-card"><div class="pr8-card-head"><div class="person-row">${avatar8(user, 'avatar-xl')}<div><h2>${esc8(user.name)}</h2><span>@${esc8(user.username)}${user.department ? ` · ${esc8(user.department)}` : ''}</span></div></div><div class="pr8-status-row">${summary.availableForProjects ? '<span class="pr8-badge blue">Available for projects</span>' : ''}</div></div><p>${summary.private ? 'This profile is private.' : esc8(user.bio || 'No bio yet.')}</p>${summary.pinnedPost ? `<div class="pr8-card" style="margin-top:14px"><span class="kicker">Pinned post</span><p>${richText8(summary.pinnedPost.body)}</p></div>` : ''}<div class="pr8-profile-tabs"><button class="active" data-pr8-profile-tab="about">About</button><button data-pr8-profile-tab="posts">Posts</button><button data-pr8-profile-tab="projects">Projects</button><button data-pr8-profile-tab="clubs">Clubs</button><button data-pr8-profile-tab="events">Events</button></div><div id="pr8-profile-tab"></div></section>`;
    const renderTab = tab => {
      $$8('[data-pr8-profile-tab]').forEach(button => button.classList.toggle('active', button.dataset.pr8ProfileTab === tab));
      const box = $8('#pr8-profile-tab');
      if (tab === 'about') box.innerHTML = `<div class="pr8-stack"><div><h3>Skills</h3><div class="pr8-skill-list">${summary.skills.map(skill => `<span class="pr8-badge yellow">${esc8(skill)}</span>`).join('') || '<span class="pr8-muted">No skills added.</span>'}</div></div>${self ? `<div class="pr8-actions"><button data-pr8-edit-skills>Edit skills</button><button data-pr8-toggle-available>${summary.availableForProjects ? 'Mark unavailable' : 'Available for projects'}</button><button data-pr8-notifications>Notification settings</button><button data-pr8-push>Push notifications</button></div>` : ''}</div>`;
      if (tab === 'posts') box.innerHTML = `<div class="pr8-stack">${(legacy.posts || []).map(postCard8).join('') || empty8('No posts', 'Nothing has been shared here yet.')}</div>`;
      if (tab === 'projects') box.innerHTML = `<div class="pr8-stack">${summary.projects.map(project => `<div class="pr8-card"><b>${esc8(project.name)}</b><span class="pr8-badge">${esc8(project.role)}</span><p>${esc8(project.pitch || '')}</p></div>`).join('') || empty8('No projects', 'No active project memberships.')}</div>`;
      if (tab === 'clubs') box.innerHTML = `<div class="pr8-stack">${summary.clubs.map(club => `<div class="pr8-card"><b>${esc8(club.name)}</b><span class="pr8-badge">${esc8(club.role)}</span><p>${esc8(club.description || '')}</p></div>`).join('') || empty8('No clubs', 'No active club memberships.')}</div>`;
      if (tab === 'events') box.innerHTML = `<div class="pr8-stack">${summary.events.map(event => `<div class="pr8-card"><b>${esc8(event.title)}</b><span class="pr8-muted">${date8(event.startsAt)} · ${esc8(event.location || '')}</span></div>`).join('') || empty8('No upcoming events', 'RSVPs will appear here.')}</div>`;
    };
    $$8('[data-pr8-profile-tab]').forEach(button => button.onclick = () => renderTab(button.dataset.pr8ProfileTab));
    renderTab('about');
    bindDialogOpeners8();
  }

  async function renderMarketplace8() {
    const data = await api8('/api/marketplace');
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Campus exchange', 'Marketplace', 'Sell, buy, borrow, or give away. CollegeOx does not process payments.', '<button class="button primary" id="pr8-market-new">New listing</button>')}<div class="pr8-toolbar"><button class="active" data-market-filter="">All</button><button data-market-filter="sell">Sell</button><button data-market-filter="buy">Buy</button><button data-market-filter="borrow">Borrow</button><button data-market-filter="giveaway">Give away</button></div><div id="pr8-market-grid" class="pr8-grid">${marketCards8(data.listings)}</div>`;
    $8('#pr8-market-new').onclick = () => listingModal8();
    $$8('[data-market-filter]').forEach(button => button.onclick = async () => {
      $$8('[data-market-filter]').forEach(item => item.classList.toggle('active', item === button));
      const type = button.dataset.marketFilter;
      const filtered = await api8(`/api/marketplace${type ? `?type=${encodeURIComponent(type)}` : ''}`);
      $8('#pr8-market-grid').innerHTML = marketCards8(filtered.listings);
    });
  }

  function marketCards8(listings) {
    if (!listings.length) return empty8('No active listings', 'Be the first person to post something.');
    return listings.map(listing => `<article class="pr8-card">${listing.image ? `<img class="pr8-list-image" src="${esc8(listing.image.src)}" alt="">` : ''}<div class="pr8-card-head"><div><span class="pr8-badge">${esc8(listing.type)}</span><h3>${esc8(listing.title)}</h3></div>${listing.priceInr != null ? `<span class="pr8-market-price">${money8(listing.priceInr)}</span>` : ''}</div><p>${esc8(listing.description)}</p><span class="pr8-muted">${esc8(listing.condition || '')}${listing.location ? ` · ${esc8(listing.location)}` : ''}</span><div class="pr8-actions">${listing.ownerId === me?.id ? `<button data-pr8-market-status="${esc8(listing.id)}">Update status</button>` : `<button class="primary" data-pr8-market-contact="${esc8(listing.id)}">Message seller</button>`}</div></article>`).join('');
  }

  async function listingModal8() {
    const modal = ensureModal8();
    modal.innerHTML = `<form class="pr8-modal-card pr8-form" id="pr8-market-form"><div class="pr8-card-head"><div><span class="kicker">Campus exchange</span><h2>New listing</h2></div><button type="button" class="pr8-close" data-pr8-close>×</button></div><div class="row"><label>Type<select name="type"><option value="sell">Sell</option><option value="buy">Buy</option><option value="borrow">Borrow</option><option value="giveaway">Give away</option></select></label><label>Price (INR)<input name="price" type="number" min="0"></label></div><label>Title<input name="title" maxlength="100" required></label><label>Description<textarea name="description" maxlength="1000" required></textarea></label><div class="row"><label>Category<input name="category" maxlength="60"></label><label>Condition<input name="condition" maxlength="60"></label></div><label>Location<input name="location" maxlength="120"></label><label>Optional image<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label><button class="button primary">Publish listing</button></form>`;
    modal.hidden = false;
    $8('#pr8-market-form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const imageFile = form.image.files[0];
        const image = imageFile ? await compressImage8(imageFile) : null;
        await api8('/api/marketplace', { method: 'POST', body: JSON.stringify({ type: form.type.value, priceInr: form.price.value, title: form.title.value, description: form.description.value, category: form.category.value, condition: form.condition.value, location: form.location.value, image }) });
        modal.hidden = true;
        toast8('Listing published.');
        renderMarketplace8();
      } catch (error) { toast8(error.message, 'error'); }
    };
  }

  async function renderLostFound8() {
    const data = await api8('/api/lost-found');
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Help things get home', 'Lost & Found', 'Report lost or found items, then use DMs to arrange a return.', '<button class="button primary" id="pr8-lost-new">Report item</button>')}<div class="pr8-grid">${lostCards8(data.items)}</div>`;
    $8('#pr8-lost-new').onclick = () => lostModal8();
  }

  function lostCards8(items) {
    if (!items.length) return empty8('Nothing active', 'No lost or found reports right now.');
    return items.map(item => `<article class="pr8-card">${item.image ? `<img class="pr8-list-image" src="${esc8(item.image.src)}" alt="">` : ''}<div class="pr8-card-head"><div><span class="pr8-badge ${item.status === 'found' ? 'blue' : 'yellow'}">${esc8(item.status)}</span><h3>${esc8(item.name)}</h3></div><span class="pr8-muted">${date8(item.occurredOn)}</span></div><p>${esc8(item.description)}</p><span class="pr8-muted">${esc8(item.location || 'Campus')} · reported by @${esc8(item.reporter?.username || '')}</span><div class="pr8-actions">${item.reporterId === me?.id ? `<button data-pr8-lost-returned="${esc8(item.id)}">Mark returned</button>` : `<button class="primary" data-pr8-lost-contact="${esc8(item.id)}">Contact reporter</button>`}</div></article>`).join('');
  }

  function lostModal8() {
    const modal = ensureModal8();
    modal.innerHTML = `<form class="pr8-modal-card pr8-form" id="pr8-lost-form"><div class="pr8-card-head"><div><span class="kicker">Lost & Found</span><h2>Report an item</h2></div><button type="button" class="pr8-close" data-pr8-close>×</button></div><div class="row"><label>Status<select name="status"><option value="lost">Lost</option><option value="found">Found</option></select></label><label>Date<input name="occurred" type="date" required></label></div><label>Item name<input name="name" maxlength="100" required></label><label>Description<textarea name="description" maxlength="1000" required></textarea></label><label>Approximate location<input name="location" maxlength="120"></label><label>Optional image<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label><button class="button primary">Publish report</button></form>`;
    modal.hidden = false;
    const occurred = $8('[name="occurred"]', modal);
    occurred.value = new Date().toISOString().slice(0, 10);
    $8('#pr8-lost-form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const imageFile = form.image.files[0];
        const image = imageFile ? await compressImage8(imageFile) : null;
        await api8('/api/lost-found', { method: 'POST', body: JSON.stringify({ status: form.status.value, occurredOn: form.occurred.value, name: form.name.value, description: form.description.value, location: form.location.value, image }) });
        modal.hidden = true;
        toast8('Report published.');
        renderLostFound8();
      } catch (error) { toast8(error.message, 'error'); }
    };
  }

  async function renderQa8() {
    const data = await api8('/api/questions');
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Ask campus', 'Campus Q&A', 'Questions can be anonymous to campus. Answers are always attributed.', '<button class="button primary" id="pr8-ask">Ask a question</button>')}<div class="pr8-stack">${data.questions.map(question => `<article class="pr8-card"><div class="pr8-card-head"><div><h3>${esc8(question.title)}</h3><span class="pr8-muted">${question.anonymous ? 'Anonymous' : `@${esc8(question.author?.username || '')}`} · ${question.answerCount} answers</span></div>${question.acceptedAnswerId ? '<span class="pr8-badge blue">Answered</span>' : ''}</div><p>${richText8(question.body)}</p><div class="pr8-actions"><button class="primary" data-pr8-question="${esc8(question.id)}">Open question</button></div></article>`).join('') || empty8('No questions yet', 'Ask the first campus question.')}</div>`;
    $8('#pr8-ask').onclick = () => questionModal8();
  }

  function questionModal8() {
    const modal = ensureModal8();
    modal.innerHTML = `<form class="pr8-modal-card pr8-form" id="pr8-question-form"><div class="pr8-card-head"><div><span class="kicker">Campus Q&A</span><h2>Ask a question</h2></div><button type="button" class="pr8-close" data-pr8-close>×</button></div><label>Title<input name="title" maxlength="140" required></label><label>Details<textarea name="body" maxlength="2400" required></textarea></label><label><span><input name="anonymous" type="checkbox"> Post anonymously to campus</span></label><button class="button primary">Post question</button></form>`;
    modal.hidden = false;
    $8('#pr8-question-form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api8('/api/questions', { method: 'POST', body: JSON.stringify({ title: form.title.value, body: form.body.value, anonymous: form.anonymous.checked }) });
        modal.hidden = true;
        toast8('Question posted.');
        renderQa8();
      } catch (error) { toast8(error.message, 'error'); }
    };
  }

  async function openQuestion8(questionId) {
    const data = await api8(`/api/questions/${encodeURIComponent(questionId)}`);
    const question = data.question;
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><div><span class="kicker">Campus Q&A</span><h2>${esc8(question.title)}</h2></div><button class="pr8-close" data-pr8-close>×</button></div><p>${richText8(question.body)}</p><span class="pr8-muted">${question.anonymous ? 'Anonymous question' : `Asked by @${esc8(question.author?.username || '')}`}</span><div class="pr8-stack" style="margin-top:18px">${question.answers.map(answer => `<article class="pr8-card ${answer.accepted ? 'pr8-accepted' : ''}"><div class="pr8-card-head"><b>@${esc8(answer.author.username)}</b>${answer.accepted ? '<span class="pr8-badge blue">Accepted</span>' : ''}</div><p>${richText8(answer.body)}</p><div class="pr8-actions"><button data-pr8-answer-vote="${esc8(answer.id)}">▲ ${answer.votes}</button>${question.mine && !answer.accepted ? `<button data-pr8-answer-accept="${esc8(answer.id)}" data-question="${esc8(question.id)}">Accept answer</button>` : ''}</div></article>`).join('') || '<span class="pr8-muted">No answers yet.</span>'}</div><form class="pr8-form" id="pr8-answer-form" style="margin-top:18px"><label>Your answer<textarea maxlength="2400" required></textarea></label><button class="button primary">Post answer</button></form></div>`;
    modal.hidden = false;
    $8('#pr8-answer-form').onsubmit = async event => {
      event.preventDefault();
      const textarea = $8('textarea', event.currentTarget);
      try {
        await api8(`/api/questions/${encodeURIComponent(question.id)}/answers`, { method: 'POST', body: JSON.stringify({ body: textarea.value }) });
        await openQuestion8(question.id);
      } catch (error) { toast8(error.message, 'error'); }
    };
  }

  async function renderCollections8() {
    const data = await api8('/api/bookmark-collections');
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Saved for later', 'Bookmark collections', 'Organize saved posts into your own collections.', '<button class="button primary" id="pr8-collection-new">New collection</button>')}<div class="pr8-grid">${data.collections.map(collection => `<article class="pr8-card"><div class="pr8-card-head"><div><h3>${esc8(collection.name)}</h3><span class="pr8-muted">${collection.itemCount} post${collection.itemCount === 1 ? '' : 's'}</span></div><button class="text-button" data-pr8-collection-delete="${esc8(collection.id)}">Delete</button></div></article>`).join('') || empty8('No collections', 'Create one, then add posts from the feed.')}</div>`;
    $8('#pr8-collection-new').onclick = async () => {
      const name = prompt('Collection name');
      if (!name?.trim()) return;
      try {
        await api8('/api/bookmark-collections', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
        renderCollections8();
      } catch (error) { toast8(error.message, 'error'); }
    };
  }

  async function renderDiscover8() {
    const [people, clubs, projects, trending] = await Promise.all([
      api8('/api/discovery/people'),
      api8('/api/discovery/clubs'),
      api8('/api/discovery/projects'),
      api8('/api/trending')
    ]);
    const view = $8('#view');
    view.innerHTML = `${pageHead8('Made for you', 'Discover', 'Explainable recommendations based on your campus interests, skills, memberships, and connections.')}<section class="pr8-section-title"><h2>People</h2></section><div class="pr8-grid">${people.items.slice(0, 6).map(item => `<article class="pr8-card"><div class="person-row">${avatar8(item.user)}<div><b>${esc8(item.user.name)}</b><span>@${esc8(item.user.username)}</span></div></div><p>${esc8(item.reason)}</p><div class="pr8-actions"><button data-pr8-profile="${esc8(item.user.username)}">View profile</button></div></article>`).join('') || empty8('No people suggestions', 'Add interests and skills to improve recommendations.')}</div><section class="pr8-section-title"><h2>Projects</h2></section><div class="pr8-grid">${projects.items.slice(0, 6).map(item => `<article class="pr8-card"><h3>${esc8(item.name)}</h3><p>${esc8(item.pitch)}</p><span class="pr8-muted">${esc8(item.reason)}</span></article>`).join('') || empty8('No project suggestions', 'Your skills will drive these suggestions.')}</div><section class="pr8-section-title"><h2>Clubs</h2></section><div class="pr8-grid">${clubs.items.slice(0, 6).map(item => `<article class="pr8-card"><h3>${esc8(item.name)}</h3><p>${esc8(item.description)}</p><span class="pr8-muted">${esc8(item.reason)}</span></article>`).join('') || empty8('No club suggestions', 'Join communities and add interests to improve matches.')}</div><section class="pr8-section-title"><h2>Trending this week</h2></section><div class="pr8-skill-list">${trending.items.map(item => `<button class="pr8-chip" data-pr8-tag="${esc8(item.tag)}">#${esc8(item.tag)} · ${item.uses}</button>`).join('') || '<span class="pr8-muted">No hashtag trends yet.</span>'}</div>`;
  }

  async function showHashtag8(tag) {
    const data = await api8(`/api/hashtags/${encodeURIComponent(tag)}`);
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><div><span class="kicker">Hashtag</span><h2>#${esc8(data.tag)}</h2></div><button class="pr8-close" data-pr8-close>×</button></div><h3>Posts</h3><div class="pr8-stack">${data.posts.map(postCard8).join('') || '<span class="pr8-muted">No posts.</span>'}</div><h3>Projects</h3><div class="pr8-skill-list">${data.projects.map(item => `<span class="pr8-badge">${esc8(item.name)}</span>`).join('') || '<span class="pr8-muted">None.</span>'}</div><h3>Clubs</h3><div class="pr8-skill-list">${data.clubs.map(item => `<span class="pr8-badge">${esc8(item.name)}</span>`).join('') || '<span class="pr8-muted">None.</span>'}</div><h3>Events</h3><div class="pr8-stack">${data.events.map(item => `<div class="pr8-card"><b>${esc8(item.title)}</b><span class="pr8-muted">${date8(item.starts_at)}</span></div>`).join('') || '<span class="pr8-muted">None.</span>'}</div></div>`;
    modal.hidden = false;
  }

  function ensureModal8() {
    let modal = $8('#pr8-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'pr8-modal';
      modal.className = 'pr8-modal';
      modal.hidden = true;
      document.body.append(modal);
    }
    return modal;
  }

  function bindDialogOpeners8() {
    $$8('[data-open]').forEach(button => {
      if (button.dataset.pr8Bound) return;
      button.dataset.pr8Bound = '1';
      button.addEventListener('click', () => {
        const dialog = $8(`#${button.dataset.open}`);
        if (dialog && !dialog.open) dialog.showModal();
      });
    });
  }

  function installSearch8() {
    const form = $8('#global-search');
    const input = $8('#global-search-input');
    if (!form || !input || $8('#pr8-search-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'pr8-search-panel';
    panel.className = 'pr8-search-panel';
    panel.hidden = true;
    panel.innerHTML = `<div class="pr8-search-tabs">${['all', 'people', 'posts', 'clubs', 'projects', 'events', 'marketplace', 'lostfound'].map(type => `<button data-pr8-search-type="${type}" class="${type === 'all' ? 'active' : ''}">${type === 'lostfound' ? 'Lost & Found' : type[0].toUpperCase() + type.slice(1)}</button>`).join('')}</div><div id="pr8-search-results"></div>`;
    document.body.append(panel);
    form.onsubmit = event => {
      event.preventDefault();
      runSearch8(input.value);
    };
    input.placeholder = 'Search campus…';
    input.addEventListener('focus', () => { if (input.value.trim()) runSearch8(input.value); });
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch8(input.value), 180);
    });
    $$8('[data-pr8-search-type]', panel).forEach(button => button.onclick = () => {
      searchType = button.dataset.pr8SearchType;
      $$8('[data-pr8-search-type]', panel).forEach(item => item.classList.toggle('active', item === button));
      runSearch8(input.value);
    });
    document.addEventListener('click', event => {
      if (!panel.contains(event.target) && !form.contains(event.target)) panel.hidden = true;
    });
  }

  async function runSearch8(query) {
    const panel = $8('#pr8-search-panel');
    const results = $8('#pr8-search-results');
    if (!panel || !results) return;
    if (!query.trim()) { panel.hidden = true; return; }
    panel.hidden = false;
    results.innerHTML = '<div class="pr8-loading">Searching…</div>';
    try {
      const data = await api8(`/api/search?q=${encodeURIComponent(query.trim())}&type=${encodeURIComponent(searchType)}`);
      results.innerHTML = data.items.length ? data.items.map(item => `<button class="pr8-search-result" data-pr8-search-route="${esc8(item.route)}"><span class="pr8-badge">${esc8(item.type)}</span><span><b>${esc8(item.title)}</b><span>${esc8(item.subtitle)}</span><span>${esc8(item.snippet)}</span></span></button>`).join('') : '<div class="pr8-empty">No matches.</div>';
      $$8('[data-pr8-search-route]', results).forEach(button => button.onclick = () => openSearchResult8(button.dataset.pr8SearchRoute));
    } catch (error) { results.innerHTML = `<div class="pr8-empty">${esc8(error.message)}</div>`; }
  }

  async function openSearchResult8(route) {
    $8('#pr8-search-panel').hidden = true;
    if (route.startsWith('profile/')) return navigate8('profile', { username: decodeURIComponent(route.slice(8)) });
    if (route.startsWith('post:')) {
      const data = await api8(`/api/posts/${encodeURIComponent(route.slice(5))}`);
      const modal = ensureModal8();
      modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><h2>Campus post</h2><button class="pr8-close" data-pr8-close>×</button></div>${postCard8(data.post)}</div>`;
      modal.hidden = false;
      return;
    }
    if (managedRoutes.has(route)) return navigate8(route);
    return window.navigate(route);
  }

  function installComposer8() {
    const form = $8('#post-form');
    if (!form || $8('#pr8-composer-controls')) return;
    const postTypes = $8('.post-types', form);
    const extra = document.createElement('div');
    extra.id = 'pr8-composer-controls';
    extra.innerHTML = `<div class="pr8-toolbar"><button type="button" id="pr8-poll-toggle">＋ Poll</button><label class="pr8-chip">＋ Images<input id="pr8-post-images" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden></label></div><div class="pr8-file-note" id="pr8-image-note">Up to 4 images. Images are compressed before upload.</div><div class="pr8-composer-extra" id="pr8-poll-fields" hidden><label>Poll options <small>one per line</small><textarea id="pr8-poll-options" maxlength="1000" placeholder="Option one\nOption two"></textarea></label><div class="two-fields"><label>Choice type<select id="pr8-poll-mode"><option value="single">Single choice</option><option value="multiple">Multiple choice</option></select></label><label>Vote visibility<select id="pr8-poll-visibility"><option value="anonymous">Anonymous</option><option value="public">Public voters</option></select></label></div><label>Voting closes<input id="pr8-poll-expiry" type="datetime-local"></label></div>`;
    postTypes?.after(extra);
    $8('#pr8-poll-toggle').onclick = event => {
      const fields = $8('#pr8-poll-fields');
      fields.hidden = !fields.hidden;
      event.currentTarget.classList.toggle('active', !fields.hidden);
      if (!fields.hidden && !$8('#pr8-poll-expiry').value) {
        const tomorrow = new Date(Date.now() + 86400000);
        tomorrow.setMinutes(tomorrow.getMinutes() - tomorrow.getTimezoneOffset());
        $8('#pr8-poll-expiry').value = tomorrow.toISOString().slice(0, 16);
      }
    };
    $8('#pr8-post-images').onchange = event => {
      const files = [...event.target.files].slice(0, 4);
      if (event.target.files.length > 4) toast8('Only the first 4 images will be used.', 'error');
      $8('#pr8-image-note').textContent = files.length ? `${files.length} image${files.length === 1 ? '' : 's'} selected.` : 'Up to 4 images. Images are compressed before upload.';
    };
    form.addEventListener('submit', submitPost8, true);
  }

  async function submitPost8(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const form = event.currentTarget;
    const body = $8('#post-body').value.trim();
    if (!body) return toast8('Write something before publishing.', 'error');
    const pollEnabled = !$8('#pr8-poll-fields').hidden;
    const tags = $8('#post-tags').value.split(',').map(item => item.trim().replace(/^#/, '')).filter(Boolean);
    const type = pollEnabled ? 'poll' : ($8('.post-types .active')?.dataset.postType || 'post');
    const payload = { body, type, tags };
    if (pollEnabled) {
      payload.poll = {
        options: $8('#pr8-poll-options').value.split('\n').map(item => item.trim()).filter(Boolean),
        choiceMode: $8('#pr8-poll-mode').value,
        voterVisibility: $8('#pr8-poll-visibility').value,
        expiresAt: new Date($8('#pr8-poll-expiry').value).toISOString()
      };
    }
    try {
      const created = await api8('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
      const files = [...$8('#pr8-post-images').files].slice(0, 4);
      if (files.length) {
        const images = [];
        for (const file of files) images.push(await compressImage8(file));
        await api8(`/api/posts/${encodeURIComponent(created.post.id)}/media`, { method: 'PUT', body: JSON.stringify({ images }) });
      }
      form.reset();
      $8('#pr8-poll-fields').hidden = true;
      $8('#pr8-poll-toggle').classList.remove('active');
      $8('#pr8-image-note').textContent = 'Up to 4 images. Images are compressed before upload.';
      form.closest('dialog')?.close();
      toast8('Published.');
      activeRoute = null;
      await coreNavigate?.('feed');
    } catch (error) { toast8(error.message, 'error'); }
  }

  async function compressImage8(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Use PNG, JPEG, or WebP images.');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    let quality = 0.82;
    let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    while (blob && blob.size > 340000 && quality > 0.42) {
      quality -= 0.1;
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    }
    if (!blob || blob.size > 350000) throw new Error('This image is still too large after compression.');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read image.'));
      reader.readAsDataURL(blob);
    });
    return { data, width, height };
  }

  function installDelegation8() {
    document.addEventListener('click', async event => {
      const target = event.target.closest('[data-pr8-close],[data-pr8-profile],[data-pr8-tag],[data-pr8-poll-option],[data-pr8-collection],[data-pr8-pin-profile],[data-pr8-project-apply],[data-pr8-project-leave],[data-pr8-project-apps],[data-pr8-project-team],[data-pr8-project-update],[data-pr8-club-join],[data-pr8-club-leave],[data-pr8-club-mode],[data-pr8-club-requests],[data-pr8-club-invite],[data-pr8-club-team],[data-pr8-club-event],[data-pr8-rsvp],[data-pr8-reminder],[data-pr8-reminder-remove],[data-pr8-message-user],[data-pr8-mute-user],[data-pr8-block-user],[data-pr8-edit-skills],[data-pr8-toggle-available],[data-pr8-notifications],[data-pr8-push],[data-pr8-market-contact],[data-pr8-market-status],[data-pr8-lost-contact],[data-pr8-lost-returned],[data-pr8-question],[data-pr8-answer-vote],[data-pr8-answer-accept],[data-pr8-collection-delete],[data-pr8-lightbox]');
      if (!target) return;
      try {
        if (target.hasAttribute('data-pr8-close')) { ensureModal8().hidden = true; return; }
        if (target.dataset.pr8Profile) return navigate8('profile', { username: target.dataset.pr8Profile });
        if (target.dataset.pr8Tag) return showHashtag8(target.dataset.pr8Tag);
        if (target.dataset.pr8Lightbox) return lightbox8(target.dataset.pr8Lightbox);
        if (target.dataset.pr8PollOption) return votePoll8(target.dataset.pr8Poll, target.dataset.pr8PollOption);
        if (target.dataset.pr8Collection) return addToCollection8(target.dataset.pr8Collection);
        if (target.dataset.pr8PinProfile) return pinProfilePost8(target.dataset.pr8PinProfile);
        if (target.dataset.pr8ProjectApply) return applyProject8(target.dataset.pr8ProjectApply);
        if (target.dataset.pr8ProjectLeave) return leaveProject8(target.dataset.pr8ProjectLeave);
        if (target.dataset.pr8ProjectApps) return projectApplications8(target.dataset.pr8ProjectApps);
        if (target.dataset.pr8ProjectTeam) return projectTeam8(target.dataset.pr8ProjectTeam);
        if (target.dataset.pr8ProjectUpdate) return projectUpdate8(target.dataset.pr8ProjectUpdate);
        if (target.dataset.pr8ClubJoin) return joinClub8(target.dataset.pr8ClubJoin, target.dataset.mode);
        if (target.dataset.pr8ClubLeave) return leaveClub8(target.dataset.pr8ClubLeave);
        if (target.dataset.pr8ClubMode) return clubMode8(target.dataset.pr8ClubMode);
        if (target.dataset.pr8ClubRequests) return clubRequests8(target.dataset.pr8ClubRequests);
        if (target.dataset.pr8ClubInvite) return clubInvite8(target.dataset.pr8ClubInvite);
        if (target.dataset.pr8ClubTeam) return clubTeam8(target.dataset.pr8ClubTeam);
        if (target.dataset.pr8ClubEvent) return clubEvent8(target.dataset.pr8ClubEvent);
        if (target.dataset.pr8Rsvp) return rsvp8(target.dataset.pr8Rsvp);
        if (target.dataset.pr8Reminder) return reminder8(target.dataset.pr8Reminder, Number(target.dataset.minutes));
        if (target.dataset.pr8ReminderRemove) return removeReminder8(target.dataset.pr8ReminderRemove);
        if (target.dataset.pr8MessageUser) return messageUser8(target.dataset.pr8MessageUser);
        if (target.dataset.pr8MuteUser) return muteUser8(target.dataset.pr8MuteUser);
        if (target.dataset.pr8BlockUser) return blockUser8(target.dataset.pr8BlockUser);
        if (target.hasAttribute('data-pr8-edit-skills')) return editSkills8();
        if (target.hasAttribute('data-pr8-toggle-available')) return toggleAvailability8();
        if (target.hasAttribute('data-pr8-notifications')) return notificationSettings8();
        if (target.hasAttribute('data-pr8-push')) return enablePush8();
        if (target.dataset.pr8MarketContact) return contactListing8(target.dataset.pr8MarketContact);
        if (target.dataset.pr8MarketStatus) return marketStatus8(target.dataset.pr8MarketStatus);
        if (target.dataset.pr8LostContact) return contactLost8(target.dataset.pr8LostContact);
        if (target.dataset.pr8LostReturned) return markReturned8(target.dataset.pr8LostReturned);
        if (target.dataset.pr8Question) return openQuestion8(target.dataset.pr8Question);
        if (target.dataset.pr8AnswerVote) return voteAnswer8(target.dataset.pr8AnswerVote);
        if (target.dataset.pr8AnswerAccept) return acceptAnswer8(target.dataset.question, target.dataset.pr8AnswerAccept);
        if (target.dataset.pr8CollectionDelete) return deleteCollection8(target.dataset.pr8CollectionDelete);
      } catch (error) { toast8(error.message, 'error'); }
    });
  }

  async function votePoll8(pollId, optionId) {
    const poll = await api8(`/api/polls/${encodeURIComponent(pollId)}`);
    let optionIds = [optionId];
    if (poll.poll.choiceMode === 'multiple') {
      const selected = new Set(poll.poll.options.filter(option => option.selected).map(option => option.id));
      if (selected.has(optionId)) selected.delete(optionId); else selected.add(optionId);
      optionIds = [...selected];
      if (!optionIds.length) optionIds = [optionId];
    }
    await api8(`/api/polls/${encodeURIComponent(pollId)}/vote`, { method: 'POST', body: JSON.stringify({ optionIds }) });
    if (activeRoute) await renderRoute8(activeRoute); else await coreRefreshCurrent?.();
  }

  async function addToCollection8(postId) {
    let data = await api8('/api/bookmark-collections');
    if (!data.collections.length) {
      const name = prompt('Create a collection name');
      if (!name?.trim()) return;
      const created = await api8('/api/bookmark-collections', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      data = { collections: [created.collection] };
    }
    const names = data.collections.map((collection, index) => `${index + 1}. ${collection.name}`).join('\n');
    const pick = Number(prompt(`Choose a collection:\n${names}`));
    const collection = data.collections[pick - 1];
    if (!collection) return;
    await api8(`/api/bookmark-collections/${encodeURIComponent(collection.id)}/posts/${encodeURIComponent(postId)}`, { method: 'PUT', body: '{}' });
    toast8(`Saved to ${collection.name}.`);
  }

  async function pinProfilePost8(postId) {
    if (!me) return;
    await api8(`/api/pins/profile/${encodeURIComponent(me.id)}`, { method: 'PUT', body: JSON.stringify({ postId }) });
    toast8('Pinned to your profile.');
  }

  async function applyProject8(projectId) {
    const message = prompt('Short application message (up to 300 characters)');
    if (!message?.trim()) return;
    await api8(`/api/projects/${encodeURIComponent(projectId)}/join`, { method: 'POST', body: JSON.stringify({ message: message.trim().slice(0, 300) }) });
    toast8('Application sent.');
    renderProjects8();
  }

  async function leaveProject8(projectId) {
    if (!confirm('Leave this project?')) return;
    await api8(`/api/projects/${encodeURIComponent(projectId)}/join`, { method: 'POST', body: '{}' });
    renderProjects8();
  }

  async function projectApplications8(projectId) {
    const data = await api8(`/api/projects/${encodeURIComponent(projectId)}/applications`);
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><h2>Applications</h2><button class="pr8-close" data-pr8-close>×</button></div><div class="pr8-stack">${data.applications.map(application => `<article class="pr8-card"><b>@${esc8(application.user.username)}</b><p>${esc8(application.message)}</p><div class="pr8-actions"><button class="primary" data-pr8-project-review="accepted" data-project="${esc8(projectId)}" data-application="${esc8(application.id)}">Accept</button><button data-pr8-project-review="rejected" data-project="${esc8(projectId)}" data-application="${esc8(application.id)}">Reject</button></div></article>`).join('') || '<span class="pr8-muted">No pending applications.</span>'}</div></div>`;
    modal.hidden = false;
    $$8('[data-pr8-project-review]', modal).forEach(button => button.onclick = async () => {
      await api8(`/api/projects/${encodeURIComponent(button.dataset.project)}/applications/${encodeURIComponent(button.dataset.application)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.pr8ProjectReview }) });
      projectApplications8(projectId);
      renderProjects8();
    });
  }

  async function projectTeam8(projectId) {
    const data = await api8(`/api/projects/${encodeURIComponent(projectId)}/members`);
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><h2>Project team</h2><button class="pr8-close" data-pr8-close>×</button></div><div class="pr8-stack">${data.members.map(member => `<div class="pr8-card"><div class="person-row">${avatar8(member)}<div><b>${esc8(member.name)}</b><span>@${esc8(member.username)}</span></div></div><div class="pr8-actions"><select data-pr8-project-role="${esc8(member.id)}"><option ${member.projectRole === 'Member' ? 'selected' : ''}>Member</option><option ${member.projectRole === 'Developer' ? 'selected' : ''}>Developer</option><option ${member.projectRole === 'Designer' ? 'selected' : ''}>Designer</option><option ${member.projectRole === 'Researcher' ? 'selected' : ''}>Researcher</option></select></div></div>`).join('')}</div></div>`;
    modal.hidden = false;
    $$8('[data-pr8-project-role]', modal).forEach(select => select.onchange = async () => {
      await api8(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(select.dataset.pr8ProjectRole)}/role`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
      toast8('Project role updated.');
    });
  }

  async function projectUpdate8(projectId) {
    const body = prompt('Project update');
    if (!body?.trim()) return;
    await api8('/api/posts', { method: 'POST', body: JSON.stringify({ body: body.trim(), type: 'update', tags: [], context: { type: 'project', id: projectId } }) });
    toast8('Project update posted.');
  }

  async function joinClub8(clubId, mode) {
    if (mode === 'invite') {
      await api8(`/api/clubs/${encodeURIComponent(clubId)}/join`, { method: 'POST', body: '{}' });
    } else if (mode === 'approval') {
      const message = prompt('Short join message (up to 300 characters)');
      if (!message?.trim()) return;
      await api8(`/api/clubs/${encodeURIComponent(clubId)}/join`, { method: 'POST', body: JSON.stringify({ message: message.trim().slice(0, 300) }) });
      toast8('Join request sent.');
    } else {
      await api8(`/api/clubs/${encodeURIComponent(clubId)}/join`, { method: 'POST', body: '{}' });
      toast8('Joined club.');
    }
    renderClubs8();
  }

  async function leaveClub8(clubId) {
    if (!confirm('Leave this club?')) return;
    await api8(`/api/clubs/${encodeURIComponent(clubId)}/join`, { method: 'POST', body: '{}' });
    renderClubs8();
  }

  async function clubMode8(clubId) {
    const mode = prompt('Join mode: open, approval, or invite', 'approval')?.trim().toLowerCase();
    if (!['open', 'approval', 'invite'].includes(mode)) return;
    await api8(`/api/clubs/${encodeURIComponent(clubId)}/join-settings`, { method: 'PATCH', body: JSON.stringify({ mode }) });
    toast8('Join settings updated.');
    renderClubs8();
  }

  async function clubRequests8(clubId) {
    const data = await api8(`/api/clubs/${encodeURIComponent(clubId)}/requests`);
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><h2>Join requests</h2><button class="pr8-close" data-pr8-close>×</button></div><div class="pr8-stack">${data.requests.map(request => `<article class="pr8-card"><b>@${esc8(request.user.username)}</b><p>${esc8(request.message)}</p><div class="pr8-actions"><button class="primary" data-pr8-club-review="accepted" data-club="${esc8(clubId)}" data-request="${esc8(request.id)}">Accept</button><button data-pr8-club-review="rejected" data-club="${esc8(clubId)}" data-request="${esc8(request.id)}">Reject</button></div></article>`).join('') || '<span class="pr8-muted">No pending requests.</span>'}</div></div>`;
    modal.hidden = false;
    $$8('[data-pr8-club-review]', modal).forEach(button => button.onclick = async () => {
      await api8(`/api/clubs/${encodeURIComponent(button.dataset.club)}/requests/${encodeURIComponent(button.dataset.request)}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.pr8ClubReview }) });
      clubRequests8(clubId);
      renderClubs8();
    });
  }

  async function clubInvite8(clubId) {
    const username = prompt('Username to invite');
    if (!username?.trim()) return;
    await api8(`/api/clubs/${encodeURIComponent(clubId)}/invites`, { method: 'POST', body: JSON.stringify({ username: username.trim() }) });
    toast8('Invite sent.');
  }

  async function clubTeam8(clubId) {
    const data = await api8(`/api/clubs/${encodeURIComponent(clubId)}/members`);
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><h2>Club roles</h2><button class="pr8-close" data-pr8-close>×</button></div><div class="pr8-stack">${data.members.map(member => `<div class="pr8-card"><div class="person-row">${avatar8(member)}<div><b>${esc8(member.name)}</b><span>@${esc8(member.username)}</span></div></div><select data-pr8-club-role="${esc8(member.id)}" ${member.clubRole === 'Owner' ? 'disabled' : ''}><option ${member.clubRole === 'Member' ? 'selected' : ''}>Member</option><option ${member.clubRole === 'Moderator' ? 'selected' : ''}>Moderator</option><option ${member.clubRole === 'Admin' ? 'selected' : ''}>Admin</option><option ${member.clubRole === 'Owner' ? 'selected' : ''}>Owner</option></select></div>`).join('')}</div></div>`;
    modal.hidden = false;
    $$8('[data-pr8-club-role]', modal).forEach(select => select.onchange = async () => {
      await api8(`/api/clubs/${encodeURIComponent(clubId)}/members/${encodeURIComponent(select.dataset.pr8ClubRole)}/role`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
      toast8('Club role updated.');
    });
  }

  async function clubEvent8(clubId) {
    const title = prompt('Event title');
    if (!title?.trim()) return;
    const startsAt = prompt('Start time (example: 2026-08-30T17:00)');
    if (!startsAt) return;
    const location = prompt('Location') || '';
    await api8(`/api/clubs/${encodeURIComponent(clubId)}/events`, { method: 'POST', body: JSON.stringify({ title: title.trim(), startsAt, location, description: '', capacity: 100 }) });
    toast8('Club event created.');
  }

  async function rsvp8(eventId) {
    await api8(`/api/events/${encodeURIComponent(eventId)}/rsvp`, { method: 'POST', body: '{}' });
    ensureModal8().hidden = true;
    renderEvents8();
  }

  async function reminder8(eventId, minutesBefore) {
    await api8(`/api/events/${encodeURIComponent(eventId)}/reminder`, { method: 'PUT', body: JSON.stringify({ minutesBefore }) });
    toast8('Event reminder set.');
  }

  async function removeReminder8(eventId) {
    await api8(`/api/events/${encodeURIComponent(eventId)}/reminder`, { method: 'DELETE', body: '{}' });
    toast8('Reminder removed.');
  }

  async function messageUser8(username) {
    const data = await api8('/api/dm/conversations', { method: 'POST', body: JSON.stringify({ username }) });
    activeConversationId = data.conversation.id;
    navigate8('messages');
  }

  async function muteUser8(userId) {
    await api8('/api/safety/mutes', { method: 'PATCH', body: JSON.stringify({ targetType: 'user', targetId: userId, muted: true }) });
    toast8('User muted from your feed.');
  }

  async function blockUser8(userId) {
    if (!confirm('Block this user?')) return;
    await api8(`/api/safety/blocks/${encodeURIComponent(userId)}`, { method: 'PUT', body: '{}' });
    toast8('User blocked.');
    activeProfileUsername = me.username;
    navigate8('profile');
  }

  async function editSkills8() {
    const current = await api8('/api/profile/skills');
    const value = prompt('Skills, comma separated', current.skills.join(', '));
    if (value == null) return;
    await api8('/api/profile/skills', { method: 'PATCH', body: JSON.stringify({ skills: value.split(',').map(item => item.trim()).filter(Boolean) }) });
    renderProfile8(me.username);
  }

  async function toggleAvailability8() {
    const current = await api8('/api/profile/preferences');
    await api8('/api/profile/preferences', { method: 'PATCH', body: JSON.stringify({ availableForProjects: !current.availableForProjects }) });
    renderProfile8(me.username);
  }

  async function notificationSettings8() {
    const data = await api8('/api/notification-preferences');
    const modal = ensureModal8();
    modal.innerHTML = `<form class="pr8-modal-card pr8-form" id="pr8-notification-form"><div class="pr8-card-head"><h2>Notification settings</h2><button type="button" class="pr8-close" data-pr8-close>×</button></div>${Object.entries(data.preferences).map(([key, enabled]) => `<label><span><input type="checkbox" name="${esc8(key)}" ${enabled ? 'checked' : ''}> ${esc8(key)}</span></label>`).join('')}<button class="button primary">Save settings</button></form>`;
    modal.hidden = false;
    $8('#pr8-notification-form').onsubmit = async event => {
      event.preventDefault();
      const payload = {};
      Object.keys(data.preferences).forEach(key => payload[key] = event.currentTarget.elements[key].checked);
      await api8('/api/notification-preferences', { method: 'PATCH', body: JSON.stringify(payload) });
      modal.hidden = true;
      toast8('Notification settings saved.');
    };
  }

  function b64ToUint8Array8(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
  }

  async function enablePush8() {
    const config = await api8('/api/push/config');
    if (!config.enabled) return toast8('Push is not configured on this deployment. In-app notifications still work.', 'error');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast8('This browser does not support push notifications.', 'error');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return toast8('Push permission was not granted.', 'error');
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8Array8(config.publicKey) });
    const json = subscription.toJSON();
    await api8('/api/push/subscriptions', { method: 'POST', body: JSON.stringify(json) });
    toast8('Push notifications enabled.');
  }

  async function contactListing8(listingId) {
    const data = await api8(`/api/marketplace/${encodeURIComponent(listingId)}/contact`, { method: 'POST', body: '{}' });
    activeConversationId = data.conversationId;
    navigate8('messages');
  }

  async function marketStatus8(listingId) {
    const status = prompt('Status: active, reserved, sold, closed', 'sold')?.trim().toLowerCase();
    if (!['active', 'reserved', 'sold', 'closed'].includes(status)) return;
    await api8(`/api/marketplace/${encodeURIComponent(listingId)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    renderMarketplace8();
  }

  async function contactLost8(itemId) {
    const data = await api8(`/api/lost-found/${encodeURIComponent(itemId)}/contact`, { method: 'POST', body: '{}' });
    activeConversationId = data.conversationId;
    navigate8('messages');
  }

  async function markReturned8(itemId) {
    await api8(`/api/lost-found/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'returned' }) });
    toast8('Marked returned.');
    renderLostFound8();
  }

  async function voteAnswer8(answerId) {
    await api8(`/api/answers/${encodeURIComponent(answerId)}/vote`, { method: 'POST', body: '{}' });
    const modal = ensureModal8();
    const questionId = $8('[data-question]', modal)?.dataset.question;
    if (questionId) openQuestion8(questionId);
  }

  async function acceptAnswer8(questionId, answerId) {
    await api8(`/api/questions/${encodeURIComponent(questionId)}/accept/${encodeURIComponent(answerId)}`, { method: 'POST', body: '{}' });
    openQuestion8(questionId);
  }

  async function deleteCollection8(collectionId) {
    if (!confirm('Delete this collection? Saved posts stay in your general Saved feed.')) return;
    await api8(`/api/bookmark-collections/${encodeURIComponent(collectionId)}`, { method: 'DELETE', body: '{}' });
    renderCollections8();
  }

  function lightbox8(src) {
    const modal = ensureModal8();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><span></span><button class="pr8-close" data-pr8-close>×</button></div><img src="${esc8(src)}" alt="Post image" style="max-width:100%;max-height:78vh;display:block;margin:auto;border-radius:14px"></div>`;
    modal.hidden = false;
  }

  function showOnboarding8() {
    let overlay = $8('#pr8-onboarding');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pr8-onboarding';
      overlay.className = 'pr8-onboarding';
      document.body.append(overlay);
    }
    overlay.innerHTML = `<form class="pr8-onboarding-card pr8-form" id="pr8-onboarding-form"><span class="kicker">Set up your campus</span><h2>Make CollegeOx useful to you.</h2><p>These details power project availability and recommendations. You can change them later.</p><div class="row"><label>Department<input name="department" maxlength="80"></label><label>Year / role<input name="year" maxlength="40"></label></div><label>Interests <small>comma separated</small><input name="interests" placeholder="Robotics, Music, Design"></label><label>Skills <small>comma separated</small><input name="skills" placeholder="JavaScript, CAD, Research"></label><label><span><input name="available" type="checkbox"> Available for projects</span></label><button class="button primary">Finish setup</button></form>`;
    overlay.hidden = false;
    $8('#pr8-onboarding-form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api8('/api/onboarding/complete', { method: 'POST', body: JSON.stringify({ department: form.department.value, year: form.year.value, interests: form.interests.value.split(',').map(item => item.trim()).filter(Boolean), skills: form.skills.value.split(',').map(item => item.trim()).filter(Boolean), availableForProjects: form.available.checked }) });
        overlay.hidden = true;
        toast8('Campus setup complete.');
        navigate8('discover');
      } catch (error) { toast8(error.message, 'error'); }
    };
  }

  async function signedInSetup8() {
    try {
      const current = await api8('/api/me');
      if (!current.user) return;
      me = current.user;
      if (corePostCard) window.postCard = postCard8;
      const preferences = await api8('/api/profile/preferences');
      if (!preferences.onboardingComplete) showOnboarding8();
      openPr8Stream8();
      refreshDmCount8();
      if (!activeRoute) coreRefreshCurrent?.();
    } catch {}
  }

  function openPr8Stream8() {
    if (pr8Stream || !me) return;
    pr8Stream = new EventSource('/api/pr8/stream');
    pr8Stream.addEventListener('dm_message', event => {
      refreshDmCount8();
      if (activeRoute === 'messages') {
        try {
          const payload = JSON.parse(event.data);
          if (!activeConversationId || payload.conversationId === activeConversationId) renderMessages8();
        } catch {}
      }
    });
    pr8Stream.addEventListener('dm_seen', () => { if (activeRoute === 'messages' && activeConversationId) openConversation8(activeConversationId); });
    pr8Stream.addEventListener('dm_typing', event => {
      try {
        const payload = JSON.parse(event.data);
        if (activeRoute === 'messages' && payload.conversationId === activeConversationId) {
          const line = $8('#pr8-typing');
          if (line) line.textContent = payload.active ? 'Typing…' : '';
        }
      } catch {}
    });
    ['project', 'project_application', 'club', 'club_request', 'club_invite', 'marketplace', 'lost_found', 'question', 'poll_update'].forEach(name => pr8Stream.addEventListener(name, () => {
      if (activeRoute) renderRoute8(activeRoute).catch(() => {});
    }));
    pr8Stream.addEventListener('notification_count', refreshDmCount8);
  }

  function watchSignedInState8() {
    const app = $8('#app');
    if (!app) return;
    const observer = new MutationObserver(() => {
      if (!app.hidden) signedInSetup8();
      else {
        me = null;
        activeRoute = null;
        activeConversationId = null;
        if (pr8Stream) { pr8Stream.close(); pr8Stream = null; }
      }
    });
    observer.observe(app, { attributes: true, attributeFilter: ['hidden'] });
    if (!app.hidden) signedInSetup8();
  }

  function patchCore8() {
    coreNavigate = typeof window.navigate === 'function' ? window.navigate : null;
    coreRefreshCurrent = typeof window.refreshCurrent === 'function' ? window.refreshCurrent : null;
    coreRenderProfile = typeof window.renderProfile === 'function' ? window.renderProfile : null;
    corePostCard = typeof window.postCard === 'function' ? window.postCard : null;
    if (corePostCard) window.postCard = postCard8;
    if (coreNavigate) {
      window.navigate = async route => {
        if (managedRoutes.has(route)) {
          if (route === 'profile' && !activeProfileUsername) activeProfileUsername = me?.username || null;
          return navigate8(route);
        }
        activeRoute = null;
        activeProfileUsername = null;
        return coreNavigate(route);
      };
    }
    if (coreRefreshCurrent) {
      window.refreshCurrent = async () => activeRoute ? renderRoute8(activeRoute) : coreRefreshCurrent();
    }
    if (coreRenderProfile) {
      window.renderProfile = async username => navigate8('profile', { username });
    }
  }

  function installDiscoverShortcut8() {
    const nav = $8('#nav');
    const people = $8('[data-route="people"]', nav);
    if (!nav || !people || $8('[data-pr8-route="discover"]', nav)) return;
    const button = document.createElement('button');
    button.dataset.pr8Route = 'discover';
    button.innerHTML = '<i>✦</i><span>Discover</span>';
    people.after(button);
    button.onclick = () => navigate8('discover');
  }

  function boot8() {
    patchCore8();
    insertNav();
    installDiscoverShortcut8();
    installSearch8();
    installComposer8();
    installDelegation8();
    watchSignedInState8();
    const hash = location.hash.slice(1);
    if (hash.startsWith('profile:')) {
      const username = hash.slice(8);
      setTimeout(() => navigate8('profile', { username }), 0);
    } else if (managedRoutes.has(hash)) {
      setTimeout(() => navigate8(hash), 0);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot8);
  else boot8();
})();
