import { expect, mock, test } from 'claude-code/testing'

// Тестовые данные: ответ сборщика и лимиты, как их отдал бы движок
const NOW = Date.parse('2026-10-29T10:30:00Z')
const LINK = 'claude://claude.ai/epitaxy/local_0b67965a-0000-0000-0000-000000000000'
const SNAPSHOT = {
  at: NOW,
  tzOffsetMin: 180,
  today: { units: 32_400_000, tokens: 215_000_000, out: 1_190_000, models: { 'opus-5-5': 32_100_000, 'sonnet-5-5': 300_000 } },
  todayPct: 110,
  sinceWindow: 5_000_000,
  rate30Pct: 17,
  hours: [0, 0, 0, 2, 0, 0, 0, 2, 39, 19, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  winStart: Date.parse('2026-10-29T10:10:00Z'),
  winBuckets: [9, 8, ...Array(28).fill(0)],
  cal: 294_000,
  agents: 2,
  // Эта сессия молчит 70 минут: кэш остыл
  self: { id: '14815d4b', lastTs: NOW - 70 * 60_000, ctx: 356_000 },
  // Неделя началась 26.10 в 03:00 UTC, сброс 02.11; по темпу лимит кончится до сброса
  week: {
    start: Date.parse('2026-10-26T03:00:00Z'),
    reset: Date.parse('2026-11-02T03:00:00Z'),
    points: [[Date.parse('2026-10-27T03:00:00Z'), 20], [Date.parse('2026-10-29T03:00:00Z'), 60]],
    perDay: 18,
    hitAt: Date.parse('2026-10-30T22:00:00Z'),
    endPct: 100,
  },
  appInFront: true,
  sessions: [
    { id: '14815d4b', title: 'Тестовый проект А', project: 'Проект-А', link: 'claude://claude.ai/epitaxy/local_14815d4b-0000-0000-0000-000000000000', note: null, needs: false, doneAt: NOW, seen: true, status: 'running', idleMin: 0, ctx: 356_000, agents: 2, units: 14_900_000, coldPct: null, coldInMin: null, urgent: false },
    { id: '0b67965a', title: 'Тестовый кейс & <пациент>', project: 'Кейс', link: LINK, note: 'Доделать его в этой же папке?', needs: true, doneAt: NOW - 300_000, seen: true, status: 'waiting', idleMin: 5, ctx: 120_000, agents: 0, units: 2_000_000, coldPct: null, coldInMin: null, urgent: false },
    // Сессия из терминала: ссылки нет, статус нарисован на картинке
    { id: 'a97eb71a', title: 'Тестовый проект В', project: 'Проект-В', link: null, note: null, needs: false, doneAt: NOW - 19_560_000, seen: true, status: 'stopped', idleMin: 326, ctx: 517_000, agents: 0, units: 0, coldPct: 3.5, coldInMin: null, urgent: false },
  ],
  top: [{ title: 'Тестовый проект А', pct: 50.7 }],
}
const USAGE = {
  startedAt: NOW - 3_600_000,
  context: { tokens: 356_000, window: 1_000_000, percent: 36 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 17, resetsAt: '2026-10-29T15:10:00Z' },
    { kind: 'seven_day', percentUsed: 72, resetsAt: '2026-11-01T03:00:00Z' },
  ],
}

const PANE = {
  plugin: 'session-pult',
  component: 'Pane',
  requestId: 'session-pult',
  props: {
    title: 'Пульт сессий',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const sources = async (ui: { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Svg' })).map(el => ({ alt: String(el.props.alt), source: String(el.props.source) }))
// Подписи кнопок: на desktop подпись в картинке под прозрачной кнопкой, в остальных приложениях у самой кнопки
const shown = async (ui: Parameters<typeof sources>[0]) => [
  ...(await sources(ui)).map(c => c.alt),
  ...(await ui.findAll({ type: 'Button' })).map(b => String(b.props.label)),
]
// Без кнопок-картинок: у них своя рамка
const charts = async (ui: Parameters<typeof sources>[0]) => (await sources(ui)).filter(c => !c.source.includes('vector-effect'))

test('пульт рисует кольца, прогноз, сессии разным цветом и кнопку сжатия', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.command.run({ command: 'pult', args: '' } as never)

  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const [gauges, , forecast, week, head, rowA, rowCase, rowB, hours, spend] = await charts(ui)
    expect(gauges?.alt).toBe('Лимит 5 часов 17%, неделя 72%, контекст 36%')
    expect(forecast?.alt).toContain('кончится ≈ 15:56')
    expect(week?.alt).toBe('Недельное окно: 72%, кончится ≈ 31 окт 01:00')
    expect(week?.source).toContain('темп 18,0% в сутки')
    expect(week?.source).toContain('>пн</text>')
    // Подпись прогноза стоит ниже заголовка и не наезжает на него
    expect(forecast?.source).toContain('y="29" text-anchor="end" class="t" style="fill:#E8A26B">кончится')
    expect(head?.alt).toBe('Сессии: внимание 1, работают 1, ждут 0, стоп 1, агентов 2')
    // Статус показывает цвет строки: зелёный работает, красный требует внимания, серый остановлена
    expect(rowA?.source).toContain('rx="2" fill="#7FBF8E"')
    expect(rowCase?.source).toContain('rx="2" fill="#E5604D"')
    expect(rowB?.source).toContain('rx="2" fill="#9A938A"')
    expect(rowCase?.source).toContain('Тестовый кейс &amp; &lt;пациент&gt;')
    expect(rowCase?.alt).toBe('Тестовый кейс & <пациент>: ждёт вас, 5 мин, контекст 120 тыс.')
    expect(rowB?.source).toContain('❄ 3,5%')
    // Строка шириной с карточки: со ссылкой справа знак Enter, без ссылки статус подписан на картинке
    expect(rowA?.source).toContain('viewBox="0 0 320 44"')
    expect(rowCase?.source).toContain('viewBox="0 0 320 44"')
    expect(rowB?.source).toContain('viewBox="0 0 320 44"')
    expect(rowA?.source).toContain('stroke-linejoin="round"')
    expect(rowB?.source).not.toContain('stroke-linejoin="round"')
    expect(rowB?.source).toContain('остановлена</text>')
    expect(await ui.find({ key: 'open-0b67965a' })).toBeDefined()
    expect(await ui.find({ key: 'open-14815d4b' })).toBeDefined()
    expect(await ui.find({ key: 'open-a97eb71a' })).toBeUndefined()
    // Что ждёт сессия видно сразу, а отвечают в самом чате: кнопки ответа нет
    expect((await ui.find({ type: 'Text', text: /в этой же папке/ }))?.text).toBe('Доделать его в этой же папке?')
    expect(await ui.find({ key: 'reply-0b67965a' })).toBeUndefined()
    expect(hours?.alt).toContain('110%')
    expect(spend?.alt).toContain('opus-5-5 99%')
    expect(await shown(ui)).toContain('Сжать · 356K')
    await ui.unmount()
  }
})

test('оформление меняется кнопками сверху, запоминается для всех сессий и не прячет кнопки', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', answerSnapshot)
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = async () => (await sources(ui)).find(c => c.alt.startsWith('Тестовый кейс'))
  const chip = async (alt: string) => (await sources(ui)).find(c => c.alt === alt)?.source

  // Золото по умолчанию: кнопки нарисованы, рамка тонкая, шрифт как у страны; нажатие ловит прозрачная кнопка поверх
  expect((await row())?.source).toContain('rx="2" fill="#E5604D"')
  expect(await chip('Статус')).toContain('stroke="#D4AF6A" stroke-width="1"')
  expect(await chip('Статус')).toContain('font-size:11.5px')
  expect(await chip('Золото')).toContain('11.5px;font-weight:600')
  expect(await chip('Цвет')).not.toContain('11.5px;font-weight:600')
  for (const key of ['style-color', 'style-gold', 'lang-ru', 'compact', 'status', 'open-0b67965a', 'refresh']) {
    expect((await ui.find({ key }))?.props.plain).toBe(true)
  }
  // Строка выше кнопки, поэтому нажатие ловят две кнопки
  expect(await ui.find({ key: 'open-0b67965a-1' })).toBeDefined()

  // Цветной: как раньше, следует за темой приложения
  await ui.press({ key: 'style-color' })
  const color = await row()
  expect(color?.source).toContain('fill="#ef4444" fill-opacity=".16"')
  expect(color?.source).toContain('prefers-color-scheme: dark')
  expect((await sources(ui)).some(c => c.source.includes('r="34"'))).toBe(true)
  expect(await chip('Цвет')).toContain('fill="#3b82f6" fill-opacity=".16"')
  expect(await chip('Статус')).toContain('class="grid"')

  // Фиолет: краски «Ультрафиолета», тревога розовым, без тёмной темы в картинке
  await ui.press({ key: 'style-violet' })
  const violet = await row()
  expect(violet?.source).toContain('rx="2" fill="#F45B96"')
  expect(violet?.source).not.toContain('prefers-color-scheme')
  expect(await chip('Фиолет')).toContain('stroke="#8B30F4" stroke-width="1"')
  await ui.unmount()
})

test('кто выбрал прежний Синий, получает Фиолет', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { style: 'blue' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', answerSnapshot)
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await sources(ui)
  expect(all.find(c => c.alt.startsWith('Тестовый кейс'))?.source).toContain('#F45B96')
  expect(all.find(c => c.alt === 'Фиолет')?.source).toContain('11.5px;font-weight:600')
  await ui.unmount()
})

test('выбор оформления общий для сессий: панель берёт его из хранилища и записывает новый', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { style: 'color' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', answerSnapshot)
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = async () => (await sources(ui)).find(c => c.alt.startsWith('Тестовый кейс'))?.source
  expect(await row()).toContain('fill-opacity=".16"')

  // Без записи в хранилище следующее обновление вернуло бы цветной
  await ui.press({ key: 'style-violet' })
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(await row()).toContain('#F45B96')
  await ui.unmount()
})

test('блоки: порядок, сворачивание, закрытие и возврат, выбор общий для сессий', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', answerSnapshot)
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const place = async (text: string) => (await charts(ui)).findIndex(c => c.alt.includes(text))
  const [SESSIONS, HOURS, MODELS] = ['Сессии:', '110%', 'opus-5-5 99%']
  const weekAlt = async () => (await charts(ui))[3]?.alt ?? ''
  const week = await weekAlt()

  // Пока настройка выключена, у блоков нет своих кнопок
  expect(await ui.find({ key: 'block-up-hours' })).toBeUndefined()
  await ui.press({ key: 'arrange' })
  expect(await ui.find({ key: 'block-up-hours' })).toBeDefined()

  // Вверх: часы встают перед сессиями. Без записи в хранилище следующее обновление вернуло бы порядок
  expect(await place(HOURS)).toBeGreaterThan(await place(SESSIONS))
  await ui.press({ key: 'block-up-hours' })
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(await place(HOURS)).toBeLessThan(await place(SESSIONS))

  // Закрытый блок исчезает и возвращается кнопкой, соседом для стрелки он не считается
  await ui.press({ key: 'block-close-week' })
  expect(await place(week)).toBe(-1)
  await ui.press({ key: 'block-up-spend' })
  await ui.press({ key: 'block-up-spend' })
  expect(await place(MODELS)).toBeLessThan(await place(HOURS))
  await ui.press({ key: 'block-open-week' })
  expect(await place(week)).toBeGreaterThan(-1)

  // Свёрнутый блок после настройки остаётся полоской с названием
  await ui.press({ key: 'block-fold-spend' })
  await ui.press({ key: 'arrange-done' })
  expect(await ui.find({ key: 'block-up-hours' })).toBeUndefined()
  expect(await place(MODELS)).toBe(-1)
  expect(await shown(ui)).toContain('Модели ▾')
  await ui.press({ key: 'unfold-spend' })
  expect(await place(MODELS)).toBeGreaterThan(-1)

  await ui.press({ key: 'arrange' })
  await ui.press({ key: 'layout-reset' })
  expect(await place(HOURS)).toBeGreaterThan(await place(SESSIONS))
  expect(await place(MODELS)).toBeGreaterThan(await place(HOURS))
  await ui.unmount()
})

test('блоки: старое сохранённое значение не ломает панель', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { layout: { order: ['spend', 'старый блок'], folded: ['hours'], closed: ['week'] } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', answerSnapshot)
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await charts(ui)
  // Модели первые, остальные блоки на месте, свёрнутые и закрытые учтены
  expect(all[0]?.alt).toContain('opus-5-5 99%')
  expect(all.some(c => c.alt.startsWith('Лимит 5 часов'))).toBe(true)
  expect(await shown(ui)).toContain('По часам ▾')
  expect(all.some(c => c.alt.includes('110%'))).toBe(false)
  await ui.unmount()
})

test('квадрат: страна и скорость, замер раз в полчаса на все сессии, кнопка Обновить мерит сразу', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  let measured = 0
  let answer: Record<string, unknown> = { code: 'SG', country: 'Сингапур', mbit: 75.6 }
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv ?? []
    if (!argv.some(a => String(a).includes('netcheck'))) return answerSnapshot()
    measured += 1
    return { value: { exitCode: 0, stdout: JSON.stringify(answer), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await sources(before)).some(c => c.alt === 'замеряю, скорость не измерена')).toBe(true)
  await before.unmount()

  await $.command.run({ command: 'pult', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const square = async () => (await sources(ui)).find(c => c.source.includes('Мбит/с'))
  expect(measured).toBe(1)
  expect((await square())?.alt).toBe('Сингапур, 76 Мбит/с')
  expect((await square())?.source).toContain('>76</text>')

  // Повторное обновление не мерит, кнопка мерит сразу, через полчаса снова
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(measured).toBe(1)
  await ui.press({ key: 'refresh' })
  expect(measured).toBe(2)
  await clock.advance(31 * 60_000)
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(measured).toBe(3)

  // Без сети панель не падает и говорит об этом
  answer = { code: '', country: null, mbit: null }
  await ui.press({ key: 'refresh' })
  expect((await square())?.alt).toBe('нет сети, скорость не измерена')
  await ui.unmount()
})

test('язык: переключатель рядом со стилями, панель и просьбы на английском, выбор общий для сессий', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv ?? []
    if (!argv.some(a => String(a).includes('netcheck'))) return answerSnapshot()
    return { value: { exitCode: 0, stdout: JSON.stringify({ code: 'SG', country: 'Сингапур', mbit: 75.6 }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shown(ui)).toContain('RU')
  expect(await shown(ui)).toContain('Статус')
  expect((await sources(ui)).map(c => c.alt)).toContain('Сингапур, 76 Мбит/с')

  await ui.press({ key: 'lang-en' })
  expect(await shown(ui)).toContain('Status')
  expect(await ui.find({ key: 'open-0b67965a' })).toBeDefined()
  expect(await shown(ui)).toContain('Gold')
  expect(await shown(ui)).toContain('Compact · 356K')
  const all = await sources(ui)
  expect(all.map(c => c.alt)).toContain('Singapore, 76 Mbit/s')
  expect(all.map(c => c.alt)).toContain('5-hour limit 17%, week 72%, context 36%')
  expect(all.some(c => c.source.includes('ATTENTION'))).toBe(true)
  // Числа с точкой, а кириллицы нет ни в подписях графиков, ни в названии дня недели
  expect(all.some(c => c.source.includes('pace 18.0% per day'))).toBe(true)
  for (const chart of all) expect(chart.source.replace(/Тестовый[^<]*|<title>[^<]*<\/title>/g, '')).not.toMatch(/[А-Яа-я]/)

  await ui.press({ key: 'status' })
  expect(sent.at(-1)).toContain('Session status')
  await ui.unmount()
})

test('кнопка сжимает с инструкцией, а во время ответа ставит /compact в очередь', async ($, on) => {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const asked: string[] = []
  const queued: string[] = []
  let isTurnRunning = false
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.compact', (_, e) => {
    if (isTurnRunning) throw new Error('a turn is running')
    asked.push(String(e.instructions))
    return { messages: [{ role: 'user', text: 'Сводка', toolUses: [] }], tokensBefore: 356_000, tokensAfter: 41_000 }
  })
  on('command.run', { command: 'compact' }, (_, e) => {
    queued.push(e.args)
    return { text: 'Compacted' }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  expect(asked[0]).toContain('полные пути к файлам')
  expect(toasts).toContain('Контекст сжат: 356K → 41K')

  isTurnRunning = true
  await ui.press({ key: 'compact' })
  expect(queued[0]).toContain('что сделано и что осталось')
  expect(toasts).toContain('Модель отвечает: сожму, как только закончит')
  expect(await shown(ui)).toContain('Сжать · 356K')
  await ui.unmount()
})

test('подпись Сжимаю не застревает, если сжатие оборвала перезагрузка мода', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.register', () => ({ value: { command: 'pult' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.compact', () => {
    throw new Error('a turn is running')
  })
  // Прерванная функция сжатия ответа так и не дождётся
  on('command.run', { command: 'compact' }, () => new Promise<never>(() => undefined))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  void ui.press({ key: 'compact' })
  let seen: string[] = []
  for (let i = 0; i < 50 && !seen.includes('Сжимаю…'); i += 1) seen = await shown(ui)
  expect(seen).toContain('Сжимаю…')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await shown(ui)).toContain('Сжать · 356K')
  await ui.unmount()
})

test('без данных панель не падает', async ($, on) => {
  mock.clock(on, { now: NOW })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Собираю данные/ }))?.text).toBe('Собираю данные…')
  expect((await charts(ui))[2]?.alt).toBe('Нет данных об окне')
  await ui.unmount()
})

const answerSnapshot = () => ({
  value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('кнопка статуса открывает сессию по ссылке, а при сбое говорит об этом', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opened: string[][] = []
  const toasts: string[] = []
  let isBroken = false
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv ?? []
    if (!String(argv[0]).includes('rundll32')) return answerSnapshot()
    if (isBroken) throw new Error('нет обработчика')
    opened.push(argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-0b67965a' })
  expect(opened).toEqual([['C:\\Windows\\System32\\rundll32.exe', 'url.dll,FileProtocolHandler', LINK]])
  expect(toasts).toHaveLength(0)

  isBroken = true
  await ui.press({ key: 'open-0b67965a' })
  expect(toasts[0]).toContain('Не удалось открыть сессию')
  await ui.unmount()
})

// Подставляет сводку со своими строками сессий
const answerWith = (sessions: unknown[], extra: Record<string, unknown> = {}) => () => ({
  value: {
    exitCode: 0,
    stdout: JSON.stringify({ ...SNAPSHOT, sessions, ...extra }),
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

const waitingRow = {
  id: 'cafe0001',
  title: 'Другая сессия',
  project: 'Другая',
  link: LINK,
  note: 'Какой вариант брать?',
  needs: true,
  doneAt: NOW - 180_000,
  seen: false,
  status: 'waiting',
  idleMin: 3,
  ctx: 120_000,
  agents: 0,
  units: 0,
  coldPct: null,
  coldInMin: null,
  urgent: false,
}

test('сессия, что вот-вот остынет, показывает цену опоздания и выделена', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', answerWith([{ ...waitingRow, seen: true, idleMin: 50, coldInMin: 10, coldPct: 2.5, urgent: true, needs: false }]))
  await $.command.run({ command: 'pult', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await sources(ui)).find(c => c.alt.startsWith('Другая сессия'))
  expect(row?.source).toContain('❄ 10 мин · 2,5%')
  expect(row?.source).toContain('style="fill:#E8A26B"')
  expect(row?.alt).toContain('кэш остынет через 10 мин, потом ответ обойдётся в 2,5% лимита')
  expect(row?.source).toContain('rx="2" fill="#E5604D"')
  await ui.unmount()
})

test('уведомление о ждущей сессии: один раз, только при окне Claude впереди, нажатие открывает её', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const shells: string[] = []
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  let answer = answerWith([waitingRow])
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv ?? []
    if (!String(argv[0]).includes('powershell')) return answer()
    // Уведомления о лимитах здесь ни при чём: считаем только те, что открывают сессию
    if (String(argv.at(-1)).includes('launch=')) shells.push(String(argv.at(-1)))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.command.run({ command: 'pult', args: '' } as never)
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(shells).toHaveLength(1)
  expect(shells[0]).toContain(`activationType='protocol' launch='${LINK}'`)

  // Окно в фоне: баннер покажет приложение, пульт только отмечает
  answer = answerWith([{ ...waitingRow, id: 'cafe0002' }], { appInFront: false })
  await $.command.run({ command: 'pult', args: '' } as never)
  answer = answerWith([{ ...waitingRow, id: 'cafe0002' }])
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(shells).toHaveLength(1)

  // Уже видели, давно ждёт или ещё работает: молчим
  answer = answerWith([
    { ...waitingRow, id: 'cafe0003', seen: true },
    { ...waitingRow, id: 'cafe0004', idleMin: 40 },
    { ...waitingRow, id: 'cafe0005', status: 'running' },
  ])
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(shells).toHaveLength(1)
})

test('прогноз недели: нет данных, темп ещё не ясен, и уведомление, что кончится до сброса', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  let answer = answerWith([], { week: null })
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv ?? []
    return String(argv[0]).includes('powershell')
      ? { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : answer()
  })
  await $.command.run({ command: 'pult', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await charts(ui))[3]?.alt).toBe('Нет данных о недельном лимите')
  await ui.unmount()

  answer = answerWith([], { week: { ...SNAPSHOT.week, perDay: null, hitAt: null, endPct: null } })
  await $.command.run({ command: 'pult', args: '' } as never)
  const fresh = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await charts(fresh))[3]?.alt).toContain('темп станет ясен')
  await fresh.unmount()
  expect(toasts.filter(t => t.startsWith('Недельный лимит кончится'))).toHaveLength(0)

  answer = answerWith([])
  await $.command.run({ command: 'pult', args: '' } as never)
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(toasts.filter(t => t.startsWith('Недельный лимит кончится'))).toEqual([
    'Недельный лимит кончится около 31 окт 01:00, а сброс только 1 ноя 06:00',
  ])
})

test('кнопки Статус, Итог, Проверка и Новый лист отправляют промпты от имени пользователя', async ($, on) => {
  mock.clock(on, { now: NOW })
  const sent: { text: string; asUser?: boolean }[] = []
  on('prompt.submit', (_, e) => {
    sent.push({ text: e.text, asUser: e.origin?.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))

  for (const surface of ['desktop', 'terminal'] as const) {
    sent.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'status' })
    await ui.press({ key: 'report' })
    await ui.press({ key: 'check' })
    expect(sent.map(p => p.text)).toEqual([
      expect.stringContaining('четырьмя блоками'),
      expect.stringContaining('Итоговый отчёт по последней задаче в 4 пунктах'),
      expect.stringContaining('цифры против источников'),
    ])
    expect(sent.every(p => p.asUser === true)).toBe(true)
    await ui.unmount()
  }

  // Кнопки «Новый лист» на панели нет: память сохраняется и контекст очищается командой
  sent.length = 0
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'sheet' })).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'new-sheet', args: '' } as never)
  for (let i = 0; i < 20 && !sent.length; i++) await $.clock.now()
  expect(sent[0]?.text).toContain('PROJECT_MEMORY.md')
})

test('полоса над вводом предупреждает, что кэш остыл, и сжимает', async ($, on) => {
  mock.clock(on, { now: NOW })
  // Под плагинами движок рисует пустую полосу, когда плагину нечего показать
  on('ui.render', { component: 'AbovePrompt' }, (eng, e) => {
    const { Box } = eng.ui.resolve(e)
    return <Box />
  })
  let compacted = 0
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', answerSnapshot)
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.compact', () => {
    compacted += 1
    return { messages: [{ role: 'user', text: 'Сводка', toolUses: [] }] }
  })
  await $.command.run({ command: 'pult', args: '' } as never)

  const BAND = {
    plugin: 'session-pult',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 } },
  } as const
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  const band = await ui.find({ type: 'Text', text: /кэш остыл/ })
  expect(band?.text).toContain('Перерыв 1 ч 10 мин')
  expect(band?.text).toContain('356K')
  await ui.press({ key: 'cold-compact' })
  expect(compacted).toBe(1)
  await ui.press({ key: 'cold-hide' })
  expect(await ui.find({ type: 'Text', text: /кэш остыл/ })).toBeUndefined()
  await ui.unmount()
})

test('агент без своей модели идёт на Sonnet, с явной моделью не трогается', async ($, on) => {
  const models: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    models.push(e.model)
    return { agentId: `a${models.length}`, model: e.model ?? e.parentModel }
  })
  await $.agent.spawn({ prompt: 'Найди файлы', description: 'поиск', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5' } as never)
  await $.agent.spawn({ prompt: 'Найди файлы', description: 'поиск', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', model: 'opus' } as never)
  expect(models).toEqual(['sonnet', 'opus'])
})

test('уведомление о лимите приходит один раз на окно', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts: string[] = []
  const shells: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-29T15:10:00Z' }] },
  }))
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv ?? []
    if (String(argv[0]).includes('powershell')) {
      shells.push(String(argv.at(-1)))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return answerSnapshot()
  })

  await $.command.run({ command: 'pult', args: '' } as never)
  await $.command.run({ command: 'pult', args: '' } as never)
  expect(toasts.filter(t => t.startsWith('Лимит 5 часов: 85%'))).toEqual(['Лимит 5 часов: 85%, сброс 18:10'])
  expect(toasts.filter(t => t.includes('кончится около'))).toHaveLength(1)
  expect(shells.length).toBeGreaterThan(0)
  expect(shells[0]).toContain('ToastNotificationManager')
})

test('без Python пульт подсказывает, что поставить, и не падает', async ($, on) => {
  mock.clock(on, { now: NOW })
  const tried: string[] = []
  on('session.id', () => ({ value: 'test-session' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv ?? []
    if (argv.some(a => String(a).includes('netcheck'))) throw new Error('ENOENT')
    tried.push(String(argv[0]))
    // Лаунчера py нет, а python3 оказался заглушкой из Microsoft Store
    if (argv[0] === 'python3') {
      return { value: { exitCode: 9009, stdout: '', stderr: 'Python was not found', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    throw new Error('ENOENT')
  })

  await $.command.run({ command: 'pult', args: '' } as never)
  expect(tried).toEqual(['py', 'python', 'python3'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Python 3/ }))?.text).toContain('python.org')
  expect(await shown(ui)).toContain('Сжать · 356K')
  await ui.unmount()
})
