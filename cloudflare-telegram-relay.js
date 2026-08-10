function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function safeEqual(first, second) {
  const a = new TextEncoder().encode(String(first));
  const b = new TextEncoder().encode(String(second));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ok:true, service:'uchastniki-telegram-relay'});
    }
    if (request.method !== 'POST' || url.pathname !== '/notify') {
      return json({ok:false, message:'Not found'}, 404);
    }
    const receivedAuthorization = request.headers.get('Authorization') || '';
    const expectedAuthorization = `Bearer ${env.RELAY_SECRET || ''}`;
    if (!env.RELAY_SECRET || !safeEqual(receivedAuthorization, expectedAuthorization)) {
      return json({ok:false, message:'Unauthorized'}, 401);
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return json({ok:false, message:'Relay is not configured'}, 503);
    }
    let body;
    try { body = await request.json(); }
    catch { return json({ok:false, message:'Invalid JSON'}, 400); }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4096) return json({ok:false, message:'Invalid message'}, 422);
    const telegramUrl = 'https:' + '//' + 'api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage';
    try {
      const telegramResponse = await fetch(telegramUrl, {
        method: 'POST',
        headers: {'Content-Type':'application/json; charset=utf-8'},
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const telegramResult = await telegramResponse.json().catch(() => null);
      if (!telegramResponse.ok || !telegramResult || telegramResult.ok !== true) {
        return json({ok:false, message:'Telegram delivery failed'}, 502);
      }
      return json({ok:true});
    } catch {
      return json({ok:false, message:'Telegram connection failed'}, 502);
    }
  }
};
