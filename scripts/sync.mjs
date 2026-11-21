#!/usr/bin/env node
/**
 * Regenerates everything derived from plugins.json:
 *
 *   data/catalog.json   full trimmed index snapshot (every installable plugin)
 *   data/verified.json  starter kit resolved against the live index + published manifests
 *   CATALOG.md          browseable catalog, freshest N per category
 *   README.md           the starter table between the BEGIN/END STARTER markers
 *
 * Usage:  node scripts/sync.mjs [--offline]
 *
 * Data sources, in order of trust:
 *   1. the community index  - what exists and which version to install
 *   2. jsDelivr npm CDN     - the package.json that actually ships, so licence and
 *                             install scripts are read from the published artifact
 *   3. GitHub API           - stars and last push, only when a token is available
 *                             (GITHUB_TOKEN, GH_TOKEN, or an authenticated `gh`)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'data')
const SNAPSHOT = join(DATA, 'index.snapshot.json')
const OFFLINE = process.argv.includes('--offline')
const TIMEOUT_MS = 20_000
const CONCURRENCY = 6
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall']

const source = JSON.parse(readFileSync(join(ROOT, 'plugins.json'), 'utf8'))
mkdirSync(DATA, { recursive: true })

/* ------------------------------------------------------------------ utils */

const log = (...args) => console.log(...args)

/** Write only on change, so an unchanged sync leaves a clean git tree. */
function writeIfChanged(path, content) {
  const next = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`
  if (existsSync(path) && readFileSync(path, 'utf8') === next) return false
  writeFileSync(path, next)
  return true
}

/** One JSON record per line: reviewable in a diff, a third the size of pretty-printing. */
function jsonLines(rows) {
  return `[\n${rows.map(row => JSON.stringify(row)).join(',\n')}\n]\n`
}

/** Escape one table cell: no pipes, no newlines, no runaway length. */
function cell(text, limit = 160) {
  let out = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
  if (limit && out.length > limit) {
    const cut = out.slice(0, limit)
    out = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit - 20)).trimEnd()}…`
  }
  return out
}

function localised(value, language = 'en') {
  if (typeof value === 'string') return value
  if (!value) return ''
  return value[language] ?? value.zh ?? Object.values(value)[0] ?? ''
}

function isoDay(timestamp) {
  return timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 10) : ''
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'useful-dsh-plugins-sync', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

/** Run tasks with a small concurrency ceiling. */
async function pooled(items, limit, task) {
  const results = []
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index], index)
    }
  }))
  return results
}

/** A token raises GitHub from 60 anonymous requests an hour to 5000, and enables stars. */
function githubToken() {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (process.env[name]) return process.env[name]
  }
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}
const TOKEN = OFFLINE ? '' : githubToken()

/* ------------------------------------------------------------------ index */

async function loadIndex() {
  if (!OFFLINE) {
    try {
      const index = await getJson(source.indexUrl)
      writeIfChanged(SNAPSHOT, index)
      return { index, stale: false }
    } catch (error) {
      log(`! index fetch failed: ${error.message}`)
      if (!existsSync(SNAPSHOT)) throw new Error('no index snapshot to fall back to')
      log('  falling back to data/index.snapshot.json')
    }
  }
  return { index: JSON.parse(readFileSync(SNAPSHOT, 'utf8')), stale: true }
}

const latestVersion = entry =>
  [...(entry.versions ?? [])].sort((a, b) => b.publishTimestamp - a.publishTimestamp)[0]

const categoryTitle = (index, key) =>
  localised(index.metadata?.categories?.[key]?.title) || key

/* ---------------------------------------------------------------- catalog */

function buildCatalog(index) {
  const byCategory = new Map()
  const rows = []
  for (const entry of index.plugins ?? []) {
    const version = latestVersion(entry)
    if (!version) continue
    const category = entry.metadata?.category ?? 'uncategorized'
    const row = {
      name: entry.name,
      category,
      version: version.version,
      engines: version.engines?.dsh ?? null,
      published: isoDay(version.publishTimestamp),
      publishedTimestamp: version.publishTimestamp ?? 0,
      description: cell(localised(entry.description), 120),
      repository: entry.repository?.url ?? null,
      directory: entry.repository?.directory ?? null,
      homepage: entry.homepage ?? null,
    }
    rows.push(row)
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push(row)
  }
  for (const list of byCategory.values()) list.sort((a, b) => b.publishedTimestamp - a.publishedTimestamp)
  return { rows, byCategory }
}

function renderCatalog(index, catalog, generatedAt) {
  const order = Object.keys(index.metadata?.categories ?? {})
  for (const key of catalog.byCategory.keys()) if (!order.includes(key)) order.push(key)
  const perCategory = source.catalogPerCategory ?? 40

  const lines = [
    '# Plugin catalog',
    '',
    `> Generated by \`npm run sync\` from [the community index](${source.indexUrl}) — do not edit by hand.`,
    `> Snapshot: ${generatedAt}. ${catalog.rows.length.toLocaleString('en-US')} installable plugins across ${catalog.byCategory.size} categories.`,
    '>',
    `> Each category shows its ${perCategory} most recently released entries: a freshness signal, not a quality ranking.`,
    `> The complete machine-readable set is the upstream index itself — \`npm run sync\` also mirrors it to \`data/catalog.json\` for scripting.`,
    '',
  ]

  for (const key of order) {
    const list = catalog.byCategory.get(key)
    if (!list?.length) continue
    const shown = list.slice(0, perCategory)
    lines.push('<details>', `<summary><b>${categoryTitle(index, key)}</b> — ${list.length.toLocaleString('en-US')} plugins</summary>`, '')
    lines.push('| Plugin | Version | Released | What it does |', '| --- | --- | --- | --- |')
    for (const row of shown) {
      const label = row.homepage ? `[\`${row.name}\`](${row.homepage})` : `\`${row.name}\``
      lines.push(`| ${label} | ${row.version} | ${row.published} | ${cell(row.description, 150)} |`)
    }
    lines.push('')
    if (list.length > shown.length) {
      lines.push(`_${(list.length - shown.length).toLocaleString('en-US')} more in the upstream index._`, '')
    }
    lines.push('</details>', '')
  }
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------ verification */

/** Repo coordinates for an npm registry URL, tolerating git+ prefixes and monorepo paths. */
function parseGitHub(url) {
  const match = /github\.com[/:]([^/]+)\/([^/#?]+)/.exec(url ?? '')
  if (!match) return null
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') }
}

/** The package.json that actually ships inside the tarball. */
async function fetchManifest(name, version) {
  try {
    const manifest = await getJson(`https://cdn.jsdelivr.net/npm/${name}@${version}/package.json`)
    const scripts = manifest.scripts ?? {}
    return {
      version: manifest.version ?? null,
      license: manifest.license ?? null,
      repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? null,
      declaresBundle: Boolean(manifest.dsh?.bundle),
      installScripts: INSTALL_HOOKS.filter(hook => scripts[hook]),
      error: null,
    }
  } catch (error) {
    return {
      version: null, license: null, repository: null, declaresBundle: null,
      installScripts: [], error: error.message,
    }
  }
}

async function fetchRepoHealth(target) {
  if (!TOKEN) return { stars: null, pushedAt: null, archived: null, error: 'no-token' }
  try {
    const repo = await getJson(`https://api.github.com/repos/${target.owner}/${target.repo}`, {
      accept: 'application/vnd.github+json', authorization: `Bearer ${TOKEN}`,
    })
    return {
      stars: repo.stargazers_count ?? null,
      pushedAt: repo.pushed_at ? repo.pushed_at.slice(0, 10) : null,
      archived: repo.archived === true,
      error: null,
    }
  } catch (error) {
    return { stars: null, pushedAt: null, archived: null, error: error.message }
  }
}

/* --------------------------------------------------------------- starter */

/** One compact health string for the README table. */
function healthCell(row) {
  const bits = []
  const license = row.manifest?.license
  if (license) bits.push(license === 'MIT' ? 'MIT' : license)
  else if (row.manifest?.error) bits.push('licence unknown')

  if (row.repo?.stars != null) {
    bits.push(`★ ${row.repo.stars}`)
    if (row.repo.pushedAt) bits.push(`pushed ${row.repo.pushedAt}`)
  } else if (row.repo?.error === 'no-token') {
    bits.push('repo unchecked')
  } else if (row.repo?.error) {
    bits.push(`repo ${cell(row.repo.error, 30)}`)
  }
  if (row.repo?.archived) bits.push('**archived**')
  return bits.join(' · ') || '—'
}

function renderStarterTable(verified) {
  const lines = [
    '| Plugin | What it does | Pinned | DSH engines | Health |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of verified.plugins) {
    const name = row.entry.repository ? `[\`${row.name}\`](${row.entry.repository})` : `\`${row.name}\``
    const pinned = row.installTarget ? `\`${row.installTarget}\`` : '—'
    const engines = row.engines && row.engines !== 'any' ? `\`${row.engines}\`` : 'any'
    lines.push(`| ${name} | ${cell(row.entry.why, 120)} | ${pinned} | ${engines} | ${healthCell(row)} |`)
  }

  const conflicts = verified.plugins.filter(row => row.entry.conflictWith)
  if (conflicts.length) {
    lines.push('', '**Install one of each pair, not both:**')
    const seen = new Set()
    for (const row of conflicts) {
      const pair = [row.name, row.entry.conflictWith].sort()
      const key = pair.join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`- \`${pair[0]}\` ↔ \`${pair[1]}\``)
    }
  }

  const flagged = verified.plugins.filter(row => row.manifest?.installScripts?.length)
  if (flagged.length) {
    lines.push('', '**These run install scripts when installed** — read them before you install:')
    for (const row of flagged) lines.push(`- \`${row.name}\`: ${row.manifest.installScripts.join(', ')}`)
  }

  const unlicensed = verified.plugins.filter(row => !row.manifest?.license && !row.manifest?.error)
  if (unlicensed.length) {
    lines.push('', '**No licence declared in the published package:** ' + unlicensed.map(row => `\`${row.name}\``).join(', '))
  }
  return lines.join('\n')
}

async function buildStarter(index) {
  const byName = new Map((index.plugins ?? []).map(entry => [entry.name, entry]))

  const resolved = source.plugins.map(entry => {
    const found = byName.get(entry.name)
    const version = found ? latestVersion(found) : undefined
    return { entry, found, version }
  })

  const manifests = await pooled(resolved, CONCURRENCY, async ({ entry, version }) =>
    version ? fetchManifest(entry.name, version.version) : null)
  log(`  read ${manifests.filter(Boolean).length} published manifests`)

  const targets = new Map()
  for (const [position, row] of resolved.entries()) {
    const target = parseGitHub(row.found?.repository?.url ?? manifests[position]?.repository)
    if (target) targets.set(`${target.owner}/${target.repo}`, target)
  }
  const health = new Map()
  const healthResults = await pooled([...targets.entries()], CONCURRENCY, async ([key, target]) =>
    [key, await fetchRepoHealth(target)])
  for (const [key, value] of healthResults) health.set(key, value)
  if (TOKEN) log(`  checked ${health.size} repositories on GitHub`)

  const plugins = []
  for (const [position, { entry, found, version }] of resolved.entries()) {
    const manifest = manifests[position]
    const target = parseGitHub(found?.repository?.url ?? manifest?.repository)
    const repo = target ? health.get(`${target.owner}/${target.repo}`) ?? null : null
    const status = !found ? 'missing' : repo?.archived ? 'archived' : 'ok'
    plugins.push({
      name: entry.name,
      category: entry.category,
      status,
      engines: version?.engines?.dsh ?? 'any',
      published: version ? isoDay(version.publishTimestamp) : null,
      installTarget: version ? `${entry.name}@${version.version}` : null,
      entry: {
        why: entry.why,
        conflictWith: entry.conflictWith ?? null,
        repository: found?.repository?.url ?? manifest?.repository ?? null,
        directory: found?.repository?.directory ?? null,
        homepage: found?.homepage ?? null,
        description: found ? cell(localised(found.description), 300) : null,
      },
      manifest,
      repo,
    })
  }
  return { generatedAt: new Date().toISOString(), githubChecked: Boolean(TOKEN), plugins }
}

/* ------------------------------------------------------------------ write */

/** Write verified data unless only the run timestamp moved, so a no-op sync leaves a clean tree. */
function writeVerified(verified) {
  const path = join(DATA, 'verified.json')
  if (existsSync(path)) {
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8'))
      const withoutTimestamp = ({ generatedAt: _ignored, ...rest }) => rest
      if (JSON.stringify(withoutTimestamp(previous)) === JSON.stringify(withoutTimestamp(verified))) {
        return false
      }
    } catch {
      /* unreadable previous file: fall through and rewrite it */
    }
  }
  return writeIfChanged(path, verified)
}

function updateReadme(table) {
  const path = join(ROOT, 'README.md')
  if (!existsSync(path)) return false
  const begin = '<!-- BEGIN STARTER (generated by scripts/sync.mjs) -->'
  const end = '<!-- END STARTER -->'
  const text = readFileSync(path, 'utf8')
  const start = text.indexOf(begin)
  const stop = text.indexOf(end)
  if (start < 0 || stop < 0) throw new Error('README.md is missing the starter markers')
  return writeIfChanged(path, `${text.slice(0, start + begin.length)}\n${table}\n${text.slice(stop)}`)
}

/* ------------------------------------------------------------------- main */

const { index, stale } = await loadIndex()
log(`index: ${index.plugins?.length ?? 0} plugins${stale ? ' (snapshot)' : ''}`)
log(`github: ${TOKEN ? 'authenticated' : 'no token — stars and last push skipped'}`)

const catalog = buildCatalog(index)
log(`catalog: ${catalog.rows.length} installable across ${catalog.byCategory.size} categories`)

const changed = []
if (writeIfChanged(join(DATA, 'catalog.json'), jsonLines(catalog.rows))) changed.push('data/catalog.json')
const generatedAt = new Date().toISOString().slice(0, 10)
if (writeIfChanged(join(ROOT, 'CATALOG.md'), renderCatalog(index, catalog, generatedAt))) changed.push('CATALOG.md')

const verified = await buildStarter(index)
if (writeVerified(verified)) changed.push('data/verified.json')
if (updateReadme(renderStarterTable(verified))) changed.push('README.md')

const problems = verified.plugins.filter(row => row.status !== 'ok')
for (const row of problems) log(`! ${row.name}: ${row.status}`)
for (const row of verified.plugins) {
  if (row.manifest?.error) log(`… ${row.name}: manifest ${row.manifest.error}`)
  if (row.manifest?.installScripts?.length) log(`… ${row.name}: install scripts ${row.manifest.installScripts.join(', ')}`)
  if (!row.manifest?.license && !row.manifest?.error) log(`… ${row.name}: no licence in published package`)
}
log(changed.length ? `wrote: ${changed.join(', ')}` : 'everything up to date')
process.exit(problems.length ? 1 : 0)
