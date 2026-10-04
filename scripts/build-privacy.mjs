// Renders PRIVACY.md → public/privacy.html so the policy inside the extension
// always matches the published one. Handles the small Markdown subset the policy uses.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const md = readFileSync('PRIVACY.md', 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
  esc(s)
    .replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

const out = [];
const lines = md.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^# /.test(l)) out.push(`<h1>${inline(l.slice(2))}</h1>`);
  else if (/^## /.test(l)) out.push(`<h2>${inline(l.slice(3))}</h2>`);
  else if (/^\|/.test(l)) {
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    i--;
    const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
    const [head, , ...body] = rows;
    out.push(
      `<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
        .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`,
    );
  } else if (/^- /.test(l)) {
    const items = [];
    while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
    i--;
    out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
  } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy</title>
<style>
:root{--bg:#fff;--ink:#18181b;--ink2:#52525b;--line:#e4e4e8;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--ink:#ececf1;--ink2:#a8a8b3;--line:#2c2c33;--accent:#8b85ff}}
body{background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}p,li{color:var(--ink2)}a{color:var(--accent)}
table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
code{font-size:12px;background:rgba(127,127,127,.15);padding:1px 4px;border-radius:4px}
</style></head><body>
${out.join('\n')}
</body></html>
`;
mkdirSync('public', { recursive: true });
writeFileSync('public/privacy.html', html);
console.log('privacy.html written');
