// Odesílání poptávek a rezervací e-mailem přímo přes schránku u Forpsi (SMTP).
// Přihlašovací údaje jsou jen v proměnných prostředí Netlify, nikdy v kódu:
//   SMTP_USER  – celá e-mailová adresa schránky, ze které se posílá (např. web@avm-visuals.cz)
//   SMTP_PASS  – heslo k této schránce
//   SMTP_HOST  – volitelně, výchozí smtp.forpsi.com
//   SMTP_PORT  – volitelně, výchozí 465 (SSL)
//   MAIL_TO_VISUALS / MAIL_TO_ATELIER – volitelně, kam zprávy chodí
import tls from 'node:tls';
import net from 'node:net';

// Minimální SMTP klient bez závislostí (SSL na portu 465, případně prostý pro testy).
function smtpSend({ host, port, secure, user, pass, from, to, raw }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    sock.setEncoding('utf8'); sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('timeout')); });
    let buf = '', step = 0;
    const b64 = (x) => Buffer.from(x, 'utf8').toString('base64');
    const steps = [
      [220, () => `EHLO avm-visuals.cz`],
      [250, () => `AUTH LOGIN`],
      [334, () => b64(user)],
      [334, () => b64(pass)],
      [235, () => `MAIL FROM:<${from}>`],
      [250, () => `RCPT TO:<${to}>`],
      [250, () => `DATA`],
      [354, () => raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.'],
      [250, () => `QUIT`],
    ];
    sock.on('data', (d) => {
      buf += d;
      let m;
      while ((m = buf.match(/^(\d{3})([ -])[^\r\n]*\r?\n/))) {
        buf = buf.slice(m[0].length);
        if (m[2] === '-') continue; // víceřádková odpověď
        const code = +m[1];
        if (step >= steps.length) { sock.end(); return resolve(); }
        const [want, cmd] = steps[step];
        if (code !== want) { sock.destroy(); return reject(new Error(`SMTP ${code} at step ${step}`)); }
        step++; sock.write(cmd() + '\r\n');
      }
    });
    sock.on('error', reject);
    sock.on('end', () => (step >= steps.length ? resolve() : reject(new Error('closed'))));
  });
}
const encH = (s) => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s;
const wrap64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

const FORMS = {
  'poptavka-visuals': { to: process.env.MAIL_TO_VISUALS || 'info@avm-visuals.cz', label: 'Poptávka AVM Visuals' },
  'rezervace-atelier': { to: process.env.MAIL_TO_ATELIER || 'atelier@avm-visuals.cz', label: 'Rezervace AVM Atelier' },
};
const FIELDS = [
  ['name', 'Jméno'], ['surname', 'Příjmení'], ['email', 'E-mail'], ['phone', 'Telefon'],
  ['firm', 'Firma'], ['type', 'Zájem / typ focení'], ['count', 'Počet osob'], ['msg', 'Zpráva'],
];
const hits = new Map(); // jednoduchá ochrana proti zahlcení (na jedné instanci funkce)

const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false });
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'x';
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (list.length >= 5) return json(429, { ok: false, error: 'rate' });
  hits.set(ip, [...list, now]);

  let data;
  try {
    const ct = req.headers.get('content-type') || '';
    data = ct.includes('application/json') ? await req.json() : Object.fromEntries(new URLSearchParams(await req.text()));
  } catch { return json(400, { ok: false }); }

  const form = FORMS[data['form-name']];
  if (!form) return json(400, { ok: false });
  if (clean(data['bot-field']) || clean(data.website)) return json(200, { ok: true }); // robot – tiše zahodit

  const v = Object.fromEntries(FIELDS.map(([k]) => [k, clean(data[k], k === 'msg' ? 5000 : 200)]));
  const email = v.email.replace(/[\r\n]/g, '');
  if (!v.name || !v.surname || !v.msg || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || v.phone.replace(/\D/g, '').length < 9)
    return json(400, { ok: false, error: 'fields' });

  const { SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) return json(503, { ok: false, error: 'not-configured' });

  const rows = FIELDS.filter(([k]) => v[k]);
  const text = rows.map(([k, l]) => `${l}: ${v[k]}`).join('\n') + '\n\n— odesláno z webu avm-visuals.cz';
  const html = '<table style="font:15px/1.5 Arial,sans-serif;border-collapse:collapse">' +
    rows.map(([k, l]) => `<tr><td style="padding:4px 14px 4px 0;color:#777;vertical-align:top">${l}</td><td style="padding:4px 0;white-space:pre-wrap">${esc(v[k])}</td></tr>`).join('') +
    '</table><p style="font:12px Arial,sans-serif;color:#999">Odesláno z webu avm-visuals.cz. Odpovědí na tento e-mail odpovíte přímo zákazníkovi.</p>';

  const port = Number(process.env.SMTP_PORT || 465);
  const subject = `${form.label}: ${v.name} ${v.surname}${v.type ? ' – ' + v.type : ''}`.slice(0, 200);
  const bnd = 'avm' + Date.now().toString(36);
  const raw = [
    `From: ${encH('Web AVM Visuals')} <${SMTP_USER}>`,
    `To: <${form.to}>`,
    `Reply-To: ${encH(`${v.name} ${v.surname}`.slice(0, 120))} <${email}>`,
    `Subject: ${encH(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${bnd}.${Math.random().toString(36).slice(2)}@avm-visuals.cz>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${bnd}"`,
    '',
    `--${bnd}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap64(text),
    `--${bnd}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap64(html),
    `--${bnd}--`, '',
  ].join('\r\n');
  try {
    await smtpSend({ host: process.env.SMTP_HOST || 'smtp.forpsi.com', port, secure: process.env.SMTP_SECURE !== 'false' && port !== 2525,
      user: SMTP_USER, pass: SMTP_PASS, from: SMTP_USER, to: form.to, raw });
    return json(200, { ok: true });
  } catch (e) {
    console.error('SMTP error', e && e.message);
    return json(502, { ok: false, error: 'smtp' });
  }
};

export const config = { path: '/api/poptavka' };
