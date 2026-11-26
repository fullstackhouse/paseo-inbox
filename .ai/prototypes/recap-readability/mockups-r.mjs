// Area R: the "Since your review" panel on the paseo-inbox review screen (client/Recap.tsx).
// Fixtures are fictional. Drawn in Paseo's Zinc dark theme (rr- block at the end of screens.css).

export function reviewStates({ esc, change }) {
  // ── fixtures ───────────────────────────────────────────────────────────
  const FIXED = {
    tone: 'success', status: 'Fixed · resolved', addressed: ['Addressed', 'success'], path: 'infra/prod/', file: 'http-probe.tf:1',
    body: 'Please redo the heartbeat on Kubernetes rather than as a custom probe job: HTTP probes that restart a frozen pod, and alerts on Kubernetes state. The gap is that the app\'s probes (app.tf, startup/liveness/readiness) are tcp_socket, and the kernel accepts the connection even when the event loop is stuck.',
    note: 'All three probes are http_get on /api/health/live with 5 s timeouts and liveness failure_threshold 6. The CronJob and its rules are gone, the k8s-infra chart is installed, and the generic k8s rules were added.',
    reply: ['nina-k', 'Scratch the dnstest question. It is a finished one-off pod (phase Succeeded), so the rule was wrong, not the pod. Fixed in 490b2ab: the rule now skips Succeeded pods.'],
  }
  const UNANSWERED = {
    tone: 'danger', status: 'Unanswered', addressed: ['Not addressed', 'danger'], path: 'apps/shop/src/', file: 'checkout.ts:88',
    body: 'This retries the payment capture without an idempotency key, so a timeout after the provider accepted it charges twice.',
    note: 'Still calls capture() with no key; the retry loop is unchanged.',
  }
  const PUSHED = {
    tone: 'warning', status: 'Pushed back', addressed: ['Partly addressed', 'warning'], path: 'apps/shop/src/', file: 'cart.ts:41',
    body: 'Round per line, not on the total, or the invoice and the cart disagree by a cent.',
    note: 'Rounds per line now, but the shipping line still rounds on the total.',
    reply: ['nina-k', 'Shipping is one line, so per-line and total rounding are the same there.'],
  }
  const LOGIC = [
    ['infra/prod/', 'app.tf', 'TCP → HTTP probes, new timeouts, liveness 3 → 6 failures.'],
    ['infra/staging/', 'app.tf', 'Same probe change as prod.'],
    ['infra/cluster/k8s-infra/', 'main.tf', 'New helm release of k8s-infra 0.17.1, metrics only, host ports closed.'],
    ['infra/alerts/', 'k8s-replicas-unavailable-prod.json', 'desired − available > 0 for 5 min, critical, alertOnAbsent 15 min.'],
    ['infra/alerts/', 'error-rate-prod.json', 'Excludes http.target LIKE /api/health/% from both queries.'],
    ['infra/alerts/', 'error-rate.json', 'Same exclusion on staging.'],
  ]
  const MECHANICAL = [
    ['infra/cluster/', 'main.tf', "Wires the module to dev's otel-gateway."],
    ['infra/alerts/', 'k8s-replicas-unavailable-staging.json', 'Staging copy, warning, no absent alert.'],
    ['infra/alerts/', 'k8s-pods-unready-staging.json', 'Staging copy of the unready rule.'],
    ['infra/alerts/', 'k8s-restart-loop-staging.json', 'Staging copy of the restart-loop rule.'],
    ['infra/', 'alerts.json', 'Six new entries with id null until pushed.'],
    ['infra/', 'README.md', 'Rule rows, Kubernetes workloads runbook section.'],
    ['apps/shop/src/', 'modules.ts', 'Comment now points at the probes instead of the CronJob.'],
  ]
  const FULL = { pill: ['Full re-look', 'warning'], why: 'The PR was redone after the previous review: the CronJob heartbeat was replaced by HTTP probes, k8s-infra and six new alert rules, so nearly every file is new.' }
  const CHECK = { pill: ['Check 2 things', 'success'], items: ['The capture retry now that checkout.ts moved the loop into payments.ts.', 'Shipping rounding against the invoice totals.'] }

  // ── pieces ─────────────────────────────────────────────────────────────
  const m = (mark, kind) => (mark ? change(kind) : '')
  const path = (dir, file) => `<span class="rr-path">${esc(dir)}${esc(file)}</span>`
  const sinceLine = (text, chip) => `<div class="rr-row"><span class="rr-muted">${esc(text)}</span>${chip ? `<span class="rr-chip">${esc(chip)}</span>` : ''}</div>`
  const look = (ai, mark) =>
    `<div class="rr-block" style="gap:6px"${m(mark, 'changed')}><span class="rr-pill ${ai.pill[1]}">${esc(ai.pill[0])}</span>${ai.why ? `<div class="rr-text">${esc(ai.why)}</div>` : ''}${(ai.items ?? []).map((item) => `<div class="rr-text">• ${esc(item)}</div>`).join('')}</div>`
  const section = (title, extra, body, mark) => `<div class="rr-block rr-sec"${m(mark, 'new')}><div class="rr-title">${esc(title)}${extra ? ` <i>· ${esc(extra)}</i>` : ''}</div>${body}</div>`
  const reviews = (mark) => section('YOUR REVIEWS', '', `<div style="font-size:13px">changes requested · 1 comment · 3h ago · <span class="rr-path">3cfa72c</span> ↗</div>`, mark)
  const comment = (c, { ai = true, mark = false } = {}) =>
    `<div class="rr-comment ${c.tone}"${m(mark, 'new')}>
      <div class="rr-row" style="gap:6px"><span class="rr-pill ${c.tone}">${esc(c.status)}</span>${ai ? `<span class="rr-pill o ${c.addressed[1]}">${esc(c.addressed[0])}</span>` : ''}${path(c.path, c.file)}</div>
      <div class="rr-text rr-clamp">${esc(c.body)}</div>
      ${ai ? `<div class="rr-note"><b${m(mark, 'new')}>Reviewer: </b>${esc(c.note)}</div>` : ''}
      ${c.reply ? `<div class="rr-note rr-clamp"><b>@${esc(c.reply[0])}: </b>${esc(c.reply[1])}</div>` : ''}
    </div>`
  const comments = (list, summary, opts) => section('YOUR COMMENTS', summary, list.map((c) => comment(c, opts)).join(''))
  const changeRow = ([dir, file, note], removedPill) =>
    `<div class="rr-change">${removedPill ? `<span class="rr-pill ${removedPill === 'Logic' ? 'warning' : 'o muted'}"${change('removed')}>${removedPill}</span>` : ''}${path(dir, file)}<div class="rr-text">${esc(note)}</div></div>`
  const logic = (mark) => section('OTHER CHANGES', `${LOGIC.length} logic changes`, LOGIC.map((row) => changeRow(row, mark ? 'Logic' : '')).join(''))
  const mechanical = ({ open = false, mark = false } = {}) =>
    section(
      'MECHANICAL',
      `${MECHANICAL.length} files`,
      `${open ? MECHANICAL.map((row) => changeRow(row)).join('') : `<div class="rr-note rr-clamp"${m(mark, 'new')}>${MECHANICAL.map(([, file]) => esc(file)).join(', ')}</div>`}<span class="rr-link"${m(mark, 'new')}>${open ? 'Hide' : 'Show'} mechanical changes</span>`,
    )

  const pane = (card, { phone = false, title = 'Kubernetes heartbeat: HTTP probes and k8s alerts' } = {}) =>
    `<div class="frame ka-frame"><div class="ka-screen rr-screen${phone ? ' rr-phone' : ''}" style="min-height:0">
      <div class="rr-head"><b>#1519</b><span>${esc(title)}</span></div>
      <div class="rr-tabs"><span class="on">Summary</span><span>Files 15</span><span>Since</span></div>
      <div class="rr-card">${card}</div>
      <div class="rr-draft">Draft review (verdict, body, comments) follows here — unchanged.</div>
    </div></div>`
  const header = (since, chip, extra = '') => `<div class="rr-block"><div class="rr-title">SINCE YOUR REVIEW</div>${sinceLine(since, chip)}${extra}</div>`
  const SINCE = '2 commits, 15 files since your last review (3cfa72c, 3h ago).'

  const full = ({ marks = false, open = false, phone = false } = {}) =>
    pane(
      `${header(SINCE, 'Since 3cfa72c', look(FULL, marks))}${reviews(marks)}${comments([FIXED], '1 fixed', { mark: marks })}${logic(marks)}${mechanical({ open, mark: marks })}`,
      { phone },
    )

  // ── states ─────────────────────────────────────────────────────────────
  return {
    R1: [
      { id: 's1', caption: 'Full re-look: one fixed comment, 6 logic and 7 mechanical changes', html: full({ marks: true }), notes: ['Changes on: per-row Logic pills shown as removed; with Changes off this is the target state.'] },
      { id: 's2', caption: 'Mechanical changes shown', html: full({ open: true }), notes: ['"Show mechanical changes" expands in place; the choice is not remembered across PRs.'] },
      {
        id: 's3',
        caption: 'Check 2 things: an unanswered and a pushed-back comment',
        html: pane(`${header('1 commit, 3 files since your last review (8d41e0a, 1d ago).', 'Since 8d41e0a', look(CHECK))}${reviews()}${comments([UNANSWERED, PUSHED], '1 pushed back, 1 unanswered')}${section('OTHER CHANGES', '1 logic change', changeRow(['apps/shop/src/', 'payments.ts', 'Capture retry moved here from checkout.ts; same loop.']))}`, { title: 'Round cart lines before invoicing' }),
      },
      { id: 's4', caption: 'No new commits since your review', html: pane(`${header('No new commits since your last review (3cfa72c, 3h ago).', '')}${reviews()}${comments([PUSHED], '1 pushed back')}`, { title: 'Round cart lines before invoicing' }), notes: ['Shown because a reply arrived; with nothing to say beyond the Since tab the panel is hidden.'] },
      {
        id: 's5',
        caption: "The reviewer hasn't written its verdicts yet",
        html: pane(`${header(SINCE, 'Since 3cfa72c')}${reviews()}${comments([FIXED], '1 fixed', { ai: false })}`),
        notes: ['No look pill, no Addressed pills, no change lists until the draft carries its recap.'],
      },
      { id: 's6', caption: 'Phone width (390)', html: full({ phone: true }) },
      {
        id: 's7',
        caption: 'Force-pushed or rebased since the review',
        html: pane(`<div class="rr-block"><div class="rr-title">SINCE YOUR REVIEW</div><div class="rr-warn" style="font-size:14px">The branch was force-pushed or rebased since your last review (3cfa72c), so there's no clean diff of what changed. Review it in full.</div><span class="rr-chip" style="align-self:flex-start">Open Files</span>${look(FULL)}</div>${reviews()}${comments([FIXED], '1 fixed')}`),
      },
      {
        id: 's8',
        caption: 'Over 300 changed files: one comment unknown',
        html: pane(`${header('3 commits, at least 300 files since your last review (3cfa72c, 3h ago).', 'Since 3cfa72c', `<div class="rr-warn">GitHub lists at most 300 changed files and the full list couldn't be read, so 1 comment is marked unknown: check it in the diff.</div>${look(FULL)}`)}${reviews()}${section('YOUR COMMENTS', '1 unknown', `<div class="rr-comment" style="border-color:var(--app-p-muted)"><div class="rr-row" style="gap:6px"><span class="rr-pill muted">Unknown</span>${path('infra/prod/', 'http-probe.tf:1')}</div><div class="rr-text rr-clamp">${esc(FIXED.body)}</div></div>`)}`),
      },
      {
        id: 's9',
        caption: "GitHub couldn't be read",
        html: pane(`${header(SINCE, 'Since 3cfa72c', look(FULL))}<div class="rr-err">Couldn't read your earlier comments: HTTP 502 from api.github.com.</div>`),
        notes: ['The since line and the diff still work; reviews and comment statuses are left out.'],
      },
    ],
  }
}
