// mentions.js — Chirm @mention autocomplete
// Intercepts typing in the message input and shows a member picker
// when the user types @.

const ChirmMentions = (() => {
  let _popover = null;
  let _selectedIdx = 0;
  let _matches = [];
  let _query = '';
  let _triggerPos = -1; // position of the @ character in the textarea

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  function init(inputEl) {
    inputEl.addEventListener('input', (e) => _onInput(e, inputEl));
    inputEl.addEventListener('keydown', (e) => _onKeydown(e, inputEl));
    inputEl.addEventListener('blur', () => {
      // Slight delay so click on popover item registers first
      setTimeout(close, 150);
    });
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  function _onInput(e, input) {
    const val = input.value;
    const cursor = input.selectionStart;

    // Find the @ character before the cursor on the same line
    let atPos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      if (val[i] === '@') { atPos = i; break; }
      if (val[i] === ' ' || val[i] === '\n') break;
    }

    if (atPos === -1) { close(); return; }

    const query = val.slice(atPos + 1, cursor).toLowerCase();
    // Only trigger if query doesn't contain spaces and is reasonably short
    if (query.length > 20 || query.includes(' ')) { close(); return; }

    _triggerPos = atPos;
    _query = query;
    _matches = _filterMembers(query);

    if (!_matches.length) { close(); return; }

    _selectedIdx = 0;
    _show(input);
  }

  function _onKeydown(e, input) {
    if (!_popover) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _selectedIdx = (_selectedIdx + 1) % _matches.length;
      _render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _selectedIdx = (_selectedIdx - 1 + _matches.length) % _matches.length;
      _render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (_matches.length) {
        e.preventDefault();
        _selectMatch(input, _matches[_selectedIdx]);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  }

  // ── Member filtering ────────────────────────────────────────────────────────

  function _filterMembers(query) {
    const members = App.members || [];
    if (!query) return members.slice(0, 8);
    return members
      .filter(m => m.username.toLowerCase().startsWith(query) ||
                   m.username.toLowerCase().includes(query))
      .sort((a, b) => {
        const aStarts = a.username.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.username.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.username.localeCompare(b.username);
      })
      .slice(0, 8);
  }

  // ── Popover rendering ───────────────────────────────────────────────────────

  function _show(input) {
    if (!_popover) {
      _popover = document.createElement('div');
      _popover.className = 'mention-popover';
      document.body.appendChild(_popover);
    }
    _render();
    _position(input);
  }

  function _render() {
    if (!_popover) return;
    _popover.innerHTML = _matches.map((m, i) => {
      const color = (typeof stringToColor === 'function') ? stringToColor(m.username) : '#7c6af5';
      const initials = m.username[0]?.toUpperCase() || '?';
      const avatarHtml = m.avatar
        ? `<img src="${esc(m.avatar)}" alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover">`
        : `<div class="mention-avatar" style="background:${color}">${initials}</div>`;
      return `<div class="mention-item${i === _selectedIdx ? ' selected' : ''}" data-idx="${i}">
        ${avatarHtml}
        <span class="mention-name">${esc(m.username)}</span>
        ${m.is_owner ? '<span class="mention-badge">Owner</span>' : (m.roles?.[0] ? `<span class="mention-badge" style="color:${m.roles[0].color}">${esc(m.roles[0].name)}</span>` : '')}
      </div>`;
    }).join('');

    _popover.querySelectorAll('.mention-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = parseInt(el.dataset.idx, 10);
        const input = document.getElementById('message-input');
        if (input) _selectMatch(input, _matches[idx]);
      });
    });
  }

  function _position(input) {
    if (!_popover) return;
    const rect = input.getBoundingClientRect();
    const popH = Math.min(_matches.length * 40 + 8, 320);
    let top = rect.top - popH - 6;
    if (top < 8) top = rect.bottom + 6;
    _popover.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${top}px;
      width: ${Math.min(280, rect.width)}px;
      z-index: 9999;
    `;
  }

  // ── Completion ──────────────────────────────────────────────────────────────

  function _selectMatch(input, member) {
    const val = input.value;
    const cursor = input.selectionStart;
    const before = val.slice(0, _triggerPos);
    const after = val.slice(cursor);
    const mention = `@${member.username} `;
    input.value = before + mention + after;
    const newCursor = before.length + mention.length;
    input.selectionStart = input.selectionEnd = newCursor;
    input.focus();
    // Trigger resize if available
    if (typeof resizeInput === 'function') resizeInput(input);
    close();
  }

  function close() {
    if (_popover) {
      _popover.remove();
      _popover = null;
    }
    _matches = [];
    _triggerPos = -1;
    _query = '';
  }

  /**
   * renderMention(content) — wrap @username patterns in styled spans.
   * Called from within renderContent() additions in app.js.
   * Highlights mentions of the current user with a special class.
   */
  function renderMentions(html) {
    if (!App.members?.length) return html;

    return html.replace(/@([a-zA-Z0-9_]{1,32})/g, (match, username) => {
      const member = App.members.find(
        m => m.username.toLowerCase() === username.toLowerCase()
      );
      if (!member) return match; // leave unrecognised @handles as-is

      const isSelf = member.id === App.user?.id;
      const cls = isSelf ? 'mention mention-self' : 'mention';
      return `<span class="${cls}" data-user-id="${member.id}" title="${esc(member.username)}">@${esc(member.username)}</span>`;
    });
  }

  return { init, close, renderMentions };
})();
