import { PANEL_CSS } from './panel-css'
import type { App, AuthStart, Command, CommandResult, Device, LibraryView, ListView, Setup, NowPlaying, PlayerView, QueueView, Row, SearchView } from './protocol'
import { clock } from './spotify'
import { waitText } from './client'
import { createImageCache } from './image-cache'

const ICONS: Record<string, string> = {
  play: '<polygon points="7 4 20 12 7 20 7 4" fill="black"/>',
  pause: '<rect x="6" y="4" width="4" height="16" fill="black"/><rect x="14" y="4" width="4" height="16" fill="black"/>',
  prev: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>',
  next: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  repeat1: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  speaker: '<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" y1="6" x2="12.01" y2="6"/>',
  laptop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  vol: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  heartFull: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" fill="black"/>',
  addq: '<path d="M3 6h13M3 12h13M3 18h9"/><path d="M19 15v6M16 18h6"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  chev: '<polyline points="6 9 12 15 18 9"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  open: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  right: '<polyline points="9 6 15 12 9 18"/>',
  shrink: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'
}

const ICON_CSS = Object.entries(ICONS)
  .map(([name, body]) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
    return `.i-${name}{-webkit-mask-image:${url};mask-image:${url}}`
  })
  .join('\n')

type Tab = 'library' | 'albums' | 'queue'
type CoverSize = 'big' | 'small'
const POLL_MS = 2000
const RETRY_MS = 20_000
const TAB_KEY = 'tab'
const COVER_KEY = 'cover'
const GRID_ROWS = 6
const STRIP_BARS_MAX = 24

type Frame = {
  plugin: { request(name: string, input?: unknown): Promise<unknown>; on(event: string, handler: (payload: unknown) => void): { dispose(): void } }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  settings: { set(key: string, value: unknown): Promise<void> }
  host: { call(method: string, params?: unknown): Promise<unknown>; has(method: string): boolean }
  shell?: { openExternal(url: string): Promise<{ opened: boolean }> }
}

const orca = (globalThis as unknown as { orca: Frame }).orca
const MAC = /Mac/i.test(navigator.platform || navigator.userAgent)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function icon(name: string): HTMLSpanElement {
  return el('span', `ic i-${name}`)
}

function iconButton(name: string, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const button = el('button', `btn ${cls}`.trim())
  button.title = label
  button.setAttribute('aria-label', label)
  button.appendChild(icon(name))
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

const SPECIAL_ART: Record<string, string> = { liked: 'heartFull', dj: 'music', daylist: 'music' }

function rowArt(row: Row): HTMLElement {
  const special = row.id === 'recent' ? 'clock' : SPECIAL_ART[row.kind]
  if (!special) return art(row.cover, row.kind === 'artist')
  const box = el('span', `art special ${row.kind}`)
  box.appendChild(icon(special))
  return box
}

const imageCache = createImageCache()
const imageFailed = new Set<string>()
const imageInFlight = new Set<string>()
const imageWaiters = new Map<string, HTMLElement[]>()
let imageTimer: ReturnType<typeof setTimeout> | null = null

function imageEl(data: string, cls: string): HTMLImageElement {
  const img = el('img', cls)
  img.src = data
  img.alt = ''
  return img
}

function scheduleImages(delay: number): void {
  if (!imageTimer && [...imageWaiters.keys()].some((url) => !imageInFlight.has(url))) imageTimer = setTimeout(() => void loadImages(), delay)
}

async function loadImages(): Promise<void> {
  imageTimer = null
  const urls = [...imageWaiters.keys()].filter((url) => !imageInFlight.has(url)).slice(0, 12)
  if (urls.length === 0) return
  for (const url of urls) imageInFlight.add(url)
  const answer = await request<Record<string, string | null>>('images.get', { urls })
  for (const url of urls) {
    const data = answer?.[url]
    imageInFlight.delete(url)
    if (answer && data === undefined) continue
    if (typeof data === 'string' && data.startsWith('data:image/')) {
      imageCache.set(url, data)
      for (const box of imageWaiters.get(url) ?? []) if (box.isConnected) box.replaceWith(imageEl(data, box.dataset.cls ?? 'art'))
      if (now()?.cover === url) setTint(data)
    } else imageFailed.add(url)
    imageWaiters.delete(url)
  }
  scheduleImages(0)
}

function art(src: string | null, round = false): HTMLElement {
  return lazyImage(src, `art${round ? ' round' : ''}`, el('span', `art${round ? ' round' : ''}`))
}

function lazyImage(src: string | null, cls: string, box: HTMLElement): HTMLElement {
  if (src && src.startsWith('data:image/')) return imageEl(src, cls)
  box.dataset.cls = cls
  if (!src || !(src.startsWith('https://') || src.startsWith('music-art:')) || imageFailed.has(src)) return box
  const known = imageCache.get(src)
  if (known) return imageEl(known, cls)
  imageWaiters.set(src, [...(imageWaiters.get(src) ?? []), box])
  scheduleImages(30)
  return box
}

const style = el('style')
style.textContent = PANEL_CSS + ICON_CSS
document.head.appendChild(style)

const app = el('div', 'app')
document.body.appendChild(app)

let view: PlayerView | null = null
let viewAt = 0
let tab: Tab = 'library'
let coverSize: CoverSize = 'big'
let library: LibraryView | null = null
const expanded = new Set<string>()
let opened: { row: Row; list: ListView | null } | null = null
let query = ''
let search: SearchView | null = null
let queue: QueueView | null = null
let history: Row[] = []
let devOpen = false
let toastTimer: ReturnType<typeof setTimeout> | null = null
let lastCover: string | null = null

const playerBox = el('div', 'player')
const tabsBox = el('div', 'tabs')
const searchBox = el('div', 'searchbox')
const searchInput = el('input')
const listBox = el('div', 'list')
const footBox = el('div', 'foot')
const toastBox = el('div', 'toast')
const popBox = el('div', 'pop')
searchInput.placeholder = 'Search Spotify'
searchInput.setAttribute('aria-label', 'Search Spotify')
const clearButton = iconButton('close', 'Clear search', () => clearSearch())
clearButton.classList.add('clear')
clearButton.hidden = true
searchBox.append(icon('search'), searchInput, clearButton)

function clearSearch(): void {
  searchInput.value = ''
  query = ''
  search = null
  searchSeq += 1
  clearButton.hidden = true
  renderList()
  searchInput.focus()
}

function toast(text: string): void {
  toastBox.textContent = text
  if (!toastBox.isConnected) app.appendChild(toastBox)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastBox.remove(), 4000)
}

async function request<T>(name: string, input?: unknown): Promise<T | null> {
  try {
    return (await orca.plugin.request(name, input)) as T
  } catch {
    toast('Now Playing did not answer. Try again.')
    return null
  }
}

async function send(command: Command): Promise<boolean> {
  const result = await request<CommandResult>('command', command)
  if (result && !result.ok) toast(result.message)
  setTimeout(() => void refresh(), 350)
  setTimeout(() => void refresh(), 1400)
  return result?.ok === true
}

function now(): NowPlaying | null {
  return view?.status === 'ok' ? view.now : null
}

function progressMs(): number {
  const playing = now()
  if (!playing) return 0
  const moved = playing.isPlaying ? Date.now() - viewAt : 0
  return Math.min(playing.durationMs, playing.progressMs + moved)
}

function vivid(data: Uint8ClampedArray): string {
  let r = 0
  let g = 0
  let b = 0
  let weight = 0
  let all = [0, 0, 0, 0]
  for (let i = 0; i < data.length; i += 4) {
    const max = Math.max(data[i], data[i + 1], data[i + 2])
    const min = Math.min(data[i], data[i + 1], data[i + 2])
    all = [all[0] + data[i], all[1] + data[i + 1], all[2] + data[i + 2], all[3] + 1]
    if (max < 40 || min > 225) continue
    const sat = (max - min) / max
    const w = sat * sat * (0.5 + max / 255)
    r += data[i] * w
    g += data[i + 1] * w
    b += data[i + 2] * w
    weight += w
  }
  const [R, G, B] = weight > 0.5 ? [r / weight, g / weight, b / weight] : [all[0] / all[3], all[1] / all[3], all[2] / all[3]]
  const max = Math.max(R, G, B) / 255
  const min = Math.min(R, G, B) / 255
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === R / 255) h = ((G - B) / 255 / d) % 6
    else if (max === G / 255) h = (B - R) / 255 / d + 2
    else h = (R - G) / 255 / d + 4
  }
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  const hue = Math.round((h * 60 + 360) % 360)
  const boosted = weight > 0.5 ? Math.max(0.55, Math.min(0.9, sat)) : sat
  return `${hue}, ${Math.round(boosted * 100)}%, ${Math.round(Math.min(0.6, Math.max(0.4, l)) * 100)}%`
}

function setTint(src: string | null): void {
  if (src === lastCover) return
  lastCover = src
  if (!src) {
    playerBox.style.removeProperty('--tint')
    return
  }
  const img = new Image()
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 16
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, 16, 16)
      const alpha = getComputedStyle(document.documentElement).getPropertyValue('--sp-tint-alpha').trim() || '0.4'
      const tint = `hsla(${vivid(ctx.getImageData(0, 0, 16, 16).data)}, ${alpha})`
      playerBox.style.setProperty('--tint', tint)
    } catch {
      playerBox.style.removeProperty('--tint')
    }
  }
  img.src = src
}

function deviceIcon(device: Device): string {
  if (/smartphone|tablet/i.test(device.type)) return 'phone'
  if (/computer/i.test(device.type)) return 'laptop'
  return 'speaker'
}

const SETUP_STEPS = [
  'Open developer.spotify.com/dashboard and click Create app.',
  'Redirect URI: http://127.0.0.1:8888/callback (click Add).',
  'Tick Web API, accept the terms and Save.',
  'Copy the Client ID from Settings and paste it below.'
]

function renderSetup(box: HTMLElement): void {
  box.append(el('div', 'b', 'One-time setup'), el('div', 'm sm', 'Spotify needs an app of your own (free, about 2 minutes, Premium account).'))
  const steps = el('ol', 'sm steps')
  for (const step of SETUP_STEPS) steps.appendChild(el('li', '', step))
  const open = el('button', 'link', 'Open the Spotify dashboard')
  open.addEventListener('click', () => void openUrl('https://developer.spotify.com/dashboard'))
  const input = el('input', 'field')
  input.placeholder = 'Client ID (32 characters)'
  input.setAttribute('aria-label', 'Spotify Client ID')
  const save = el('button', 'cta', 'Save Client ID')
  const submit = async (): Promise<void> => {
    const value = input.value.trim()
    if (!/^[A-Za-z0-9]{20,64}$/.test(value)) return toast('That does not look like a Client ID. It is 32 letters and numbers.')
    try {
      await orca.settings.set('clientId', value)
    } catch {
      return toast('Could not save the Client ID.')
    }
    await refresh()
  }
  save.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submit()
  })
  box.append(steps, open, input, save)
}

async function openUrl(url: string): Promise<boolean> {
  try {
    if (orca.shell) return (await orca.shell.openExternal(url)).opened
    return ((await orca.host.call('shell.openExternal', { url })) as { opened: boolean }).opened
  } catch {
    return false
  }
}

function renderSignedOut(text: string | null, needsClientId: boolean, mac: boolean): void {
  if (app.dataset.signedOut === `${needsClientId}:${mac}:${text}` && app.firstChild) return
  app.dataset.signedOut = `${needsClientId}:${mac}:${text}`
  app.replaceChildren()
  const box = el('div', 'center')
  const logo = icon('music')
  logo.style.width = '36px'
  logo.style.height = '36px'
  logo.classList.add('m')
  if (mac) {
    box.append(logo, el('div', 'b', 'Open Spotify on this Mac'), el('div', 'm sm', 'Now Playing controls the Spotify app here. Nothing to set up.'))
    const card = el('div', 'card')
    card.append(el('div', 'b', 'Want Library, search and Queue?'), el('div', 'm sm', 'Connect your Spotify account. Optional, about 2 minutes. Also lets you control Spotify on your phone or another computer.'))
    const go = el('button', 'cta small', needsClientId ? 'Set it up' : 'Sign in with Spotify')
    go.addEventListener('click', () => {
      if (!needsClientId) return void signIn(card)
      go.remove()
      renderSetup(card)
    })
    card.appendChild(go)
    if (text) card.appendChild(el('div', 'sm', text))
    box.appendChild(card)
    app.appendChild(box)
    return
  }
  if (needsClientId) {
    box.appendChild(logo)
    renderSetup(box)
    app.appendChild(box)
    return
  }
  const button = el('button', 'cta', 'Sign in with Spotify')
  button.addEventListener('click', () => void signIn(box))
  box.append(logo, el('div', '', 'Control Spotify from Orca.'), button, el('div', 'm sm', 'Opens Spotify in your browser once. You stay signed in.'))
  if (text) box.appendChild(el('div', 'sm', text))
  app.appendChild(box)
}

async function signIn(box: HTMLElement): Promise<void> {
  const answer = await request<AuthStart>('auth.start')
  if (!answer) return
  if ('error' in answer) {
    toast(answer.error)
    return
  }
  const opened = await openUrl(answer.url)
  const hint = el('div', 'm sm', opened ? 'Finish in your browser. This panel updates when you are signed in.' : 'Your browser did not open. Copy this link into it:')
  box.appendChild(hint)
  if (!opened) {
    const link = el('input')
    link.value = answer.url
    link.readOnly = true
    link.style.width = '100%'
    link.addEventListener('focus', () => link.select())
    box.appendChild(link)
  }
}

const APP_LABEL: Record<App, string> = { spotify: 'Spotify', music: 'Apple Music' }
let shellKey: string | null = null
const apiLine = el('div', 'apiline m sm')

function pausedMs(): number {
  const ok = okView()
  return ok?.app === 'spotify' && ok.setup === 'connected' ? ok.pausedMs : 0
}

function syncPaused(): void {
  const ms = pausedMs()
  apiLine.textContent = ms > 0 ? `Spotify API paused · back in ${waitText(ms)}` : ''
  apiLine.hidden = ms === 0
  searchBox.style.display = spotifyOffline() || (ms > 0 && !library?.savedAt) ? 'none' : ''
}

function okView(): Extract<PlayerView, { status: 'ok' }> | null {
  return view?.status === 'ok' ? view : null
}

function currentApp(): App {
  return okView()?.app ?? 'spotify'
}

function isLive(answer: PlayerView | null): boolean {
  return answer?.status === 'ok' && (answer.app === 'music' || (answer.setup === 'connected' && answer.pausedMs === 0))
}

function spotifyOffline(): boolean {
  const ok = okView()
  return ok?.app === 'spotify' && ok.setup !== 'connected'
}

function hasQueue(): boolean {
  const ok = okView()
  return ok?.app === 'spotify' && ok.setup === 'connected' && ok.pausedMs === 0
}

function renderConnect(box: HTMLElement, setup: 'clientId' | 'signIn'): void {
  const card = el('div', 'card wide')
  card.append(el('div', 'b', 'Want your library, search and Queue?'), el('div', 'm sm', 'Connect your Spotify account to add them, plus devices and likes. Optional, about 2 minutes.'))
  const go = el('button', 'cta small', setup === 'clientId' ? 'Set it up' : 'Sign in with Spotify')
  go.addEventListener('click', () => {
    if (setup === 'signIn') return void signIn(card)
    go.remove()
    renderSetup(card)
  })
  card.appendChild(go)
  box.appendChild(card)
}

function loadHistory(): void {
  void request<Row[]>('history.get').then((rows) => {
    history = Array.isArray(rows) ? rows : []
    if (tab === 'library' && !opened && query.trim() === '') renderList()
  })
}

function recentSection(): void {
  if (history.length === 0) return
  const key = 'recent'
  listBox.appendChild(el('div', 'sec', 'Recently played'))
  const open = expanded.has(key)
  for (const row of open ? history : history.slice(0, 3)) listBox.appendChild(rowItem(row, () => void send({ action: 'playTrack', uri: row.uri }), { current: now()?.uri === row.uri }))
  if (history.length > 3) {
    const more = el('button', 'link more', open ? 'Show less' : `Show all ${history.length}`)
    more.addEventListener('click', () => {
      if (open) expanded.delete(key)
      else expanded.add(key)
      renderList()
    })
    listBox.appendChild(more)
  }
}

function resetLists(): void {
  history = []
  library = null
  search = null
  queue = null
  opened = null
  query = ''
  searchInput.value = ''
  clearButton.hidden = true
  expanded.clear()
}

async function chooseApp(next: App): Promise<void> {
  choosing = false
  const answer = await request<{ ok: boolean }>('app.set', { app: next })
  if (!answer?.ok) return toast('Could not switch apps.')
  resetLists()
  shellKey = null
  view = null
  lastTrack = null
  await refresh()
}

const SPOTIFY_LOGO = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#1DB954" d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>'
const MUSIC_LOGO = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="am" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb5c74"/><stop offset="1" stop-color="#fa233b"/></linearGradient></defs><rect width="24" height="24" rx="5.5" fill="url(#am)"/><path fill="#fff" d="M16.6 5.1 9.9 6.5c-.4.1-.6.4-.6.8v7.6a2.3 2.3 0 0 0-1-.2c-1.3 0-2.3.8-2.3 1.9s1 1.8 2.1 1.8c1.3 0 2.4-.9 2.4-2.3V10l5.4-1.1v4.8a2.3 2.3 0 0 0-1-.2c-1.3 0-2.3.8-2.3 1.9s1 1.8 2.1 1.8c1.3 0 2.4-.9 2.4-2.3V5.8c0-.5-.4-.8-.8-.7z"/></svg>'

let choosing = false

function renderChoose(mac: boolean, cancellable = false): void {
  if (!cancellable && app.dataset.choose === String(mac) && app.firstChild) return
  choosing = cancellable
  shellKey = null
  delete app.dataset.signedOut
  app.dataset.choose = String(mac)
  const box = el('div', 'choose')
  box.append(el('div', 'b big', 'Now Playing'), el('div', 'm sm', 'Pick the app you listen with.'))
  const option = (which: App, logo: string, sub: string): HTMLButtonElement => {
    const button = el('button', 'pick')
    const mark = el('span', 'logo')
    mark.innerHTML = logo
    const text = el('span', 'pick-text')
    text.append(el('span', 'b', APP_LABEL[which]), el('span', 'm sm', sub))
    button.append(mark, text)
    button.addEventListener('click', () => void chooseApp(which))
    return button
  }
  box.appendChild(option('spotify', SPOTIFY_LOGO, 'DJ, queue and your library'))
  if (mac) box.append(el('div', 'or m sm', 'or'), option('music', MUSIC_LOGO, 'Player and your library'))
  box.appendChild(el('div', 'm sm note-end', 'Change it any time at the bottom of the panel.'))
  if (cancellable) {
    const cancel = el('button', 'link note-end', 'Cancel')
    cancel.addEventListener('click', () => {
      choosing = false
      shellKey = null
      void refresh()
    })
    box.appendChild(cancel)
  }
  app.replaceChildren(box)
}

function renderFoot(): void {
  const row = el('div', 'footrow')
  footBox.replaceChildren(row)
  const which = currentApp()
  const left = el('div', 'appname m sm')
  const name = el('button', 'link appbtn')
  name.title = 'Change app'
  name.append(el('span', `appdot ${which}`), el('span', '', APP_LABEL[which]))
  name.addEventListener('click', () => renderChoose(MAC, true))
  left.appendChild(name)
  if (MAC) {
    const other: App = which === 'spotify' ? 'music' : 'spotify'
    const swap = el('button', 'link', `Switch to ${APP_LABEL[other]}`)
    swap.addEventListener('click', () => void chooseApp(other))
    left.append(el('span', '', '·'), swap)
  }
  row.appendChild(left)
  const ok = okView()
  if (ok?.app === 'spotify' && ok.setup === 'connected') {
    const signOut = el('button', 'link m', 'Sign out')
    signOut.addEventListener('click', async () => {
      await request('auth.signOut')
      resetLists()
      shellKey = null
      await refresh()
    })
    row.appendChild(signOut)
  }
}

function ensureShell(): void {
  const ok = okView()
  const key = `${ok?.app}:${ok?.setup}:${hasQueue()}`
  if (playerBox.isConnected && shellKey === key) return
  const fresh = shellKey !== null && shellKey.split(':')[0] !== String(ok?.app)
  shellKey = key
  delete app.dataset.signedOut
  delete app.dataset.choose
  if (fresh) resetLists()
  if (!hasQueue()) tab = 'library'
  if (tab === 'albums' && !hasQueue()) tab = 'library'
  syncSearchLabel()
  app.replaceChildren(playerBox, tabsBox, listBox, footBox)
  if (!hasQueue()) tabsBox.replaceWith(searchBox)
  else renderTabs()
  library = ok?.app === 'spotify' && ok.setup !== 'connected' ? null : library
  loadTab()
  loadHistory()
  renderList()
  renderFoot()
}

function syncSearchLabel(): void {
  const ok = okView()
  const paused = ok?.app === 'spotify' && ok.pausedMs > 0
  const label = tab === 'albums' ? 'Search albums' : ok?.app === 'music' ? 'Search your library' : paused ? 'Search your saved library' : 'Search Spotify'
  searchInput.placeholder = label
  searchInput.setAttribute('aria-label', label)
}

function setCoverSize(size: CoverSize): void {
  coverSize = size
  void orca.storage.set(COVER_KEY, size).catch(() => undefined)
  renderPlayer()
}

function albumRowOf(playing: NowPlaying): Row | null {
  const ref = playing.albumRef
  if (!ref?.uri) return null
  return { kind: 'album', id: ref.id ?? '', uri: ref.uri, name: ref.name || playing.album, sub: playing.artists, cover: playing.cover, year: ref.year, count: ref.total }
}

function renderStrip(playing: NowPlaying): HTMLElement | null {
  const ref = playing.albumRef
  if (!ref || (!ref.uri && !ref.openUrl)) return null
  const strip = el('button', 'ctx')
  const art = lazyImage(playing.cover, 'art', el('span', 'art'))
  strip.append(art, el('span', 'clip', ref.name || playing.album))
  if (ref.uri && ref.number && ref.total) {
    strip.appendChild(el('span', 'm', `· ${ref.number} of ${ref.total}`))
    if (ref.total <= STRIP_BARS_MAX) {
      const bars = el('span', 'prog')
      for (let i = 1; i <= ref.total; i += 1) bars.appendChild(el('i', i <= ref.number ? 'd' : ''))
      strip.appendChild(bars)
    }
  } else if (ref.year) strip.appendChild(el('span', 'm', `· ${ref.year}`))
  if (ref.uri) {
    strip.title = `Open ${ref.name || 'this album'}`
    strip.appendChild(icon('right'))
    strip.addEventListener('click', (event) => {
      event.stopPropagation()
      const row = albumRowOf(playing)
      if (row) openAlbum(row)
    })
  } else {
    strip.title = 'Open in Music'
    const pill = el('span', 'pillsm', 'Open in Music')
    strip.appendChild(pill)
    strip.addEventListener('click', (event) => {
      event.stopPropagation()
      if (ref.openUrl) void openUrl(ref.openUrl)
    })
  }
  return strip
}

function renderPlayer(): void {
  const playing = now()
  const devices = view?.status === 'ok' ? view.devices : []
  playerBox.replaceChildren()
  app.dataset.app = currentApp()
  playerBox.dataset.size = coverSize
  const head = el('div', 'titlerow')
  const meta = el('div', 'meta')
  if (playing) {
    meta.append(el('div', 'title clip', playing.name), el('div', 'm clip', playing.artists))
    if (playing.album) meta.appendChild(el('div', 'm sm clip', playing.album))
  } else {
    const hint = currentApp() === 'music' ? 'Play something in the Music app, or pick an album below.' : devices.length > 0 ? 'Pick an album or playlist below.' : 'Open Spotify on your Mac or phone.'
    meta.append(el('div', 'b', 'Nothing playing'), el('div', 'm sm', hint))
  }
  if (coverSize === 'big') {
    const placeholder = el('div', 'bigcover m')
    placeholder.appendChild(icon('music'))
    const wrap = el('div', 'coverwrap')
    wrap.appendChild(playing ? lazyImage(playing.cover, 'bigcover', placeholder) : placeholder)
    wrap.appendChild(iconButton('shrink', 'Smaller cover', () => setCoverSize('small'), 'corner'))
    playerBox.appendChild(wrap)
  } else {
    const placeholder = el('div', 'cover m')
    placeholder.appendChild(icon('music'))
    const mini = el('button', 'minicover')
    mini.title = 'Bigger cover'
    mini.setAttribute('aria-label', 'Bigger cover')
    mini.appendChild(playing ? lazyImage(playing.cover, 'cover', placeholder) : placeholder)
    mini.addEventListener('click', (event) => {
      event.stopPropagation()
      setCoverSize('big')
    })
    head.appendChild(mini)
  }
  const active = playing?.device ?? devices.find((device) => device.active) ?? null
  const connected = isLive(view)
  const chipRow = el('div', 'chiprow')
  if (active || devices.length > 0) {
    const chip = el('button', 'devbtn')
    chip.title = active ? `Playing on ${active.name}` : 'Pick a device'
    chip.setAttribute('aria-label', chip.title)
    chip.appendChild(icon(active ? deviceIcon(active) : 'speaker'))
    chip.setAttribute('aria-expanded', devOpen ? 'true' : 'false')
    chip.addEventListener('click', (event) => {
      event.stopPropagation()
      devOpen = !devOpen
      renderPop()
      if (devOpen) {
        if (connected) void request<Device[]>('devices.get').then((list) => {
          if (!list || list.length === 0 || view?.status !== 'ok') return
          const own = (now()?.device ?? view.devices.find((device) => device.active))?.volume ?? null
          view.devices = currentApp() === 'music' ? list.map((device) => (device.active && device.type === 'Computer' ? { ...device, volume: own } : device)) : list
          renderPop()
        })
      }
    })
    chipRow.appendChild(chip)
  }
  head.append(meta)
  if (playing?.trackId && connected && playing.liked !== null) {
    const liked = playing.liked === true
    head.appendChild(
      iconButton(liked ? 'heartFull' : 'heart', currentApp() === 'music' ? (liked ? 'Remove from Favourite Songs' : 'Add to Favourite Songs') : liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', () => {
        if (!playing.trackId) return
        playing.liked = !liked
        renderPlayer()
        void send({ action: 'like', trackId: playing.trackId, on: !liked })
      }, liked ? 'on' : '')
    )
  }
  playerBox.appendChild(head)
  setTint(playing?.cover ? (imageCache.get(playing.cover) ?? null) : null)

  if (playing && playing.durationMs > 0) {
    const seek = el('div')
    const bar = el('div', 'bar')
    bar.setAttribute('role', 'slider')
    bar.setAttribute('aria-label', 'Seek')
    const fill = el('i')
    bar.appendChild(fill)
    bar.addEventListener('click', (event) => {
      const rect = bar.getBoundingClientRect()
      const position = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * playing.durationMs
      playing.progressMs = position
      viewAt = Date.now()
      updateProgress()
      void send({ action: 'seek', positionMs: position })
    })
    const times = el('div', 'times m')
    times.append(el('span', 'elapsed'), el('span', '', clock(playing.durationMs)))
    seek.append(bar, times)
    playerBox.appendChild(seek)
  }

  const ctrls = el('div', 'ctrls')
  if (MAC) ctrls.appendChild(iconButton('open', `Open ${APP_LABEL[currentApp()]}`, () => void send({ action: 'openApp' }), 'openbtn'))
  const shuffleOn = playing?.shuffle === true
  ctrls.appendChild(
    iconButton('shuffle', shuffleOn ? 'Shuffle on' : 'Shuffle off', () => {
      if (playing) playing.shuffle = !shuffleOn
      renderPlayer()
      void send({ action: 'shuffle', on: !shuffleOn })
    }, shuffleOn ? 'on dot' : '')
  )
  ctrls.appendChild(iconButton('prev', 'Previous', () => void send({ action: 'previous' })))
  const isPlaying = playing?.isPlaying === true
  ctrls.appendChild(
    iconButton(isPlaying ? 'pause' : 'play', isPlaying ? 'Pause' : 'Play', () => {
      if (playing) {
        playing.progressMs = progressMs()
        viewAt = Date.now()
        playing.isPlaying = !isPlaying
      }
      renderPlayer()
      void send({ action: isPlaying ? 'pause' : 'play' })
    }, 'play')
  )
  ctrls.appendChild(iconButton('next', 'Next', () => void send({ action: 'next' })))
  const repeat = playing?.repeat ?? 'off'
  const nextRepeat = repeat === 'off' ? 'context' : repeat === 'context' ? 'track' : 'off'
  ctrls.appendChild(
    iconButton(repeat === 'track' ? 'repeat1' : 'repeat', `Repeat: ${repeat === 'off' ? 'off' : repeat === 'context' ? 'all' : 'one song'}`, () => {
      if (playing) playing.repeat = nextRepeat
      renderPlayer()
      void send({ action: 'repeat', mode: nextRepeat })
    }, repeat === 'off' ? '' : 'on dot')
  )
  while (chipRow.firstChild) ctrls.appendChild(chipRow.firstChild)
  playerBox.appendChild(ctrls)
  const strip = playing ? renderStrip(playing) : null
  if (strip) playerBox.appendChild(strip)
  updateProgress()
  renderPop()
}

function updateProgress(): void {
  const playing = now()
  if (!playing) return
  const fill = playerBox.querySelector('.bar i') as HTMLElement | null
  const elapsed = playerBox.querySelector('.elapsed')
  const position = progressMs()
  if (fill) fill.style.width = `${playing.durationMs > 0 ? (position / playing.durationMs) * 100 : 0}%`
  if (elapsed) elapsed.textContent = clock(position)
}

function renderPop(): void {
  const listed = view?.status === 'ok' ? view.devices : []
  const own = now()?.device ?? null
  const devices = listed.length > 0 ? listed : own ? [own] : []
  if (!devOpen || devices.length === 0) {
    popBox.remove()
    return
  }
  popBox.replaceChildren()
  for (const device of devices) {
    const row = el('button', `item${device.active ? ' on' : ''}`)
    row.append(icon(deviceIcon(device)), el('span', 'clip', device.name))
    if (device.active) row.appendChild(icon('check'))
    row.addEventListener('click', (event) => {
      event.stopPropagation()
      devOpen = false
      renderPop()
      if (!device.active) void send({ action: 'transfer', deviceId: device.id })
    })
    popBox.appendChild(row)
  }
  const active = devices.find((device) => device.active)
  if (active && active.volume !== null) {
    const vol = el('div', 'vol m')
    const slider = el('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = '100'
    slider.value = String(active.volume)
    slider.setAttribute('aria-label', 'Volume')
    const level = el('span', 'level m', `${active.volume}%`)
    const paint = (): void => {
      level.textContent = `${slider.value}%`
      slider.style.background = `linear-gradient(to right, var(--acc) ${slider.value}%, var(--sp-track) ${slider.value}%)`
    }
    paint()
    slider.addEventListener('input', paint)
    slider.addEventListener('click', (event) => event.stopPropagation())
    slider.addEventListener('change', () => {
      active.volume = Number(slider.value)
      void send({ action: 'volume', percent: Number(slider.value) })
    })
    vol.append(icon('vol'), slider, level)
    popBox.appendChild(vol)
  }
  if (!popBox.isConnected) app.appendChild(popBox)
  const chip = playerBox.querySelector('.devbtn')
  if (chip) {
    const at = chip.getBoundingClientRect()
    popBox.style.top = `${Math.round(at.bottom + 4)}px`
    popBox.style.left = `${Math.max(12, Math.min(window.innerWidth - popBox.offsetWidth - 12, Math.round(at.right - popBox.offsetWidth)))}px`
  }
}

function switchTab(key: Tab): void {
  if (tab === key && !opened && query.trim() === '') return
  opened = null
  if (query.trim() !== '') {
    searchInput.value = ''
    query = ''
    search = null
    searchSeq += 1
    clearButton.hidden = true
  }
  tab = key
  void orca.storage.set(TAB_KEY, key).catch(() => undefined)
  syncSearchLabel()
  renderTabs()
  loadTab()
  renderList()
  listBox.scrollTop = 0
}

function openAlbum(row: Row): void {
  const target: Tab = hasQueue() && query.trim() === '' ? 'albums' : tab === 'queue' ? 'library' : tab
  if (tab !== target) {
    tab = target
    void orca.storage.set(TAB_KEY, target).catch(() => undefined)
    syncSearchLabel()
    if (hasQueue()) renderTabs()
  }
  opened = { row, list: null }
  renderList()
  listBox.scrollTop = 0
  void request<ListView>('tracks.get', { kind: row.kind, id: row.id }).then((list) => {
    if (opened?.row !== row) return
    opened.list = list ?? { rows: [], message: 'Could not load the songs.' }
    renderList()
  })
}

function renderTabs(): void {
  tabsBox.replaceChildren()
  const labels: [Tab, string][] = [
    ['library', 'Library'],
    ['albums', 'Albums'],
    ['queue', 'Queue']
  ]
  for (const [key, label] of labels) {
    const button = el('button', tab === key ? 'on' : '', label)
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', tab === key ? 'true' : 'false')
    button.addEventListener('click', () => switchTab(key))
    tabsBox.appendChild(button)
  }
  if (tab !== 'queue') {
    if (!searchBox.isConnected) tabsBox.after(searchBox)
  } else searchBox.remove()
}

function rowItem(row: Row, onPlay: () => void, extra?: { queue?: boolean; current?: boolean; onOpen?: () => void }): HTMLElement {
  const item = el('div', `item${extra?.current ? ' now' : ''}`)
  item.setAttribute('role', 'button')
  item.tabIndex = 0
  const text = el('div', 't')
  text.append(el('span', 'clip', row.name), el('span', 'm sm clip', row.sub))
  item.append(rowArt(row), text)
  if (extra?.queue) item.appendChild(iconButton('addq', 'Add to queue', () => void send({ action: 'queue', uri: row.uri }).then((ok) => ok && toast(`Added "${row.name}" to the queue.`)), 'act'))
  if (extra?.onOpen) item.appendChild(iconButton('play', `Play ${row.name}`, onPlay, 'act'))
  const main = extra?.onOpen ?? onPlay
  item.addEventListener('click', main)
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') main()
  })
  return item
}

function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function note(text: string): HTMLElement {
  return el('div', 'note m sm', text)
}

const SHOW_ROWS = 5
const OPENS = new Set(['playlist', 'album', 'artist', 'liked'])

function libraryRow(row: Row): HTMLElement {
  if (row.kind === 'dj') return rowItem(row, () => void send({ action: 'dj' }))
  const play = (): void => void send({ action: 'playContext', contextUri: row.uri })
  if (!OPENS.has(row.kind)) return rowItem(row, play)
  return rowItem(row, play, { onOpen: () => openAlbum(row) })
}

const seen = new WeakMap<Element, Row>()
const watcher =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const row = seen.get(entry.target)
            watcher?.unobserve(entry.target)
            if (row && entry.target.isConnected) entry.target.replaceWith(lazyImage(row.cover, 'tcover', el('span', 'tcover')))
          }
        },
        { root: listBox, rootMargin: '200px 0px' }
      )
    : null

function albumTile(row: Row): HTMLElement {
  const tile = el('button', 'tile')
  tile.title = `Open ${row.name}`
  const box = el('span', 'tcover')
  if (watcher && !(row.cover && imageCache.has(row.cover))) {
    seen.set(box, row)
    watcher.observe(box)
    tile.appendChild(box)
  } else tile.appendChild(lazyImage(row.cover, 'tcover', box))
  tile.append(el('span', 'n clip', row.name), el('span', 'm clip s', row.sub))
  tile.addEventListener('click', () => openAlbum(row))
  return tile
}

function albumGrid(list: Row[]): HTMLElement {
  const grid = el('div', 'grid')
  for (const row of list) grid.appendChild(albumTile(row))
  return grid
}

function albumsSection(all: Row[]): void {
  if (all.length === 0) return
  const head = el('div', 'sec')
  head.append(el('span', '', 'Albums'), el('span', 'cnt', String(all.length)))
  listBox.appendChild(head)
  const open = expanded.has('albums') && !hasQueue()
  listBox.appendChild(albumGrid(open ? all : all.slice(0, GRID_ROWS)))
  if (all.length > GRID_ROWS) {
    const more = el('button', 'link more', hasQueue() ? `Show all ${all.length} →` : open ? 'Show less' : `Show all ${all.length}`)
    more.addEventListener('click', () => {
      if (hasQueue()) return switchTab('albums')
      if (open) expanded.delete('albums')
      else expanded.add('albums')
      renderList()
    })
    listBox.appendChild(more)
  }
}

function lengthText(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

function backLabel(): string {
  if (query.trim() !== '') return 'Search results'
  return tab === 'albums' ? 'Albums' : 'Library'
}

function renderAlbumPage(current: { row: Row; list: ListView | null }): void {
  const parent = current.row
  const back = el('div', 'backrow')
  const backButton = iconButton('back', `Back to ${backLabel().toLowerCase()}`, () => {
    opened = null
    renderList()
  })
  back.append(backButton, el('span', 'm sm', backLabel()))
  listBox.appendChild(back)
  const head = el('div', 'alb')
  head.appendChild(lazyImage(parent.cover, 'albcover', el('span', 'albcover')))
  head.append(el('div', 'n clip', parent.name), el('div', 'm clip', parent.sub))
  const songs = current.list?.rows ?? []
  const total = songs.reduce((sum, row) => sum + (row.durationMs ?? 0), 0)
  const count = songs.length > 0 ? songs.length : (parent.count ?? null)
  const facts = [parent.year ? String(parent.year) : null, count ? `${count} ${count === 1 ? 'song' : 'songs'}` : null, total > 0 ? lengthText(total) : null].filter((part): part is string => part !== null)
  if (facts.length > 0) head.appendChild(el('div', 'm sm', facts.join(' · ')))
  const pills = el('div', 'pills')
  const play = el('button', 'pill pri')
  play.append(icon('play'), el('span', '', 'Play'))
  play.addEventListener('click', () => void send({ action: 'playContext', contextUri: parent.uri }))
  const shuffle = el('button', 'pill')
  shuffle.append(icon('shuffle'), el('span', '', 'Shuffle'))
  shuffle.addEventListener('click', () => void send({ action: 'playContext', contextUri: parent.uri, shuffle: true }))
  pills.append(play, shuffle)
  head.appendChild(pills)
  listBox.appendChild(head)
  if (!current.list) return void listBox.appendChild(note('Loading songs…'))
  if (current.list.message) return void listBox.appendChild(note(current.list.message))
  if (songs.length === 0) return void listBox.appendChild(note('Nothing here yet.'))
  songs.forEach((song, index) => listBox.appendChild(albumTrackRow(song, index + 1, parent)))
}

function albumTrackRow(row: Row, position: number, parent: Row): HTMLElement {
  const item = el('div', `item${now()?.uri === row.uri ? ' now' : ''}`)
  item.setAttribute('role', 'button')
  item.tabIndex = 0
  const text = el('div', 't')
  text.appendChild(el('span', 'clip', row.name))
  if (row.sub && row.sub !== parent.sub) text.appendChild(el('span', 'm sm clip', row.sub))
  item.append(el('span', 'num', String(row.number ?? position)), text)
  if (hasQueue()) item.appendChild(iconButton('addq', 'Add to queue', () => void send({ action: 'queue', uri: row.uri }).then((ok) => ok && toast(`Added "${row.name}" to the queue.`)), 'act'))
  if (row.liked !== null && row.liked !== undefined && isLive(view)) {
    const liked = row.liked
    const label = currentApp() === 'music' ? (liked ? 'Remove from Favourite Songs' : 'Add to Favourite Songs') : liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'
    item.appendChild(
      iconButton(liked ? 'heartFull' : 'heart', label, () => {
        row.liked = !liked
        renderList()
        void send({ action: 'like', trackId: row.id, on: !liked })
      }, `fav${liked ? ' on' : ' off'}`)
    )
  }
  if (row.durationMs) item.appendChild(el('span', 'dur', clock(row.durationMs)))
  const play = (): void => void send({ action: 'playContext', contextUri: parent.uri, offsetUri: row.uri })
  item.addEventListener('click', play)
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') play()
  })
  return item
}

function renderOpened(current: { row: Row; list: ListView | null }): void {
  const parent = current.row
  if (parent.kind === 'album') return renderAlbumPage(current)
  const head = el('div', 'item')
  head.append(
    iconButton('back', `Back to ${backLabel().toLowerCase()}`, () => {
      opened = null
      renderList()
    }),
    rowArt(parent)
  )
  const text = el('div', 't')
  text.append(el('span', 'b clip', parent.name), el('span', 'm sm clip', parent.sub))
  head.append(text, iconButton('play', `Play ${parent.name}`, () => void send({ action: 'playContext', contextUri: parent.uri }), 'play'))
  listBox.appendChild(head)
  if (!current.list) return void listBox.appendChild(note('Loading songs…'))
  if (current.list.message) return void listBox.appendChild(note(current.list.message))
  if (current.list.rows.length === 0) return void listBox.appendChild(note('Nothing here yet.'))
  for (const row of current.list.rows) {
    const play = parent.kind === 'artist' ? (): void => void send({ action: 'playTrack', uri: row.uri }) : (): void => void send({ action: 'playContext', contextUri: parent.uri, offsetUri: row.uri })
    listBox.appendChild(rowItem(row, play, { queue: hasQueue(), current: now()?.uri === row.uri }))
  }
}

function renderAlbumsTab(): void {
  if (opened) return renderOpened(opened)
  if (!library) return void listBox.appendChild(note('Loading your albums…'))
  const q = query.trim().toLowerCase()
  const all = q === '' ? library.albums : library.albums.filter((row) => row.name.toLowerCase().includes(q) || row.sub.toLowerCase().includes(q))
  if (library.albums.length === 0) return void listBox.appendChild(note(library.message ?? 'Save an album in Spotify and it shows here.'))
  if (all.length === 0) return void listBox.appendChild(note(`No albums match "${query.trim()}".`))
  const head = el('div', 'sec')
  head.append(el('span', '', `${all.length} ${all.length === 1 ? 'album' : 'albums'}`), el('span', 'cnt', q === '' ? 'newest first' : ''))
  listBox.appendChild(head)
  listBox.appendChild(albumGrid(all))
}

function renderList(): void {
  listBox.replaceChildren()
  if (tab === 'library') {
    const ok = okView()
    if (ok?.app === 'spotify' && ok.setup !== 'connected') {
      if (MAC) listBox.append(el('div', 'sec', 'Made for you'), libraryRow({ kind: 'dj', id: 'dj', uri: 'spotify:playlist:37i9dQZF1EYkqdzj48dyYq', name: 'DJ', sub: 'Plays in the Spotify app on this Mac', cover: null }))
      recentSection()
      return renderConnect(listBox, ok.setup === 'signIn' ? 'signIn' : 'clientId')
    }
    if (opened) return renderOpened(opened)
    if (query.trim() !== '') return renderSearch()
    if (!library) return void listBox.appendChild(note('Loading your library…'))
    syncPaused()
    if (library.message && pausedMs() === 0) listBox.appendChild(note(library.message))
    if (library.savedAt && pausedMs() === 0) listBox.appendChild(note(`Your library from ${ago(library.savedAt)}.`))
    if (library.needsReauth) {
      const box = el('div', 'note m sm')
      const again = el('button', 'link', 'Sign in again')
      again.addEventListener('click', () => void signIn(box))
      box.append(el('div', '', 'Sign in again to show your artists, albums and daylist.'), again)
      listBox.appendChild(box)
    }
    const sections: [string, string, Row[]][] = [
      ['made', 'Made for you', library.made],
      ['playlists', 'Playlists', library.playlists],
      ['artists', 'Artists', library.artists]
    ]
    for (const [key, label, list] of sections) {
      if (key === 'playlists') {
        albumsSection(library.albums)
        recentSection()
      }
      if (list.length === 0) continue
      listBox.appendChild(el('div', 'sec', label))
      const open = expanded.has(key) || list.length <= SHOW_ROWS + 1
      for (const row of open ? list : list.slice(0, SHOW_ROWS)) listBox.appendChild(libraryRow(row))
      if (list.length > SHOW_ROWS + 1) {
        const more = el('button', 'link more', open ? 'Show less' : `Show all ${list.length}`)
        more.addEventListener('click', () => {
          if (open) expanded.delete(key)
          else expanded.add(key)
          renderList()
        })
        listBox.appendChild(more)
      }
    }
    if (pausedMs() > 0) listBox.appendChild(apiLine)
    return
  }
  if (tab === 'albums') return renderAlbumsTab()
  renderQueue()
}

function renderSearch(): void {
  {
    if (!search) return void listBox.appendChild(note('Searching…'))
    if (search.message) return void listBox.appendChild(note(search.message))
    const sections: [string, Row[]][] = [
      ['Songs', search.songs],
      ['Artists', search.artists],
      ['Albums', search.albums],
      ['Playlists', search.playlists]
    ]
    let any = false
    for (const [label, list] of sections) {
      if (list.length === 0) continue
      any = true
      listBox.appendChild(el('div', 'sec', label))
      for (const row of list) {
        listBox.appendChild(
          row.kind === 'track' ? rowItem(row, () => void send({ action: 'playTrack', uri: row.uri }), { queue: true, current: now()?.uri === row.uri }) : libraryRow(row)
        )
      }
    }
    if (!any) listBox.appendChild(note(`Nothing found for "${query.trim()}".`))
  }
}

function renderQueue(): void {
  if (!queue) return void listBox.appendChild(note('Loading the queue…'))
  if (queue.message) return void listBox.appendChild(note(queue.message))
  if (queue.now) {
    listBox.appendChild(el('div', 'sec', 'Now playing'))
    listBox.appendChild(rowItem(queue.now, () => undefined, { current: true }))
  }
  listBox.appendChild(el('div', 'sec', 'Up next'))
  if (queue.next.length === 0) listBox.appendChild(note('Nothing queued. Add songs from Search or a playlist.'))
  for (const row of queue.next) listBox.appendChild(rowItem(row, () => void send({ action: 'playTrack', uri: row.uri })))
}

function loadTab(): void {
  if ((tab === 'library' || tab === 'albums') && !library) {
    libraryAt = Date.now()
    void request<LibraryView>('library.get').then((answer) => {
      library = answer ?? { made: [], playlists: [], artists: [], albums: [], needsReauth: false, message: 'Could not load your library.' }
      libraryAt = Date.now()
      if (tab !== 'queue') renderList()
    })
  }
  if (tab === 'queue') {
    void request<QueueView>('queue.get').then((answer) => {
      queue = answer ?? { now: null, next: [], message: 'Could not load the queue.' }
      if (tab === 'queue') renderList()
    })
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchInput.value !== '') {
    event.stopPropagation()
    clearSearch()
  }
})
searchInput.addEventListener('input', () => {
  query = searchInput.value
  clearButton.hidden = query === ''
  opened = null
  if (searchTimer) clearTimeout(searchTimer)
  search = null
  renderList()
  if (query.trim() === '' || tab === 'albums') return
  searchTimer = setTimeout(() => {
    const seq = ++searchSeq
    void request<SearchView>('search', { q: query }).then((answer) => {
      if (seq !== searchSeq) return
      search = answer ?? { songs: [], artists: [], albums: [], playlists: [], message: 'Search failed.' }
      if (tab === 'library') renderList()
    })
  }, 450)
})

let lastTrack: string | null = null
let refreshing = false
let lastError: string | null = null
let libraryAt = 0
async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  const answer = await request<PlayerView>('player.get')
  refreshing = false
  if (!answer) return
  if (choosing) return
  if (answer.status === 'error') {
    if (!playerBox.isConnected) ensureShell()
    if (answer.message !== lastError) toast(answer.message)
    lastError = answer.message
    return
  }
  view = answer
  viewAt = Date.now()
  if (answer.status === 'choose') {
    playerBox.remove()
    renderChoose(answer.mac)
    return
  }
  if (answer.status === 'signedOut') {
    playerBox.remove()
    shellKey = null
    renderSignedOut(answer.message, answer.needsClientId, answer.mac)
    return
  }
  lastError = null
  ensureShell()
  syncPaused()
  renderPlayer()
  if (tab === 'library' && library?.message && Date.now() - libraryAt > RETRY_MS) {
    library = null
    loadTab()
  } else if (library?.savedAt && answer.pausedMs === 0 && Date.now() - libraryAt > RETRY_MS) {
    libraryAt = Date.now()
    void request<LibraryView>('library.get').then((answer) => {
      if (!answer || answer.savedAt || answer.message) return
      library = answer
      if (tab === 'library' && !opened && query.trim() === '') renderList()
    })
  }
  const track = answer.now?.uri ?? null
  if (track !== lastTrack) {
    lastTrack = track
    if (answer.app === 'spotify') setTimeout(loadHistory, 300)
    if (tab === 'queue') loadTab()
    else if (query.trim() === '' || search) renderList()
  }
}

document.addEventListener('click', () => {
  if (!devOpen) return
  devOpen = false
  renderPop()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && devOpen) {
    devOpen = false
    renderPop()
  }
})

orca.plugin.on('changed', () => void refresh())
setInterval(() => {
  if (document.visibilityState !== 'hidden') void refresh()
}, POLL_MS)
setInterval(updateProgress, 500)

void Promise.all([orca.storage.get(TAB_KEY).catch(() => null), orca.storage.get(COVER_KEY).catch(() => null)]).then(([savedTab, savedCover]) => {
  if (savedTab === 'library' || savedTab === 'albums' || savedTab === 'queue') tab = savedTab
  if (savedCover === 'small') coverSize = 'small'
  return refresh()
})

