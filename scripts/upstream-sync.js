import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONFIG_PATH = '.github/upstream-sync.json'
const UPSTREAM_REF = 'refs/upstream/sync'

const REASON_OUTSIDE_ALLOW_LIST = '不在允許自動更新的規則內'
const REASON_LOCALLY_MODIFIED = '本倉庫自分歧點起也改過此檔案,為避免覆蓋自定變更而跳過'
const REVIEW_HINT =
  '請在本地執行 `git pull` 後跑 `update.bat`，再以 `git show` 比對上游改動了你哪些自定檔案。'

const STATUS_LABELS = {
  A: '新增',
  M: '修改',
  D: '刪除',
  R: '重新命名',
  C: '複製',
}

const gitArgs = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
const gitArgsQuiet = { ...gitArgs, stdio: ['ignore', 'pipe', 'ignore'] }

function git(args) {
  return execFileSync('git', args, gitArgs)
}

function tryGit(args) {
  try {
    return execFileSync('git', args, gitArgsQuiet)
  } catch {
    return null
  }
}

function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      const globstar = pattern[index + 1] === '*'
      source += globstar ? '.*' : '[^/]*'
      index += globstar ? 1 : 0
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  if (typeof config.upstream_repo !== 'string' || !config.upstream_repo) {
    throw new Error(`${CONFIG_PATH} 缺少 upstream_repo`)
  }
  if (typeof config.upstream_ref !== 'string' || !config.upstream_ref) {
    throw new Error(`${CONFIG_PATH} 缺少 upstream_ref`)
  }
  if (!Array.isArray(config.allow)) {
    throw new Error(`${CONFIG_PATH} 缺少 allow 陣列`)
  }
  return {
    upstreamRepo: config.upstream_repo,
    upstreamRef: config.upstream_ref,
    upstreamUrl: config.upstream_remote ?? `https://github.com/${config.upstream_repo}.git`,
    matchers: config.allow.map(globToRegExp),
  }
}

function withPathspec(paths, run) {
  const file = join(mkdtempSync(join(tmpdir(), 'upstream-sync-')), 'pathspec')
  writeFileSync(file, paths.map(path => `${path}\0`).join(''), 'utf8')
  try {
    run([`--pathspec-from-file=${file}`, '--pathspec-file-nul'])
  } finally {
    rmSync(file, { force: true })
  }
}

async function fetchJson(path) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return response.ok ? response.json() : null
}

async function compareWithUpstream(config, owner) {
  if (!owner || !config.upstreamUrl.startsWith('https://github.com/')) return {}
  const localBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const basehead = `${config.upstreamRef}...${owner}:${localBranch}`
  const compare = await fetchJson(
    `/repos/${config.upstreamRepo}/compare/${basehead}`,
  )
  if (!compare) {
    console.log('跨倉庫 compare 不可用,改用本地 git merge-base 計算。')
    return {}
  }
  return { baseSha: compare.merge_base_commit?.sha, compareUrl: compare.html_url }
}

function fetchUpstream(config) {
  git([
    'fetch',
    '--no-tags',
    '--prune',
    config.upstreamUrl,
    `+refs/heads/${config.upstreamRef}:${UPSTREAM_REF}`,
  ])
}

function commitExists(sha) {
  return tryGit(['cat-file', '-e', `${sha}^{commit}`]) !== null
}

function resolveBaseSha(comparedBase) {
  if (comparedBase && commitExists(comparedBase)) return comparedBase
  return git(['merge-base', 'HEAD', UPSTREAM_REF]).trim()
}

function countCommits(range) {
  return Number(git(['rev-list', '--count', range]).trim())
}

function parseNameStatus(raw) {
  const tokens = raw.split('\0')
  const changes = []
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++]
    if (!status) continue
    const code = status[0]
    const isPair = code === 'R' || code === 'C'
    const previous = isPair ? tokens[index++] : null
    changes.push({ status: code, previous, path: tokens[index++] })
  }
  return changes
}

function readUpstreamChanges(baseSha) {
  const args = ['diff', '--name-status', '-z', '--find-renames', `${baseSha}..${UPSTREAM_REF}`]
  return parseNameStatus(git(args))
}

function readLocalChanges(baseSha) {
  const args = ['diff', '--name-only', '-z', `${baseSha}..HEAD`]
  return new Set(git(args).split('\0').filter(Boolean))
}

function classifyChanges(changes, localChanges, matchers) {
  const applied = []
  const pendingReview = []
  for (const change of changes) {
    if (!matchers.some(matcher => matcher.test(change.path))) {
      pendingReview.push({ ...change, reason: REASON_OUTSIDE_ALLOW_LIST })
    } else if (localChanges.has(change.path)) {
      pendingReview.push({ ...change, reason: REASON_LOCALLY_MODIFIED })
    } else {
      applied.push(change)
    }
  }
  return { applied, pendingReview }
}

function applyChanges(applied) {
  const pathsOf = keep => applied.filter(change => keep(change.status)).map(change => change.path)
  const overwritten = pathsOf(status => status !== 'D')
  const deleted = pathsOf(status => status === 'D')
  if (overwritten.length) {
    withPathspec(overwritten, options => git(['checkout', UPSTREAM_REF, ...options, '--']))
  }
  if (deleted.length) {
    withPathspec(deleted, options =>
      git(['rm', '-q', '-f', '--ignore-unmatch', ...options, '--']),
    )
  }
}

function hasStagedChanges() {
  return git(['diff', '--cached', '--name-only']).trim().length > 0
}

function mergeUpstreamHistory() {
  git(['merge', '-s', 'ours', '--no-commit', '--no-ff', UPSTREAM_REF])
}

function abortUpstreamMerge() {
  git(['merge', '--abort'])
}

function resetInProgressMerge() {
  if (tryGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']) !== null) {
    abortUpstreamMerge()
  }
}

function describeChange(change) {
  const label = STATUS_LABELS[change.status] ?? change.status
  const from = change.previous ? ` ← ${change.previous}` : ''
  return `[${label}] ${change.path}${from}`
}

function logSummary(context) {
  const { config, baseSha, behindBy, aheadBy, compareUrl, applied, pendingReview } = context
  const lines = [
    `上游：${config.upstreamRepo} @ ${config.upstreamRef}`,
    `分歧點：${baseSha}`,
    `落後 ${behindBy} 個 commit ／ 領先 ${aheadBy} 個 commit`,
  ]
  if (compareUrl) lines.push(`比較頁：${compareUrl}`)

  if (behindBy === 0) {
    lines.push('上游沒有新 commit,無需同步。')
    return lines
  }

  lines.push(`已自動更新 ${applied.length} 個檔案。`)
  if (!pendingReview.length) {
    lines.push('沒有需要人工審查的檔案。')
    return lines
  }

  lines.push(
    '',
    `以下 ${pendingReview.length} 個檔案不會自動更新,需自行從上游取得並替換:`,
    ...pendingReview.map(change => `  ${describeChange(change)} — ${change.reason}`),
    '',
    REVIEW_HINT,
  )
  return lines
}

function publish(lines, outputs) {
  for (const line of lines) console.log(line)
  if (!process.env.GITHUB_OUTPUT) return
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  writeFileSync(process.env.GITHUB_OUTPUT, `${body}\n`, { flag: 'a' })
}

async function main() {
  resetInProgressMerge()
  const config = loadConfig()
  const [owner = ''] = (process.env.GITHUB_REPOSITORY ?? '').split('/')

  const { baseSha: comparedBase, compareUrl } = await compareWithUpstream(config, owner)
  fetchUpstream(config)
  const baseSha = resolveBaseSha(comparedBase)
  const behindBy = countCommits(`${baseSha}..${UPSTREAM_REF}`)
  const aheadBy = countCommits(`${baseSha}..HEAD`)
  const summary = extra =>
    logSummary({ config, baseSha, behindBy, aheadBy, compareUrl, ...extra })

  if (behindBy === 0) {
    publish(summary({ applied: [], pendingReview: [] }), {
      'has-changes': 'false',
      'needs-review': 'false',
    })
    return
  }

  const classified = classifyChanges(
    readUpstreamChanges(baseSha),
    readLocalChanges(baseSha),
    config.matchers,
  )

  mergeUpstreamHistory()
  applyChanges(classified.applied)

  publish(summary(classified), {
    'has-changes': String(hasStagedChanges()),
    'needs-review': String(classified.pendingReview.length > 0),
    'history-updated': 'true',
  })
}

await main()
