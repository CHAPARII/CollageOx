(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function toast(message, type = 'success') {
    if (typeof window.toast === 'function') return window.toast(message, type);
    const host = document.querySelector('#toasts');
    if (!host) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    host.append(item);
    setTimeout(() => item.remove(), 3500);
  }

  function modal() {
    let element = document.querySelector('#pr8-modal');
    if (!element) {
      element = document.createElement('div');
      element.id = 'pr8-modal';
      element.className = 'pr8-modal';
      document.body.append(element);
    }
    return element;
  }

  function pinPath(type, id) {
    const encoded = encodeURIComponent(id);
    return type === 'project' ? `/api/pins/project/${encoded}` : `/api/pins/club/${encoded}`;
  }

  async function showPollVoters(pollId) {
    const data = await api(`/api/polls/${encodeURIComponent(pollId)}`);
    const poll = data.poll;
    if (poll.voterVisibility !== 'public') throw new Error('This poll keeps voters anonymous.');
    const element = modal();
    element.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><div><span class="kicker">Public poll</span><h2>Who voted</h2></div><button class="pr8-close" data-pr8-close>×</button></div><div class="pr8-stack">${poll.options.map(option => `<section class="pr8-card"><h3>${esc(option.label)}</h3><div class="pr8-skill-list">${(option.voters || []).map(voter => `<button type="button" class="pr8-badge" data-pr8-public-voter="${esc(voter.username)}">@${esc(voter.username)}</button>`).join('') || '<span class="pr8-muted">No votes yet.</span>'}</div></section>`).join('')}</div></div>`;
    element.hidden = false;
  }

  async function inspectPoll(pollNode) {
    if (pollNode.dataset.pr8VotersChecked) return;
    pollNode.dataset.pr8VotersChecked = '1';
    try {
      const pollId = pollNode.dataset.poll;
      const data = await api(`/api/polls/${encodeURIComponent(pollId)}`);
      if (data.poll.voterVisibility !== 'public') return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pr8-chip';
      button.dataset.pr8PollVotersFix = pollId;
      button.textContent = 'View voters';
      pollNode.append(button);
    } catch {}
  }

  function contextFromCard(card) {
    const project = card.querySelector('[data-pr8-project-update],[data-pr8-project-apply],[data-pr8-project-leave],[data-pr8-project-apps]');
    if (project) {
      const id = project.dataset.pr8ProjectUpdate || project.dataset.pr8ProjectApply || project.dataset.pr8ProjectLeave || project.dataset.pr8ProjectApps;
      return id ? { type: 'project', id, manager: !!card.querySelector('[data-pr8-project-update]') } : null;
    }
    const club = card.querySelector('[data-pr8-club-mode],[data-pr8-club-join],[data-pr8-club-leave]');
    if (club) {
      const id = club.dataset.pr8ClubMode || club.dataset.pr8ClubJoin || club.dataset.pr8ClubLeave;
      const admin = [...card.querySelectorAll('.pr8-badge.blue')].some(badge => badge.textContent.trim() === 'Admin');
      return id ? { type: 'club', id, manager: !!card.querySelector('[data-pr8-club-mode]') || admin } : null;
    }
    return null;
  }

  async function loadPin(card, context) {
    const key = `${context.type}:${context.id}`;
    if (card.dataset.pr8PinLoaded === key) return;
    card.dataset.pr8PinLoaded = key;
    try {
      const data = await api(pinPath(context.type, context.id));
      card.querySelector('.pr8-context-pin-display')?.remove();
      if (!data.post) return;
      const display = document.createElement('div');
      display.className = 'pr8-card pr8-context-pin-display';
      display.innerHTML = `<span class="kicker">Pinned update</span><p>${esc(data.post.body)}</p><span class="pr8-muted">@${esc(data.post.author?.username || '')}</span>`;
      const actions = card.querySelector('.pr8-actions');
      if (actions) actions.before(display);
      else card.append(display);
    } catch {}
  }

  function installContextPins() {
    document.querySelectorAll('.pr8-card').forEach(card => {
      const context = contextFromCard(card);
      if (!context) return;
      loadPin(card, context);
      const actions = card.querySelector('.pr8-actions');
      if (!context.manager || !actions || actions.querySelector('[data-pr8-context-pin-fix]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.pr8ContextPinFix = `${context.type}:${context.id}`;
      button.textContent = 'Post & pin update';
      actions.append(button);
    });
  }

  function installClubMuteButtons() {
    document.querySelectorAll('.pr8-card').forEach(card => {
      const context = contextFromCard(card);
      if (!context || context.type !== 'club') return;
      const actions = card.querySelector('.pr8-actions');
      if (!actions || actions.querySelector('[data-pr8-club-mute]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.pr8ClubMute = context.id;
      button.textContent = 'Mute club feed';
      actions.append(button);
    });
  }

  function safetyPerson(user, action, label) {
    return `<article class="pr8-card"><div class="pr8-card-head"><div><b>${esc(user.name)}</b><span class="pr8-muted">@${esc(user.username)}</span></div><button type="button" data-pr8-${action}="${esc(user.id)}">${label}</button></div></article>`;
  }

  function safetyClub(club) {
    return `<article class="pr8-card"><div class="pr8-card-head"><div><b>${esc(club.name)}</b><span class="pr8-muted">${esc(club.category || 'Club')}</span></div><button type="button" data-pr8-unmute-club="${esc(club.id)}">Unmute club</button></div></article>`;
  }

  async function showSafetySettings() {
    const [blocked, muted, mutedClubs] = await Promise.all([
      api('/api/safety/blocks'),
      api('/api/safety/mutes?targetType=user'),
      api('/api/safety/mutes?targetType=club')
    ]);
    const element = modal();
    element.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><div><span class="kicker">Privacy & safety</span><h2>Safety settings</h2></div><button class="pr8-close" data-pr8-close>×</button></div><section><h3>Blocked users</h3><div class="pr8-stack">${blocked.blocks.map(user => safetyPerson(user, 'unblock', 'Unblock')).join('') || '<span class="pr8-muted">You have not blocked anyone.</span>'}</div></section><section><h3>Muted from your feed</h3><div class="pr8-stack">${muted.mutes.map(user => safetyPerson(user, 'unmute', 'Unmute')).join('') || '<span class="pr8-muted">You have not muted anyone.</span>'}</div></section><section><h3>Muted clubs</h3><div class="pr8-stack">${mutedClubs.mutes.map(safetyClub).join('') || '<span class="pr8-muted">You have not muted any clubs.</span>'}</div></section></div>`;
    element.hidden = false;
  }

  function installSafetyButton() {
    const notificationButton = document.querySelector('[data-pr8-notifications]');
    const actions = notificationButton?.closest('.pr8-actions');
    if (!actions || actions.querySelector('[data-pr8-safety-settings]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.pr8SafetySettings = '1';
    button.textContent = 'Safety settings';
    actions.append(button);
  }

  function scan() {
    document.querySelectorAll('.pr8-poll[data-poll]').forEach(inspectPoll);
    installContextPins();
    installClubMuteButtons();
    installSafetyButton();
  }

  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();

  document.addEventListener('click', async event => {
    const clubMute = event.target.closest('[data-pr8-club-mute]');
    if (clubMute) {
      event.preventDefault();
      try {
        await api('/api/safety/mutes', {
          method: 'PATCH',
          body: JSON.stringify({ targetType: 'club', targetId: clubMute.dataset.pr8ClubMute, muted: true })
        });
        clubMute.textContent = 'Club feed muted';
        clubMute.disabled = true;
        toast('Club feed muted. You can reverse this in Safety settings.');
      } catch (error) { toast(error.message, 'error'); }
      return;
    }

    const safety = event.target.closest('[data-pr8-safety-settings]');
    if (safety) {
      event.preventDefault();
      try { await showSafetySettings(); }
      catch (error) { toast(error.message, 'error'); }
      return;
    }

    const unblock = event.target.closest('[data-pr8-unblock]');
    if (unblock) {
      event.preventDefault();
      try {
        await api(`/api/safety/blocks/${encodeURIComponent(unblock.dataset.pr8Unblock)}`, { method: 'DELETE' });
        toast('User unblocked.');
        await showSafetySettings();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }

    const unmute = event.target.closest('[data-pr8-unmute]');
    if (unmute) {
      event.preventDefault();
      try {
        await api('/api/safety/mutes', {
          method: 'PATCH',
          body: JSON.stringify({ targetType: 'user', targetId: unmute.dataset.pr8Unmute, muted: false })
        });
        toast('User unmuted.');
        await showSafetySettings();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }

    const unmuteClub = event.target.closest('[data-pr8-unmute-club]');
    if (unmuteClub) {
      event.preventDefault();
      try {
        await api('/api/safety/mutes', {
          method: 'PATCH',
          body: JSON.stringify({ targetType: 'club', targetId: unmuteClub.dataset.pr8UnmuteClub, muted: false })
        });
        toast('Club feed unmuted.');
        await showSafetySettings();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }

    const voters = event.target.closest('[data-pr8-poll-voters-fix]');
    if (voters) {
      event.preventDefault();
      try { await showPollVoters(voters.dataset.pr8PollVotersFix); }
      catch (error) { toast(error.message, 'error'); }
      return;
    }

    const voter = event.target.closest('[data-pr8-public-voter]');
    if (voter) {
      event.preventDefault();
      modal().hidden = true;
      if (typeof window.renderProfile === 'function') window.renderProfile(voter.dataset.pr8PublicVoter);
      return;
    }

    const pin = event.target.closest('[data-pr8-context-pin-fix]');
    if (!pin) return;
    event.preventDefault();
    const [type, ...parts] = pin.dataset.pr8ContextPinFix.split(':');
    const id = parts.join(':');
    if (!['project', 'club'].includes(type) || !id) return;
    const body = prompt(`Post an important ${type} update to pin`);
    if (!body?.trim()) return;
    try {
      const created = await api('/api/posts', {
        method: 'POST',
        body: JSON.stringify({ body: body.trim().slice(0, 1800), type: 'update', tags: [], context: { type, id } })
      });
      await api(pinPath(type, id), {
        method: 'PUT',
        body: JSON.stringify({ postId: created.post.id })
      });
      const card = pin.closest('.pr8-card');
      if (card) {
        card.dataset.pr8PinLoaded = '';
        card.querySelector('.pr8-context-pin-display')?.remove();
        loadPin(card, { type, id });
      }
      toast('Pinned update published.');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
})();
