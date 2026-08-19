(() => {
  'use strict';

  const STORAGE_KEY = 'uch_cookie_notice_v1';
  const NOTICE_VERSION = '2026-08-19-v2';
  const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

  function hasAccepted() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return Boolean(saved && saved.version === NOTICE_VERSION && Number(saved.expiresAt) > Date.now());
    } catch {
      return false;
    }
  }

  function saveAcceptance() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: NOTICE_VERSION,
        acceptedAt: new Date().toISOString(),
        expiresAt: Date.now() + RETENTION_MS
      }));
    } catch {
      // Если localStorage недоступен, уведомление появится при следующем посещении.
    }
  }

  function buildNotice() {
    const notice = document.createElement('section');
    notice.className = 'cookie-notice';
    notice.id = 'cookieNotice';
    notice.hidden = true;
    notice.setAttribute('role', 'dialog');
    notice.setAttribute('aria-modal', 'false');
    notice.setAttribute('aria-labelledby', 'cookieNoticeTitle');
    notice.setAttribute('aria-describedby', 'cookieNoticeText');
    notice.innerHTML = `
      <div class="cookie-notice__inner">
        <div class="cookie-notice__copy">
          <h2 class="cookie-notice__title" id="cookieNoticeTitle">Файлы cookie</h2>
          <p class="cookie-notice__text" id="cookieNoticeText">
            Мы используем только необходимые технологии браузера, чтобы сайт работал корректно и запоминал ваш выбор. Аналитические и рекламные cookie не используются. <a href="/politika-cookie.html">Подробнее</a>
          </p>
        </div>
        <div class="cookie-notice__actions">
          <button class="cookie-notice__accept" type="button" data-cookie-notice-accept>Принять</button>
        </div>
      </div>
      <button class="cookie-notice__close" type="button" aria-label="Закрыть уведомление" data-cookie-notice-accept>×</button>`;
    document.body.appendChild(notice);
    return notice;
  }

  function init() {
    const notice = buildNotice();
    const close = () => {
      saveAcceptance();
      notice.hidden = true;
      window.dispatchEvent(new CustomEvent('uch:cookie-notice-accepted', {detail: {version: NOTICE_VERSION}}));
    };
    const open = () => {
      notice.hidden = false;
      requestAnimationFrame(() => notice.querySelector('[data-cookie-notice-accept]')?.focus({preventScroll: true}));
    };

    notice.querySelectorAll('[data-cookie-notice-accept]').forEach(button => button.addEventListener('click', close));
    document.querySelectorAll('[data-cookie-notice-open]').forEach(button => button.addEventListener('click', open));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !notice.hidden) close();
    });
    if (!hasAccepted()) open();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true});
  else init();
})();
