// utils.js — Shared rendering utilities for Chirm

import App from './state.js';
import { EMOJI_SHORTCODES } from './emoji-data.js';
import ChirmMentions from './mentions.js';

export function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function avatar(user, size = '', status = '') {
  const cls = `avatar ${size}`;
  const dot = status ? `<div class="status-dot ${status}"></div>` : '';
  if (user?.avatar) {
    return `<div class="${cls}"><img src="${user.avatar}" alt="${esc(user.username)}">${dot}</div>`;
  }
  const initials = (user?.username || '?')[0].toUpperCase();
  const color = stringToColor(user?.username || '');
  return `<div class="${cls}" style="background:${color}">${initials}${dot}</div>`;
}

export function stringToColor(str) {
  const colors = ['#6c63ff','#3fba7a','#e05252','#e0a030','#3fa0e0','#a052e0','#e05290'];
  let hash = 0;
  for (const c of str) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function escInline(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function escAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}

export function formatTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isYesterday = d.toDateString() === new Date(now - 86400000).toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${time}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1048576).toFixed(1)} MB`;
}

export function formatTimeShort(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function renderContent(content) {
  // ── Step 0: extract fenced code blocks to protect them from other transforms
  const codeBlocks = [];
  let s = content.replace(/```([a-zA-Z]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="msg-codeblock" data-lang="${esc(lang)}">${esc(code.trim())}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // ── Step 1: escape HTML in the remaining text
  s = esc(s);

  // Re-escape the placeholders that got double-escaped
  s = s.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

  // ── Step 2: custom emoji :name: substitution (custom first, then shortcodes)
  s = s.replace(/:([a-zA-Z0-9_]+):/g, (match, name) => {
    // Check custom server emojis
    const custom = App.customEmojis?.find(e => e.name === name.toLowerCase());
    if (custom) {
      return `<img class="custom-emoji" src="/api/v1/uploads/${esc(custom.filename)}" alt=":${esc(name)}:" title=":${esc(name)}:">`;
    }
    // Check standard shortcodes
    const std = EMOJI_SHORTCODES[name] || EMOJI_SHORTCODES[name.toLowerCase()];
    if (std) return std;
    return match; // unchanged
  });

  // ── Step 3: inline images  ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, alt, url) => `<img class="msg-inline-img" src="${url}" alt="${esc(alt)}" loading="lazy" onclick="openImageViewer('${url}')">`);

  // ── Step 4: blockquotes
  s = s.replace(/^&gt; ?(.*)$/gm, '<div class="msg-blockquote">$1</div>');

  // ── Step 5: headers
  s = s.replace(/^### (.+)$/gm, '<h3 class="msg-h3 msg-h">$1</h3>');
  s = s.replace(/^## (.+)$/gm,  '<h2 class="msg-h2 msg-h">$1</h2>');
  s = s.replace(/^# (.+)$/gm,   '<h1 class="msg-h1 msg-h">$1</h1>');

  // ── Step 6: horizontal rule  --- or *** or ___
  s = s.replace(/^(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr class="msg-hr">');

  // ── Step 7: task list items  - [ ] / - [x]
  s = s.replace(/^- \[( |x)\] (.*)$/gm, (_, checked, text) => {
    const ch = checked === 'x' ? 'checked' : '';
    return `<div class="msg-task"><input type="checkbox" ${ch} disabled> ${text}</div>`;
  });

  // ── Step 8: unordered list items  - item  or  * item  (not task list)
  s = s.replace(/^[ \t]*[-*] (.+)$/gm, '<li class="msg-li">$1</li>');

  // ── Step 9: ordered list items  1. item
  s = s.replace(/^[ \t]*\d+\. (.+)$/gm, '<li class="msg-oli">$1</li>');

  // ── Step 10: wrap consecutive <li> into <ul>/<ol>
  s = s.replace(/(<li class="msg-li">[\s\S]*?<\/li>)(?![\s\S]*?<li class="msg-li">)/g, '<ul class="msg-ul">$1</ul>');
  s = s.replace(/(<li class="msg-oli">[\s\S]*?<\/li>)(?![\s\S]*?<li class="msg-oli">)/g, '<ol class="msg-ol">$1</ol>');
  // Group consecutive lis
  s = s.replace(/(<li class="msg-li">.*?<\/li>)\n(<li class="msg-li">)/g, '$1$2');
  s = s.replace(/(<li class="msg-oli">.*?<\/li>)\n(<li class="msg-oli">)/g, '$1$2');

  // ── Step 11: tables  | col | col |
  s = s.replace(/(\|.+\|\n)((?:\|[-: ]+\|\n))(\|.+\|\n?)+/g, (table) => {
    const rows = table.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return table;
    const parseRow = r => r.split('|').slice(1, -1).map(c => c.trim());
    const headerCells = parseRow(rows[0]);
    const isSep = rows[1] && /^\|[-| :]+\|/.test(rows[1]);
    if (!isSep) return table;
    const align = parseRow(rows[1]).map(c => {
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    const bodyRows = rows.slice(2);
    const thead = `<tr>${headerCells.map((c,i) => `<th style="text-align:${align[i]||'left'}">${c}</th>`).join('')}</tr>`;
    const tbody = bodyRows.map(r => {
      const cells = parseRow(r);
      return `<tr>${cells.map((c,i) => `<td style="text-align:${align[i]||'left'}">${c}</td>`).join('')}</tr>`;
    }).join('');
    return `<table class="msg-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });

  // ── Step 12: inline code  `code`
  s = s.replace(/`([^`\n]+)`/g, '<code class="msg-inlinecode">$1</code>');

  // ── Step 13: bold+italic ***
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_\s][^_]*)_/g, '<em>$1</em>');
  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // ── Step 14: URLs — match https?:// and bare www. addresses
  const foundURLs = [];
  s = s.replace(/(?<!href="|src="|">|:\/\/)(https?:\/\/[^\s<>"')\]]+|www\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s<>"')\]]*)/g,
    (match) => {
      const href = match.startsWith('http') ? match : `https://${match}`;
      if (foundURLs.length < 2 && href.startsWith('http') && !foundURLs.includes(href)) {
        foundURLs.push(href);
      }
      return `<a href="${href}" target="_blank" rel="noopener" class="msg-link">${match}</a>`;
    });
  if (foundURLs.length > 0) {
    s += `<span class="link-preview-trigger" data-urls="${escAttr(foundURLs.join('|'))}" style="display:none"></span>`;
  }

  // ── Step 15: newlines → <br> (skipping inside block-level tags)
  s = s.replace(/\n/g, '<br>');
  const BLOCK = 'pre|ul|ol|li|div|hr|h[1-6]|table|thead|tbody|tr|th|td|blockquote';
  s = s.replace(new RegExp(`<br>(</?(?:${BLOCK})[^>]*>)`, 'g'), '$1');
  s = s.replace(new RegExp(`(</?(?:${BLOCK})[^>]*>)<br>`, 'g'), '$1');

  // ── Step 16: @mention highlighting
  if (typeof ChirmMentions !== 'undefined') {
    s = ChirmMentions.renderMentions(s);
  }

  return s;
}

export function isAdmin(user) {
  if (!user) return false;
  if (user.is_owner) return true;
  const PERM_ADMIN = 64;
  const PERM_MANAGE_SERVER = 32;
  return (user.permissions & PERM_ADMIN) !== 0 || (user.permissions & PERM_MANAGE_SERVER) !== 0;
}

export function resizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}
