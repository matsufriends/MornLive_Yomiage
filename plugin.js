const fs = require('fs')
const path = require('path')
const https = require('https')

// 教育コマンドの正規表現: 教育（a=b） or 教育(a=b)  ※=は半角/全角両対応
const KYOUIKU_PATTERN = /^教育[（(](.+?)[=＝](.+?)[）)]$/
const CONFIG_FILE = 'config.json'

const REPO_OWNER = 'matsufriends'
const REPO_NAME = 'MornLive_Yomiage'
const FILE_PATH = 'yomiage.json'
const BASE_BRANCH = 'main'

function githubApi(method, endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'yomiage-dictionary-plugin',
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }
    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) })
        } catch {
          resolve({ status: res.statusCode, data: body })
        }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const plugin = {
  name: '読み上げ辞書プラグイン',
  uid: 'com.matsufriends.yomiage-dictionary',
  version: '2.4.0',
  author: 'matsufriends',
  permissions: ['filter.comment'],
  url: 'https://github.com/matsufriends/MornLive_Yomiage',
  defaultState: {
    dictionary: {},
  },

  store: null,
  githubToken: '',

  init({ dir, store }) {
    this.store = store
    this.dir = dir

    // config.json からトークンを読み込み
    try {
      const configPath = path.join(dir, CONFIG_FILE)
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      this.githubToken = config.githubToken || ''
      console.info('[yomiage-dictionary] Token loaded from config.json')
    } catch (e) {
      console.info('[yomiage-dictionary] config.json not found. Create it with: {"githubToken": "github_pat_xxx"}')
    }

    // 起動時にGitHubからyomiage.jsonを取得して辞書を同期
    this._syncFromGitHub()
  },

  destroy() {},

  filterComment(comment) {
    const text = comment.data.comment
    const match = text.match(KYOUIKU_PATTERN)

    if (match) {
      const from = match[1].trim()
      const to = match[2].trim()
      if (from && to) {
        // 同じコメントIDの重複処理を防止
        this._processedIds = this._processedIds || new Set()
        if (this._processedIds.has(comment.data.id)) {
          return comment
        }
        this._processedIds.add(comment.data.id)

        // 辞書に登録（即時反映）
        const dict = this.store.get('dictionary') || {}
        dict[from] = to
        this.store.set('dictionary', dict)

        // GitHub PR を非同期で作成
        this._createPR(from, to).catch((e) => {
          console.info('[yomiage-dictionary] PR creation failed:', e.message)
        })

        // 表示・読み上げテキストを書き換え
        const newText = from + ' は ' + to + ' を覚えました！'
        comment.data.comment = newText
        comment.data.speechText = newText
        console.info('[yomiage-dictionary] Registered:', from, '->', to)
        return comment
      }
    }

    // 辞書による置換（元テキストに適用してspeechTextを再構成）
    const dict = this.store.get('dictionary') || {}
    const keys = Object.keys(dict).sort((a, b) => b.length - a.length)
    let replaced = text
    for (const from of keys) {
      replaced = replaced.split(from).join(dict[from])
    }
    if (replaced !== text) {
      const nickname = comment.data.nickname || comment.data.displayName || ''
      comment.data.speechText = nickname ? nickname + ' ' + replaced : replaced
    }

    return comment
  },

  async request(req) {
    switch (req.method) {
      case 'GET':
        return {
          code: 200,
          response: {
            dictionary: this.store.get('dictionary') || {},
            githubToken: this.githubToken ? '(set)' : '(not set)',
          },
        }
      case 'PUT': {
        const data = JSON.parse(req.body)
        if (data.dictionary !== undefined) {
          this.store.set('dictionary', data.dictionary)
        }
        return { code: 200, response: { ok: true } }
      }
      case 'DELETE': {
        const data = JSON.parse(req.body)
        if (data.key) {
          const dict = this.store.get('dictionary') || {}
          delete dict[data.key]
          this.store.set('dictionary', dict)
        }
        return { code: 200, response: { ok: true } }
      }
    }
    return { code: 404, response: {} }
  },

  // GitHubからyomiage.jsonを取得してstoreにマージ
  async _syncFromGitHub() {
    const token = this.githubToken
    if (!token) return

    try {
      const res = await githubApi('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BASE_BRANCH}`, token)
      if (res.status !== 200) return

      const content = Buffer.from(res.data.content, 'base64').toString('utf-8')
      const arr = JSON.parse(content)
      const dict = this.store.get('dictionary') || {}
      for (const [from, to] of arr) {
        dict[from] = to
      }
      this.store.set('dictionary', dict)
      console.info('[yomiage-dictionary] Synced', Object.keys(dict).length, 'entries from GitHub')
    } catch (e) {
      console.info('[yomiage-dictionary] GitHub sync failed:', e.message)
    }
  },

  // 辞書エントリ追加のPRを作成
  async _createPR(from, to) {
    const token = this.githubToken
    if (!token) {
      console.info('[yomiage-dictionary] GitHub token not set, skipping PR')
      return
    }

    const timestamp = Date.now()
    const branchName = `yomiage/${timestamp}/${from}`

    // 1. main の最新SHAを取得
    const refRes = await githubApi('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`, token)
    if (refRes.status !== 200) throw new Error('Failed to get base ref: ' + JSON.stringify(refRes.data))
    const baseSha = refRes.data.object.sha

    // 2. ブランチ作成
    const branchRes = await githubApi('POST', `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, token, {
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    })
    if (branchRes.status !== 201) throw new Error('Failed to create branch: ' + JSON.stringify(branchRes.data))

    // 3. 現在のyomiage.jsonを取得
    const fileRes = await githubApi('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${BASE_BRANCH}`, token)
    if (fileRes.status !== 200) throw new Error('Failed to get file: ' + JSON.stringify(fileRes.data))

    const currentContent = Buffer.from(fileRes.data.content, 'base64').toString('utf-8')
    const arr = JSON.parse(currentContent)

    // 既に同じキーがあれば値を更新、なければ追加
    const existingIndex = arr.findIndex(([key]) => key === from)
    if (existingIndex >= 0) {
      arr[existingIndex] = [from, to]
    } else {
      arr.push([from, to])
    }

    const newContent = JSON.stringify(arr, null, 4) + '\n'
    const encodedContent = Buffer.from(newContent).toString('base64')

    // 4. ファイル更新
    const updateRes = await githubApi('PUT', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, token, {
      message: `add: ${from} = ${to}`,
      content: encodedContent,
      sha: fileRes.data.sha,
      branch: branchName,
    })
    if (updateRes.status !== 200) throw new Error('Failed to update file: ' + JSON.stringify(updateRes.data))

    // 5. PR作成
    const prRes = await githubApi('POST', `/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, token, {
      title: `教育: ${from} = ${to}`,
      body: `チャットから辞書登録:\n- **変換前**: ${from}\n- **変換後**: ${to}`,
      head: branchName,
      base: BASE_BRANCH,
    })
    if (prRes.status !== 201) throw new Error('Failed to create PR: ' + JSON.stringify(prRes.data))

    console.info('[yomiage-dictionary] PR created:', prRes.data.html_url)
  },
}

module.exports = plugin
