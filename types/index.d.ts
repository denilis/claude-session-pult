// Оформление панели: цветное, золотое, синее
export type StyleId = 'ivory' | 'gold' | 'violet'
export type LangId = 'ru' | 'en'
// Блоки панели: порядок, свёрнутые и закрытые общие для всех сессий
export type BlockId = 'gauges' | 'actions' | 'forecast' | 'week' | 'sessions' | 'hours' | 'spend'
export type Layout = { order: BlockId[]; folded: BlockId[]; closed: BlockId[] }
// Цвет строки сессии
export type RowState = 'attention' | 'running' | 'waiting' | 'stopped'

// Страна выхода в интернет и скорость загрузки: замер один на все сессии
export type Net = { at: number; mbit: number | null }

// Строка сессии из сборщика collector/collect.py
export type Row = {
  id: string
  title: string
  project: string
  // Ссылка claude:// на сессию в приложении; null у сессий, запущенных не из приложения
  link: string | null
  // Что нужно от человека или чем закончился ход; только у тех, кто ждёт
  note: string | null
  // Сессия задала прямой вопрос или ждёт решения
  needs: boolean
  // Время последнего сообщения, мс: по нему уведомление уходит один раз на ход
  doneAt: number
  // Человек уже видел конец хода или эта сессия сейчас на экране
  seen: boolean
  status: 'running' | 'waiting' | 'limit' | 'stopped'
  idleMin: number
  ctx: number
  agents: number
  units: number
  // Сколько % лимита съест следующий ответ, если кэш остыл или вот-вот остынет
  coldPct: number | null
  coldInMin: number | null
  // Кэш остынет меньше чем через 15 минут
  urgent: boolean
}

// Недельное окно: точки [мс, %] раз в полчаса и прогноз по темпу
export type Week = {
  start: number
  reset: number
  points: [number, number][]
  perDay: number | null
  hitAt: number | null
  endPct: number | null
}

// Сводка по всем сессиям; ед. = токены с поправкой на цену, cal = ед. на 1% пятичасового лимита
export type Snapshot = {
  at: number
  tzOffsetMin: number
  today: { units: number; tokens: number; out: number; models: Record<string, number> }
  todayPct: number
  sinceWindow: number
  rate30Pct: number
  // % пятичасового лимита: по часам суток и по 10-минуткам текущего окна
  hours: number[]
  winStart: number | null
  winBuckets: number[]
  cal: number
  agents: number
  // Эта сессия по её логу: время последнего сообщения (мс) и контекст; null, если лога нет
  self: { id: string; lastTs: number | null; ctx: number } | null
  week: Week | null
  // Окно Claude активно; если оно в фоне, о конце хода сообщает само приложение
  appInFront: boolean
  sessions: Row[]
  top: { title: string; pct: number }[]
}

// Лимиты и контекст этой сессии, как их отдаёт $.session.usage()
export type Limits = {
  at: number
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-pult': {
      snap: Shaped<Snapshot | null>
      limits: Shaped<Limits | null>
      error: Shaped<string | null>
      // Идёт сжатие: кнопка показывает «Сжимаю…» и не запускает второе
      compacting: Shaped<boolean>
      // Конец последнего хода главной сессии, мс; по нему видно, остыл ли кэш
      lastTurnAt: Shaped<number | null>
      turnRunning: Shaped<boolean>
      // Время хода, для которого полосу «кэш остыл» скрыли
      coldHidden: Shaped<number | null>
      // Очистка после сохранения памяти: 'queued' до начала хода, затем id этого хода
      pendingClear: Shaped<string | null>
      style: Shaped<StyleId>
      lang: Shaped<LangId>
      net: Shaped<Net | null>
      layout: Shaped<Layout>
      arranging: Shaped<boolean>
    }
  }
}
