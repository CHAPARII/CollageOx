(() => {
  const escFix = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let activeClubChatFix = null;
  let clubStreamFix = null;

  function toastFix(message, type = 'error') {
    if (typeof window.toast === 'function') return window.toast(message, type);
    const host = document.querySelector('#toasts');
    if (!host) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    host.append(item);
    setTimeout(() => item.remove(), 3500);
  }

  function modalFix() {
    let modal = document.querySelector('#pr8-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'pr8-modal';
      modal.className = 'pr8-modal';
      document.body.append(modal);
    }
    return modal;
  }

  function chatTextFix(text) {
    return escFix(text).replace(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]{2,24})/g, '$1<button type="button" class="text-button" data-pr8-chat-profile="$2">@$2</button>');
  }

  function ensureClubStreamFix() {
    if (clubStreamFix) return;
    clubStreamFix = new EventSource('/api/pr8/stream');
    clubStreamFix.addEventListener('clubMessage', event => {
      if (!activeClubChatFix) return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.clubId === activeClubChatFix) openClubChatFix(activeClubChatFix, false);
      } catch {}
    });
  }

  async function openClubChatFix(clubId, focusInput = true) {
    const response = await fetch(`/api/clubs/${encodeURIComponent(clubId)}/messages`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not open club chat.');
    activeClubChatFix = clubId;
    ensureClubStreamFix();
    const modal = modalFix();
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><div><span class="kicker">Club room · Live</span><h2>${escFix(data.club.name)}</h2></div><button class="pr8-close" data-pr8-close>×</button></div><div class="pr8-stack" id="pr8-club-chat-fix-messages" style="max-height:55vh;overflow:auto">${data.messages.map(message => `<article class="pr8-card"><div class="pr8-card-head"><b>@${escFix(message.author?.username || '')}</b><span class="pr8-muted">${new Date(message.createdAt).toLocaleString()}</span></div><p>${chatTextFix(message.body)}</p></article>`).join('') || '<div class="pr8-empty">Start the club conversation.</div>'}</div><form class="pr8-inline-input" id="pr8-club-chat-fix-form"><input maxlength="1000" autocomplete="off" required placeholder="Message ${escFix(data.club.name)}" ${data.club.status !== 'active' ? 'disabled' : ''}><button class="button primary" ${data.club.status !== 'active' ? 'disabled' : ''}>Send</button></form></div>`;
    modal.hidden = false;
    const list = modal.querySelector('#pr8-club-chat-fix-messages');
    if (list) list.scrollTop = list.scrollHeight;
    const form = modal.querySelector('#pr8-club-chat-fix-form');
    if (form) {
      form.onsubmit = async event => {
        event.preventDefault();
        const input = form.querySelector('input');
        const body = input.value.trim();
        if (!body) return;
        input.value = '';
        try {
          const sent = await fetch(`/api/clubs/${encodeURIComponent(clubId)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body })
          });
          const result = await sent.json().catch(() => ({}));
          if (!sent.ok) throw new Error(result.error || 'Could not send this message.');
          await openClubChatFix(clubId, true);
        } catch (error) {
          toastFix(error.message);
        }
      };
      if (focusInput) form.querySelector('input')?.focus();
    }
  }

  function installClubChatButtonsFix() {
    document.querySelectorAll('[data-pr8-club-mode],[data-pr8-club-leave]').forEach(anchor => {
      const clubId = anchor.dataset.pr8ClubMode || anchor.dataset.pr8ClubLeave;
      const actions = anchor.closest('.pr8-actions');
      if (!clubId || !actions || actions.querySelector('[data-pr8-club-chat-fix]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'primary';
      button.dataset.pr8ClubChatFix = clubId;
      button.textContent = 'Open chat';
      actions.prepend(button);
    });
  }

  const clubObserverFix = new MutationObserver(installClubChatButtonsFix);
  clubObserverFix.observe(document.documentElement, { childList: true, subtree: true });
  installClubChatButtonsFix();

  async function openQuestionRouteFix(questionId) {
    const response = await fetch(`/api/questions/${encodeURIComponent(questionId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not open this question.');
    const question = data.question;
    const modal = modalFix();
    const author = question.anonymous ? 'Anonymous' : `@${escFix(question.author?.username || '')}`;
    modal.innerHTML = `<div class="pr8-modal-card"><div class="pr8-card-head"><div><span class="kicker">Campus Q&A</span><h2>${escFix(question.title)}</h2><span class="pr8-muted">${author}</span></div><button class="pr8-close" data-pr8-close>×</button></div><p>${escFix(question.body)}</p><div class="pr8-stack">${(question.answers || []).map(answer => `<article class="pr8-card ${answer.accepted ? 'pr8-accepted' : ''}"><div class="pr8-card-head"><b>@${escFix(answer.author?.username || '')}</b>${answer.accepted ? '<span class="pr8-badge blue">Accepted</span>' : ''}</div><p>${escFix(answer.body)}</p><div class="pr8-actions"><button type="button" data-pr8-answer-vote="${escFix(answer.id)}" data-question="${escFix(question.id)}">▲ ${Number(answer.votes || 0)}</button>${question.mine && !answer.accepted ? `<button type="button" data-pr8-answer-accept="${escFix(answer.id)}" data-question="${escFix(question.id)}">Accept answer</button>` : ''}</div></article>`).join('') || '<span class="pr8-muted">No answers yet.</span>'}</div><form class="pr8-form" id="pr8-search-answer-form"><label>Your answer<textarea name="body" maxlength="2400" required></textarea></label><button class="button primary">Post answer</button></form></div>`;
    modal.hidden = false;
    const form = modal.querySelector('#pr8-search-answer-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const body = form.body.value.trim();
      if (!body) return;
      try {
        const answered = await fetch(`/api/questions/${encodeURIComponent(question.id)}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body })
        });
        const result = await answered.json().catch(() => ({}));
        if (!answered.ok) throw new Error(result.error || 'Could not post this answer.');
        await openQuestionRouteFix(question.id);
      } catch (error) {
        toastFix(error.message);
      }
    };
  }

  if (!window.createImageBitmap) {
    window.createImageBitmap = file => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        image.close = () => URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not open this image.'));
      };
      image.src = url;
    });
  }

  document.addEventListener('submit', event => {
    const form = event.target.closest('#post-form');
    if (!form) return;
    const pollFields = document.querySelector('#pr8-poll-fields');
    if (!pollFields || pollFields.hidden) return;
    const expiry = document.querySelector('#pr8-poll-expiry');
    const value = expiry?.value || '';
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toastFix('Choose a future poll expiry.');
      expiry?.focus();
    }
  }, true);

  document.addEventListener('click', async event => {
    const chat = event.target.closest('[data-pr8-club-chat-fix]');
    if (chat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        await openClubChatFix(chat.dataset.pr8ClubChatFix);
      } catch (error) {
        toastFix(error.message);
      }
      return;
    }

    const profile = event.target.closest('[data-pr8-chat-profile]');
    if (profile) {
      event.preventDefault();
      const modal = modalFix();
      modal.hidden = true;
      activeClubChatFix = null;
      if (typeof window.renderProfile === 'function') window.renderProfile(profile.dataset.pr8ChatProfile);
      return;
    }

    const result = event.target.closest('[data-pr8-search-route^="question:"]');
    if (result) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const panel = document.querySelector('#pr8-search-panel');
      if (panel) panel.hidden = true;
      try {
        await openQuestionRouteFix(result.dataset.pr8SearchRoute.slice(9));
      } catch (error) {
        toastFix(error.message);
      }
    }
  }, true);
})();
