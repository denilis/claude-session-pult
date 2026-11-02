import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Limits, Net, Row, Snapshot, StyleId } from '../types'

const PANE = 'session-pult'
const TITLE = 'Пульт сессий'
const REFRESH_MS = 90_000
// Страна и скорость: замер расходует трафик, поэтому редко и один на все сессии
const NET_EVERY_MS = 30 * 60_000
const HEAVY_CTX = 300_000
// Python 3 для сборщика: сначала лаунчер py с python.org, затем то, что найдётся в PATH
const PYTHONS = [['py', '-3'], ['python'], ['python3']]
const NO_PYTHON =
  'Графики по всем сессиям строит Python 3, он не найден. Установите его с python.org с галочкой «Add python.exe to PATH». ' +
  'Кольца лимитов и кнопки работают и без него.'

// Сменить тег, если поменялись поля: старое значение из прошлой версии будет отклонено
const snap = atom({ plugin: 'session-pult', key: 'snap' } as const, null, { shape: 'snap-5' })
const limits = atom({ plugin: 'session-pult', key: 'limits' } as const, null, { shape: 'limits-1' })
const error = atom({ plugin: 'session-pult', key: 'error' } as const, null, { shape: 'error-1' })
const compacting = atom({ plugin: 'session-pult', key: 'compacting' } as const, false, { shape: 'compacting-1' })
const lastTurnAt = atom({ plugin: 'session-pult', key: 'lastTurnAt' } as const, null, { shape: 'last-turn-1' })
const turnRunning = atom({ plugin: 'session-pult', key: 'turnRunning' } as const, false, { shape: 'turn-running-1' })
const coldHidden = atom({ plugin: 'session-pult', key: 'coldHidden' } as const, null, { shape: 'cold-hidden-1' })
const pendingClear = atom({ plugin: 'session-pult', key: 'pendingClear' } as const, null, { shape: 'pending-clear-1' })
const replyTo = atom({ plugin: 'session-pult', key: 'replyTo' } as const, null, { shape: 'reply-to-1' })
const style = atom({ plugin: 'session-pult', key: 'style' } as const, 'gold', { shape: 'style-1' })
const net = atom({ plugin: 'session-pult', key: 'net' } as const, null, { shape: 'net-1' })

// Что кнопки отправляют от имени пользователя. Тексты самодостаточные: не опираются на чужие CLAUDE.md,
// а агентов и скиллы называют только как необязательные
const MEMORY_MARK = 'Перед очисткой контекста сохрани память проекта'
const ASKS = {
  status:
    'Статус сессии, кратко, четырьмя блоками: выполнено (с результатами), не получилось и почему, ' +
    'в процессе, осталось (с оценкой времени). Ничего нового не начинай.',
  report:
    'Итоговый отчёт по последней задаче в 4 пунктах: задача; решена ли, с цифрами и фактами; ' +
    'почему решение оптимально и какую альтернативу отвергли; как было и как стало.',
  check:
    'Проверь последний результат перед отправкой: цифры против источников, арифметику, логику выводов, ' +
    'опечатки, следы ИИ в тексте. Если есть агент editor-qa или скилл humanizer-ru-pro, используй их. ' +
    'Блокеры исправь, остальные замечания перечисли.',
  memory:
    `${MEMORY_MARK}: запиши в PROJECT_MEMORY.md в корне проекта (если есть скилл project-memory, через него) ` +
    'цель, что сделано, решения и почему, пути к файлам, что осталось. Ответь одной строкой.',
  resume:
    'Контекст очищен кнопкой «Новый лист». Если памяти проекта ещё нет в контексте, прочитай PROJECT_MEMORY.md ' +
    'в корне проекта. Ответь одной строкой, на чём остановились.',
}
// Кэш промпта живёт час: после часа тишины весь контекст читается заново по цене записи
const COLD_MIN = 60
const WARN_MIN = 45
const COLD_CTX = 100_000
// Без своей модели эти агенты берут модель родителя, то есть Opus; им ставим Sonnet
const INHERIT_BUILTIN = new Set(['general-purpose', 'claude'])
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const RUNDLL32 = 'C:\\Windows\\System32\\rundll32.exe'
// Пороги уведомлений о лимите, %
const ALERT_PCT = 80
const FORECAST_FROM_PCT = 40
// Об ожидании сообщаем только свежем: при запуске пульта старые строки не должны засыпать уведомлениями
const WAIT_FRESH_MIN = 15
// Получатель видит ответ как сообщение другой сессии, поэтому в тексте сказано, чей он
const REPLY_MARK = 'Ответ пользователя из панели «Пульт сессий»:'

// Что сводка сжатия обязана сохранить, чтобы работа шла дальше без переспросов
const COMPACT_HINT =
  'Пиши сводку по-русски. Сохрани: цель и текущую задачу; принятые решения и почему; ' +
  'полные пути к файлам, которые меняли или читали; что сделано и что осталось; ' +
  'ошибки и как их обошли; договорённости и запреты пользователя из этого разговора.'

// Оформления на выбор. Золото и Синий: один оттенок с градиентом металла, фон карточек внутри картинки,
// вид не зависит от темы приложения. Цветной: статусы разными цветами, подстраивается под тему приложения
type Look = {
  id: StyleId
  label: string
  // Цвет по уровню вместо градиента, без карточек
  flat: boolean
  // Фон всей панели; на нём подпись обычной кнопки сливается, поэтому нужны плотные кнопки
  page?: string
  solid: boolean
  // Цвет подписей приложения; без него они приглушённые своей темы
  note?: string
  ink: string
  muted: string
  hi: string
  mid: string
  lo: string
  alarm: string
  warn: string
  good: string
  track: string
  line: string
  cardTop: string
  cardEnd: string
  glow: string
  ctx: string
  cold: string
  status: Record<Row['status'], string>
  models: [string, string][]
}

const COLOR: Look = {
  id: 'color',
  label: 'Цветной',
  flat: true,
  solid: false,
  ink: '#1f2328',
  muted: '#6b7280',
  hi: '#3b82f6',
  mid: '#06b6d4',
  lo: '#3b82f6',
  alarm: '#ef4444',
  warn: '#f59e0b',
  good: '#22c55e',
  track: '#e5e7eb',
  line: '#d1d5db',
  cardTop: 'transparent',
  cardEnd: 'transparent',
  glow: 'transparent',
  ctx: '#3b82f6',
  cold: '#06b6d4',
  status: { running: '#22c55e', waiting: '#f59e0b', limit: '#ef4444', stopped: '#94a3b8' },
  models: [['opus', '#8b5cf6'], ['sonnet', '#06b6d4'], ['haiku', '#22c55e'], ['fable', '#f59e0b']],
}

// «Золотой нуар»: золото единственная краска, зелёный только для плюсов, персик для тревоги, красного нет
const GOLD: Look = {
  id: 'gold',
  label: 'Золото',
  flat: false,
  page: '#141317',
  solid: true,
  note: '#9A938A',
  ink: '#F4E9D8',
  muted: '#9A938A',
  hi: '#E7C989',
  mid: '#D4AF6A',
  lo: '#8A6B33',
  alarm: '#E8A26B',
  warn: '#D4AF6A',
  good: '#7FBF8E',
  track: '#2A2830',
  line: 'rgba(212,175,106,.15)',
  cardTop: '#26242A',
  cardEnd: '#1C1B20',
  glow: '#3A3222',
  ctx: '#E7C989',
  cold: '#D4AF6A',
  status: { running: '#7FBF8E', waiting: '#E7C989', limit: '#E8A26B', stopped: '#9A938A' },
  models: [['opus', '#E7C989'], ['sonnet', '#8A6B33'], ['haiku', '#7FBF8E'], ['fable', '#E8A26B']],
}

// Светлые карточки и глубокий синий: спокойный деловой вид
const BLUE: Look = {
  id: 'blue',
  label: 'Синий',
  flat: false,
  solid: false,
  ink: '#0B1F4B',
  muted: '#5F6B85',
  hi: '#3D7BFF',
  mid: '#0B4FD6',
  lo: '#002882',
  alarm: '#E8590C',
  warn: '#0B4FD6',
  good: '#1F9D6B',
  track: '#E4E9F5',
  line: 'rgba(0,40,130,.14)',
  cardTop: '#FFFFFF',
  cardEnd: '#F5F7FC',
  glow: '#E3ECFF',
  ctx: '#0B4FD6',
  cold: '#0B4FD6',
  status: { running: '#1F9D6B', waiting: '#0B4FD6', limit: '#E8590C', stopped: '#8A94A8' },
  models: [['opus', '#002882'], ['sonnet', '#3D7BFF'], ['haiku', '#1F9D6B'], ['fable', '#E8590C']],
}

const LOOKS = [COLOR, GOLD, BLUE]

const STATUS: Record<Row['status'], { label: string; short: string }> = {
  running: { label: 'работает', short: 'работает' },
  waiting: { label: 'ждёт вас', short: 'ждёт вас' },
  limit: { label: 'лимит', short: 'лимит' },
  stopped: { label: 'остановлена', short: 'стоп' },
}

const styleOf = (c: Look) =>
  '<style>' +
  "text{font-family:'Segoe UI','SF Pro Display',system-ui,sans-serif}" +
  (c.flat
    ? `.t{fill:${c.ink};font-size:12px;font-weight:600}.n,.h{fill:${c.ink};font-size:12px;font-weight:700}` +
      `.l,.m{fill:${c.muted};font-size:11px}.b{fill:${c.ink};font-size:18px;font-weight:700}` +
      `.tr{stroke:${c.track}}.trf{fill:${c.track}}.grid{stroke:${c.line}}` +
      '@media (prefers-color-scheme: dark){.t,.n,.h,.b{fill:#e5e7eb}.l,.m{fill:#9ca3af}.tr{stroke:#374151}.trf{fill:#374151}.grid{stroke:#4b5563}}'
    : `.t{fill:${c.ink};font-size:12px}.n{fill:${c.ink};font-size:12.5px}.l{fill:${c.ink};font-size:11px}` +
      `.m{fill:${c.muted};font-size:11px}.h{fill:${c.muted};font-size:10.5px;letter-spacing:.1em}` +
      `.b{fill:${c.ink};font-size:20px;font-weight:300}.a{fill:${c.hi};font-weight:600}` +
      `.tr{stroke:${c.track}}.trf{fill:${c.track}}.grid{stroke:${c.line}}`) +
  '</style>'

// Графики строятся синхронно внутри одной отрисовки, поэтому текущее оформление держим здесь, а не в параметрах
let C: Look = GOLD
let STYLE = styleOf(GOLD)

function useLook(id: StyleId) {
  C = LOOKS.find(look => look.id === id) ?? GOLD
  STYLE = styleOf(C)
}

// Ширина карточки и её содержимого; строка сессии уже, рядом с ней стоит кнопка статуса
const OUT_W = 320
const PAD_X = 12
const PAD_Y = 10
const W = OUT_W - PAD_X * 2
const ROW_W = 196

const METAL = 'url(#metal)'
const num = (n: number, digits = 1) => n.toFixed(digits).replace('.', ',')
const thousands = (n: number) => `${Math.round(n / 1000)} тыс.`
const kilo = (n: number) => `${Math.round(n / 1000)}K`
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cut = (s: string, n: number) => esc(s.length > n ? `${s.slice(0, n - 1)}…` : s)
const cap = (s: string) => (C.flat ? s : s.toUpperCase())
// Краска по уровню: в цветном оформлении три цвета, в остальных градиент и тревога
const level = (pct: number) => (pct >= 85 ? C.alarm : pct >= 60 ? C.warn : C.good)
const paint = (pct: number, gradient: string) => (C.flat ? level(pct) : pct >= 85 ? C.alarm : gradient)
const areaFill = (pct: number) => (C.flat || pct >= 85 ? `fill="${paint(pct, '')}" fill-opacity=".18"` : 'fill="url(#fall)"')
const ctxPaint = (n: number) => (n >= HEAVY_CTX ? C.alarm : !C.flat ? 'url(#ring)' : n >= 150_000 ? C.warn : C.good)
const idle = (min: number) => (min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`)
const stops = `<stop stop-color="#000" stop-opacity="0"/>`
const defs = (w: number) => {
  const metal = C.flat ? stops : `<stop stop-color="${C.lo}"/><stop offset="1" stop-color="${C.hi}"/>`
  return (
    '<defs>' +
    `<linearGradient id="metal" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${w}" y2="0">${metal}</linearGradient>` +
    `<linearGradient id="fillh" x1="0" y1="0" x2="1" y2="0">${metal}</linearGradient>` +
    `<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">${metal}</linearGradient>` +
    `<linearGradient id="bar" x1="0" y1="1" x2="0" y2="0">${metal}</linearGradient>` +
    `<linearGradient id="fall" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${C.mid}" stop-opacity=".32"/><stop offset="1" stop-color="${C.mid}" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="card" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${C.cardTop}"/><stop offset="1" stop-color="${C.cardEnd}"/></linearGradient>` +
    `<radialGradient id="glow" cx=".2" cy="0" r="1.2"><stop stop-color="${C.glow}"/><stop offset=".55" stop-color="${C.cardTop}"/></radialGradient>` +
    '</defs>'
  )
}
const doc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${STYLE}${defs(w)}${body}</svg>`
// Карточка с каймой; h и содержимое считаются без внутренних отступов. В цветном оформлении карточки нет
const svg = (h: number, body: string, fill = 'card') => {
  if (C.flat) return doc(W, h, body)
  const outH = h + PAD_Y * 2
  return doc(
    OUT_W,
    outH,
    `<rect x=".5" y=".5" width="${OUT_W - 1}" height="${outH - 1}" rx="14" fill="url(#${fill})" stroke="${C.line}"/>` +
      `<g transform="translate(${PAD_X} ${PAD_Y})">${body}</g>`,
  )
}

function clock(ms: number, tz: number) {
  const d = new Date(ms + tz * 60_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function dayClock(ms: number, tz: number) {
  const d = new Date(ms + tz * 60_000)
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${clock(ms, tz)}`
}

// Круговая шкала: кольцо и число; в оформлениях с металлом ещё насечки снаружи и жирный акцент внутри числа
function ring(cx: number, pct: number, stroke: string, value: string, label: string, sub: string) {
  const cy = 42
  const r = C.flat ? 34 : 30
  const width = C.flat ? 9 : 7
  const len = 2 * Math.PI * r
  const v = (clamp(pct, 0, 100) / 100) * len
  const arc =
    v > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${v.toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : ''
  const big = value.endsWith('%') ? `<tspan class="a">${value.slice(0, -1)}</tspan>%` : value
  const ticks = C.flat
    ? ''
    : `<circle cx="${cx}" cy="${cy}" r="38" fill="none" stroke="${C.mid}" stroke-opacity=".5" stroke-width="1.5" stroke-dasharray="1.5 6.46"/>`
  return (
    ticks +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" class="tr" stroke-width="${width}"/>${arc}` +
    `<text x="${cx}" y="${cy + 6}" text-anchor="middle" class="b" style="font-size:18px">${big}</text>` +
    `<text x="${cx}" y="${cy + 54}" text-anchor="middle" class="h">${cap(label)}</text>` +
    `<text x="${cx}" y="${cy + 68}" text-anchor="middle" class="m">${sub}</text>`
  )
}

function gaugesSvg(lim: Limits | null, tz: number) {
  const five = lim?.rateLimits.find(r => r.kind === 'five_hour')
  const week = lim?.rateLimits.find(r => r.kind === 'seven_day')
  const ctx = lim?.context
  const body =
    (five
      ? ring(48, five.percentUsed, paint(five.percentUsed, 'url(#ring)'), `${Math.round(five.percentUsed)}%`, '5 часов',
          five.resetsAt ? `сброс ${clock(Date.parse(five.resetsAt), tz)}` : '')
      : ring(48, 0, C.muted, '—', '5 часов', 'после ответа')) +
    (week
      ? ring(148, week.percentUsed, paint(week.percentUsed, 'url(#ring)'), `${Math.round(week.percentUsed)}%`, 'Неделя',
          week.resetsAt ? `сброс ${dayClock(Date.parse(week.resetsAt), tz)}` : '')
      : ring(148, 0, C.muted, '—', 'Неделя', '')) +
    (ctx?.tokens !== undefined
      ? ring(248, ctx.percent ?? 0, ctxPaint(ctx.tokens), `${ctx.percent ?? 0}%`, 'Контекст', thousands(ctx.tokens))
      : ring(248, 0, C.muted, '—', 'Контекст', ''))
  const alt = `Лимит 5 часов ${five ? Math.round(five.percentUsed) : '?'}%, неделя ${week ? Math.round(week.percentUsed) : '?'}%, контекст ${ctx?.percent ?? '?'}%`
  return { source: svg(114, body, 'glow'), alt }
}

function forecastSvg(s: Snapshot | null, lim: Limits | null, now: number, tz: number) {
  const five = lim?.rateLimits.find(r => r.kind === 'five_hour')
  const head = `<text x="0" y="12" class="h">${cap('5-часовое окно')}</text>`
  if (!s || !five || !s.winStart) {
    return { source: svg(34, `${head}<text x="0" y="31" class="m">нет данных об окне, появятся после ответа модели</text>`), alt: 'Нет данных об окне' }
  }
  const x0 = 26
  const x1 = W - 4
  // Сверху запас под прогноз: заголовок и подпись «кончится» не должны наезжать друг на друга
  const yTop = 36
  const yBot = 94
  const x = (min: number) => x0 + (clamp(min, 0, 300) / 300) * (x1 - x0)
  const y = (pct: number) => yBot - (clamp(pct, 0, 100) / 100) * (yBot - yTop)
  const nowMin = clamp((now - s.winStart) / 60_000, 0, 300)
  const pct = five.percentUsed
  const done = s.winBuckets.filter((_, i) => i * 10 < nowMin)
  const sum = done.reduce((a, b) => a + b, 0)
  const k = sum > 0 ? pct / sum : 0
  let cum = 0
  let line = `M${x(0)},${y(0)}`
  done.forEach((v, i) => {
    cum += v * k
    line += ` L${x(Math.min((i + 1) * 10, nowMin)).toFixed(1)},${y(cum).toFixed(1)}`
  })
  line += ` L${x(nowMin).toFixed(1)},${y(pct).toFixed(1)}`
  const area = `${line} L${x(nowMin).toFixed(1)},${yBot} Z`

  const perMin = s.rate30Pct / 30
  let proj = ''
  let note = 'сейчас почти не тратится'
  if (perMin >= 0.01) {
    const hitMin = nowMin + (100 - pct) / perMin
    const endMin = Math.min(300, hitMin)
    const endPct = pct + perMin * (endMin - nowMin)
    const hits = hitMin < 300
    const color = hits ? C.alarm : C.muted
    const ex = x(endMin)
    proj =
      `<path d="M${x(nowMin).toFixed(1)},${y(pct).toFixed(1)} L${ex.toFixed(1)},${y(endPct).toFixed(1)}" stroke="${color}" stroke-width="1.6" stroke-dasharray="5 4" fill="none"/>` +
      (hits ? `<circle cx="${ex.toFixed(1)}" cy="${y(100)}" r="4" fill="${C.alarm}"/>` : '')
    note = hits
      ? `кончится ≈ ${clock(s.winStart + hitMin * 60_000, tz)}`
      : `к сбросу ≈ ${Math.round(endPct)}%`
    const lx = clamp(ex, x0 + 90, x1)
    proj += `<text x="${lx.toFixed(1)}" y="${hits ? yTop - 7 : y(endPct) - 7}" text-anchor="end" class="t" style="fill:${color}">${note}</text>`
  }
  const resets = five.resetsAt ? Date.parse(five.resetsAt) : s.winStart + 300 * 60_000
  const body =
    head +
    `<text x="${W}" y="12" text-anchor="end" class="m">темп ${num(s.rate30Pct)}% за 30 мин</text>` +
    `<line x1="${x0}" y1="${y(100)}" x2="${x1}" y2="${y(100)}" stroke="${C.alarm}" stroke-opacity=".45" stroke-dasharray="3 3"/>` +
    `<line x1="${x0}" y1="${y(50)}" x2="${x1}" y2="${y(50)}" class="grid" stroke-dasharray="2 4"/>` +
    `<line x1="${x0}" y1="${yBot}" x2="${x1}" y2="${yBot}" class="grid"/>` +
    `<text x="${x0 - 5}" y="${y(100) + 4}" text-anchor="end" class="m">100</text>` +
    `<text x="${x0 - 5}" y="${y(50) + 4}" text-anchor="end" class="m">50</text>` +
    `<text x="${x0 - 5}" y="${yBot + 4}" text-anchor="end" class="m">0</text>` +
    `<path d="${area}" ${areaFill(pct)}/>` +
    `<path d="${line}" stroke="${paint(pct, METAL)}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>` +
    `<line x1="${x(nowMin).toFixed(1)}" y1="${yTop}" x2="${x(nowMin).toFixed(1)}" y2="${yBot}" class="grid" stroke-dasharray="2 3"/>` +
    `<circle cx="${x(nowMin).toFixed(1)}" cy="${y(pct).toFixed(1)}" r="3.6" fill="${paint(pct, C.hi)}"/>` +
    proj +
    `<text x="${x0}" y="${yBot + 16}" class="m">${clock(s.winStart, tz)}</text>` +
    `<text x="${x(nowMin).toFixed(1)}" y="${yBot + 16}" text-anchor="middle" class="m">сейчас</text>` +
    `<text x="${x1}" y="${yBot + 16}" text-anchor="end" class="m">${clock(resets, tz)}</text>`
  return { source: svg(114, body), alt: `Пятичасовое окно: ${Math.round(pct)}%, ${note}` }
}

function sessionsHeadSvg(s: Snapshot) {
  const rows = s.sessions
  const count = (st: Row['status'][]) => rows.filter(r => st.includes(r.status)).length
  const stopColor = count(['limit']) ? C.status.limit : C.status.stopped
  const alt = `Сессии: работают ${count(['running'])}, ждут ${count(['waiting'])}, стоп ${count(['stopped', 'limit'])}, агентов ${s.agents}`
  if (C.flat) {
    const slot = (x: number, color: string, text: string) =>
      `<circle cx="${x + 5}" cy="11" r="5" fill="${color}"/><text x="${x + 14}" y="15" class="t">${text}</text>`
    const body =
      slot(0, C.status.running, `${count(['running'])} работают`) +
      slot(84, C.status.waiting, `${count(['waiting'])} ждут`) +
      slot(148, stopColor, `${count(['stopped', 'limit'])} стоп`) +
      `<rect x="212" y="4" width="84" height="15" rx="7.5" fill="${C.ctx}" fill-opacity=".15"/>` +
      `<text x="254" y="15" text-anchor="middle" class="t" style="fill:${C.ctx}">агентов ${s.agents}</text>` +
      (rows.length ? '' : `<text x="0" y="40" class="m">сегодня сессий не было</text>`)
    return { source: svg(rows.length ? 24 : 46, body), alt }
  }
  const stat = (x: number, value: number, label: string, color: string) =>
    `<text x="${x}" y="20" text-anchor="middle" class="b" style="fill:${color}">${value}</text>` +
    `<text x="${x}" y="35" text-anchor="middle" class="h" style="font-size:9.5px">${label}</text>`
  let body =
    stat(37, count(['running']), 'РАБОТАЮТ', C.status.running) +
    stat(111, count(['waiting']), 'ЖДУТ', C.status.waiting) +
    stat(185, count(['stopped', 'limit']), 'СТОП', stopColor) +
    stat(259, s.agents, 'АГЕНТОВ', C.ink)
  if (!rows.length) body += `<text x="0" y="56" class="m">сегодня сессий не было</text>`
  return { source: svg(rows.length ? 38 : 60, body), alt }
}

// Строка сессии. Если её можно открыть, статус рисует кнопка рядом, поэтому картинка уже и без плашки
function sessionRowSvg(r: Row) {
  const rowW = r.link ? ROW_W : C.flat ? W : OUT_W
  const h = 44
  const color = C.status[r.status]
  const label = STATUS[r.status].label
  const barW = r.link ? 52 : 160
  const barH = C.flat ? 8 : 5
  const fill = (clamp(r.ctx, 0, 1_000_000) / 1_000_000) * barW
  const heavyX = 14 + (HEAVY_CTX / 1_000_000) * barW
  const isHeavy = r.ctx >= HEAVY_CTX
  const ctxColor = isHeavy ? C.alarm : C.ctx
  // Статус крупно справа в первой строке, время простоя во второй, чтобы не резать название
  const since = r.status === 'running' ? '' : idle(r.idleMin)
  // До остывания видно и сколько осталось, и во что обойдётся опоздание
  const cold =
    r.coldInMin !== null
      ? `❄ ${r.coldInMin} мин · ${num(r.coldPct ?? 0)}%`
      : r.coldPct !== null
        ? `❄ ${num(r.coldPct)}%`
        : null
  const tail = cold ?? (r.agents ? `агентов ${r.agents}` : since)
  const tailColor = r.urgent ? C.alarm : cold ? C.cold : r.agents ? C.ctx : undefined
  const chip = r.link
    ? ''
    : `<rect x="${rowW - 98}" y="6" width="90" height="18" rx="9" fill="${C.flat ? color : C.track}"/>` +
      `<text x="${rowW - 53}" y="19" text-anchor="middle" class="t" style="fill:${C.flat ? '#fff' : color};font-size:11.5px">${label}</text>`
  const back = C.flat
    ? `<rect x="0" y="0" width="${rowW}" height="${h}" rx="7" fill="${color}" fill-opacity=".16"/><rect x="0" y="0" width="6" height="${h}" rx="3" fill="${color}"/>`
    : `<rect x=".5" y=".5" width="${rowW - 1}" height="${h - 1}" rx="10" fill="url(#card)" stroke="${C.line}"/><rect x="0" y="10" width="3" height="${h - 20}" rx="1.5" fill="${color}"/>`
  const body =
    `<title>${esc(r.title)} · ${esc(r.project)} · ${label} ${since} · контекст ${thousands(r.ctx)}</title>` +
    back +
    `<text x="14" y="18" class="n">${cut(r.title, !r.link ? 27 : C.flat ? 24 : 26)}</text>` +
    chip +
    `<rect x="14" y="28" width="${barW}" height="${barH}" rx="${barH / 2}" class="trf"/>` +
    (fill > 0 ? `<rect x="14" y="28" width="${Math.max(4, fill).toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${isHeavy ? C.alarm : C.flat ? C.ctx : 'url(#fillh)'}"/>` : '') +
    `<line x1="${heavyX.toFixed(1)}" y1="26" x2="${heavyX.toFixed(1)}" y2="${28 + barH + 2}" stroke="${C.alarm}" stroke-opacity=".6"/>` +
    `<text x="${14 + barW + 6}" y="36" class="m" style="fill:${ctxColor}">${kilo(r.ctx)}</text>` +
    (tail ? `<text x="${rowW - 8}" y="36" text-anchor="end" class="m"${tailColor ? ` style="fill:${tailColor}"` : ''}>${tail}</text>` : '')
  const coldAlt = r.coldInMin !== null ? `, кэш остынет через ${r.coldInMin} мин, потом ответ обойдётся в ${num(r.coldPct ?? 0)}% лимита` : ''
  const alt = `${r.title}: ${label}${since ? `, ${since}` : ''}, контекст ${thousands(r.ctx)}${coldAlt}`
  return { source: doc(rowW, h, body), alt }
}

function weekSvg(s: Snapshot, lim: Limits | null, now: number, tz: number) {
  const head = `<text x="0" y="12" class="h">${cap('Недельное окно')}</text>`
  const wk = s.week
  if (!wk) {
    return { source: svg(34, `${head}<text x="0" y="31" class="m">нет данных о недельном лимите</text>`), alt: 'Нет данных о недельном лимите' }
  }
  const x0 = 26
  const x1 = W - 4
  const yTop = 36
  const yBot = 94
  const day = 24 * 3600_000
  const span = wk.reset - wk.start
  const x = (ms: number) => x0 + (clamp(ms - wk.start, 0, span) / span) * (x1 - x0)
  const y = (pct: number) => yBot - (clamp(pct, 0, 100) / 100) * (yBot - yTop)
  const pct = lim?.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed ?? wk.points.at(-1)?.[1] ?? 0
  let line = `M${x(wk.start).toFixed(1)},${y(0)}`
  for (const [ms, v] of wk.points) line += ` L${x(ms).toFixed(1)},${y(v).toFixed(1)}`
  line += ` L${x(now).toFixed(1)},${y(pct).toFixed(1)}`
  const area = `${line} L${x(now).toFixed(1)},${yBot} Z`

  let proj = ''
  let note = 'темп станет ясен через несколько часов'
  if (wk.perDay !== null && wk.endPct !== null) {
    const hits = wk.hitAt !== null
    const color = hits ? C.alarm : C.muted
    const ex = x(wk.hitAt ?? wk.reset)
    const ey = y(hits ? 100 : wk.endPct)
    note = wk.hitAt !== null ? `кончится ≈ ${dayClock(wk.hitAt, tz)}` : `к сбросу ≈ ${Math.min(100, wk.endPct)}%`
    proj =
      `<path d="M${x(now).toFixed(1)},${y(pct).toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}" stroke="${color}" stroke-width="1.6" stroke-dasharray="5 4" fill="none"/>` +
      (hits ? `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="${C.alarm}"/>` : '') +
      `<text x="${clamp(ex, x0 + 120, x1).toFixed(1)}" y="${hits ? yTop - 7 : ey - 7}" text-anchor="end" class="t" style="fill:${color}">${note}</text>`
  }
  const names = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
  let days = ''
  for (let i = 0; i < 7; i++) {
    const at = wk.start + i * day
    if (i) days += `<line x1="${x(at).toFixed(1)}" y1="${yTop}" x2="${x(at).toFixed(1)}" y2="${yBot}" class="grid" stroke-dasharray="1 5"/>`
    days += `<text x="${x(at + day / 2).toFixed(1)}" y="${yBot + 16}" text-anchor="middle" class="m">${names[new Date(at + tz * 60_000).getUTCDay()]}</text>`
  }
  const body =
    head +
    (wk.perDay !== null ? `<text x="${W}" y="12" text-anchor="end" class="m">темп ${num(wk.perDay)}% в сутки</text>` : '') +
    `<line x1="${x0}" y1="${y(100)}" x2="${x1}" y2="${y(100)}" stroke="${C.alarm}" stroke-opacity=".45" stroke-dasharray="3 3"/>` +
    `<line x1="${x0}" y1="${y(50)}" x2="${x1}" y2="${y(50)}" class="grid" stroke-dasharray="2 4"/>` +
    `<line x1="${x0}" y1="${yBot}" x2="${x1}" y2="${yBot}" class="grid"/>` +
    `<text x="${x0 - 5}" y="${y(100) + 4}" text-anchor="end" class="m">100</text>` +
    `<text x="${x0 - 5}" y="${y(50) + 4}" text-anchor="end" class="m">50</text>` +
    `<text x="${x0 - 5}" y="${yBot + 4}" text-anchor="end" class="m">0</text>` +
    days +
    `<path d="${area}" ${areaFill(pct)}/>` +
    `<path d="${line}" stroke="${paint(pct, METAL)}" stroke-width="2.2" fill="none" stroke-linejoin="round"/>` +
    `<circle cx="${x(now).toFixed(1)}" cy="${y(pct).toFixed(1)}" r="3.6" fill="${paint(pct, C.hi)}"/>` +
    proj
  return { source: svg(114, body), alt: `Недельное окно: ${Math.round(pct)}%, ${note}` }
}

function hoursSvg(s: Snapshot, now: number, tz: number) {
  const x0 = 2
  const step = (W - x0 - 2) / 24
  const yTop = 28
  const yBot = 78
  const max = Math.max(25, ...s.hours)
  const y = (v: number) => yBot - (v / max) * (yBot - yTop)
  const hourNow = new Date(now + tz * 60_000).getUTCHours()
  let bars = ''
  s.hours.forEach((v, h) => {
    const bx = x0 + h * step + 2
    const color = v >= 20 ? C.alarm : !C.flat ? 'url(#bar)' : v >= 10 ? C.warn : C.good
    bars +=
      v > 0
        ? `<rect x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${(step - 4).toFixed(1)}" height="${(yBot - y(v)).toFixed(1)}" rx="2" fill="${color}"><title>${String(h).padStart(2, '0')}:00 — ${num(v)}% лимита</title></rect>`
        : `<rect x="${bx.toFixed(1)}" y="${yBot - 2}" width="${(step - 4).toFixed(1)}" height="2" class="trf"/>`
    if (h === hourNow) bars += `<circle cx="${(bx + (step - 4) / 2).toFixed(1)}" cy="${yBot + 6}" r="2.2" fill="${C.hi}"/>`
  })
  const labels = [0, 6, 12, 18, 23]
    .map(h => `<text x="${(x0 + h * step + step / 2).toFixed(1)}" y="${yBot + 20}" text-anchor="middle" class="m">${h}</text>`)
    .join('')
  const body =
    `<text x="0" y="12" class="h">${cap('Сегодня по часам')}</text>` +
    `<text x="${W}" y="12" text-anchor="end" class="m">${num(s.todayPct, 0)}% лимита за день</text>` +
    `<line x1="${x0}" y1="${y(20).toFixed(1)}" x2="${W - 2}" y2="${y(20).toFixed(1)}" stroke="${C.alarm}" stroke-dasharray="4 3" stroke-opacity=".6"/>` +
    `<text x="${W - 2}" y="${(y(20) - 3).toFixed(1)}" text-anchor="end" class="m">норма 20%/ч</text>` +
    bars +
    labels
  return { source: svg(100, body), alt: `Сегодня ${num(s.todayPct, 0)}% пятичасового лимита, по часам` }
}

function spendSvg(s: Snapshot) {
  const total = s.today.units || 1
  const models = Object.entries(s.today.models).sort((a, b) => b[1] - a[1])
  const colorOf = (m: string) => C.models.find(([k]) => m.includes(k))?.[1] ?? C.muted
  let x = 0
  let stack = ''
  let legend = ''
  let lx = 0
  for (const [m, u] of models) {
    const w = (u / total) * W
    if (w < 0.5) continue
    stack += `<rect x="${x.toFixed(1)}" y="22" width="${w.toFixed(1)}" height="8" fill="${colorOf(m)}"/>`
    x += w
    const share = Math.round((u / total) * 100)
    if (share >= 1 && lx < W - 80) {
      const name = m.replace(/-(\d+)-(\d+)$/, ' $1.$2')
      legend += `<circle cx="${lx + 4}" cy="42" r="3.5" fill="${colorOf(m)}"/><text x="${lx + 12}" y="46" class="m">${esc(name)} ${share}%</text>`
      lx += 12 + (name.length + 5) * 6.2
    }
  }
  const maxPct = Math.max(1, ...s.top.map(t => t.pct))
  let leaders = ''
  s.top.forEach((t, i) => {
    const y0 = 62 + i * 20
    const w = (t.pct / maxPct) * 104
    leaders +=
      `<text x="0" y="${y0 + 9}" class="l">${cut(t.title, 22)}</text>` +
      `<rect x="150" y="${y0 + 3}" width="104" height="5" rx="2.5" class="trf"/>` +
      `<rect x="150" y="${y0 + 3}" width="${Math.max(3, w).toFixed(1)}" height="5" rx="2.5" fill="${paint(Math.min(100, t.pct * 1.5), 'url(#fillh)')}"/>` +
      `<text x="${W}" y="${y0 + 10}" text-anchor="end" class="t" style="fill:${C.flat ? C.ctx : C.hi}">${num(t.pct, 0)}%</text>`
  })
  const body =
    `<text x="0" y="12" class="h">${cap('Модели и лидеры расхода')}</text>` +
    `<clipPath id="r"><rect x="0" y="22" width="${W}" height="8" rx="4"/></clipPath><g clip-path="url(#r)"><rect x="0" y="22" width="${W}" height="8" class="trf"/>${stack}</g>` +
    legend +
    leaders
  return { source: svg(58 + s.top.length * 20, body), alt: `Модели: ${models.map(([m, u]) => `${m} ${Math.round((u / total) * 100)}%`).join(', ')}` }
}

// Квадрат рядом с кнопками: вверху страна выхода в интернет, внизу скорость на круговой шкале.
// Шкала логарифмическая: разница между 5 и 50 Мбит/с важнее, чем между 300 и 350
const NET_W = 92
const NET_H = 92

function netSvg(n: Net | null) {
  const cx = NET_W / 2
  const cy = 72
  const r = 25
  const len = Math.PI * r
  const mbit = n?.mbit ?? null
  const name = n ? (n.country ?? 'нет сети') : 'замеряю'
  const pos = mbit === null ? 0 : clamp(Math.log10(Math.max(mbit, 1)) / 3, 0, 1)
  const arc = `M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}`
  const stroke = mbit !== null && mbit < 5 ? C.alarm : !C.flat ? 'url(#ring)' : mbit !== null && mbit < 25 ? C.warn : C.good
  const size = name.length > 11 ? 10 : name.length > 8 ? 11 : 12.5
  const body =
    `<rect x=".5" y=".5" width="${NET_W - 1}" height="${NET_H - 1}" rx="12" fill="${C.flat ? 'none' : 'url(#card)'}" stroke="${C.line}"/>` +
    `<text x="${cx}" y="23" text-anchor="middle" class="t" style="font-size:${size}px">${esc(name)}</text>` +
    `<line x1="12" y1="34" x2="${NET_W - 12}" y2="34" class="grid"/>` +
    `<path d="${arc}" fill="none" class="tr" stroke-width="6" stroke-linecap="round"/>` +
    (pos > 0
      ? `<path d="${arc}" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(pos * len).toFixed(1)} ${len.toFixed(1)}"/>`
      : '') +
    `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="b" style="font-size:15px">${mbit === null ? '—' : Math.round(mbit)}</text>` +
    `<text x="${cx}" y="${cy + 12}" text-anchor="middle" class="m" style="font-size:9px">Мбит/с</text>`
  const alt = `${name}, ${mbit === null ? 'скорость не измерена' : `${Math.round(mbit)} Мбит/с`}`
  return { source: doc(NET_W, NET_H, body), alt }
}

let tick: Timer | undefined
let busy = false
let netBusy = false

async function readUsage($: EngineInterface) {
  const u = await $.session.usage()
  const at = await $.clock.now()
  await update($, limits, () => ({ at, context: u.context, rateLimits: u.rateLimits }))
}

// Запускает collector/collect.py; он читает логи всех сессий и печатает сводку JSON
async function collect($: EngineInterface) {
  if (busy) return
  busy = true
  try {
    const lim = await read($, limits)
    const five = lim?.rateLimits.find(r => r.kind === 'five_hour')
    const week = lim?.rateLimits.find(r => r.kind === 'seven_day')
    const start = five?.resetsAt ? new Date(Date.parse(five.resetsAt) - 5 * 3600_000).toISOString() : ''
    const script = `${$.plugin.root}/collector/collect.py`
    const sid = await $.session.id()
    // Заглушка python3 из Microsoft Store запускается, но падает, поэтому при любой ошибке пробуем следующий
    let failure = NO_PYTHON
    for (const exe of PYTHONS) {
      try {
        const args = [start, five ? String(five.percentUsed) : '', sid, week ? String(week.percentUsed) : '', week?.resetsAt ?? '']
        const r = await $.process.run([...exe, '-I', script, ...args], { timeoutMs: 60_000 })
        if (r.exitCode === 0) {
          const data = JSON.parse(r.stdout) as Snapshot
          await update($, snap, () => data)
          await update($, error, () => null)
          return
        }
        if (r.stderr.includes('Traceback')) failure = `сборщик: ${r.stderr.slice(-200)}`
      } catch {
        continue
      }
    }
    await update($, error, () => failure)
  } finally {
    busy = false
  }
}

// Замер общий для всех сессий: результат лежит в хранилище, метка времени ставится до начала,
// чтобы другие панели не запускали его одновременно
async function checkNet($: EngineInterface, force: boolean) {
  if (netBusy) return
  const now = await $.clock.now()
  const saved = ((await $.store.get('net').catch(() => undefined)) as Net | undefined) ?? null
  if (saved) await update($, net, () => saved)
  if (!force && saved && now - saved.at < NET_EVERY_MS) return
  netBusy = true
  await $.store.set('net', { code: '', country: null, mbit: null, ...saved, at: now }).catch(() => undefined)
  try {
    const script = `${$.plugin.root}/collector/netcheck.py`
    for (const exe of PYTHONS) {
      try {
        const r = await $.process.run([...exe, '-I', script], { timeoutMs: 40_000 })
        if (r.exitCode !== 0) continue
        const data: Net = { ...(JSON.parse(r.stdout) as Omit<Net, 'at'>), at: now }
        await update($, net, () => data)
        await $.store.set('net', data).catch(() => undefined)
        return
      } catch {
        continue
      }
    }
  } finally {
    netBusy = false
  }
}

async function refresh($: EngineInterface, force = false) {
  const saved = (await $.store.get('style').catch(() => undefined)) as StyleId | undefined
  if (saved) await update($, style, () => saved)
  await readUsage($)
  await collect($)
  // Уведомление вторично: его сбой не должен ломать обновление пульта
  await alertLimits($).catch(() => undefined)
  await alertWaiting($).catch(() => undefined)
  await checkNet($, force).catch(() => undefined)
}

// Всплывающее уведомление Windows через PowerShell. Текст передаём кодами символов, чтобы кириллица
// и кавычки не ломали команду. С link нажатие на уведомление открывает эту ссылку
async function windowsToast($: EngineInterface, title: string, text: string, link?: string) {
  const chars = (s: string) => {
    const x = esc(s)
    return `[string]::new([char[]](${Array.from({ length: x.length }, (_, i) => x.charCodeAt(i)).join(',')}))`
  }
  const open = link ? ` activationType='protocol' launch='${link}'` : ''
  const script =
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;' +
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;' +
    `$t = ${chars(title)}; $b = ${chars(text)};` +
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument;' +
    `$x.LoadXml("<toast${open}><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>");` +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))"
  try {
    await $.process.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeoutMs: 20_000,
    })
  } catch {
    // уведомление необязательное: пульт показывает то же самое
  }
}

// Уведомление о лимите: сначала средствами приложения, а в Claude для Windows оно туда не доходит,
// тогда уведомлением Windows
async function notify($: EngineInterface, text: string) {
  $.ui.toast(text)
  let isSent = false
  try {
    isSent = (await $.ui.notify(text, { title: TITLE })).isSent
  } catch {
    isSent = false
  }
  if (!isSent) await windowsToast($, TITLE, text)
}

// Сессия закончила ход. Пока окно Claude в фоне, баннер показывает само приложение, поэтому такие строки
// только отмечаем. Уведомление нужно, когда вы работаете в Claude, а ждёт другая сессия
async function alertWaiting($: EngineInterface) {
  const s = await read($, snap)
  if (!s) return
  const key = (r: Row) => `${r.id}-${r.doneAt}`
  const rows = s.sessions.filter(r => r.status === 'waiting' && !r.seen && r.idleMin <= WAIT_FRESH_MIN)
  if (!rows.length) return
  const sent = ((await $.store.get('waits')) as string[] | undefined) ?? []
  const fresh = rows.filter(r => !sent.includes(key(r)))
  if (!fresh.length) return
  await $.store.set('waits', [...sent, ...fresh.map(key)].slice(-60))
  if (!s.appInFront) return
  for (const r of fresh) {
    if (r.link) await windowsToast($, `Ждёт вас: ${r.title}`, r.note ?? 'Нажмите, чтобы открыть сессию', r.link)
  }
}

// Предупреждает один раз на окно: 80% пятичасового или недельного лимита и прогноз, что пятичасовой
// кончится раньше сброса. Отметки общие для всех сессий, поэтому уведомление не повторяется в каждой
async function alertLimits($: EngineInterface) {
  const lim = await read($, limits)
  if (!lim) return
  const s = await read($, snap)
  const tz = s?.tzOffsetMin ?? 180
  const now = await $.clock.now()
  const alerts: [string, string][] = []
  for (const r of lim.rateLimits) {
    if (!r.resetsAt || (r.kind !== 'five_hour' && r.kind !== 'seven_day')) continue
    const isFive = r.kind === 'five_hour'
    const name = isFive ? 'Лимит 5 часов' : 'Недельный лимит'
    const resetMs = Date.parse(r.resetsAt)
    const reset = isFive ? clock(resetMs, tz) : dayClock(resetMs, tz)
    if (r.percentUsed >= ALERT_PCT) {
      alerts.push([`${r.kind}-${ALERT_PCT}-${r.resetsAt}`, `${name}: ${Math.round(r.percentUsed)}%, сброс ${reset}`])
    }
    const perMin = (s?.rate30Pct ?? 0) / 30
    if (isFive && perMin > 0 && r.percentUsed >= FORECAST_FROM_PCT && r.percentUsed < 100) {
      const endsAt = now + ((100 - r.percentUsed) / perMin) * 60_000
      if (endsAt < resetMs) {
        alerts.push([`five_hour-end-${r.resetsAt}`, `${name} кончится около ${clock(endsAt, tz)}, а сброс только в ${reset}`])
      }
    }
    if (!isFive && s?.week?.hitAt && r.percentUsed >= FORECAST_FROM_PCT) {
      alerts.push([`seven_day-end-${r.resetsAt}`, `${name} кончится около ${dayClock(s.week.hitAt, tz)}, а сброс только ${reset}`])
    }
  }
  if (!alerts.length) return
  const sent = ((await $.store.get('alerts')) as string[] | undefined) ?? []
  const fresh = alerts.filter(([key]) => !sent.includes(key))
  if (!fresh.length) return
  await $.store.set('alerts', [...sent, ...fresh.map(([key]) => key)].slice(-40))
  for (const [, text] of fresh) await notify($, text)
}

// Выбор оформления сохраняем для всех сессий: другие панели подхватят его при следующем обновлении
async function chooseStyle($: EngineInterface, id: StyleId) {
  await update($, style, () => id)
  await $.store.set('style', id).catch(() => undefined)
}

// Открывает сессию в приложении: rundll32 отдаёт ссылку claude:// обработчику без оболочки и кавычек
async function openSession($: EngineInterface, link: string) {
  try {
    await $.process.run([RUNDLL32, 'url.dll,FileProtocolHandler', link], { timeoutMs: 10_000 })
  } catch (err) {
    $.ui.toast(`Не удалось открыть сессию: ${String(err).slice(0, 100)}`)
  }
}

// Ответ из панели. Адрес local_… понимает приложение: сессию, которая не запущена, оно запускает само
async function sendReply($: EngineInterface, r: Row, text: string) {
  const body = text.trim()
  if (!body || !r.link) return
  try {
    const sent = await $.session.send({ to: r.link.slice(r.link.lastIndexOf('/') + 1), text: `${REPLY_MARK} ${body}` })
    if (sent.isDelivered) {
      await update($, replyTo, () => null)
      $.ui.toast(`Ответ ушёл в «${r.title}»`)
    } else {
      $.ui.toast(`Не дошло: ${sent.reason}`)
    }
  } catch (err) {
    $.ui.toast(`Не дошло: ${String(err).slice(0, 120)}`)
  }
}

// Кнопки «Статус», «Итог», «Проверка»: промпт уходит как набранный пользователем, во время ответа ждёт очереди
async function ask($: EngineInterface, text: string) {
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) $.ui.toast(`Не отправилось: ${r.drop}`)
}

// Команда /new-sheet: отправляет сохранение памяти, а контекст очищается, когда закончится
// именно этот ход (см. turn.start и turn.complete)
async function newSheet($: EngineInterface) {
  await update($, pendingClear, () => 'queued')
  // Если ход с сохранением так и не начался за 10 минут, снимаем ожидание, чтобы кнопка не зависла
  $.clock.after(10 * 60_000, () => void update($, pendingClear, v => (v === 'queued' ? null : v)))
  $.ui.toast('Сохраняю память проекта, потом очищу контекст')
  const r = await $.prompt.submit({ text: ASKS.memory, asUser: true })
  if (r.drop !== undefined) {
    await update($, pendingClear, () => null)
    $.ui.toast(`Не отправилось: ${r.drop}`)
  }
}

async function clearNow($: EngineInterface) {
  try {
    await $.command.run({ command: 'clear', args: '' })
    $.ui.toast('Новый лист: контекст очищен, подгружаю память проекта')
  } catch (err) {
    $.ui.toast(`Не удалось очистить, наберите /clear: ${String(err).slice(0, 100)}`)
    return
  }
  await readUsage($)
  // Память подгружает не каждый: у кого нет хука на старт сессии, модель прочитает файл сама
  await ask($, ASKS.resume)
}

// Модель агента из его файла в ~/.claude/agents: true, если там inherit или модели нет
const inheritCache = new Map<string, boolean>()
async function inheritsParent($: EngineInterface, type: string) {
  if (INHERIT_BUILTIN.has(type)) return true
  const known = inheritCache.get(type)
  if (known !== undefined) return known
  let result = false
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) throw new Error('нет домашней папки')
    const text = String(await $.fs.read(`${home}/.claude/agents/${type}.md`))
    const model = /^model:\s*(\S+)/m.exec(text)?.[1]
    result = model === undefined || model === 'inherit'
  } catch {
    result = false
  }
  inheritCache.set(type, result)
  return result
}

// Сжимает эту сессию; пока модель отвечает, движок сжатие не пускает, тогда ставим его в очередь как /compact
async function compactNow($: EngineInterface) {
  if (await read($, compacting)) return
  await update($, compacting, () => true)
  try {
    let r
    try {
      r = await $.session.compact({ instructions: COMPACT_HINT })
    } catch {
      $.ui.toast('Модель отвечает: сожму, как только закончит')
      await $.command.run({ command: 'compact', args: COMPACT_HINT })
      $.ui.toast('Контекст сжат')
      return
    }
    if (r.skip !== undefined) $.ui.toast(`Сжатие отменено: ${r.skip}`)
    else if (r.tokensBefore && r.tokensAfter) $.ui.toast(`Контекст сжат: ${kilo(r.tokensBefore)} → ${kilo(r.tokensAfter)}`)
    else $.ui.toast('Контекст сжат')
  } catch (err) {
    $.ui.toast(`Не удалось сжать: ${String(err).slice(0, 120)}`)
  } finally {
    await update($, compacting, () => false)
    await readUsage($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'pult', description: 'Открыть пульт сессий: лимиты, контекст, расход, агенты' })
    await $.command.register({ name: 'new-sheet', description: 'Новый лист: сохранить память проекта и очистить контекст' })
    void $.ui.open({ id: PANE, title: TITLE })
    tick?.cancel()
    tick = $.clock.every(REFRESH_MS, () => void refresh($))
    void refresh($)

    return started
  })

  on('command.run', { command: 'pult' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Пульт сессий открыт и обновлён.' }
  })

  on('command.run', { command: 'new-sheet' }, $ => {
    // Не ждём: команда не должна висеть до конца хода с сохранением памяти
    void newSheet($)

    return { text: 'Сохраняю память проекта, потом очищу контекст.' }
  })

  on('session.measure', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, limits, () => ({ at, context: e.context, rateLimits: e.rateLimits }))
    void alertLimits($).catch(() => undefined)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const cheaper =
      e.model === undefined &&
      e.subagentType !== 'fork' &&
      /opus/i.test(e.parentModel) &&
      (await inheritsParent($, e.subagentType))

    return next(cheaper ? { ...e, model: 'sonnet' } : e)
  })

  // Ход главной сессии: пока идёт, полоса «кэш остыл» не нужна; конец хода запоминаем
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turnRunning, () => true)
      if ((await read($, pendingClear)) === 'queued' && e.text.includes(MEMORY_MARK)) {
        await update($, pendingClear, () => e.turnId)
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const at = await $.clock.now()
    await update($, turnRunning, () => false)
    await update($, lastTurnAt, () => at)
    if ((await read($, pendingClear)) === e.turnId) {
      await update($, pendingClear, () => null)
      // Не ждём очистку в хуке: команда ждала бы конца хода, который ждёт этот хук
      if (!e.isAborted && e.reason !== 'refusal') $.clock.after(300, () => void clearNow($))
    }

    return next(e)
  })

  // Полоса над вводом: за 15 минут до остывания кэша и после, если контекст большой
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || (await read($, turnRunning))) return next(e)
    const s = await read($, snap)
    const lim = await read($, limits)
    const last = Math.max((await read($, lastTurnAt)) ?? 0, s?.self?.lastTs ?? 0)
    const ctx = lim?.context.tokens ?? s?.self?.ctx ?? 0
    if (!last || ctx < COLD_CTX || (await read($, coldHidden)) === last) return next(e)
    const idleMin = Math.floor(((await $.clock.now()) - last) / 60_000)
    if (idleMin < WARN_MIN) return next(e)
    const cal = s?.cal ?? 255_000
    const isCold = idleMin >= COLD_MIN
    const text = isCold
      ? `Перерыв ${idle(idleMin)}, кэш остыл: следующий ответ перечитает ${kilo(ctx)} заново, это около ${num((ctx * 2) / cal)}% лимита. После сжатия шаги станут в разы дешевле.`
      : `Кэш остынет через ${COLD_MIN - idleMin} мин. Пока он тёплый, сжатие дешёвое; потом ${kilo(ctx)} придётся читать заново, около ${num((ctx * 2) / cal)}% лимита.`
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text color={isCold ? 'warning' : undefined}>{text}</Text>
        <Button key="cold-compact" variant="primary" onPress={() => void compactNow($)}>
          Сжать
        </Button>
        <Button key="cold-hide" onPress={() => void update($, coldHidden, () => last)}>
          Скрыть
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    // В терминале нет Svg: там вместо графиков их текстовые подписи
    const Svg = 'Svg' in els ? els.Svg : undefined
    const s = await read($, snap)
    const lim = await read($, limits)
    const err = await read($, error)
    const now = await $.clock.now()
    const tz = s?.tzOffsetMin ?? 180

    const ctx = lim?.context.tokens ?? s?.self?.ctx ?? 0
    const busyCompact = await read($, compacting)
    const replying = await read($, replyTo)
    const netNow = await read($, net)
    // После этой строки чтений нет: всё, что ниже, рисуется синхронно в выбранном оформлении
    useLook(await read($, style))
    const backdrop = Svg && C.page ? { backgroundColor: C.page, padding: 'sm' as const } : {}
    const noteColor = C.note ? { color: C.note } : { dimColor: true }
    // На своём фоне панели подпись обычной кнопки сливается с ним: там все кнопки плотные, второстепенные приглушены
    const pick = (isMain: boolean) =>
      C.solid
        ? { variant: 'primary' as const, dimColor: !isMain }
        : { variant: isMain ? ('primary' as const) : ('secondary' as const) }
    // Подпись меньше обычной, иначе кнопки занимают всю ширину панели. На угольном фоне кнопка сливается с ним,
    // поэтому у неё золотая окантовка
    const btn = (key: string, text: string, isMain: boolean, onPress: () => void) => {
      const button = (
        <Button key={key} {...pick(isMain)} onPress={onPress}>
          <Text size="footnote">{text}</Text>
        </Button>
      )

      return Svg && C.solid ? (
        <Box key={`frame-${key}`} borderStyle="round" borderColor={C.mid}>
          {button}
        </Box>
      ) : (
        button
      )
    }
    // Картинкой, не isInteractive: интерактивная рамка ужимает высокий график до своей высоты
    const draw = (c: { source: string; alt: string }) => (Svg ? <Svg source={c.source} alt={c.alt} /> : <Text>{c.alt}</Text>)
    // Кнопка заменяет нарисованную плашку статуса: на картинке нельзя нажать часть
    const sessionRow = (r: Row) => {
      const link = r.link
      const canReply = link !== null && r.status === 'waiting' && r.id !== s?.self?.id
      const isReplying = canReply && replying === r.id

      return (
        <Box key={r.id} flexDirection="column" gap="xs">
          {/* Строка сжимается вместе с панелью, чтобы кнопка статуса не уходила за край */}
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap="xs">
            <Box width={link ? '70%' : '100%'} flexShrink={1}>
              {draw(sessionRowSvg(r))}
            </Box>
            {link &&
              btn(`open-${r.id}`, STATUS[r.status].short, r.needs || r.urgent || r.status === 'limit', () => void openSession($, link))}
          </Box>
          {(r.note || (canReply && !isReplying)) && (
            <Box flexDirection="row" alignItems="flex-start" justifyContent="flex-end" gap={1}>
              {r.note && (
                <Box flexGrow={1} flexShrink={1}>
                  <Text {...noteColor}>{r.note}</Text>
                </Box>
              )}
              {canReply && !isReplying && btn(`reply-${r.id}`, 'Ответить', false, () => void update($, replyTo, () => r.id))}
            </Box>
          )}
          {isReplying && (
            <Box flexDirection="column" gap="xs">
              {/* Ответ будит сессию: если кэш остывает или остыл, цена видна до отправки */}
              <Input
                key={`text-${r.id}`}
                autoFocus
                placeholder={r.coldPct !== null ? `Ответ перечитает контекст: около ${num(r.coldPct)}% лимита` : 'Ответ в сессию'}
                submitLabel="Отправить"
                onSubmit={value => void sendReply($, r, value)}
              />
              <Box flexDirection="row" gap={1}>
                {btn('reply-off', 'Отмена', false, () => void update($, replyTo, () => null))}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} {...backdrop}>
        <Box flexDirection="row" gap="xs">
          {LOOKS.map(look => btn(`style-${look.id}`, look.label, look.id === C.id, () => void chooseStyle($, look.id)))}
        </Box>
        {draw(gaugesSvg(lim, tz))}
        {/* Кнопки сразу под кольцами: сжатие видно без прокрутки, главным при тяжёлом контексте. Справа страна и скорость */}
        <Box flexDirection="row" alignItems="flex-start" justifyContent="space-between" gap="xs">
          <Box flexDirection="column" gap="xs" flexShrink={1}>
            <Box flexDirection="row">
              {btn(
                'compact',
                busyCompact ? 'Сжимаю…' : ctx ? `Сжать контекст · ${kilo(ctx)}` : 'Сжать контекст',
                ctx >= HEAVY_CTX,
                () => void compactNow($),
              )}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" gap="xs">
              {btn('status', 'Статус', false, () => void ask($, ASKS.status))}
              {btn('report', 'Итог', false, () => void ask($, ASKS.report))}
              {btn('check', 'Проверка', false, () => void ask($, ASKS.check))}
            </Box>
          </Box>
          <Box width="30%" flexShrink={0}>
            {draw(netSvg(netNow))}
          </Box>
        </Box>
        {draw(forecastSvg(s, lim, now, tz))}
        {s && draw(weekSvg(s, lim, now, tz))}
        {s && (
          <Box flexDirection="column" gap="xs">
            {draw(sessionsHeadSvg(s))}
            {s.sessions.map(sessionRow)}
          </Box>
        )}
        {s && draw(hoursSvg(s, now, tz))}
        {s && draw(spendSvg(s))}
        {!s && <Text {...noteColor}>Собираю данные…</Text>}
        {err && <Text color="error">{err}</Text>}
        <Box flexDirection="row" gap={1}>
          <Text {...noteColor}>
            {s ? `Обновлено ${clock(s.at, tz)} · 1% лимита ≈ ${thousands(s.cal)} ед.` : 'Первое обновление…'}
          </Text>
          {btn('refresh', 'Обновить', false, () => void refresh($, true))}
        </Box>
      </Box>
    )
  })
}
