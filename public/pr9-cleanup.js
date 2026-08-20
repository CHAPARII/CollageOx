(() => {
  const REMOVED_ROUTES = new Set(['messages', 'marketplace', 'qa']);
  const REMOVED_CLICK_SELECTOR = [
    '[data-pr8-route="messages"]',
    '[data-pr8-route="marketplace"]',
    '[data-pr8-route="qa"]',
    '[data-pr8-message-user]',
    '[data-pr8-market-contact]',
    '[data-pr8-market-status]',
    '[data-pr8-question]',
    '[data-pr8-lost-contact]',
    '[data-pr8-search-route="marketplace"]',
    '[data-pr8-search-route^="question:"]'
  ].join(',');

  function routeFromHash() {
    return location.hash.slice(1).split(':')[0];
  }

  function removeRetiredUi() {
    document.querySelectorAll('[data-pr8-route="messages"],[data-pr8-route="marketplace"],[data-pr8-route="qa"],[data-pr8-search-type="marketplace"],[data-pr8-search-type="qa"],[data-pr8-message-user],[data-pr8-market-contact],[data-pr8-market-status],[data-pr8-question],[data-pr8-lost-contact]').forEach(node => node.remove());
    document.querySelectorAll('[data-pr8-search-route]').forEach(node => {
      const route = node.dataset.pr8SearchRoute || '';
      if (route === 'marketplace' || route.startsWith('question:')) node.remove();
    });
  }

  function restoreProfileCover() {
    const view = document.querySelector('#view');
    const tabs = view?.querySelector('.pr8-profile-tabs');
    if (!view || !tabs) return;
    const card = tabs.closest('.pr8-card');
    if (!card) return;
    const avatar = card.querySelector('.avatar');
    const accent = avatar?.style.getPropertyValue('--accent')?.trim() || '#155eef';
    let cover = view.querySelector('.pr9-profile-cover');
    if (!cover) {
      cover = document.createElement('section');
      cover.className = 'profile-cover pr9-profile-cover';
      view.insertBefore(cover, card);
    }
    cover.style.setProperty('--accent', accent);
    card.classList.add('pr9-profile-card');
  }

  function cleanVisibleUi() {
    removeRetiredUi();
    restoreProfileCover();
  }

  function redirectRemovedRoute() {
    if (!REMOVED_ROUTES.has(routeFromHash())) return;
    if (typeof window.navigate === 'function') window.navigate('feed');
    else location.hash = 'feed';
  }

  function patchNavigate() {
    const previous = window.navigate;
    if (typeof previous !== 'function' || previous.__pr9Cleanup) return;
    const wrapped = async route => {
      if (REMOVED_ROUTES.has(route)) return previous('feed');
      return previous(route);
    };
    wrapped.__pr9Cleanup = true;
    window.navigate = wrapped;
  }

  function boot() {
    patchNavigate();
    cleanVisibleUi();
    const observer = new MutationObserver(cleanVisibleUi);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(redirectRemovedRoute, 0);
  }

  document.addEventListener('click', event => {
    const target = event.target.closest(REMOVED_CLICK_SELECTOR);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (target.matches('[data-pr8-route="messages"],[data-pr8-route="marketplace"],[data-pr8-route="qa"],[data-pr8-search-route="marketplace"],[data-pr8-search-route^="question:"]')) {
      window.navigate?.('feed');
    }
  }, true);

  window.addEventListener('hashchange', redirectRemovedRoute);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
