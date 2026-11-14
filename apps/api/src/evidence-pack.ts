/**
 * The evidence pack as a printable page (review of wave 2): what `GET /api/requests/:id/evidence-pack?format=html`
 * returns. The same facts as the JSON, one column, every time with its time zone (UTC, ISO 8601), nothing loaded from
 * elsewhere. Print it to PDF from the browser.
 */
import type { EvidencePack } from '@landledger/contracts';

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const utc = (iso: string) =>
  `${iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
    .replace(/Z$/, '')} UTC`;

export function evidencePackHtml(pack: EvidencePack): string {
  const r = pack.request;
  const rows = (pairs: [string, unknown][]) =>
    pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const decisions = pack.decisions
    .map(
      (d) =>
        `<li><b>${esc(d.outcome)}</b> at step ${d.step} (${esc(d.stepKey)}) by ${esc(d.person.name)}${
          d.person.email ? ` &lt;${esc(d.person.email)}&gt;` : ''
        }, ${esc(utc(d.at))}, via ${esc(d.via)}${
          d.relay ? ` (relayed from ${esc(d.relay.kind)} user ${esc(d.relay.externalUserId)})` : ''
        }; owner role: ${esc(d.ownerRole)}; evidence <code>${esc(d.evidenceSha256)}</code>${
          d.comment ? `<br>“${esc(d.comment)}”` : ''
        }</li>`,
    )
    .join('');
  const snapshots = pack.snapshots
    .map(
      (s) =>
        `<section><h3><code>${esc(s.sha256)}</code></h3><p>Taken ${esc(utc(s.createdAt))}. Served: ${
          s.served.length
            ? s.served.map((v) => `${esc(v.to)} (${esc(v.kind)}) ${esc(utc(v.at))}`).join('; ')
            : 'not recorded (before serves were recorded)'
        }</p><details><summary>Snapshot</summary><pre>${esc(JSON.stringify(s.body, null, 2))}</pre></details></section>`,
    )
    .join('');
  const audit = pack.audit
    .map(
      (a) =>
        `<tr><td>${a.seq}</td><td>${esc(utc(a.at))}</td><td>${esc(a.actor)} (${esc(a.actorKind)})</td><td>${esc(
          a.action,
        )}</td><td><code>${esc(a.hash.slice(0, 16))}…</code></td></tr>`,
    )
    .join('');
  const c = pack.chain;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence pack: ${esc(r.number)} ${esc(r.title)}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ccc}h3{font-size:.85rem;word-break:break-all}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.25rem .5rem;border-bottom:1px solid #eee}
th{width:12rem;font-weight:600}code,pre{font:12px ui-monospace,monospace}pre{white-space:pre-wrap;background:#f6f6f6;padding:.5rem}
.ok{color:#05612b}.bad{color:#a00}@media print{details{display:block}details>*{display:block}}
</style></head><body>
<h1>Evidence pack: ${esc(r.number)} ${esc(r.title)}</h1>
<p>Generated ${esc(utc(pack.generatedAt))} by Landledger.</p>
<h2>Request</h2><table>${rows([
    ['Status', r.status],
    ['Kind', r.kind],
    ['Cost center', `${r.costCenter.code} ${r.costCenter.name}`],
    [
      'Amount',
      `${r.amount.amount} ${r.amount.currency} (${r.recurrence}, from ${r.start}${r.end ? ` to ${r.end}` : ''})`,
    ],
    [
      'Requester',
      r.requester.kind === 'person'
        ? r.requester.person.name
        : `${r.requester.agent.name} (sponsor ${r.requester.sponsor.name})`,
    ],
    ['Created by', `${r.createdBy.kind} ${r.createdBy.name}`],
    ['Origin', `${r.origin.type}${r.origin.verified ? ' (verified)' : ' (not verified)'}`],
    [
      'Confirmation',
      r.confirmation
        ? `${r.confirmation.status} by ${r.confirmation.person.name}${r.confirmation.at ? ` ${utc(r.confirmation.at)}` : ''}`
        : 'not needed',
    ],
    ['Created', utc(r.createdAt)],
  ])}</table>
<h2>Decisions</h2><ol>${decisions || '<li>None</li>'}</ol>
<h2>Evidence served</h2>${snapshots || '<p>None</p>'}
<h2>Audit entries</h2><table><tr><th>Seq</th><th>At</th><th>Actor</th><th>Action</th><th>Hash</th></tr>${audit}</table>
<h2>Chain proof</h2><p class="${c.ok ? 'ok' : 'bad'}">${
    c.ok ? 'The chain verifies' : `The chain is broken at entry ${c.brokenAt}`
  } from entry ${c.from} to ${c.to}${
    c.anchor
      ? `; last anchor: entry ${c.anchor.seq} <code>${esc(c.anchor.hash)}</code> at ${esc(utc(c.anchor.at))}`
      : '; no anchor yet'
  }.</p>
</body></html>`;
}
