// Email transport. Set MAIL_WEBHOOK to a URL that accepts {from,to,subject,text} JSON
// (e.g. a small relay in front of SES/SendGrid/SMTP). Without it, mail is only logged in dev.
export function createMailer({ webhook = process.env.MAIL_WEBHOOK, from = process.env.MAIL_FROM ?? 'Carpool <no-reply@localhost>' } = {}) {
  const outbox = [];
  return {
    outbox,
    async send(msg) {
      outbox.push(msg);
      if (outbox.length > 100) outbox.shift();
      if (webhook) {
        const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, ...msg }) });
        if (!res.ok) throw new Error(`mail webhook returned ${res.status}`);
      } else if (process.env.NODE_ENV !== 'production') {
        console.log(`[mail] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
      }
    },
  };
}
