// Сетевой движок расширений Chrome: declarativeNetRequest + chrome.webRequest + состояние в профиле.
//
// Chromium в Electron 44 хранит правила DNR в ExtensionRegistry, но сетевой стек Electron
// не прогоняет через них запросы вкладок <webview> и отбрасывает listeners webRequest у расширений.
// Этот модуль реализует быстрое индексированное сопоставление DNR-правил и маршрутизацию
// chrome.webRequest в едином конвейере сессии вкладок (не мешая Google-входу и мосту YouCloud).

import { type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDomain } from 'tldts'
import { JsonFile } from './store'

export type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other'

export interface DnrRule {
  id: number
  priority?: number
  action: {
    type: 'block' | 'redirect' | 'allow' | 'upgradeScheme' | 'modifyHeaders' | 'allowAllRequests'
    redirect?: {
      url?: string
      extensionPath?: string
      regexSubstitution?: string
      transform?: {
        scheme?: string
        host?: string
        port?: string
        path?: string
        query?: string
        fragment?: string
        username?: string
        password?: string
        queryTransform?: {
          removeParams?: string[]
          addOrReplaceParams?: { key: string; value: string; replaceOnly?: boolean }[]
        }
      }
    }
    requestHeaders?: { header: string; operation: 'append' | 'set' | 'remove'; value?: string }[]
    responseHeaders?: { header: string; operation: 'append' | 'set' | 'remove'; value?: string }[]
  }
  condition: {
    urlFilter?: string
    regexFilter?: string
    isUrlFilterCaseSensitive?: boolean
    resourceTypes?: ResourceType[]
    excludedResourceTypes?: ResourceType[]
    domains?: string[]
    excludedDomains?: string[]
    initiatorDomains?: string[]
    excludedInitiatorDomains?: string[]
    requestDomains?: string[]
    excludedRequestDomains?: string[]
    domainType?: 'firstParty' | 'thirdParty'
    requestMethods?: string[]
    excludedRequestMethods?: string[]
    tabIds?: number[]
    excludedTabIds?: number[]
  }
}

export interface StoredUserScript {
  id: string
  matches?: string[]
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
  js?: { file?: string; code?: string }[]
  css?: { file?: string; code?: string }[]
  allFrames?: boolean
  runAt?: 'document_start' | 'document_end' | 'document_idle'
  world?: 'MAIN' | 'USER_SCRIPT'
  worldId?: string
}

export interface ExtensionStoredState {
  version?: string
  enabledRulesets?: Record<string, boolean>
  disabledStatic?: Record<string, number[]>
  dynamicRules?: DnrRule[]
  actionOptions?: { displayActionCountAsBadgeText?: boolean; tabUpdate?: { tabId: number; increment: number } }
  userScripts?: StoredUserScript[]
  userScriptWorld?: Record<string, { csp?: string; messaging?: boolean }>
  sidePanel?: { path?: string; enabled?: boolean; openPanelOnActionClick?: boolean }
}

interface CompiledRule {
  extId: string
  extPath: string
  rulesetId: string
  rule: DnrRule
  priority: number
  isModifyHeaders: boolean
  isAllowAllRequests: boolean
  caseSensitive: boolean
  urlRe: RegExp | null
  regexRe: RegExp | null
  resourceTypes: Set<ResourceType> | null
  excludedResourceTypes: Set<ResourceType> | null
  initiatorDomains: string[] | null
  excludedInitiatorDomains: string[] | null
  requestDomains: string[] | null
  excludedRequestDomains: string[] | null
  domainType: 'firstParty' | 'thirdParty' | null
  requestMethods: Set<string> | null
  excludedRequestMethods: Set<string> | null
  tabIds: Set<number> | null
  excludedTabIds: Set<number> | null
  tokenKey: string | null
}

export interface WebRequestListener {
  extId: string
  listenerId: string
  event: WebRequestEventName
  urls: string[]
  types: Set<string> | null
  tabId?: number
  windowId?: number
  extraInfoSpec: string[]
  blocking: boolean
  urlPatterns: RegExp[]
}

export type WebRequestEventName =
  | 'onBeforeRequest'
  | 'onBeforeSendHeaders'
  | 'onSendHeaders'
  | 'onHeadersReceived'
  | 'onResponseStarted'
  | 'onBeforeRedirect'
  | 'onCompleted'
  | 'onErrorOccurred'

export interface MatchedRuleRecord {
  rule: { ruleId: number; rulesetId: string }
  tabId: number
  timeStamp: number
}

const stateFile = new JsonFile<Record<string, ExtensionStoredState>>('extensions-state.json')
let storedAll: Record<string, ExtensionStoredState> = {}
let stateLoaded = false

/** Загруженные правила по расширениям: при изменении одного пересобираем общий индекс. */
const extStaticMeta = new Map<string, { path: string; resources: { id: string; enabled: boolean; path: string }[] }>()
const sessionRules = new Map<string, DnrRule[]>()
const matchedHistory = new Map<string, MatchedRuleRecord[]>()
const tabActionCounts = new Map<string, Map<number, number>>() // extId -> (tabId -> count)
const allowAllFrames = new Map<number, Map<string, { extId: string; priority: number }>>() // wcId -> (originOrUrl -> bestAllowAll)

// Общий индекс всех активных DNR-правил
let indexDirty = true
let domainIndex = new Map<string, CompiledRule[]>()
let tokenIndex = new Map<string, CompiledRule[]>()
let genericRules: CompiledRule[] = []
let hasAnyDnrNetRules = false
let hasAnyHeaderRules = false

// Подписчики chrome.webRequest
const webRequestListeners = new Map<string, WebRequestListener>()
let webRequestCounter = 0
let notifyBadgeChange: ((extId: string, tabId: number, text: string) => void) | null = null
let emitWebRequestEvent: ((extId: string, listenerId: string, event: WebRequestEventName, details: unknown, reqId?: string) => void) | null = null
let onWebRequestTopologyChanged: (() => void) | null = null

const pendingWrBlocking = new Map<string, { resolve: (res: unknown) => void; timer: NodeJS.Timeout }>()

// Какие запросы принадлежат внутренним механизмам Masaki и не должны резаться расширениями
const INTERNAL_GOOGLE = /^https:\/\/accounts\.google\.com\//i

const RESOURCE_TYPE_MAP: Record<string, ResourceType> = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  webTransport: 'webtransport',
  webBundle: 'webbundle',
  other: 'other'
}

function mapResourceType(t?: string): ResourceType {
  return (t && RESOURCE_TYPE_MAP[t]) || 'other'
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function domainOfHost(host: string): string {
  if (!host) return ''
  return getDomain(host) || host
}

function domainMatches(host: string, list: string[]): boolean {
  if (!host) return false
  for (const d of list) {
    if (host === d || host.endsWith('.' + d)) return true
  }
  return false
}

/** Перевод Chrome DNR urlFilter (||domain^, |start, end|, *, ^) в RegExp. */
function compileUrlFilter(filter: string, caseSensitive: boolean): { re: RegExp; token: string | null } {
  let s = filter
  const anchorStart = s.startsWith('|') && !s.startsWith('||')
  const anchorDomain = s.startsWith('||')
  if (anchorDomain) s = s.slice(2)
  else if (anchorStart) s = s.slice(1)
  const anchorEnd = s.endsWith('|') && !s.endsWith('^|') ? true : s.endsWith('|')
  if (anchorEnd) s = s.slice(0, -1)

  // Для быстрого пред-отбора ищем самый длинный буквенно-цифровой токен длиной >= 3.
  // ВАЖНО: из-за разделителя '-' (например, 'static-ad', 'clean-url') regex-токен на URL тоже должен
  // совпадать по [a-z0-9]{3,}. А вот если фильтр содержит '*', токен внутри части со '*' мог бы
  // иметь разные регистры, но оба match-а работают в нижнем регистре.
  const tokens = s
    .replace(/\*/g, ' ')
    .replace(/\^/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
  let bestToken: string | null = null
  if (tokens) {
    for (const tok of tokens) {
      if (tok === 'http' || tok === 'https' || tok === 'www' || tok === 'com') continue
      if (!bestToken || tok.length > bestToken.length) bestToken = tok
    }
    if (!bestToken) {
      for (const tok of tokens) if (!bestToken || tok.length > bestToken.length) bestToken = tok
    }
  }

  let body = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '*') body += '.*'
    else if (ch === '^') body += '(?:[^a-zA-Z0-9_.%-]|$)'
    else body += ch.replace(/[.+?${}()|[\]\\]/g, '\\$&')
  }
  let prefix = ''
  if (anchorDomain) prefix = '^[a-z][a-z0-9+.-]*://(?:[^/?#]+\\.)?'
  else if (anchorStart) prefix = '^'
  const suffix = anchorEnd ? '$' : ''
  try {
    return { re: new RegExp(prefix + body + suffix, caseSensitive ? '' : 'i'), token: bestToken }
  } catch {
    return { re: /^$/, token: null }
  }
}

function compileRule(extId: string, extPath: string, rulesetId: string, rule: DnrRule): CompiledRule | null {
  if (!rule || typeof rule.id !== 'number' || !rule.action || !rule.condition) return null
  const c = rule.condition
  const caseSensitive = !!c.isUrlFilterCaseSensitive
  let urlRe: RegExp | null = null
  let tokenKey: string | null = null
  if (c.urlFilter) {
    const compiled = compileUrlFilter(c.urlFilter, caseSensitive)
    urlRe = compiled.re
    tokenKey = compiled.token
  }
  let regexRe: RegExp | null = null
  if (c.regexFilter) {
    try {
      regexRe = new RegExp(c.regexFilter, caseSensitive ? '' : 'i')
    } catch {
      return null
    }
  }
  const initList = (c.initiatorDomains ?? c.domains)?.map((d) => d.toLowerCase()).filter(Boolean)
  const exclInitList = (c.excludedInitiatorDomains ?? c.excludedDomains)?.map((d) => d.toLowerCase()).filter(Boolean)
  const reqDomList = c.requestDomains?.map((d) => d.toLowerCase()).filter(Boolean)
  const exclReqDomList = c.excludedRequestDomains?.map((d) => d.toLowerCase()).filter(Boolean)

  // По умолчанию Chrome DNR при отсутствии resourceTypes НЕ матчит main_frame.
  const resourceTypes = Array.isArray(c.resourceTypes) && c.resourceTypes.length ? new Set(c.resourceTypes) : null
  const excludedResourceTypes =
    Array.isArray(c.excludedResourceTypes) && c.excludedResourceTypes.length ? new Set(c.excludedResourceTypes) : null

  return {
    extId,
    extPath,
    rulesetId,
    rule,
    priority: typeof rule.priority === 'number' ? rule.priority : 1,
    isModifyHeaders: rule.action.type === 'modifyHeaders',
    isAllowAllRequests: rule.action.type === 'allowAllRequests',
    caseSensitive,
    urlRe,
    regexRe,
    resourceTypes,
    excludedResourceTypes,
    initiatorDomains: initList?.length ? initList : null,
    excludedInitiatorDomains: exclInitList?.length ? exclInitList : null,
    requestDomains: reqDomList?.length ? reqDomList : null,
    excludedRequestDomains: exclReqDomList?.length ? exclReqDomList : null,
    domainType: c.domainType ?? null,
    requestMethods: c.requestMethods?.length ? new Set(c.requestMethods.map((m) => m.toLowerCase())) : null,
    excludedRequestMethods: c.excludedRequestMethods?.length ? new Set(c.excludedRequestMethods.map((m) => m.toLowerCase())) : null,
    tabIds: c.tabIds?.length ? new Set(c.tabIds) : null,
    excludedTabIds: c.excludedTabIds?.length ? new Set(c.excludedTabIds) : null,
    tokenKey
  }
}

function addCompiledToIndex(cr: CompiledRule): void {
  if (cr.requestDomains && cr.requestDomains.length > 0) {
    for (const d of cr.requestDomains) {
      let arr = domainIndex.get(d)
      if (!arr) {
        arr = []
        domainIndex.set(d, arr)
      }
      arr.push(cr)
    }
    return
  }
  if (cr.tokenKey) {
    let arr = tokenIndex.get(cr.tokenKey)
    if (!arr) {
      arr = []
      tokenIndex.set(cr.tokenKey, arr)
    }
    arr.push(cr)
    return
  }
  genericRules.push(cr)
}

function isPathInside(childPath: string, parentDir: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(childPath))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function readDnrResources(extPath: string, manifest?: unknown): { id: string; enabled: boolean; path: string }[] {
  const m = manifest as {
    declarative_net_request?: { rule_resources?: { id: string; enabled?: boolean; path: string }[] }
  } | undefined
  let list = m?.declarative_net_request?.rule_resources
  if (!Array.isArray(list)) {
    try {
      const disk = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8')) as {
        declarative_net_request?: { rule_resources?: { id: string; enabled?: boolean; path: string }[] }
      }
      list = disk?.declarative_net_request?.rule_resources
    } catch {
      list = undefined
    }
  }
  return Array.isArray(list) ? list.map((r) => ({ id: r.id, enabled: !!r.enabled, path: r.path })) : []
}

function rebuildIndex(): void {
  indexDirty = false
  domainIndex = new Map()
  tokenIndex = new Map()
  genericRules = []
  hasAnyDnrNetRules = false
  hasAnyHeaderRules = false

  for (const [extId, meta] of extStaticMeta) {
    const st = storedAll[extId] ?? {}
    const enabledMap = st.enabledRulesets ?? {}
    const disabledMap = st.disabledStatic ?? {}

    for (const res of meta.resources) {
      const enabled = typeof enabledMap[res.id] === 'boolean' ? enabledMap[res.id] : res.enabled
      if (!enabled) continue
      const fullPath = path.resolve(meta.path, res.path.replace(/^\/+/, ''))
      if (!isPathInside(fullPath, meta.path)) continue
      try {
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as DnrRule[]
        if (!Array.isArray(raw)) continue
        const disabledIds = new Set(disabledMap[res.id] ?? [])
        for (const r of raw) {
          if (disabledIds.has(r.id)) continue
          const c = compileRule(extId, meta.path, res.id, r)
          if (!c) continue
          if (c.isModifyHeaders) hasAnyHeaderRules = true
          else hasAnyDnrNetRules = true
          addCompiledToIndex(c)
        }
      } catch {
        // повреждённый или отсутствующий JSON набора правил — пропускаем
      }
    }

    for (const r of st.dynamicRules ?? []) {
      const c = compileRule(extId, meta.path, '_dynamic', r)
      if (!c) continue
      if (c.isModifyHeaders) hasAnyHeaderRules = true
      else hasAnyDnrNetRules = true
      addCompiledToIndex(c)
    }

    for (const r of sessionRules.get(extId) ?? []) {
      const c = compileRule(extId, meta.path, '_session', r)
      if (!c) continue
      if (c.isModifyHeaders) hasAnyHeaderRules = true
      else hasAnyDnrNetRules = true
      addCompiledToIndex(c)
    }
  }
  onWebRequestTopologyChanged?.()
}

function ensureIndex(): void {
  if (indexDirty) rebuildIndex()
}

export async function initExtNet(hooks: {
  onBadgeCount?: (extId: string, tabId: number, text: string) => void
  onWebRequestEvent?: (extId: string, listenerId: string, event: WebRequestEventName, details: unknown, reqId?: string) => void
  onTopologyChanged?: () => void
}): Promise<void> {
  notifyBadgeChange = hooks.onBadgeCount ?? null
  emitWebRequestEvent = hooks.onWebRequestEvent ?? null
  onWebRequestTopologyChanged = hooks.onTopologyChanged ?? null
  if (!stateLoaded) {
    storedAll = (await stateFile.read()) ?? {}
    stateLoaded = true
  }
}

export function flushExtNet(): void {
  stateFile.flushSync()
}

export function getStoredState(extId: string): ExtensionStoredState {
  return storedAll[extId] ?? {}
}

export function updateStoredState(extId: string, patch: Partial<ExtensionStoredState>): void {
  const prev = storedAll[extId] ?? {}
  storedAll[extId] = { ...prev, ...patch }
  stateFile.write(storedAll, 300)
}

export function clearExtensionRuntime(extId: string, removePersisted = false): void {
  extStaticMeta.delete(extId)
  sessionRules.delete(extId)
  matchedHistory.delete(extId)
  tabActionCounts.delete(extId)
  for (const [key, l] of webRequestListeners) {
    if (l.extId === extId) webRequestListeners.delete(key)
  }
  if (removePersisted) {
    delete storedAll[extId]
    stateFile.write(storedAll, 300)
  }
  indexDirty = true
  rebuildIndex()
}

/** При загрузке расширения читаем declarative_net_request из manifest и перестраиваем индекс. */
export function registerExtensionDnr(ext: Electron.Extension): void {
  const resources = readDnrResources(ext.path, ext.manifest)
  extStaticMeta.set(ext.id, { path: path.resolve(ext.path), resources })
  indexDirty = true
  rebuildIndex()
}

export function getEnabledRulesetsForExtension(extId: string): string[] {
  const meta = extStaticMeta.get(extId)
  if (!meta) return []
  const st = storedAll[extId] ?? {}
  const enabledMap = st.enabledRulesets ?? {}
  return meta.resources
    .filter((r) => (typeof enabledMap[r.id] === 'boolean' ? enabledMap[r.id] : r.enabled))
    .map((r) => r.id)
}

export function getDisabledRuleIdsForExtension(extId: string, rulesetId: string): number[] {
  return [...(storedAll[extId]?.disabledStatic?.[rulesetId] ?? [])]
}

/** Синхронизация правил/опций DNR из renderer/service-worker расширения. */
export function syncDnrFromExtension(
  ext: Electron.Extension,
  payload: {
    boot?: boolean
    dynamicRules?: DnrRule[]
    sessionRules?: DnrRule[]
    enabledRulesets?: string[]
    rulesetDelta?: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }
    disabledStatic?: Record<string, number[]>
    staticRuleDelta?: { rulesetId: string; disableRuleIds?: number[]; enableRuleIds?: number[] }
    actionOptions?: ExtensionStoredState['actionOptions']
  }
): void {
  if (!extStaticMeta.has(ext.id)) registerExtensionDnr(ext)
  const st = { ...(storedAll[ext.id] ?? {}) }
  let dirty = false
  if (Array.isArray(payload.dynamicRules)) {
    if (!(payload.boot && payload.dynamicRules.length === 0 && (st.dynamicRules?.length ?? 0) > 0)) {
      st.dynamicRules = payload.dynamicRules
      dirty = true
    }
  }
  if (Array.isArray(payload.sessionRules)) {
    sessionRules.set(ext.id, payload.sessionRules)
    dirty = true
  }
  if (Array.isArray(payload.enabledRulesets)) {
    const resources = extStaticMeta.get(ext.id)?.resources ?? readDnrResources(ext.path, ext.manifest)
    const enabledSet = new Set(payload.enabledRulesets)
    const map: Record<string, boolean> = {}
    for (const r of resources) map[r.id] = enabledSet.has(r.id)
    st.enabledRulesets = map
    dirty = true
  }
  if (payload.rulesetDelta && typeof payload.rulesetDelta === 'object') {
    const map: Record<string, boolean> = { ...(st.enabledRulesets ?? {}) }
    for (const id of payload.rulesetDelta.enableRulesetIds ?? []) map[id] = true
    for (const id of payload.rulesetDelta.disableRulesetIds ?? []) map[id] = false
    st.enabledRulesets = map
    dirty = true
  }
  if (payload.disabledStatic && typeof payload.disabledStatic === 'object') {
    st.disabledStatic = { ...(st.disabledStatic ?? {}), ...payload.disabledStatic }
    dirty = true
  }
  if (payload.staticRuleDelta?.rulesetId) {
    const rid = payload.staticRuleDelta.rulesetId
    const cur = new Set(st.disabledStatic?.[rid] ?? [])
    for (const id of payload.staticRuleDelta.disableRuleIds ?? []) cur.add(id)
    for (const id of payload.staticRuleDelta.enableRuleIds ?? []) cur.delete(id)
    st.disabledStatic = { ...(st.disabledStatic ?? {}), [rid]: [...cur] }
    dirty = true
  }
  if (payload.actionOptions) {
    st.actionOptions = { ...(st.actionOptions ?? {}), ...payload.actionOptions }
    if (payload.actionOptions.tabUpdate) {
      const { tabId, increment } = payload.actionOptions.tabUpdate
      bumpActionCount(ext.id, tabId, increment)
    }
  }
  storedAll[ext.id] = st
  stateFile.write(storedAll, 300)
  if (dirty) {
    indexDirty = true
    rebuildIndex()
  }
}

function bumpActionCount(extId: string, tabId: number, delta = 1): void {
  if (tabId <= 0) return
  let byTab = tabActionCounts.get(extId)
  if (!byTab) {
    byTab = new Map()
    tabActionCounts.set(extId, byTab)
  }
  const next = Math.max(0, (byTab.get(tabId) ?? 0) + delta)
  byTab.set(tabId, next)
  if (storedAll[extId]?.actionOptions?.displayActionCountAsBadgeText) {
    notifyBadgeChange?.(extId, tabId, next > 0 ? String(next) : '')
  }
}

export function resetTabDnrState(wcId: number): void {
  allowAllFrames.delete(wcId)
  for (const [extId, byTab] of tabActionCounts) {
    if (byTab.has(wcId)) {
      byTab.delete(wcId)
      if (storedAll[extId]?.actionOptions?.displayActionCountAsBadgeText) {
        notifyBadgeChange?.(extId, wcId, '')
      }
    }
  }
}

export function getMatchedRulesForExtension(extId: string, filter?: { tabId?: number; minTimeStamp?: number }): MatchedRuleRecord[] {
  const list = matchedHistory.get(extId) ?? []
  return list.filter((m) => {
    if (typeof filter?.tabId === 'number' && m.tabId !== filter.tabId) return false
    if (typeof filter?.minTimeStamp === 'number' && m.timeStamp < filter.minTimeStamp) return false
    return true
  })
}

function recordMatch(extId: string, cr: CompiledRule, tabId: number): void {
  let list = matchedHistory.get(extId)
  if (!list) {
    list = []
    matchedHistory.set(extId, list)
  }
  list.push({ rule: { ruleId: cr.rule.id, rulesetId: cr.rulesetId }, tabId, timeStamp: Date.now() })
  if (list.length > 500) list.splice(0, list.length - 500)
  if (cr.rule.action.type === 'block' || cr.rule.action.type === 'redirect') {
    bumpActionCount(extId, tabId, 1)
  }
}

function candidatesFor(urlLower: string, host: string): CompiledRule[] {
  const out: CompiledRule[] = []
  if (domainIndex.size > 0 && host) {
    let cur = host
    while (cur) {
      const hit = domainIndex.get(cur)
      if (hit) for (const r of hit) out.push(r)
      const dot = cur.indexOf('.')
      if (dot < 0) break
      cur = cur.slice(dot + 1)
    }
  }
  if (tokenIndex.size > 0) {
    const tokens = urlLower.match(/[a-z0-9]{3,}/g)
    if (tokens) {
      const seen = new Set<string>()
      for (const t of tokens) {
        if (seen.has(t)) continue
        seen.add(t)
        const hit = tokenIndex.get(t)
        if (hit) for (const r of hit) out.push(r)
      }
    }
  }
  for (const r of genericRules) out.push(r)
  return out
}

function ruleMatches(
  cr: CompiledRule,
  url: string,
  reqHost: string,
  reqDomain: string,
  initHost: string,
  initDomain: string,
  type: ResourceType,
  method: string,
  tabId: number
): boolean {
  if (cr.resourceTypes) {
    if (!cr.resourceTypes.has(type)) return false
  } else if (type === 'main_frame') {
    // По спецификации Chrome DNR: если resourceTypes не задан, main_frame не матчится.
    return false
  }
  if (cr.excludedResourceTypes?.has(type)) return false
  if (cr.tabIds && !cr.tabIds.has(tabId)) return false
  if (cr.excludedTabIds?.has(tabId)) return false
  if (cr.requestMethods && !cr.requestMethods.has(method)) return false
  if (cr.excludedRequestMethods?.has(method)) return false
  if (cr.requestDomains && !domainMatches(reqHost, cr.requestDomains)) return false
  if (cr.excludedRequestDomains && domainMatches(reqHost, cr.excludedRequestDomains)) return false
  if (cr.initiatorDomains && !domainMatches(initHost, cr.initiatorDomains)) return false
  if (cr.excludedInitiatorDomains && domainMatches(initHost, cr.excludedInitiatorDomains)) return false
  if (cr.domainType) {
    const isFirst = !!initDomain && initDomain === reqDomain
    if (cr.domainType === 'firstParty' && !isFirst) return false
    if (cr.domainType === 'thirdParty' && isFirst) return false
  }
  if (cr.urlRe && !cr.urlRe.test(url)) return false
  if (cr.regexRe && !cr.regexRe.test(url)) return false
  return true
}

const ACTION_WEIGHT: Record<string, number> = {
  allowAllRequests: 5,
  allow: 4,
  block: 3,
  redirect: 2,
  upgradeScheme: 1
}

function sortRulesDesc(a: CompiledRule, b: CompiledRule): number {
  if (b.priority !== a.priority) return b.priority - a.priority
  return (ACTION_WEIGHT[b.rule.action.type] ?? 0) - (ACTION_WEIGHT[a.rule.action.type] ?? 0)
}

function extensionResourceAsRedirect(extId: string, relPath: string): string {
  return `chrome-extension://${extId}/${relPath.replace(/^\/+/, '')}`
}

function applyRedirect(cr: CompiledRule, rawUrl: string): string | null {
  const red = cr.rule.action.redirect
  if (!red) return null
  if (red.url) return red.url
  if (red.extensionPath) return extensionResourceAsRedirect(cr.extId, red.extensionPath)
  if (red.regexSubstitution && cr.regexRe) {
    try {
      return rawUrl.replace(cr.regexRe, red.regexSubstitution)
    } catch {
      return null
    }
  }
  if (red.transform) {
    try {
      const u = new URL(rawUrl)
      const t = red.transform
      if (t.scheme) u.protocol = t.scheme.endsWith(':') ? t.scheme : t.scheme + ':'
      if (t.host) u.hostname = t.host
      if (t.port !== undefined) u.port = t.port
      if (t.path !== undefined) u.pathname = t.path
      if (t.query !== undefined) u.search = t.query
      if (t.fragment !== undefined) u.hash = t.fragment
      if (t.username !== undefined) u.username = t.username
      if (t.password !== undefined) u.password = t.password
      if (t.queryTransform) {
        for (const p of t.queryTransform.removeParams ?? []) u.searchParams.delete(p)
        for (const item of t.queryTransform.addOrReplaceParams ?? []) {
          if (item.replaceOnly) {
            if (u.searchParams.has(item.key)) u.searchParams.set(item.key, item.value)
          } else {
            u.searchParams.set(item.key, item.value)
          }
        }
      }
      const next = u.toString()
      return next === rawUrl ? null : next
    } catch {
      return null
    }
  }
  return null
}

function isTabAllowedByRule(wcId: number, extId: string, priority: number): boolean {
  const byOrigin = allowAllFrames.get(wcId)
  if (!byOrigin) return false
  for (const entry of byOrigin.values()) {
    if (entry.extId === extId && entry.priority >= priority) return true
  }
  return false
}

function requestTabUrl(details: { webContents?: WebContents; referrer?: string; initiator?: string }): string {
  try {
    const wcUrl = details.webContents?.getURL()
    if (wcUrl) return wcUrl
  } catch {
    // webContents мог уничтожиться
  }
  return details.initiator || details.referrer || ''
}

function isProtectedRequest(
  details: Electron.OnBeforeRequestListenerDetails | Electron.OnBeforeSendHeadersListenerDetails | Electron.OnHeadersReceivedListenerDetails,
  uiWcId?: number
): boolean {
  if (details.webContentsId === undefined) return true
  if (typeof uiWcId === 'number' && details.webContentsId === uiWcId) return true
  if (details.url.startsWith('chrome-extension://') || details.url.startsWith('devtools://') || details.url.startsWith('crx://')) {
    return true
  }
  const init = (details as { initiator?: string }).initiator
  if (init?.startsWith('chrome-extension://')) return true
  try {
    if (details.webContents?.getURL().startsWith('chrome-extension://')) return true
  } catch {
    // webContents мог быть уничтожен
  }
  if (INTERNAL_GOOGLE.test(details.url) || /[?&]ycr=\d+/.test(details.url)) return true
  return false
}

// ---------- Подписчики chrome.webRequest ----------

function globToRegex(pattern: string): RegExp {
  if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):\/\/.*$/i
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + esc(pattern) + '$', 'i')
}

export function registerWebRequestListener(
  extId: string,
  payload: {
    listenerId: string
    event: WebRequestEventName
    filter?: { urls?: string[]; types?: string[]; tabId?: number; windowId?: number }
    extraInfoSpec?: string[]
  }
): void {
  const urls = Array.isArray(payload.filter?.urls) && payload.filter.urls.length ? payload.filter.urls : ['<all_urls>']
  const extra = Array.isArray(payload.extraInfoSpec) ? payload.extraInfoSpec : []
  webRequestListeners.set(`${extId}:${payload.listenerId}`, {
    extId,
    listenerId: payload.listenerId,
    event: payload.event,
    urls,
    types: Array.isArray(payload.filter?.types) && payload.filter.types.length ? new Set(payload.filter.types) : null,
    tabId: typeof payload.filter?.tabId === 'number' ? payload.filter.tabId : undefined,
    windowId: typeof payload.filter?.windowId === 'number' ? payload.filter.windowId : undefined,
    extraInfoSpec: extra,
    blocking: extra.includes('blocking'),
    urlPatterns: urls.map(globToRegex)
  })
  onWebRequestTopologyChanged?.()
}

export function unregisterWebRequestListener(extId: string, listenerId?: string): void {
  if (listenerId) {
    webRequestListeners.delete(`${extId}:${listenerId}`)
  } else {
    for (const [k, v] of webRequestListeners) if (v.extId === extId) webRequestListeners.delete(k)
  }
  onWebRequestTopologyChanged?.()
}

export function answerWebRequestBlocking(reqId: string, res: unknown): void {
  const entry = pendingWrBlocking.get(reqId)
  if (!entry) return
  pendingWrBlocking.delete(reqId)
  clearTimeout(entry.timer)
  entry.resolve(res)
}

export function hasListenersFor(event: WebRequestEventName): boolean {
  for (const l of webRequestListeners.values()) if (l.event === event) return true
  return false
}

export function hasAnyDnrRules(): boolean {
  ensureIndex()
  return hasAnyDnrNetRules
}

export function hasAnyDnrHeaderRules(): boolean {
  ensureIndex()
  return hasAnyHeaderRules
}

function matchingWrListeners(
  event: WebRequestEventName,
  url: string,
  type: ResourceType,
  tabId: number
): WebRequestListener[] {
  const out: WebRequestListener[] = []
  for (const l of webRequestListeners.values()) {
    if (l.event !== event) continue
    if (typeof l.tabId === 'number' && l.tabId !== tabId) continue
    if (l.types && !l.types.has(type)) continue
    if (!l.urlPatterns.some((re) => re.test(url))) continue
    out.push(l)
  }
  return out
}

function toWrHeaders(headers: Record<string, string> | Record<string, string[]>): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  for (const [name, val] of Object.entries(headers)) {
    if (Array.isArray(val)) for (const v of val) out.push({ name, value: v })
    else if (typeof val === 'string') out.push({ name, value: val })
  }
  return out
}

function safeEmitWebRequest(
  extId: string,
  listenerId: string,
  event: WebRequestEventName,
  details: unknown,
  reqId?: string
): boolean {
  try {
    emitWebRequestEvent?.(extId, listenerId, event, details, reqId)
    return true
  } catch {
    // Сбой доставки события в расширение не должен ронять сетевой конвейер и главный процесс.
    return false
  }
}

async function runWrBlocking(l: WebRequestListener, details: unknown): Promise<Record<string, unknown> | null> {
  const reqId = `wr-${++webRequestCounter}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingWrBlocking.delete(reqId)
      resolve(null)
    }, 1500)
    pendingWrBlocking.set(reqId, { resolve: (v) => resolve((v as Record<string, unknown>) ?? null), timer })
    if (!safeEmitWebRequest(l.extId, l.listenerId, l.event, details, reqId)) {
      clearTimeout(timer)
      pendingWrBlocking.delete(reqId)
      resolve(null)
    }
  })
}

// ---------- Обработчики этапов сетевого конвейера ----------

export async function handleBeforeRequest(
  details: Electron.OnBeforeRequestListenerDetails,
  uiWcId?: number
): Promise<Electron.CallbackResponse | null> {
  if (isProtectedRequest(details, uiWcId)) return null
  ensureIndex()
  const type = mapResourceType(details.resourceType)
  const tabId = details.webContentsId ?? -1

  if (type === 'main_frame' && tabId > 0) {
    resetTabDnrState(tabId)
  }

  if (hasAnyDnrNetRules) {
    const reqHost = hostFromUrl(details.url)
    const reqDomain = domainOfHost(reqHost)
    const initUrl = (details as { initiator?: string }).initiator || details.referrer || requestTabUrl(details)
    const initHost = hostFromUrl(initUrl)
    const initDomain = domainOfHost(initHost)
    const method = (details.method || 'GET').toLowerCase()
    const candidates = candidatesFor(details.url.toLowerCase(), reqHost)

    if (candidates.length > 0) {
      const matched = candidates
        .filter((cr) => !cr.isModifyHeaders && ruleMatches(cr, details.url, reqHost, reqDomain, initHost, initDomain, type, method, tabId))
        .sort(sortRulesDesc)

      // Обрабатываем правила по убыванию приоритета; allowAllRequests фиксируем для документа
      for (const cr of matched) {
        if (cr.isAllowAllRequests) {
          if (tabId > 0) {
            let map = allowAllFrames.get(tabId)
            if (!map) {
              map = new Map()
              allowAllFrames.set(tabId, map)
            }
            map.set(details.url, { extId: cr.extId, priority: cr.priority })
          }
          recordMatch(cr.extId, cr, tabId)
          return null
        }
        if (tabId > 0 && isTabAllowedByRule(tabId, cr.extId, cr.priority)) continue

        const action = cr.rule.action.type
        if (action === 'allow') {
          recordMatch(cr.extId, cr, tabId)
          return null
        }
        if (action === 'block') {
          recordMatch(cr.extId, cr, tabId)
          return { cancel: true }
        }
        if (action === 'upgradeScheme') {
          try {
            const u = new URL(details.url)
            if (u.protocol === 'http:' || u.protocol === 'ws:') {
              u.protocol = u.protocol === 'http:' ? 'https:' : 'wss:'
              recordMatch(cr.extId, cr, tabId)
              return { redirectURL: u.toString() }
            }
          } catch {
            // игнорируем некорректный URL
          }
        }
        if (action === 'redirect') {
          const target = applyRedirect(cr, details.url)
          if (target) {
            recordMatch(cr.extId, cr, tabId)
            return { redirectURL: target }
          }
        }
      }
    }
  }

  const wr = matchingWrListeners('onBeforeRequest', details.url, type, tabId)
  if (wr.length > 0) {
    const wrDetails = {
      requestId: String(details.id),
      url: details.url,
      method: details.method,
      frameId: details.frame ? (details.frame === details.frame.top ? 0 : details.frame.frameTreeNodeId) : 0,
      parentFrameId: details.frame?.parent ? details.frame.parent.frameTreeNodeId : -1,
      tabId,
      type,
      timeStamp: details.timestamp,
      initiator: details.referrer || undefined
    }
    for (const l of wr) {
      if (l.blocking) {
        const res = await runWrBlocking(l, wrDetails)
        if (res?.cancel) return { cancel: true }
        if (typeof res?.redirectUrl === 'string') return { redirectURL: res.redirectUrl }
      } else {
        safeEmitWebRequest(l.extId, l.listenerId, 'onBeforeRequest', wrDetails)
      }
    }
  }

  return null
}

function applyHeaderOps(
  headers: Record<string, string>,
  ops: { header: string; operation: 'append' | 'set' | 'remove'; value?: string }[]
): boolean {
  let changed = false
  for (const op of ops) {
    const targetLow = op.header.toLowerCase()
    const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === targetLow)
    if (op.operation === 'remove') {
      if (existingKey) {
        delete headers[existingKey]
        changed = true
      }
    } else if (op.operation === 'set' && typeof op.value === 'string') {
      if (existingKey) delete headers[existingKey]
      headers[op.header] = op.value
      changed = true
    } else if (op.operation === 'append' && typeof op.value === 'string') {
      const prev = existingKey ? headers[existingKey] : ''
      if (existingKey) delete headers[existingKey]
      headers[op.header] = prev ? `${prev}, ${op.value}` : op.value
      changed = true
    }
  }
  return changed
}

function applyResponseHeaderOps(
  headers: Record<string, string[]>,
  ops: { header: string; operation: 'append' | 'set' | 'remove'; value?: string }[]
): boolean {
  let changed = false
  for (const op of ops) {
    const targetLow = op.header.toLowerCase()
    const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === targetLow)
    if (op.operation === 'remove') {
      if (existingKey) {
        delete headers[existingKey]
        changed = true
      }
    } else if (op.operation === 'set' && typeof op.value === 'string') {
      if (existingKey) delete headers[existingKey]
      headers[op.header] = [op.value]
      changed = true
    } else if (op.operation === 'append' && typeof op.value === 'string') {
      const list = existingKey ? [...headers[existingKey]] : []
      list.push(op.value)
      if (existingKey) delete headers[existingKey]
      headers[op.header] = list
      changed = true
    }
  }
  return changed
}

export async function handleBeforeSendHeaders(
  details: Electron.OnBeforeSendHeadersListenerDetails,
  headers: Record<string, string>,
  uiWcId?: number
): Promise<Record<string, string> | null> {
  if (isProtectedRequest(details, uiWcId)) return null
  ensureIndex()
  const type = mapResourceType(details.resourceType)
  const tabId = details.webContentsId ?? -1
  let mutated = false

  if (hasAnyHeaderRules) {
    const reqHost = hostFromUrl(details.url)
    const reqDomain = domainOfHost(reqHost)
    const initUrl = (details as { initiator?: string }).initiator || details.referrer || requestTabUrl(details)
    const initHost = hostFromUrl(initUrl)
    const initDomain = domainOfHost(initHost)
    const method = (details.method || 'GET').toLowerCase()
    const matched = candidatesFor(details.url.toLowerCase(), reqHost)
      .filter((cr) => cr.isModifyHeaders && cr.rule.action.requestHeaders?.length && ruleMatches(cr, details.url, reqHost, reqDomain, initHost, initDomain, type, method, tabId))
      .sort(sortRulesDesc)

    for (const cr of matched) {
      if (tabId > 0 && isTabAllowedByRule(tabId, cr.extId, cr.priority)) continue
      if (applyHeaderOps(headers, cr.rule.action.requestHeaders!)) mutated = true
      recordMatch(cr.extId, cr, tabId)
    }
  }

  const wr = matchingWrListeners('onBeforeSendHeaders', details.url, type, tabId)
  if (wr.length > 0) {
    const wrDetails = {
      requestId: String(details.id),
      url: details.url,
      method: details.method,
      frameId: 0,
      parentFrameId: -1,
      tabId,
      type,
      timeStamp: details.timestamp,
      requestHeaders: toWrHeaders(headers)
    }
    for (const l of wr) {
      if (l.blocking) {
        const res = await runWrBlocking(l, wrDetails)
        if (Array.isArray(res?.requestHeaders)) {
          for (const k of Object.keys(headers)) delete headers[k]
          for (const h of res.requestHeaders as { name: string; value?: string }[]) {
            if (h?.name && typeof h.value === 'string') headers[h.name] = h.value
          }
          mutated = true
        }
      } else {
        safeEmitWebRequest(l.extId, l.listenerId, 'onBeforeSendHeaders', wrDetails)
      }
    }
  }

  return mutated ? headers : null
}

export async function handleHeadersReceived(
  details: Electron.OnHeadersReceivedListenerDetails,
  uiWcId?: number
): Promise<Record<string, string[]> | null> {
  if (isProtectedRequest(details, uiWcId)) return null
  ensureIndex()
  const type = mapResourceType(details.resourceType)
  const tabId = details.webContentsId ?? -1
  const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) }
  let mutated = false

  if (hasAnyHeaderRules) {
    const reqHost = hostFromUrl(details.url)
    const reqDomain = domainOfHost(reqHost)
    const initUrl = (details as { initiator?: string }).initiator || details.referrer || requestTabUrl(details)
    const initHost = hostFromUrl(initUrl)
    const initDomain = domainOfHost(initHost)
    const method = (details.method || 'GET').toLowerCase()
    const matched = candidatesFor(details.url.toLowerCase(), reqHost)
      .filter((cr) => cr.isModifyHeaders && cr.rule.action.responseHeaders?.length && ruleMatches(cr, details.url, reqHost, reqDomain, initHost, initDomain, type, method, tabId))
      .sort(sortRulesDesc)

    for (const cr of matched) {
      if (tabId > 0 && isTabAllowedByRule(tabId, cr.extId, cr.priority)) continue
      if (applyResponseHeaderOps(headers, cr.rule.action.responseHeaders!)) mutated = true
      recordMatch(cr.extId, cr, tabId)
    }
  }

  const wr = matchingWrListeners('onHeadersReceived', details.url, type, tabId)
  if (wr.length > 0) {
    const wrDetails = {
      requestId: String(details.id),
      url: details.url,
      method: details.method,
      frameId: 0,
      parentFrameId: -1,
      tabId,
      type,
      timeStamp: details.timestamp,
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      responseHeaders: toWrHeaders(headers)
    }
    for (const l of wr) {
      if (l.blocking) {
        const res = await runWrBlocking(l, wrDetails)
        if (Array.isArray(res?.responseHeaders)) {
          for (const k of Object.keys(headers)) delete headers[k]
          for (const h of res.responseHeaders as { name: string; value?: string }[]) {
            if (h?.name && typeof h.value === 'string') {
              headers[h.name] = [...(headers[h.name] ?? []), h.value]
            }
          }
          mutated = true
        }
      } else {
        safeEmitWebRequest(l.extId, l.listenerId, 'onHeadersReceived', wrDetails)
      }
    }
  }

  return mutated ? headers : null
}

export function attachWebRequestObservers(ses: Session, uiWc: () => WebContents | undefined): void {
  const uiId = (): number | undefined => {
    const w = uiWc()
    return w && !w.isDestroyed() ? w.id : undefined
  }
  const emitObs = (
    event: WebRequestEventName,
    details: { id: number; url: string; method: string; resourceType?: string; webContentsId?: number; timestamp: number; statusCode?: number; statusLine?: string; redirectURL?: string; fromCache?: boolean; error?: string; responseHeaders?: Record<string, string[]>; requestHeaders?: Record<string, string> }
  ): void => {
    try {
      if (typeof uiId() === 'number' && details.webContentsId === uiId()) return
      const type = mapResourceType(details.resourceType)
      const tabId = details.webContentsId ?? -1
      for (const l of matchingWrListeners(event, details.url, type, tabId)) {
        safeEmitWebRequest(l.extId, l.listenerId, event, {
          requestId: String(details.id),
          url: details.url,
          method: details.method,
          frameId: 0,
          parentFrameId: -1,
          tabId,
          type,
          timeStamp: details.timestamp,
          statusCode: details.statusCode,
          statusLine: details.statusLine,
          redirectUrl: details.redirectURL,
          fromCache: details.fromCache,
          error: details.error,
          responseHeaders: details.responseHeaders ? toWrHeaders(details.responseHeaders) : undefined,
          requestHeaders: details.requestHeaders ? toWrHeaders(details.requestHeaders) : undefined
        })
      }
    } catch {
      // Сбой наблюдателя webRequest не должен ронять главный процесс.
    }
  }

  if (hasListenersFor('onSendHeaders')) ses.webRequest.onSendHeaders({ urls: ['<all_urls>'] }, (d) => emitObs('onSendHeaders', d))
  else ses.webRequest.onSendHeaders(null)

  if (hasListenersFor('onResponseStarted')) ses.webRequest.onResponseStarted({ urls: ['<all_urls>'] }, (d) => emitObs('onResponseStarted', d))
  else ses.webRequest.onResponseStarted(null)

  if (hasListenersFor('onBeforeRedirect')) ses.webRequest.onBeforeRedirect({ urls: ['<all_urls>'] }, (d) => emitObs('onBeforeRedirect', d))
  else ses.webRequest.onBeforeRedirect(null)

  if (hasListenersFor('onCompleted')) ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => emitObs('onCompleted', d))
  else ses.webRequest.onCompleted(null)

  if (hasListenersFor('onErrorOccurred')) ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => emitObs('onErrorOccurred', d))
  else ses.webRequest.onErrorOccurred(null)
}
