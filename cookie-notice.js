(() => {
  'use strict';

  const STORAGE_KEY = 'uch_cookie_notice_v1';
  const NOTICE_VERSION = '2026-08-19';
  const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

  function readAcknowledgement() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || saved.version !== NOTICE_VERSION) return false;
      return Number(saved.expiresAt) > Date.now();
    } catch {
      return false;
    }
  }

  function saveAcknowledgement() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: NOTICE_VERSION,
        acknowledgedAt: new Date().toISOString(),
        expiresAt: Date.now() + RETENTION_MS
      }));
    } catch {
      // Если локальное хранилище недоступно, уведомление появится при следующем посещении.
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
          <h2 class="cookie-notice__title" id="cookieNoticeTitle">О необходимых технологиях</h2>
          <p class="cookie-notice__text" id="cookieNoticeText">
            Сайт использует только необходимые технологии браузера для корректной работы и запоминания вашего выбора. Аналитические и рекламные cookie не устанавливаются. Подробнее — в <a href="/politika-konfidencialnosti.html#cookies">Политике конфиденциальности</a>.
          </p>
        </div>
        <div class="cookie-notice__actions">
          <button class="cookie-notice__accept" type="button" data-cookie-notice-accept>Понятно</button>
        </div>
      </div>
      <button class="cookie-notice__close" type="button" aria-label="Закрыть уведомление" data-cookie-notice-accept>×</button>`;
    document.body.appendChild(notice);
    return notice;
  }

  function init() {
    const notice = buildNotice();
    const acceptButtons = notice.querySelectorAll('[data-cookie-notice-accept]');
    const openButtons = document.querySelectorAll('[data-cookie-notice-open]');

    const open = () => {
      notice.hidden = false;
      requestAnimationFrame(() => notice.querySelector('[data-cookie-notice-accept]')?.focus({preventScroll: true}));
    };

    const close = () => {
      saveAcknowledgement();
      notice.hidden = true;
      window.dispatchEvent(new CustomEvent('uch:cookie-notice-acknowledged', {
        detail: {version: NOTICE_VERSION}
      }));
    };

    acceptButtons.forEach(button => button.addEventListener('click', close));
    openButtons.forEach(button => button.addEventListener('click', open));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !notice.hidden) close();
    });

    if (!readAcknowledgement()) open();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {once: true});
  } else {
    init();
  }
})();
