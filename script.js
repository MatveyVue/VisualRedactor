;(function () {
  'use strict'

  const API_BASE = ((document.currentScript || {}).dataset || {}).api || ''
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => document.querySelectorAll(s)
  const MAX_LEN = 32768
  const TRUNCATE_LEN = 8000

  let userId = null
  let channels = []
  let previewVisible = false
  let previewExpanded = false
  let tg = null
  let pendingImages = {}
  let savedRange = null
  let toastTimer = null
  let _keyboardOpen = false

  const ed = $('#editor')
  const toastEl = $('#toast')

  /* === Init === */

  async function init() {
    if (window.Telegram && window.Telegram.WebApp) {
      try {
        tg = Telegram.WebApp
        tg.ready()
        tg.expand()
        userId = tg.initDataUnsafe?.user?.id
        applyTheme(tg.colorScheme === 'dark' ? 'dark' : 'light', true)
        if (tg.onEvent) { tg.onEvent('viewportChanged', syncViewportHeight); tg.onEvent('viewportStable', syncViewportHeight) }
      } catch (e) { console.warn('TWA:', e) }
    }
    if (!userId) {
      userId = localStorage.getItem('ve_uid')
      if (!userId) { userId = crypto.randomUUID(); localStorage.setItem('ve_uid', userId) }
    }
    const savedTheme = localStorage.getItem('ve_theme')
    if (savedTheme) {
      applyTheme(savedTheme, true)
    } else if (!tg) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      applyTheme(prefersDark ? 'dark' : 'dark', true)
    }
    loadChannels()
    loadDraft()
    syncViewportHeight()
    updateCounter()
    updatePreview()
  }

  init()

  /* === Theme === */

  function applyTheme(scheme, silent) {
    const dark = scheme === 'dark'
    document.body.classList.toggle('dark', dark)
    document.body.classList.toggle('light', !dark)
    $$('.pv-theme').forEach((b) => b.classList.toggle('active', (dark && b.dataset.theme === 'dark') || (!dark && b.dataset.theme === 'light')))
    if (!silent) { localStorage.setItem('ve_theme', scheme); updatePreview() }
  }

  /* === Toast === */

  function showToast(msg, dur) {
    dur = dur || 2500
    toastEl.textContent = msg
    toastEl.className = 'toast-show'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastEl.className = 'hidden'), dur)
  }

  /* === Modal === */

  function showModal(title, bodyEl) {
    $('#modalTitle').textContent = title
    const mb = $('#modalBody'); mb.innerHTML = ''
    mb.appendChild(bodyEl)
    $('#modal-overlay').classList.remove('hidden')
  }

  function closeModal(e) {
    if (e && e.target !== $('#modal-overlay') && !e.target.closest('#modalCloseBtn')) return
    $('#modal-overlay').classList.add('hidden')
  }
  $('#modal-overlay').addEventListener('click', closeModal)
  $('#modalCloseBtn').addEventListener('click', closeModal)

  /* === Confirm === */

  async function showConfirm(msg) {
    if (tg && tg.showConfirm) return new Promise((r) => tg.showConfirm(msg, (ok) => r(ok)))
    return confirm(msg)
  }

  /* === Mobile helpers === */

  function syncViewportHeight() {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight
    document.documentElement.style.setProperty('--app-height', vh + 'px')
    const wasOpen = _keyboardOpen
    _keyboardOpen = vh < window.screen?.height * 0.8
    if (_keyboardOpen && !wasOpen) {
      setTimeout(() => ed.scrollIntoView({ block: 'start', behavior: 'smooth' }), 350)
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight)
    window.visualViewport.addEventListener('scroll', syncViewportHeight)
  }
  window.addEventListener('resize', syncViewportHeight)

  /* === Draft === */

  function loadDraft() {
    try { const d = localStorage.getItem('ve_draft'); if (d) ed.innerHTML = d } catch (e) {}
  }
  function saveDraft() {
    clearTimeout(ed._save)
    ed._save = setTimeout(() => { try { localStorage.setItem('ve_draft', ed.innerHTML) } catch (e) {} }, 400)
  }

  /* === Counter === */

  function updateCounter() {
    const len = (ed.innerText || '').trim().length
    const c = $('#counter')
    c.textContent = len + ' / ' + MAX_LEN
    c.style.color = len > MAX_LEN ? 'var(--danger)' : ''
  }

  /* === Editor Events === */

  ed.addEventListener('input', () => {
    updateCounter()
    previewExpanded = false
    cancelAnimationFrame(ed._previewFrame)
    ed._previewFrame = requestAnimationFrame(() => { updatePreview(); saveDraft() })
    if (ed.innerText.length > MAX_LEN) {
      ed.innerText = ed.innerText.slice(0, MAX_LEN); updatePreview()
      showToast('Максимум ' + MAX_LEN + ' символов')
    }
  })

  ed.addEventListener('mouseup', () => { const s = window.getSelection(); if (s.rangeCount) savedRange = s.getRangeAt(0) })
  ed.addEventListener('keyup', () => { const s = window.getSelection(); if (s.rangeCount) savedRange = s.getRangeAt(0) })

  ed.addEventListener('click', (e) => {
    const li = e.target.closest('ul.task li')
    if (li && !window.getSelection().toString()) { li.classList.toggle('done'); saveDraft(); updatePreview() }
  })

  /* === Toolbar === */

  $$('.tb[data-cmd]').forEach((btn) => { btn.addEventListener('click', () => { if (tg) tg.HapticFeedback?.impactOccurred?.('light'); execCmd(btn.dataset.cmd) }) })

  function markCursor() {
    const old = document.getElementById('ve_mkr')
    if (old) old.remove()
    const sel = window.getSelection()
    if (!sel.rangeCount) return null
    savedRange = sel.getRangeAt(0)
    const m = document.createElement('span')
    m.id = 've_mkr'; m.style.display = 'none'
    savedRange.insertNode(m)
    return m
  }

  function execCmd(cmd) {
    ed.focus()
    try {
      switch (cmd) {
        case 'table': markCursor(); insertTable(); break
        case 'slideshow': markCursor(); pickPhotos(); break
        case 'map': markCursor(); insertMap(); break
        case 'emoji': markCursor(); pickEmoji(); break
        case 'h1': case 'h2': case 'h3': toggleBlock(cmd); break
        case 'spoiler': toggleSpoiler(); break
        case 'task': toggleTask(); break
        case 'blockquote': toggleBlockquote(); break
        case 'pullquote': togglePullquote(); break
        case 'details': toggleDetails(); break
        case 'code': toggleCode(); break
        case 'sub': toggleSub(); break
        case 'sup': toggleSup(); break
        case 'mark': toggleMark(); break
        case 'math': insertMath(); break
        case 'pre': togglePre(); break
        case 'clear': clearEditor(); break
        default: document.execCommand(cmd, false, null)
      }
    } catch (e) { console.warn('cmd:', cmd, e) }
    ed.focus(); updatePreview()
  }

  /* === Inline Formatting === */

  function selectEnd(n) {
    const r = document.createRange(); r.selectNodeContents(n); r.collapse(false)
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
  }

  function toggleInline(className, placeholder) {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    if (sel.isCollapsed) {
      const sp = document.createElement('span')
      sp.className = className
      sp.textContent = placeholder
      r.insertNode(sp)
      const nr = document.createRange(); nr.setStartAfter(sp); nr.collapse(true)
      sel.removeAllRanges(); sel.addRange(nr)
      return
    }
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('.' + className.replace(/\s/g, '.'))
    if (existing) {
      existing.replaceWith(document.createTextNode(existing.textContent))
    } else {
      const s = document.createElement('span')
      s.className = className
      s.appendChild(r.extractContents())
      r.deleteContents()
      r.insertNode(s)
    }
  }

  function toggleSpoiler() { toggleInline('spoiler show', 'скрытый текст') }
  function toggleCode() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    if (sel.isCollapsed) {
      const c = document.createElement('code'); c.textContent = 'code'
      r.insertNode(c)
      const nr = document.createRange(); nr.setStartAfter(c); nr.collapse(true)
      sel.removeAllRanges(); sel.addRange(nr); return
    }
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('code')
    if (existing) { existing.replaceWith(document.createTextNode(existing.textContent)) }
    else { const c = document.createElement('code'); c.appendChild(r.extractContents()); r.deleteContents(); r.insertNode(c) }
  }
  function toggleSub() { toggleInline('tg-sub', 'sub') }
  function toggleSup() { toggleInline('tg-sup', 'sup') }
  function toggleMark() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    if (sel.isCollapsed) {
      const m = document.createElement('mark'); m.textContent = 'выделено'
      r.insertNode(m)
      const nr = document.createRange(); nr.setStartAfter(m); nr.collapse(true)
      sel.removeAllRanges(); sel.addRange(nr); return
    }
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('mark')
    if (existing) { existing.replaceWith(document.createTextNode(existing.textContent)) }
    else { const m = document.createElement('mark'); m.appendChild(r.extractContents()); r.deleteContents(); r.insertNode(m) }
  }

  /* === Block Formatting === */

  function toggleBlock(tag) {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    let node = r.commonAncestorContainer
    if (node.nodeType === 3) node = node.parentNode
    const block = node.closest('h1,h2,h3,p,li,div')
    if (block && ['H1', 'H2', 'H3'].includes(block.tagName)) {
      const p = document.createElement('p')
      p.innerHTML = block.innerHTML; block.replaceWith(p); selectEnd(p)
    } else {
      const h = document.createElement(tag)
      if (block && block.tagName === 'P') { h.innerHTML = block.innerHTML; block.replaceWith(h); selectEnd(h) }
      else { h.appendChild(r.extractContents()); r.deleteContents(); r.insertNode(h); selectEnd(h) }
    }
  }

  function toggleBlockquote() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('blockquote')
    if (existing) {
      const p = document.createElement('p'); p.innerHTML = existing.innerHTML; existing.replaceWith(p); selectEnd(p)
    } else {
      const bq = document.createElement('blockquote')
      const p = n.closest('p,li,h1,h2,h3,div')
      if (p && p.parentNode) { bq.innerHTML = p.innerHTML; p.replaceWith(bq); selectEnd(bq) }
      else { bq.appendChild(r.extractContents()); r.deleteContents(); r.insertNode(bq) }
    }
  }

  function togglePullquote() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('aside.pull-quote')
    if (existing) {
      const p = document.createElement('p')
      p.innerHTML = existing.innerHTML.replace(/<cite>[\s\S]*?<\/cite>/g, '')
      existing.replaceWith(p); selectEnd(p)
    } else {
      const a = document.createElement('aside'); a.className = 'pull-quote'
      const p = n.closest('p,li,h1,h2,h3,div')
      if (p && p.parentNode) { a.innerHTML = p.innerHTML; p.replaceWith(a); selectEnd(a) }
      else { a.appendChild(r.extractContents()); r.deleteContents(); r.insertNode(a) }
    }
  }

  function toggleDetails() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('details.tg-details')
    if (existing) {
      existing.replaceWith(document.createTextNode(existing.textContent.replace(existing.querySelector('summary')?.textContent || '', '').trim() || '[details]'))
    } else {
      const d = document.createElement('details'); d.className = 'tg-details'
      const sum = document.createElement('summary'); sum.textContent = 'Нажмите чтобы раскрыть'
      const body = document.createElement('div'); body.className = 'details-body'
      const selText = r.toString().trim()
      if (selText) {
        const p = document.createElement('p'); p.textContent = selText; body.appendChild(p)
        r.deleteContents()
      } else {
        const p = document.createElement('p'); p.textContent = 'скрытый контент'; body.appendChild(p)
      }
      d.appendChild(sum); d.appendChild(body); r.insertNode(d)
    }
  }

  function toggleTask() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('ul.task')
    if (existing) {
      const p = document.createElement('p')
      p.innerHTML = existing.innerHTML.replace(/<li[^>]*>/g, '• ').replace(/<\/li>/gi, '')
      existing.replaceWith(p)
    } else {
      const ul = document.createElement('ul'); ul.className = 'task'
      const selText = r.toString().trim()
      if (selText) {
        selText.split('\n').forEach((line) => {
          const li = document.createElement('li'); li.textContent = line.replace(/^[•\-*]\s*/, '')
          ul.appendChild(li)
        })
        r.deleteContents()
      } else {
        const li = document.createElement('li'); li.textContent = 'задача'; ul.appendChild(li)
      }
      r.insertNode(ul)
    }
  }

  function togglePre() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentNode
    const existing = n.closest('pre.tg-code')
    if (existing) {
      const p = document.createElement('p'); p.textContent = existing.textContent
      existing.replaceWith(p)
    } else {
      const pre = document.createElement('pre'); pre.className = 'tg-code'
      const selText = r.toString().trim()
      if (selText) { pre.textContent = selText; r.deleteContents() }
      else { pre.textContent = 'код' }
      r.insertNode(pre)
    }
  }

  function insertTable() {
    const t = document.createElement('table'); t.contentEditable = 'false'
    const h = document.createElement('tr')
    ;['A', 'B', 'C'].forEach((c) => {
      const th = document.createElement('th'); th.contentEditable = 'true'; th.textContent = c; h.appendChild(th)
    })
    t.appendChild(h)
    for (let i = 0; i < 2; i++) {
      const tr = document.createElement('tr')
      for (let j = 0; j < 3; j++) {
        const td = document.createElement('td'); td.contentEditable = 'true'; td.textContent = '—'; tr.appendChild(td)
      }
      t.appendChild(tr)
    }
    const r = window.getSelection().getRangeAt(0); r.deleteContents(); r.insertNode(t)
    const p = document.createElement('p'); p.innerHTML = '&nbsp;'; t.parentNode.insertBefore(p, t.nextSibling)
  }

  function insertMath() {
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const r = sel.getRangeAt(0)
    if (sel.isCollapsed) {
      const m = document.createElement('span'); m.className = 'tg-math'; m.textContent = 'E = mc²'
      r.insertNode(m)
      const nr = document.createRange(); nr.setStartAfter(m); nr.collapse(true)
      sel.removeAllRanges(); sel.addRange(nr)
    } else {
      let n = r.commonAncestorContainer
      if (n.nodeType === 3) n = n.parentNode
      const existing = n.closest('.tg-math')
      if (existing) { existing.replaceWith(document.createTextNode(existing.textContent)) }
      else {
        const m = document.createElement('span'); m.className = 'tg-math'
        m.appendChild(r.extractContents()); r.deleteContents(); r.insertNode(m)
      }
    }
  }

  /* === Photos / Slideshow === */

  function insertAfter(el) {
    const p = document.createElement('p'); p.innerHTML = '<br>'
    el.parentNode.insertBefore(p, el.nextSibling)
    selectEnd(p)
  }

  function pickPhotos() {
    const picker = $('#imgPicker')
    picker.value = ''
    picker.onchange = () => {
      if (!picker.files.length) return
      const m = document.getElementById('ve_mkr')
      if (!m) { showToast('Поставьте курсор в редакторе'); return }
      const files = Array.from(picker.files)
      const div = document.createElement('div'); div.className = 'slideshow'; div.dataset.count = files.length
      files.forEach((file, i) => {
        const img = document.createElement('img'); img.alt = file.name; img.draggable = false
        img.src = URL.createObjectURL(file); div.appendChild(img)
        const key = 'img_' + Date.now() + '_' + i; pendingImages[key] = file; img.dataset.imgKey = key
      })
      m.parentNode.replaceChild(div, m)
      insertAfter(div)
      updatePreview(); showToast('Добавлено ' + files.length + ' фото')
    }
    picker.click()
  }

  function insertMap() {
    const m = document.getElementById('ve_mkr')
    if (!m) { showToast('Поставьте курсор в редакторе'); return }
    const div = document.createElement('div'); div.className = 'map'
    div.dataset.lat = '55.751244'; div.dataset.lng = '37.618423'; div.dataset.address = 'Москва, Красная площадь'
    m.parentNode.replaceChild(div, m)
    insertAfter(div)
    ed.focus(); updatePreview()
  }

  function pickEmoji() {
    const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px'
    const hint = document.createElement('div')
    hint.style.cssText = 'font-size:12px;color:var(--hint);line-height:1.4'
    hint.innerHTML = 'ID emoji из стикер-пака. Создайте набор через @BotFather → /newpack → выберите emoji → получите ID стикера'
    const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Например: 512351235123'
    inp.style.cssText = 'padding:10px 14px;border-radius:8px;border:1px solid var(--border);font-size:14px;background:var(--bg);color:var(--text)'
    const btn = document.createElement('button'); btn.textContent = 'Вставить'
    btn.style.cssText = 'padding:10px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:14px;cursor:pointer'
    btn.onclick = () => {
      const id = inp.value.trim()
      if (!id) { showToast('Введите ID эмодзи'); return }
      const m = document.getElementById('ve_mkr')
      if (!m) { showToast('Поставьте курсор в редакторе'); return }
      const sp = document.createElement('span'); sp.className = 'tg-emoji'; sp.dataset.id = id; sp.textContent = '👍'
      m.parentNode.replaceChild(sp, m)
      const nr = document.createRange(); nr.setStartAfter(sp); nr.collapse(true)
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(nr)
      closeModal(); ed.focus(); updatePreview()
    }
    wrap.appendChild(hint); wrap.appendChild(inp); wrap.appendChild(btn)
    showModal('Кастомный эмодзи', wrap); inp.focus()
  }

  async function clearEditor() {
    if (!ed.innerText.trim()) return
    const ok = await showConfirm('Очистить редактор?')
    if (!ok) return
    ed.innerHTML = ''; pendingImages = {}; updateCounter(); updatePreview(); saveDraft()
    if (tg) tg.HapticFeedback?.impactOccurred?.('medium')
  }

  /* === Preview === */

  function updatePreview() {
    const html = ed.innerHTML; const text = ed.innerText; const msg = $('#preview-msg')
    if (!html || !text.trim()) { msg.innerHTML = '<p style="color:var(--hint);font-size:13px">Начните писать…</p>'; return }
    const clone = document.createElement('div'); clone.innerHTML = html
    clone.querySelectorAll('.spoiler').forEach((el) => { el.classList.remove('show'); el.classList.add('tg-spoiler') })
    clone.querySelectorAll('.slideshow').forEach((el) => { el.style.maxWidth = '100%'; el.style.display = 'flex' })
    clone.querySelectorAll('.map').forEach((el) => { el.style.maxWidth = '100%' })
    clone.querySelectorAll('.tg-sub').forEach((el) => { el.style.fontSize = '.8em'; el.style.verticalAlign = 'sub' })
    clone.querySelectorAll('.tg-sup').forEach((el) => { el.style.fontSize = '.8em'; el.style.verticalAlign = 'super' })
    clone.querySelectorAll('.tg-math').forEach((el) => { el.style.fontStyle = 'italic'; el.style.fontFamily = '"Times New Roman",serif' })
    const theme = document.body.classList.contains('dark') ? 'tg-dark' : 'tg-light'
    let content
    if (text.length > TRUNCATE_LEN && !previewExpanded) {
      const trunc = document.createElement('div'); trunc.className = 'tg-truncated'
      trunc.innerHTML = clone.innerHTML
      trunc.addEventListener('click', () => { previewExpanded = true; updatePreview() })
      const noTrunc = document.createElement('div'); noTrunc.appendChild(trunc); content = noTrunc.innerHTML
    } else { content = clone.innerHTML }
    const now = new Date()
    msg.className = 'tg-msg ' + theme + ' tg-channel'
    msg.innerHTML = content +
      '<div class="tg-date">' +
      String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') +
      ' · ' + String(now.getDate()).padStart(2, '0') + '.' + String(now.getMonth() + 1).padStart(2, '0') + '.' + now.getFullYear() +
      '</div>'
    msg.querySelectorAll('.tg-spoiler').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); el.classList.toggle('show') } })
    msg.querySelectorAll('ul.task li').forEach((el) => { el.onclick = (e) => { e.stopPropagation(); el.classList.toggle('done') } })
  }

  $('#btnPreview').onclick = () => {
    previewVisible = !previewVisible; $('#preview-wrap').classList.toggle('hidden', !previewVisible)
    previewExpanded = false; updatePreview()
    if (tg) tg.HapticFeedback?.impactOccurred?.('light')
  }

  $$('.pv-theme').forEach((b) => (b.onclick = () => applyTheme(b.dataset.theme)))

  /* === Channels === */

  async function loadChannels() {
    if (!userId) return
    try {
      const r = await fetch(API_BASE + '/api/channels?userId=' + userId)
      if (!r.ok) { console.warn('API channels:', r.status); channels = []; return }
      const d = await r.json(); channels = d.channels || []
    } catch (e) { channels = [] }
    renderChannelSel()
  }

  function renderChannelSel() {
    const sel = $('#channelSel')
    if (!sel) return
    sel.innerHTML = channels.map((c) => '<option value="' + c.id + '">' + c.title + '</option>').join('')
    $('#channelArea').classList.toggle('hidden', $('#destSel').value !== 'channel' || !channels.length)
  }

  $('#destSel').onchange = () => { $('#channelArea').classList.toggle('hidden', $('#destSel').value !== 'channel') }

  $('#btnManageCh').onclick = () => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px'
    const addRow = document.createElement('div'); addRow.style.cssText = 'display:flex;gap:8px'
    const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = '@username канала'
    inp.style.cssText = 'flex:1;padding:8px;border-radius:6px;border:1px solid var(--border);font-size:14px;background:var(--bg);color:var(--text)'
    const addBtn = document.createElement('button'); addBtn.textContent = '+'
    addBtn.style.cssText = 'padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:16px'
    addRow.appendChild(inp); addRow.appendChild(addBtn)
    const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto'

    function renderChList() {
      list.innerHTML = channels.map((c) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--sec);border-radius:6px">' +
        '<span>' + c.title + '</span>' +
        '<button class="ch-rm" data-id="' + c.id + '" style="padding:4px 10px;background:var(--danger);color:#fff;border:none;border-radius:4px;cursor:pointer">✕</button></div>'
      ).join('')
      list.querySelectorAll('.ch-rm').forEach((b) => {
        b.onclick = async () => {
          const chId = Number(b.dataset.id)
                     await fetch(API_BASE + '/api/channels/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, channelId: chId }) })
          channels = channels.filter((c) => c.id !== chId); renderChList(); renderChannelSel()
        }
      })
    }
    renderChList()

    addBtn.onclick = async () => {
      if (!inp.value.trim()) return
      try {
        const r = await fetch(API_BASE + '/api/channels/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, username: inp.value.trim() }) })
        let txt; try { txt = await r.text(); const d = JSON.parse(txt); if (d.ok) { channels.push(d.channel); renderChList(); renderChannelSel(); inp.value = ''; showToast('✅ Канал добавлен'); return } else { txt = d.error || 'Ошибка' } } catch (e) { txt = 'HTTP ' + r.status + ' — сервер не отвечает' }
        showToast('❌ ' + txt)
      } catch (e) { showToast('❌ Нет сети') }
    }
    wrap.appendChild(addRow); wrap.appendChild(list)
    showModal('Управление каналами', wrap)
  }

  /* === Publish === */

  $('#btnPublish').onclick = async () => {
    const html = ed.innerHTML; const text = ed.innerText
    if (!text.trim()) { showToast('Напишите что-нибудь'); return }
    const dest = $('#destSel').value
    const btn = $('#btnPublish'); btn.disabled = true; btn.textContent = '⏳ Отправка…'
    const ac = new AbortController()
    const tm = setTimeout(() => ac.abort(), 25000)

    try {
      const imgKeys = Object.keys(pendingImages)
      let finalHtml = html
      let r

      if (imgKeys.length > 0) {
        const fd = new FormData()
        fd.append('userId', userId); fd.append('destination', dest); fd.append('html', html); fd.append('text', text)
        if (dest === 'channel') { const chId = Number($('#channelSel').value); if (chId) fd.append('channelId', String(chId)) }
        for (const key of imgKeys) {
          const file = pendingImages[key]
          if (file) {
            fd.append(key, file, file.name || key + '.jpg')
            const re = new RegExp('<img[^>]*data-img-key="' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*/?>', 'g')
            finalHtml = finalHtml.replace(re, '<img src="attach://' + key + '">')
          }
        }
        fd.set('html', finalHtml)
        r = await fetch(API_BASE + '/api/publish', { method: 'POST', body: fd, signal: ac.signal })
      } else {
        const body = { userId, destination: dest, html, text }
        if (dest === 'channel') { const chId = Number($('#channelSel').value); if (chId) body.channelId = chId }
        r = await fetch(API_BASE + '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal })
      }
      clearTimeout(tm)

      let txt
      try { txt = await r.text(); const d = JSON.parse(txt); if (d.ok) { showToast('✅ Опубликовано!'); if (d.link) showToast('📎 ' + d.link, 4000); pendingImages = {}; btn.disabled = false; btn.textContent = '📤 Опубликовать'; return } else { txt = d.error || 'Ошибка' } }
      catch (e) { txt = 'HTTP ' + r.status + ' — сервер не отвечает' }
      showToast('❌ ' + txt)
    } catch (e) { showToast('❌ ' + (e.name === 'AbortError' ? 'Таймаут — сервер не ответил за 25с' : 'Нет сети')) }
    btn.disabled = false; btn.textContent = '📤 Опубликовать'
  }

  /* === Keyboard shortcuts === */

  ed.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('#btnPublish').click() }
    if (e.key === 'Enter' && e.shiftKey) {
      const sel = window.getSelection()
      if (sel.rangeCount) {
        const r = sel.getRangeAt(0); let n = r.commonAncestorContainer
        if (n.nodeType === 3) n = n.parentNode
        if (n.closest('h1,h2,h3,blockquote,aside,li')) { e.preventDefault(); document.execCommand('insertLineBreak') }
      }
    }
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '    ') }
  })

  console.log('VisualEditor v2 loaded')
})()
