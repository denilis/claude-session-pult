import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BlockId, LangId, Layout, Limits, Net, Row, RowState, Snapshot, StyleId } from '../types'

const PANE = 'session-pult'
// Язык панели: обе подписи стоят прямо в месте вывода, чтобы не расходились
let LANG: LangId = 'ru'
const t = (ru: string, en: string) => (LANG === 'en' ? en : ru)
const title = () => t('Пульт сессий', 'Session Pult')
const REFRESH_MS = 90_000
// Страна и скорость: замер расходует трафик, поэтому редко и один на все сессии
const NET_EVERY_MS = 30 * 60_000
const HEAVY_CTX = 300_000
// Python 3 для сборщика: сначала лаунчер py с python.org, затем то, что найдётся в PATH
const PYTHONS = [['py', '-3'], ['python'], ['python3']]
const noPython = () =>
  t(
    'Графики по всем сессиям строит Python 3, он не найден. Установите его с python.org с галочкой «Add python.exe to PATH». ' +
      'Кольца лимитов и кнопки работают и без него.',
    'Charts across all sessions need Python 3, which was not found. Install it from python.org with "Add python.exe to PATH" ticked. ' +
      'Limit rings and buttons work without it.',
  )

// Сменить тег, если поменялись поля: старое значение из прошлой версии будет отклонено
const snap = atom({ plugin: 'session-pult', key: 'snap' } as const, null, { shape: 'snap-5' })
const limits = atom({ plugin: 'session-pult', key: 'limits' } as const, null, { shape: 'limits-1' })
const error = atom({ plugin: 'session-pult', key: 'error' } as const, null, { shape: 'error-1' })
const compacting = atom({ plugin: 'session-pult', key: 'compacting' } as const, false, { shape: 'compacting-1' })
const lastTurnAt = atom({ plugin: 'session-pult', key: 'lastTurnAt' } as const, null, { shape: 'last-turn-1' })
const turnRunning = atom({ plugin: 'session-pult', key: 'turnRunning' } as const, false, { shape: 'turn-running-1' })
const coldHidden = atom({ plugin: 'session-pult', key: 'coldHidden' } as const, null, { shape: 'cold-hidden-1' })
const pendingClear = atom({ plugin: 'session-pult', key: 'pendingClear' } as const, null, { shape: 'pending-clear-1' })
const style = atom({ plugin: 'session-pult', key: 'style' } as const, 'gold', { shape: 'style-1' })
const net = atom({ plugin: 'session-pult', key: 'net' } as const, null, { shape: 'net-1' })
const lang = atom({ plugin: 'session-pult', key: 'lang' } as const, 'ru', { shape: 'lang-1' })
// Блоки панели в исходном порядке
const BLOCKS: { id: BlockId; label: string; en: string }[] = [
  { id: 'gauges', label: 'Лимиты', en: 'Limits' },
  { id: 'actions', label: 'Кнопки', en: 'Actions' },
  { id: 'forecast', label: '5 часов', en: '5 hours' },
  { id: 'week', label: 'Неделя', en: 'Week' },
  { id: 'sessions', label: 'Сессии', en: 'Sessions' },
  { id: 'hours', label: 'По часам', en: 'By hour' },
  { id: 'spend', label: 'Модели', en: 'Models' },
]
const FIRST_LAYOUT: Layout = { order: BLOCKS.map(b => b.id), folded: [], closed: [] }
const layout = atom({ plugin: 'session-pult', key: 'layout' } as const, FIRST_LAYOUT, { shape: 'layout-1' })
// Режим настройки: над каждым блоком его кнопки
const arranging = atom({ plugin: 'session-pult', key: 'arranging' } as const, false, { shape: 'arranging-1' })

// Что кнопки отправляют от имени пользователя. Тексты самодостаточные: не опираются на чужие CLAUDE.md,
// а агентов и скиллы называют только как необязательные
const MEMORY_MARKS = ['Перед очисткой контекста сохрани память проекта', 'Before clearing the context, save the project memory']
const asks = () => ({
  status: t(
    'Статус сессии, кратко, четырьмя блоками: выполнено (с результатами), не получилось и почему, ' +
      'в процессе, осталось (с оценкой времени). Ничего нового не начинай.',
    'Session status, briefly, in four blocks: done (with results), failed and why, ' +
      'in progress, remaining (with a time estimate). Do not start anything new.',
  ),
  report: t(
    'Итоговый отчёт по последней задаче в 4 пунктах: задача; решена ли, с цифрами и фактами; ' +
      'почему решение оптимально и какую альтернативу отвергли; как было и как стало.',
    'Final report on the last task in 4 points: the task; whether it is solved, with figures and facts; ' +
      'why the solution is optimal and which alternative was rejected; before and after.',
  ),
  check: t(
    'Проверь последний результат перед отправкой: цифры против источников, арифметику, логику выводов, ' +
      'опечатки, следы ИИ в тексте. Если есть агент editor-qa или скилл humanizer-ru-pro, используй их. ' +
      'Блокеры исправь, остальные замечания перечисли.',
    'Check the last result before it goes out: figures against sources, arithmetic, logic of the conclusions, ' +
      'typos, traces of AI in the text. If an editor-qa agent or a humanizer skill exists, use it. ' +
      'Fix blockers and list the other remarks.',
  ),
  memory: t(
    `${MEMORY_MARKS[0]}: запиши в PROJECT_MEMORY.md в корне проекта (если есть скилл project-memory, через него) ` +
      'цель, что сделано, решения и почему, пути к файлам, что осталось. Ответь одной строкой.',
    `${MEMORY_MARKS[1]}: write to PROJECT_MEMORY.md in the project root (through the project-memory skill if there is one) ` +
      'the goal, what is done, decisions and why, file paths, what is left. Answer in one line.',
  ),
  resume: t(
    'Контекст очищен командой /new-sheet. Если памяти проекта ещё нет в контексте, прочитай PROJECT_MEMORY.md ' +
      'в корне проекта. Ответь одной строкой, на чём остановились.',
    'The context was cleared with /new-sheet. If the project memory is not in context yet, read PROJECT_MEMORY.md ' +
      'in the project root. Answer in one line where we left off.',
  ),
})
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

// Что сводка сжатия обязана сохранить, чтобы работа шла дальше без переспросов
const compactHint = () =>
  t(
    'Пиши сводку по-русски. Сохрани: цель и текущую задачу; принятые решения и почему; ' +
      'полные пути к файлам, которые меняли или читали; что сделано и что осталось; ' +
      'ошибки и как их обошли; договорённости и запреты пользователя из этого разговора.',
    'Write the summary in English. Keep: the goal and current task; decisions made and why; ' +
      'full paths of files changed or read; what is done and what is left; ' +
      'errors and how they were worked around; agreements and prohibitions from the user in this conversation.',
  )

// Оформления на выбор: одна краска с градиентом, фон карточек внутри картинки, вид не зависит от темы приложения.
// Плоский вид (flat: цвет по уровню, без карточек, следует за темой приложения) был у Цветного, сейчас его нет ни у одного
type Look = {
  id: StyleId
  label: string
  en: string
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
  status: Record<RowState, string>
  models: [string, string][]
}

// «Слоновая кость» из библиотеки дашбордов: тёплая бумага, чернильный текст, бирюза для роста, красный только для тревоги
const IVORY: Look = {
  id: 'ivory',
  label: 'Кость',
  en: 'Ivory',
  flat: false,
  page: '#F4EFE9',
  solid: false,
  note: '#8B8577',
  ink: '#232347',
  muted: '#8B8577',
  hi: '#3FA8A0',
  mid: '#3FA8A0',
  lo: '#A9D4D0',
  alarm: '#C0504D',
  warn: '#4A4AA0',
  good: '#3FA8A0',
  track: '#E4DCCE',
  line: '#EAE2D4',
  cardTop: '#FBF8F4',
  cardEnd: '#EFE7DC',
  glow: '#FBF8F4',
  ctx: '#3FA8A0',
  cold: '#4A4AA0',
  status: { running: '#3FA8A0', waiting: '#4A4AA0', attention: '#C0504D', stopped: '#8B8577' },
  models: [['opus', '#232347'], ['sonnet', '#3FA8A0'], ['haiku', '#A9D4D0'], ['fable', '#4A4AA0']],
}

// «Золотой нуар»: золото единственная краска, зелёный только для плюсов, персик для тревоги; красный только у строки, требующей внимания
const GOLD: Look = {
  id: 'gold',
  label: 'Золото',
  en: 'Gold',
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
  status: { running: '#7FBF8E', waiting: '#E7C989', attention: '#E5604D', stopped: '#9A938A' },
  models: [['opus', '#E7C989'], ['sonnet', '#8A6B33'], ['haiku', '#7FBF8E'], ['fable', '#E8A26B']],
}

// «Ультрафиолет» из библиотеки дашбордов: фиолет главная краска, плюсы зелёным, розовый для тревоги, циан для остывшего кэша
const VIOLET: Look = {
  id: 'violet',
  label: 'Фиолет',
  en: 'Violet',
  flat: false,
  page: '#07070C',
  solid: true,
  note: '#8D87A8',
  ink: '#F2EFFA',
  muted: '#8D87A8',
  hi: '#A24BFF',
  mid: '#8B30F4',
  lo: '#5F27A8',
  alarm: '#F45B96',
  warn: '#A24BFF',
  good: '#35D07F',
  track: '#2A2657',
  line: 'rgba(141,135,168,.14)',
  cardTop: '#1A1A2C',
  cardEnd: '#131320',
  glow: '#361F5E',
  ctx: '#A24BFF',
  cold: '#2ED3E8',
  status: { running: '#35D07F', waiting: '#A24BFF', attention: '#F45B96', stopped: '#8D87A8' },
  models: [['opus', '#A24BFF'], ['sonnet', '#2ED3E8'], ['haiku', '#35D07F'], ['fable', '#F45B96']],
}

const LOOKS = [IVORY, GOLD, VIOLET]

const STATUS: Record<Row['status'], { label: string; en: string }> = {
  running: { label: 'работает', en: 'running' },
  waiting: { label: 'ждёт вас', en: 'waiting' },
  limit: { label: 'лимит', en: 'limit' },
  stopped: { label: 'остановлена', en: 'stopped' },
}
const statusLabel = (s: Row['status']) => t(STATUS[s].label, STATUS[s].en)
// Цвет строки: красный, если нужны вы, жёлтый, если ждёт, зелёный, если работает, серый, если остановлена
const stateOf = (r: Row): RowState => (r.status === 'limit' || r.needs || r.urgent ? 'attention' : r.status)

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

// Прежние оформления: Синий стал Фиолетом, Цвет стал Костью
const RENAMED: Record<string, StyleId> = { blue: 'violet', color: 'ivory' }

function useLook(id: StyleId) {
  const wanted = RENAMED[id] ?? id
  C = LOOKS.find(look => look.id === wanted) ?? GOLD
  STYLE = styleOf(C)
}

// Ширина карточки и её содержимого
const OUT_W = 320
const PAD_X = 12
const PAD_Y = 10
const W = OUT_W - PAD_X * 2
// Кнопки-картинки: w и h в точках, width их доля в ряду
type Chip = { w: number; h: number; width: string }
const STYLE_CHIP: Chip = { w: 62, h: 26, width: '20%' }
const LANG_CHIP: Chip = { w: 36, h: 26, width: '12%' }
const ACT_CHIP: Chip = { w: 108, h: 30, width: '48%' }
const LOW_CHIP: Chip = { w: 86, h: 26, width: '27%' }
const TOOL_CHIP: Chip = { w: 36, h: 24, width: '12%' }
const OPEN_CHIP: Chip = { w: 100, h: 26, width: '31%' }
// Кнопка размером с подпись, поэтому прозрачная подпись длиннее любой картинки. Лишнее приложение режет многоточием,
// поэтому кнопка заходит за край картинки: многоточие остаётся за обрезанным краем
const BLANK = '\u00a0'.repeat(130)

const METAL = 'url(#metal)'
const num = (n: number, digits = 1) => n.toFixed(digits).replace('.', t(',', '.'))
const thousands = (n: number) => t(`${Math.round(n / 1000)} тыс.`, `${Math.round(n / 1000)}k`)
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
const idle = (min: number) =>
  min < 60
    ? t(`${min} мин`, `${min} min`)
    : t(`${Math.floor(min / 60)} ч ${min % 60} мин`, `${Math.floor(min / 60)} h ${min % 60} min`)
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
  const months = t('янв фев мар апр мая июн июл авг сен окт ноя дек', 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec').split(' ')
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
      ? ring(48, five.percentUsed, paint(five.percentUsed, 'url(#ring)'), `${Math.round(five.percentUsed)}%`, t('5 часов', '5 hours'),
          five.resetsAt ? t(`сброс ${clock(Date.parse(five.resetsAt), tz)}`, `resets ${clock(Date.parse(five.resetsAt), tz)}`) : '')
      : ring(48, 0, C.muted, '—', t('5 часов', '5 hours'), t('после ответа', 'after a reply'))) +
    (week
      ? ring(148, week.percentUsed, paint(week.percentUsed, 'url(#ring)'), `${Math.round(week.percentUsed)}%`, t('Неделя', 'Week'),
          week.resetsAt ? t(`сброс ${dayClock(Date.parse(week.resetsAt), tz)}`, `resets ${dayClock(Date.parse(week.resetsAt), tz)}`) : '')
      : ring(148, 0, C.muted, '—', t('Неделя', 'Week'), '')) +
    (ctx?.tokens !== undefined
      ? ring(248, ctx.percent ?? 0, ctxPaint(ctx.tokens), `${ctx.percent ?? 0}%`, t('Контекст', 'Context'), thousands(ctx.tokens))
      : ring(248, 0, C.muted, '—', t('Контекст', 'Context'), ''))
  const fivePct = five ? Math.round(five.percentUsed) : '?'
  const weekPct = week ? Math.round(week.percentUsed) : '?'
  const alt = t(`Лимит 5 часов ${fivePct}%, неделя ${weekPct}%, контекст ${ctx?.percent ?? '?'}%`, `5-hour limit ${fivePct}%, week ${weekPct}%, context ${ctx?.percent ?? '?'}%`)
  return { source: svg(114, body, 'glow'), alt }
}

function forecastSvg(s: Snapshot | null, lim: Limits | null, now: number, tz: number) {
  const five = lim?.rateLimits.find(r => r.kind === 'five_hour')
  const head = `<text x="0" y="12" class="h">${cap(t('5-часовое окно', '5-hour window'))}</text>`
  if (!s || !five || !s.winStart) {
    return { source: svg(34, `${head}<text x="0" y="31" class="m">${t('нет данных об окне, появятся после ответа модели', 'no window data yet, it appears after a model reply')}</text>`), alt: t('Нет данных об окне', 'No window data') }
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
  let note = t('сейчас почти не тратится', 'almost no spend right now')
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
      ? t(`кончится ≈ ${clock(s.winStart + hitMin * 60_000, tz)}`, `runs out ≈ ${clock(s.winStart + hitMin * 60_000, tz)}`)
      : t(`к сбросу ≈ ${Math.round(endPct)}%`, `at reset ≈ ${Math.round(endPct)}%`)
    const lx = clamp(ex, x0 + 90, x1)
    proj += `<text x="${lx.toFixed(1)}" y="${hits ? yTop - 7 : y(endPct) - 7}" text-anchor="end" class="t" style="fill:${color}">${note}</text>`
  }
  const resets = five.resetsAt ? Date.parse(five.resetsAt) : s.winStart + 300 * 60_000
  const body =
    head +
    `<text x="${W}" y="12" text-anchor="end" class="m">${t(`темп ${num(s.rate30Pct)}% за 30 мин`, `pace ${num(s.rate30Pct)}% per 30 min`)}</text>` +
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
    // У краёв «сейчас» наехало бы на время начала или сброса; момент и так видно по пунктиру
    (x(nowMin) - x0 > 56 && x1 - x(nowMin) > 56
      ? `<text x="${x(nowMin).toFixed(1)}" y="${yBot + 16}" text-anchor="middle" class="m">${t('сейчас', 'now')}</text>`
      : '') +
    `<text x="${x1}" y="${yBot + 16}" text-anchor="end" class="m">${clock(resets, tz)}</text>`
  return { source: svg(114, body), alt: t(`Пятичасовое окно: ${Math.round(pct)}%, ${note}`, `5-hour window: ${Math.round(pct)}%, ${note}`) }
}

function sessionsHeadSvg(s: Snapshot) {
  const rows = s.sessions
  const count = (state: RowState) => rows.filter(r => stateOf(r) === state).length
  const [need, run, wait, stop] = [count('attention'), count('running'), count('waiting'), count('stopped')]
  const alt = t(`Сессии: внимание ${need}, работают ${run}, ждут ${wait}, стоп ${stop}, агентов ${s.agents}`, `Sessions: ${need} need you, ${run} running, ${wait} waiting, ${stop} stopped, ${s.agents} agents`)
  if (C.flat) {
    const slot = (x: number, color: string, text: string) =>
      `<circle cx="${x + 5}" cy="11" r="5" fill="${color}"/><text x="${x + 14}" y="15" class="t">${text}</text>`
    const body =
      slot(0, C.status.attention, String(need)) +
      slot(40, C.status.running, String(run)) +
      slot(80, C.status.waiting, String(wait)) +
      slot(120, C.status.stopped, String(stop)) +
      `<rect x="212" y="4" width="84" height="15" rx="7.5" fill="${C.ctx}" fill-opacity=".15"/>` +
      `<text x="254" y="15" text-anchor="middle" class="t" style="fill:${C.ctx}">${t(`агентов ${s.agents}`, `agents ${s.agents}`)}</text>` +
      (rows.length ? '' : `<text x="0" y="40" class="m">${t('сегодня сессий не было', 'no sessions today')}</text>`)
    return { source: svg(rows.length ? 24 : 46, body), alt }
  }
  const stat = (x: number, value: number, label: string, color: string) =>
    `<text x="${x}" y="20" text-anchor="middle" class="b" style="fill:${color}">${value}</text>` +
    `<text x="${x}" y="35" text-anchor="middle" class="h" style="font-size:9px;letter-spacing:.06em">${label}</text>`
  let body =
    stat(28, need, t('ВНИМАНИЕ', 'ATTENTION'), C.status.attention) +
    stat(92, run, t('РАБОТАЮТ', 'RUNNING'), C.status.running) +
    stat(150, wait, t('ЖДУТ', 'WAITING'), C.status.waiting) +
    stat(204, stop, t('СТОП', 'STOPPED'), C.status.stopped) +
    stat(264, s.agents, t('АГЕНТОВ', 'AGENTS'), C.ink)
  if (!rows.length) body += `<text x="0" y="56" class="m">${t('сегодня сессий не было', 'no sessions today')}</text>`
  return { source: svg(rows.length ? 38 : 60, body), alt }
}

// Строка сессии. Статус показывает цвет строки, справа прямоугольник со знаком Enter; без ссылки статус подписан
function sessionRowSvg(r: Row) {
  const rowW = C.flat ? W : OUT_W
  const h = 44
  const color = C.status[stateOf(r)]
  const label = statusLabel(r.status)
  const barW = r.link ? 104 : 160
  const keyX = rowW - 42
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
      ? t(`❄ ${r.coldInMin} мин · ${num(r.coldPct ?? 0)}%`, `❄ ${r.coldInMin} min · ${num(r.coldPct ?? 0)}%`)
      : r.coldPct !== null
        ? `❄ ${num(r.coldPct)}%`
        : null
  const tail = cold ?? (r.agents ? t(`агентов ${r.agents}`, `agents ${r.agents}`) : since)
  const tailColor = r.urgent ? C.alarm : cold ? C.cold : r.agents ? C.ctx : undefined
  // Знак Enter нарисован линиями: символ шрифта на разных компьютерах выглядит по-разному
  const chip = r.link
    ? `<rect x="${keyX}" y="7" width="34" height="30" rx="6" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".7"/>` +
      `<path d="M${keyX + 23} 16v6a2.5 2.5 0 0 1-2.5 2.5H${keyX + 11}m3.5-3.5l-3.5 3.5 3.5 3.5" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<rect x="${rowW - 98}" y="6" width="90" height="18" rx="9" fill="${C.flat ? color : C.track}"/>` +
      `<text x="${rowW - 53}" y="19" text-anchor="middle" class="t" style="fill:${C.flat ? '#fff' : color};font-size:11.5px">${label}</text>`
  const back = C.flat
    ? `<rect x="0" y="0" width="${rowW}" height="${h}" rx="7" fill="${color}" fill-opacity=".16"/><rect x="0" y="0" width="6" height="${h}" rx="3" fill="${color}"/>`
    : `<rect x=".5" y=".5" width="${rowW - 1}" height="${h - 1}" rx="10" fill="url(#card)"/>` +
      `<rect x=".5" y=".5" width="${rowW - 1}" height="${h - 1}" rx="10" fill="${color}" fill-opacity=".09" stroke="${color}" stroke-opacity=".6"/>` +
      `<rect x="0" y="8" width="4" height="${h - 16}" rx="2" fill="${color}"/>`
  const body =
    `<title>${esc(r.title)} · ${esc(r.project)} · ${label} ${since} · ${t('контекст', 'context')} ${thousands(r.ctx)}</title>` +
    back +
    `<text x="14" y="18" class="n">${cut(r.title, !r.link ? 27 : C.flat ? 33 : 38)}</text>` +
    chip +
    `<rect x="14" y="28" width="${barW}" height="${barH}" rx="${barH / 2}" class="trf"/>` +
    (fill > 0 ? `<rect x="14" y="28" width="${Math.max(4, fill).toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${isHeavy ? C.alarm : C.flat ? C.ctx : 'url(#fillh)'}"/>` : '') +
    `<line x1="${heavyX.toFixed(1)}" y1="26" x2="${heavyX.toFixed(1)}" y2="${28 + barH + 2}" stroke="${C.alarm}" stroke-opacity=".6"/>` +
    `<text x="${14 + barW + 6}" y="36" class="m" style="fill:${ctxColor}">${kilo(r.ctx)}</text>` +
    (tail ? `<text x="${r.link ? keyX - 8 : rowW - 8}" y="36" text-anchor="end" class="m"${tailColor ? ` style="fill:${tailColor}"` : ''}>${tail}</text>` : '')
  const coldAlt =
    r.coldInMin !== null
      ? t(`, кэш остынет через ${r.coldInMin} мин, потом ответ обойдётся в ${num(r.coldPct ?? 0)}% лимита`, `, cache cools in ${r.coldInMin} min, then a reply costs ${num(r.coldPct ?? 0)}% of the limit`)
      : ''
  const alt = `${r.title}: ${label}${since ? `, ${since}` : ''}, ${t('контекст', 'context')} ${thousands(r.ctx)}${coldAlt}`
  return { source: doc(rowW, h, body), alt }
}

// Кнопка-картинка: шрифт как у подписи квадрата скорости, рамка в один пиксель, выбранная заметнее
function chipSvg(c: Chip, text: string, isMain: boolean, mark?: string) {
  const accent = C.flat ? C.ctx : C.mid
  // На тёмном фоне (solid) слабая заливка не видна, выбранную кнопку закрашиваем плотнее
  const fill = isMain ? `fill="${accent}" fill-opacity="${C.solid ? '.45' : '.16'}"` : C.flat ? 'fill="none"' : 'fill="url(#card)"'
  const edge = C.flat && !isMain ? 'class="grid"' : `stroke="${accent}"`
  const body =
    `<rect x=".5" y=".5" width="${c.w - 1}" height="${c.h - 1}" rx="7" ${fill} ${edge} stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    (mark ?? `<text x="${c.w / 2}" y="${c.h / 2 + 4}" text-anchor="middle" class="t" style="font-size:11.5px${isMain ? ';font-weight:600' : ''}">${esc(text)}</text>`)
  return { source: doc(c.w, c.h, body), alt: text }
}

// Значок кнопки настройки: четыре блока
const BLOCKS_MARK = [[12, 7], [19, 7], [12, 14], [19, 14]].map(([x, y]) => `<rect x="${x}" y="${y}" width="5" height="5" rx="1.2" class="t"/>`).join('')

// Название блока в режиме настройки
function blockLabelSvg(text: string) {
  return { source: doc(120, 24, `<text x="2" y="16" class="h">${esc(cap(text))}</text>`), alt: text }
}

function weekSvg(s: Snapshot, lim: Limits | null, now: number, tz: number) {
  const head = `<text x="0" y="12" class="h">${cap(t('Недельное окно', 'Weekly window'))}</text>`
  const wk = s.week
  if (!wk) {
    return { source: svg(34, `${head}<text x="0" y="31" class="m">${t('нет данных о недельном лимите', 'no weekly limit data')}</text>`), alt: t('Нет данных о недельном лимите', 'No weekly limit data') }
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
  let note = t('темп станет ясен через несколько часов', 'the pace will be clear in a few hours')
  if (wk.perDay !== null && wk.endPct !== null) {
    const hits = wk.hitAt !== null
    const color = hits ? C.alarm : C.muted
    const ex = x(wk.hitAt ?? wk.reset)
    const ey = y(hits ? 100 : wk.endPct)
    note =
      wk.hitAt !== null
        ? t(`кончится ≈ ${dayClock(wk.hitAt, tz)}`, `runs out ≈ ${dayClock(wk.hitAt, tz)}`)
        : t(`к сбросу ≈ ${Math.min(100, wk.endPct)}%`, `at reset ≈ ${Math.min(100, wk.endPct)}%`)
    proj =
      `<path d="M${x(now).toFixed(1)},${y(pct).toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}" stroke="${color}" stroke-width="1.6" stroke-dasharray="5 4" fill="none"/>` +
      (hits ? `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="${C.alarm}"/>` : '') +
      `<text x="${clamp(ex, x0 + 120, x1).toFixed(1)}" y="${hits ? yTop - 7 : ey - 7}" text-anchor="end" class="t" style="fill:${color}">${note}</text>`
  }
  const names = t('вс пн вт ср чт пт сб', 'Su Mo Tu We Th Fr Sa').split(' ')
  let days = ''
  for (let i = 0; i < 7; i++) {
    const at = wk.start + i * day
    if (i) days += `<line x1="${x(at).toFixed(1)}" y1="${yTop}" x2="${x(at).toFixed(1)}" y2="${yBot}" class="grid" stroke-dasharray="1 5"/>`
    days += `<text x="${x(at + day / 2).toFixed(1)}" y="${yBot + 16}" text-anchor="middle" class="m">${names[new Date(at + tz * 60_000).getUTCDay()]}</text>`
  }
  const body =
    head +
    (wk.perDay !== null ? `<text x="${W}" y="12" text-anchor="end" class="m">${t(`темп ${num(wk.perDay)}% в сутки`, `pace ${num(wk.perDay)}% per day`)}</text>` : '') +
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
  return { source: svg(114, body), alt: t(`Недельное окно: ${Math.round(pct)}%, ${note}`, `Weekly window: ${Math.round(pct)}%, ${note}`) }
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
        ? `<rect x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${(step - 4).toFixed(1)}" height="${(yBot - y(v)).toFixed(1)}" rx="2" fill="${color}"><title>${String(h).padStart(2, '0')}:00, ${num(v)}% ${t('лимита', 'of the limit')}</title></rect>`
        : `<rect x="${bx.toFixed(1)}" y="${yBot - 2}" width="${(step - 4).toFixed(1)}" height="2" class="trf"/>`
    if (h === hourNow) bars += `<circle cx="${(bx + (step - 4) / 2).toFixed(1)}" cy="${yBot + 6}" r="2.2" fill="${C.hi}"/>`
  })
  const labels = [0, 6, 12, 18, 23]
    .map(h => `<text x="${(x0 + h * step + step / 2).toFixed(1)}" y="${yBot + 20}" text-anchor="middle" class="m">${h}</text>`)
    .join('')
  const body =
    `<text x="0" y="12" class="h">${cap(t('Сегодня по часам', 'Today by hour'))}</text>` +
    `<text x="${W}" y="12" text-anchor="end" class="m">${t(`${num(s.todayPct, 0)}% лимита за день`, `${num(s.todayPct, 0)}% of the limit today`)}</text>` +
    `<line x1="${x0}" y1="${y(20).toFixed(1)}" x2="${W - 2}" y2="${y(20).toFixed(1)}" stroke="${C.alarm}" stroke-dasharray="4 3" stroke-opacity=".6"/>` +
    `<text x="${W - 2}" y="${(y(20) - 3).toFixed(1)}" text-anchor="end" class="m">${t('норма 20%/ч', 'norm 20%/h')}</text>` +
    bars +
    labels
  return { source: svg(100, body), alt: t(`Сегодня ${num(s.todayPct, 0)}% пятичасового лимита, по часам`, `Today ${num(s.todayPct, 0)}% of the 5-hour limit, by hour`) }
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
    `<text x="0" y="12" class="h">${cap(t('Модели и лидеры расхода', 'Models and top spenders'))}</text>` +
    `<clipPath id="r"><rect x="0" y="22" width="${W}" height="8" rx="4"/></clipPath><g clip-path="url(#r)"><rect x="0" y="22" width="${W}" height="8" class="trf"/>${stack}</g>` +
    legend +
    leaders
  return { source: svg(58 + s.top.length * 20, body), alt: `${t('Модели', 'Models')}: ${models.map(([m, u]) => `${m} ${Math.round((u / total) * 100)}%`).join(', ')}` }
}

// Квадрат рядом с кнопками: скорость загрузки на круговой шкале.
// Шкала логарифмическая: разница между 5 и 50 Мбит/с важнее, чем между 300 и 350
const NET_W = 92
const NET_H = 74

function netSvg(n: Net | null) {
  const cx = NET_W / 2
  const cy = 60
  const r = 21
  const len = Math.PI * r
  const mbit = n?.mbit ?? null
  const name = n ? (mbit === null ? t('нет сети', 'offline') : t('Интернет', 'Internet')) : t('замеряю', 'measuring')
  const pos = mbit === null ? 0 : clamp(Math.log10(Math.max(mbit, 1)) / 3, 0, 1)
  const arc = `M${cx - r},${cy} A${r},${r} 0 0 1 ${cx + r},${cy}`
  const stroke = mbit !== null && mbit < 5 ? C.alarm : !C.flat ? 'url(#ring)' : mbit !== null && mbit < 25 ? C.warn : C.good
  const size = name.length > 11 ? 10 : name.length > 8 ? 11 : 12.5
  const body =
    `<rect x=".5" y=".5" width="${NET_W - 1}" height="${NET_H - 1}" rx="12" fill="${C.flat ? 'none' : 'url(#card)'}" stroke="${C.line}"/>` +
    `<text x="${cx}" y="18" text-anchor="middle" class="t" style="font-size:${size}px">${esc(name)}</text>` +
    `<line x1="12" y1="26" x2="${NET_W - 12}" y2="26" class="grid"/>` +
    `<path d="${arc}" fill="none" class="tr" stroke-width="6" stroke-linecap="round"/>` +
    (pos > 0
      ? `<path d="${arc}" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(pos * len).toFixed(1)} ${len.toFixed(1)}"/>`
      : '') +
    `<text x="${cx}" y="${cy - 1}" text-anchor="middle" class="b" style="font-size:14px">${mbit === null ? '—' : Math.round(mbit)}</text>` +
    `<text x="${cx}" y="${cy + 10}" text-anchor="middle" class="m" style="font-size:9px">${t('Мбит/с', 'Mbit/s')}</text>`
  const alt = `${name}, ${mbit === null ? t('скорость не измерена', 'speed not measured') : `${Math.round(mbit)} ${t('Мбит/с', 'Mbit/s')}`}`
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
    let failure = noPython()
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
        if (r.stderr.includes('Traceback')) failure = `${t('сборщик', 'collector')}: ${r.stderr.slice(-200)}`
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
  await $.store.set('net', { mbit: null, ...saved, at: now }).catch(() => undefined)
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

// Стиль, язык и блоки общие для всех сессий: открытые панели подхватывают их при обновлении
async function loadPrefs($: EngineInterface) {
  const savedStyle = (await $.store.get('style').catch(() => undefined)) as StyleId | undefined
  if (savedStyle) await update($, style, () => savedStyle)
  const savedLang = (await $.store.get('lang').catch(() => undefined)) as LangId | undefined
  if (savedLang) {
    LANG = savedLang
    await update($, lang, () => savedLang)
  }
  const savedLayout = (await $.store.get('layout').catch(() => undefined)) as Layout | undefined
  if (savedLayout) await update($, layout, () => cleanLayout(savedLayout))
}

async function refresh($: EngineInterface, force = false) {
  await loadPrefs($)
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
    isSent = (await $.ui.notify(text, { title: title() })).isSent
  } catch {
    isSent = false
  }
  if (!isSent) await windowsToast($, title(), text)
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
    if (r.link) await windowsToast($, t(`Ждёт вас: ${r.title}`, `Waiting for you: ${r.title}`), r.note ?? t('Нажмите, чтобы открыть сессию', 'Click to open the session'), r.link)
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
    const name = isFive ? t('Лимит 5 часов', '5-hour limit') : t('Недельный лимит', 'Weekly limit')
    const resetMs = Date.parse(r.resetsAt)
    const reset = isFive ? clock(resetMs, tz) : dayClock(resetMs, tz)
    if (r.percentUsed >= ALERT_PCT) {
      alerts.push([`${r.kind}-${ALERT_PCT}-${r.resetsAt}`, t(`${name}: ${Math.round(r.percentUsed)}%, сброс ${reset}`, `${name}: ${Math.round(r.percentUsed)}%, resets ${reset}`)])
    }
    const perMin = (s?.rate30Pct ?? 0) / 30
    if (isFive && perMin > 0 && r.percentUsed >= FORECAST_FROM_PCT && r.percentUsed < 100) {
      const endsAt = now + ((100 - r.percentUsed) / perMin) * 60_000
      if (endsAt < resetMs) {
        alerts.push([`five_hour-end-${r.resetsAt}`, t(`${name} кончится около ${clock(endsAt, tz)}, а сброс только в ${reset}`, `${name} runs out around ${clock(endsAt, tz)}, the reset is only at ${reset}`)])
      }
    }
    if (!isFive && s?.week?.hitAt && r.percentUsed >= FORECAST_FROM_PCT) {
      alerts.push([`seven_day-end-${r.resetsAt}`, t(`${name} кончится около ${dayClock(s.week.hitAt, tz)}, а сброс только ${reset}`, `${name} runs out around ${dayClock(s.week.hitAt, tz)}, the reset is only on ${reset}`)])
    }
  }
  if (!alerts.length) return
  const sent = ((await $.store.get('alerts')) as string[] | undefined) ?? []
  const fresh = alerts.filter(([key]) => !sent.includes(key))
  if (!fresh.length) return
  await $.store.set('alerts', [...sent, ...fresh.map(([key]) => key)].slice(-40))
  for (const [, text] of fresh) await notify($, text)
}

async function chooseStyle($: EngineInterface, id: StyleId) {
  await update($, style, () => id)
  await $.store.set('style', id).catch(() => undefined)
}

async function chooseLang($: EngineInterface, id: LangId) {
  LANG = id
  await update($, lang, () => id)
  await $.store.set('lang', id).catch(() => undefined)
  void $.ui.open({ id: PANE, title: title() })
}

// Сохранённое могло остаться от другой версии: неизвестное отбрасываем, новые блоки ставим в конец
function cleanLayout(l: Layout): Layout {
  const known = FIRST_LAYOUT.order
  const kept = (ids: BlockId[]) => ids.filter(id => known.includes(id))
  const order = kept(l.order)

  return { order: [...order, ...known.filter(id => !order.includes(id))], folded: kept(l.folded), closed: kept(l.closed) }
}

const toggled = (ids: BlockId[], id: BlockId) => (ids.includes(id) ? ids.filter(b => b !== id) : [...ids, id])

// Меняется местами с соседом на экране: закрытые блоки не считаются, иначе нажатие ничего бы не сдвинуло
function moved({ order, closed }: Layout, id: BlockId, by: -1 | 1) {
  const shown = order.filter(b => !closed.includes(b))
  const other = shown[shown.indexOf(id) + by]

  return other ? order.map(b => (b === id ? other : b === other ? id : b)) : order
}

async function changeLayout($: EngineInterface, change: (l: Layout) => Layout) {
  const next = change(await read($, layout))
  await update($, layout, () => next)
  await $.store.set('layout', next).catch(() => undefined)
}

// Открывает сессию в приложении: rundll32 отдаёт ссылку claude:// обработчику без оболочки и кавычек
async function openSession($: EngineInterface, link: string) {
  try {
    await $.process.run([RUNDLL32, 'url.dll,FileProtocolHandler', link], { timeoutMs: 10_000 })
  } catch (err) {
    $.ui.toast(`${t('Не удалось открыть сессию', 'Could not open the session')}: ${String(err).slice(0, 100)}`)
  }
}

// Кнопки «Статус», «Итог», «Проверка»: промпт уходит как набранный пользователем, во время ответа ждёт очереди
async function ask($: EngineInterface, text: string) {
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) $.ui.toast(`${t('Не отправилось', 'Not sent')}: ${r.drop}`)
}

// Команда /new-sheet: отправляет сохранение памяти, а контекст очищается, когда закончится
// именно этот ход (см. turn.start и turn.complete)
async function newSheet($: EngineInterface) {
  await update($, pendingClear, () => 'queued')
  // Если ход с сохранением так и не начался за 10 минут, снимаем ожидание, чтобы кнопка не зависла
  $.clock.after(10 * 60_000, () => void update($, pendingClear, v => (v === 'queued' ? null : v)))
  $.ui.toast(t('Сохраняю память проекта, потом очищу контекст', 'Saving the project memory, then clearing the context'))
  const r = await $.prompt.submit({ text: asks().memory, asUser: true })
  if (r.drop !== undefined) {
    await update($, pendingClear, () => null)
    $.ui.toast(`${t('Не отправилось', 'Not sent')}: ${r.drop}`)
  }
}

async function clearNow($: EngineInterface) {
  try {
    await $.command.run({ command: 'clear', args: '' })
    $.ui.toast(t('Новый лист: контекст очищен, подгружаю память проекта', 'New sheet: context cleared, loading the project memory'))
  } catch (err) {
    $.ui.toast(`${t('Не удалось очистить, наберите /clear', 'Could not clear, type /clear')}: ${String(err).slice(0, 100)}`)
    return
  }
  await readUsage($)
  // Память подгружает не каждый: у кого нет хука на старт сессии, модель прочитает файл сама
  await ask($, asks().resume)
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
      r = await $.session.compact({ instructions: compactHint() })
    } catch {
      $.ui.toast(t('Модель отвечает: сожму, как только закончит', 'The model is replying: will compact when it finishes'))
      await $.command.run({ command: 'compact', args: compactHint() })
      $.ui.toast(t('Контекст сжат', 'Context compacted'))
      return
    }
    if (r.skip !== undefined) $.ui.toast(`${t('Сжатие отменено', 'Compaction cancelled')}: ${r.skip}`)
    else if (r.tokensBefore && r.tokensAfter) $.ui.toast(`${t('Контекст сжат', 'Context compacted')}: ${kilo(r.tokensBefore)} → ${kilo(r.tokensAfter)}`)
    else $.ui.toast(t('Контекст сжат', 'Context compacted'))
  } catch (err) {
    $.ui.toast(`${t('Не удалось сжать', 'Could not compact')}: ${String(err).slice(0, 120)}`)
  } finally {
    await update($, compacting, () => false)
    await readUsage($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Перезагрузка обрывает сжатие на полпути, а флаг её переживает: без сброса кнопка осталась бы на «Сжимаю…»
    await update($, compacting, () => false)
    await loadPrefs($)
    await $.command.register({ name: 'pult', description: t('Открыть пульт сессий: лимиты, контекст, расход, агенты', 'Open the session pult: limits, context, spend, agents') })
    await $.command.register({ name: 'new-sheet', description: t('Новый лист: сохранить память проекта и очистить контекст', 'New sheet: save the project memory and clear the context') })
    void $.ui.open({ id: PANE, title: title() })
    tick?.cancel()
    tick = $.clock.every(REFRESH_MS, () => void refresh($))
    void refresh($)

    return started
  })

  on('command.run', { command: 'pult' }, async $ => {
    await $.ui.open({ id: PANE, title: title() })
    await refresh($)

    return { text: t('Пульт сессий открыт и обновлён.', 'Session pult opened and refreshed.') }
  })

  on('command.run', { command: 'new-sheet' }, $ => {
    // Не ждём: команда не должна висеть до конца хода с сохранением памяти
    void newSheet($)

    return { text: t('Сохраняю память проекта, потом очищу контекст.', 'Saving the project memory, then clearing the context.') }
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
      if ((await read($, pendingClear)) === 'queued' && MEMORY_MARKS.some(mark => e.text.includes(mark))) {
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
      ? t(
          `Перерыв ${idle(idleMin)}, кэш остыл: следующий ответ перечитает ${kilo(ctx)} заново, это около ${num((ctx * 2) / cal)}% лимита. После сжатия шаги станут в разы дешевле.`,
          `Break of ${idle(idleMin)}, the cache has cooled: the next reply rereads ${kilo(ctx)}, about ${num((ctx * 2) / cal)}% of the limit. After compacting, steps get several times cheaper.`,
        )
      : t(
          `Кэш остынет через ${COLD_MIN - idleMin} мин. Пока он тёплый, сжатие дешёвое; потом ${kilo(ctx)} придётся читать заново, около ${num((ctx * 2) / cal)}% лимита.`,
          `The cache cools in ${COLD_MIN - idleMin} min. Compacting is cheap while it is warm; later ${kilo(ctx)} must be reread, about ${num((ctx * 2) / cal)}% of the limit.`,
        )
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text color={isCold ? 'warning' : undefined}>{text}</Text>
        <Button key="cold-compact" variant="primary" onPress={() => void compactNow($)}>
          {t('Сжать', 'Compact')}
        </Button>
        <Button key="cold-hide" onPress={() => void update($, coldHidden, () => last)}>
          {t('Скрыть', 'Hide')}
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // В терминале нет Svg: там вместо графиков их текстовые подписи
    const Svg = 'Svg' in els ? els.Svg : undefined
    // Кнопки-картинки только на desktop: наложение проверено там, в остальных приложениях кнопки обычные
    const isDrawn = Svg !== undefined && e.surface === 'desktop'
    const s = await read($, snap)
    const lim = await read($, limits)
    const err = await read($, error)
    const now = await $.clock.now()
    const tz = s?.tzOffsetMin ?? 180

    const ctx = lim?.context.tokens ?? s?.self?.ctx ?? 0
    const busyCompact = await read($, compacting)
    const netNow = await read($, net)
    const view = await read($, layout)
    const isArranging = await read($, arranging)
    // После этой строки чтений нет: всё, что ниже, рисуется синхронно в выбранном оформлении
    LANG = await read($, lang)
    useLook(await read($, style))
    const backdrop = Svg && C.page ? { backgroundColor: C.page, padding: 'sm' as const } : {}
    const noteColor = C.note ? { color: C.note } : { dimColor: true }
    // Обычная кнопка там, где кнопки не нарисованы: на своём фоне панели подпись сливается с ним, поэтому они плотные
    const pick = (isMain: boolean) =>
      C.solid
        ? { variant: 'primary' as const, dimColor: !isMain }
        : { variant: isMain ? ('primary' as const) : ('secondary' as const) }
    // Картинкой, не isInteractive: интерактивная рамка ужимает высокий график до своей высоты
    const draw = (c: { source: string; alt: string }) => (Svg ? <Svg source={c.source} alt={c.alt} /> : <Text>{c.alt}</Text>)
    // Шрифт и рамку обычной кнопки приложение менять не даёт, поэтому на desktop кнопку рисует картинка,
    // а нажатие ловит прозрачная кнопка поверх. Подпись только в картинке: заданную подпись приложение рисует поверх
    const hit = (key: string, onPress: () => void, rows = 1) => (
      <Box position="absolute" left={0} top={0} width="200%" height="100%" flexDirection="column">
        {Array.from({ length: rows }, (_, i) => (
          <Button key={i ? `${key}-${i}` : key} plain onPress={onPress}>
            {BLANK}
          </Button>
        ))}
      </Box>
    )
    const btn = (key: string, text: string, isMain: boolean, chip: Chip, onPress: () => void, mark?: string) =>
      isDrawn ? (
        <Box key={`frame-${key}`} position="relative" width={chip.width} flexDirection="column" overflow="hidden">
          {draw(chipSvg(chip, text, isMain, mark))}
          {hit(key, onPress)}
        </Box>
      ) : (
        <Button key={key} {...pick(isMain)} onPress={onPress}>
          {text}
        </Button>
      )
    const sessionRow = (r: Row) => {
      const link = r.link
      const open = link ? () => void openSession($, link) : undefined

      return (
        <Box key={r.id} flexDirection="column" gap="xs">
          <Box position="relative" flexDirection="column" overflow="hidden">
            {draw(sessionRowSvg(r))}
            {/* Нажимается вся строка: она выше кнопки, поэтому кнопок две, одна под другой */}
            {open && isDrawn && hit(`open-${r.id}`, open, 2)}
          </Box>
          {open && !isDrawn && (
            <Button key={`open-${r.id}`} {...pick(stateOf(r) === 'attention')} onPress={open}>
              {t('Перейти', 'Open')}
            </Button>
          )}
          {r.note && <Text {...noteColor}>{r.note}</Text>}
        </Box>
      )
    }
    // Картинки сжимаются вместе с панелью, а обычным кнопкам нужен перенос
    const rowFit = isDrawn ? {} : { flexWrap: 'wrap' as const, gap: 'xs' as const }

    const change = (fn: (l: Layout) => Layout) => () => void changeLayout($, fn)
    const toggleArranging = () => void update($, arranging, isOn => !isOn)
    const blockName = (id: BlockId) => {
      const b = BLOCKS.find(x => x.id === id)

      return b ? t(b.label, b.en) : id
    }
    const content = (id: BlockId) => {
      if (id === 'gauges') return draw(gaugesSvg(lim, tz))
      if (id === 'forecast') return draw(forecastSvg(s, lim, now, tz))
      if (id === 'actions') {
        return (
          // Сжатие главным при тяжёлом контексте, справа скорость
          <Box flexDirection="row" alignItems="flex-start" justifyContent="space-between" gap="xs">
            <Box width="71%" flexShrink={1} flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between" {...rowFit}>
                {btn(
                  'compact',
                  busyCompact
                    ? t('Сжимаю…', 'Compacting…')
                    : ctx
                      ? t(`Сжать · ${kilo(ctx)}`, `Compact · ${kilo(ctx)}`)
                      : t('Сжать', 'Compact'),
                  ctx >= HEAVY_CTX,
                  ACT_CHIP,
                  () => void compactNow($),
                )}
                {btn('status', t('Статус', 'Status'), false, ACT_CHIP, () => void ask($, asks().status))}
              </Box>
              <Box flexDirection="row" justifyContent="space-between" {...rowFit}>
                {btn('report', t('Итог', 'Report'), false, ACT_CHIP, () => void ask($, asks().report))}
                {btn('check', t('Проверка', 'Check'), false, ACT_CHIP, () => void ask($, asks().check))}
              </Box>
            </Box>
            <Box width="27%" flexShrink={0} flexDirection="row" justifyContent="flex-end">
              {draw(netSvg(netNow))}
            </Box>
          </Box>
        )
      }
      if (!s) return null
      if (id === 'week') return draw(weekSvg(s, lim, now, tz))
      if (id === 'hours') return draw(hoursSvg(s, now, tz))
      if (id === 'spend') return draw(spendSvg(s))

      return (
        <Box flexDirection="column" gap="xs">
          {draw(sessionsHeadSvg(s))}
          {s.sessions.map(sessionRow)}
        </Box>
      )
    }
    // Перетаскивания у панели нет: порядок меняют стрелки
    const tools = (id: BlockId, isFolded: boolean) => (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" {...rowFit}>
        <Box width="40%">{draw(blockLabelSvg(blockName(id)))}</Box>
        {btn(`block-up-${id}`, '▲', false, TOOL_CHIP, change(l => ({ ...l, order: moved(l, id, -1) })))}
        {btn(`block-down-${id}`, '▼', false, TOOL_CHIP, change(l => ({ ...l, order: moved(l, id, 1) })))}
        {btn(`block-fold-${id}`, isFolded ? '+' : '−', false, TOOL_CHIP, change(l => ({ ...l, folded: toggled(l.folded, id) })))}
        {btn(`block-close-${id}`, '×', false, TOOL_CHIP, change(l => ({ ...l, closed: toggled(l.closed, id) })))}
      </Box>
    )
    const block = (id: BlockId) => {
      const isFolded = view.folded.includes(id)
      const body = isFolded ? null : content(id)
      if (isArranging) {
        return (
          <Box key={id} flexDirection="column" gap="xs">
            {tools(id, isFolded)}
            {body}
          </Box>
        )
      }
      // Свёрнутый блок остаётся полоской с названием: нажатие разворачивает его
      if (isFolded) {
        return btn(`unfold-${id}`, `${blockName(id)} ▾`, false, { w: C.flat ? W : OUT_W, h: 26, width: '100%' }, change(l => ({ ...l, folded: toggled(l.folded, id) })))
      }

      return (
        body && (
          <Box key={id} flexDirection="column">
            {body}
          </Box>
        )
      )
    }

    return (
      <Box flexDirection="column" gap={1} {...backdrop}>
        <Box flexDirection="row" justifyContent="space-between" {...rowFit}>
          {LOOKS.map(look => btn(`style-${look.id}`, t(look.label, look.en), look.id === C.id, STYLE_CHIP, () => void chooseStyle($, look.id)))}
          {(['ru', 'en'] as const).map(id => btn(`lang-${id}`, id.toUpperCase(), id === LANG, LANG_CHIP, () => void chooseLang($, id)))}
          {btn('arrange', t('Блоки', 'Blocks'), isArranging, LANG_CHIP, toggleArranging, BLOCKS_MARK)}
        </Box>
        {view.order.filter(id => !view.closed.includes(id)).map(id => block(id))}
        {isArranging && (
          <Box flexDirection="row" flexWrap="wrap" gap="xs">
            {view.closed.map(id => btn(`block-open-${id}`, `+ ${blockName(id)}`, false, OPEN_CHIP, change(l => ({ ...l, closed: toggled(l.closed, id) }))))}
            {btn('layout-reset', t('Как было', 'Reset'), false, OPEN_CHIP, change(() => FIRST_LAYOUT))}
            {btn('arrange-done', t('Готово', 'Done'), true, OPEN_CHIP, toggleArranging)}
          </Box>
        )}
        {!s && <Text {...noteColor}>{t('Собираю данные…', 'Collecting data…')}</Text>}
        {err && <Text color="error">{err}</Text>}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Text {...noteColor}>
            {s
              ? t(`Обновлено ${clock(s.at, tz)} · 1% лимита ≈ ${thousands(s.cal)} ед.`, `Updated ${clock(s.at, tz)} · 1% of the limit ≈ ${thousands(s.cal)} units`)
              : t('Первое обновление…', 'First update…')}
          </Text>
          {btn('refresh', t('Обновить', 'Refresh'), false, LOW_CHIP, () => void refresh($, true))}
        </Box>
      </Box>
    )
  })
}
