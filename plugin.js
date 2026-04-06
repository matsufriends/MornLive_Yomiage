const fs = require('fs')
const path = require('path')
const https = require('https')

// 教育コマンド: 教育（a=b）  前後に文字があったり、内部に()（）=＝を含む場合は無視
const KYOUIKU_PATTERN = /^教育[（(]([^()（）=＝]+)[=＝]([^()（）=＝]+)[）)]$/
// 忘却コマンド: 忘却（a）  同上
const BOUKYAKU_PATTERN = /^忘却[（(]([^()（）=＝]+)[）)]$/
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
  version: '4.0.0',
  author: 'matsufriends',
  permissions: ['filter.comment', 'reactions'],
  url: 'https://github.com/matsufriends/MornLive_Yomiage',
  defaultState: {
    dictionary: {},
  },

  store: null,
  githubToken: '',

  // --- リアクションエフェクト用 ---
  _reactionQueue: [],
  _emojiRegex: /\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu,
  _customEmojiRegex: /data-src="([^"]+)"/g,

  init({ dir, store }) {
    this.store = store
    this.dir = dir
    this._reactionQueue = []

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

    console.info('[yomiage-dictionary] Overlay: file://' + path.join(dir, 'overlay.html'))
  },

  destroy() {},

  subscribe(type, ...args) {
    if (type === 'reactions') {
      this._reactionQueue.push({ timestamp: Date.now(), data: args })
    }
  },

  filterComment(comment) {
    // HTMLタグを除去（imgはalt属性の値に変換）してからパターンマッチ
    const text = comment.data.comment
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1')
      .replace(/<[^>]+>/g, '')
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
        const isUpdate = from in dict
        dict[from] = to
        this.store.set('dictionary', dict)

        // バッチキューに追加（数秒後にまとめてPR作成）
        this._enqueue({ type: 'add', from, to })

        // 読み上げテキストのみ書き換え（表示はそのまま）
        const speechText = isUpdate
          ? from + ' は ' + to + ' に上書きしました！'
          : from + ' は ' + to + ' を覚えました！'
        comment.data.speechText = speechText
        console.info('[yomiage-dictionary] Registered:', from, '->', to)
        return comment
      }
    }

    // 忘却コマンド
    const boukyakuMatch = text.match(BOUKYAKU_PATTERN)
    if (boukyakuMatch) {
      const key = boukyakuMatch[1].trim()
      if (key) {
        this._processedIds = this._processedIds || new Set()
        if (this._processedIds.has(comment.data.id)) {
          return comment
        }
        this._processedIds.add(comment.data.id)

        const dict = this.store.get('dictionary') || {}
        if (key in dict) {
          delete dict[key]
          this.store.set('dictionary', dict)

          // バッチキューに追加
          this._enqueue({ type: 'delete', key })

          comment.data.speechText = key + ' を忘れました！'
          console.info('[yomiage-dictionary] Deleted:', key)
        } else {
          comment.data.speechText = key + ' は覚えていません！'
        }
        return comment
      }
    }

    // 辞書による置換（speechTextに直接適用）
    if (comment.data.speechText) {
      const dict = this.store.get('dictionary') || {}
      const keys = Object.keys(dict).sort((a, b) => b.length - a.length)
      let speech = comment.data.speechText
      for (const from of keys) {
        const regex = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
        speech = speech.replace(regex, dict[from])
      }
      comment.data.speechText = speech
    }

    // --- リアクションエフェクト: 絵文字検出 ---
    this._detectEmojis(comment)

    return comment
  },

  _detectEmojis(comment) {
    const rawText = comment.data.comment
    const speechText = comment.data.speechText || ''
    const reactions = []

    // Unicode 絵文字（生コメント + 辞書変換後の両方から検出）
    const allText = rawText + ' ' + speechText
    const unicodeEmojis = allText.match(this._emojiRegex)
    if (unicodeEmojis) {
      for (const e of unicodeEmojis) {
        reactions.push({ key: e, value: 1 })
      }
    }

    // カスタム絵文字（<img data-src="...">）
    this._customEmojiRegex.lastIndex = 0
    let match
    while ((match = this._customEmojiRegex.exec(rawText)) !== null) {
      reactions.push({ key: 'img:' + match[1], value: 1 })
    }

    if (reactions.length > 0) {
      this._reactionQueue.push({
        timestamp: Date.now(),
        data: [{ reactions, effect: true }],
      })
    }
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
      case 'POST': {
        // リアクションキューを返してクリア
        const reactions = this._reactionQueue.splice(0)
        return { code: 200, response: { reactions } }
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

  // バッチキューに変更を追加し、5秒後にまとめてPR作成
  _enqueue(change) {
    this._batchQueue = this._batchQueue || []
    this._batchQueue.push(change)

    if (this._batchTimer) clearTimeout(this._batchTimer)
    this._batchTimer = setTimeout(() => {
      const queue = this._batchQueue
      this._batchQueue = []
      this._batchTimer = null
      this._flushBatch(queue).catch((e) => {
        console.info('[yomiage-dictionary] Batch PR failed:', e.message)
      })
    }, 5000)
  },

  // バッチキューの変更をまとめて1つのPRにする
  async _flushBatch(queue) {
    const token = this.githubToken
    if (!token) {
      console.info('[yomiage-dictionary] GitHub token not set, skipping PR')
      return
    }
    if (queue.length === 0) return

    const timestamp = Date.now()
    const branchName = `yomiage/${timestamp}/batch`

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
    let arr = JSON.parse(currentContent)

    // 4. キューの変更を全て適用
    const descriptions = []
    for (const change of queue) {
      if (change.type === 'add') {
        const existingIndex = arr.findIndex(([key]) => key === change.from)
        if (existingIndex >= 0) {
          arr[existingIndex] = [change.from, change.to]
        } else {
          arr.push([change.from, change.to])
        }
        descriptions.push(`教育: ${change.from} = ${change.to}`)
      } else if (change.type === 'delete') {
        arr = arr.filter(([k]) => k !== change.key)
        descriptions.push(`忘却: ${change.key}`)
      }
    }

    const newContent = JSON.stringify(arr, null, 4) + '\n'
    const encodedContent = Buffer.from(newContent).toString('base64')

    // 5. ファイル更新
    const commitMsg = descriptions.join(', ')
    const updateRes = await githubApi('PUT', `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`, token, {
      message: commitMsg,
      content: encodedContent,
      sha: fileRes.data.sha,
      branch: branchName,
    })
    if (updateRes.status !== 200) throw new Error('Failed to update file: ' + JSON.stringify(updateRes.data))

    // 6. PR作成
    const title = queue.length === 1 ? descriptions[0] : `辞書更新 (${queue.length}件)`
    const body = descriptions.map((d) => `- ${d}`).join('\n')
    const prRes = await githubApi('POST', `/repos/${REPO_OWNER}/${REPO_NAME}/pulls`, token, {
      title,
      body: `チャットから辞書更新:\n${body}`,
      head: branchName,
      base: BASE_BRANCH,
    })
    if (prRes.status !== 201) throw new Error('Failed to create PR: ' + JSON.stringify(prRes.data))

    console.info('[yomiage-dictionary] Batch PR created:', prRes.data.html_url, `(${queue.length} changes)`)
  },
}

module.exports = plugin
