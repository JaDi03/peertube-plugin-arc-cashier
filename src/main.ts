import * as crypto from 'crypto'
import { RegisterServerOptions } from '@peertube/peertube-types'

const TIMEOUT_MS = 30000
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

interface TesseraPluginData {
  'tessera-mode'?: string
  'tessera-rate'?: string
  'tessera-wallet'?: string
  'tessera-tip-amount'?: string
}

function extractTesseraPluginData (pluginData: unknown): TesseraPluginData {
  if (!pluginData) return {}
  let pData: unknown = pluginData
  if (typeof pData === 'string') {
    try { pData = JSON.parse(pData) } catch { return {} }
  }
  if (typeof pData !== 'object' || pData === null) return {}

  const record = pData as Record<string, unknown>
  if (typeof record['tessera-wallet'] === 'string' || typeof record['tessera-mode'] === 'string') {
    return record as TesseraPluginData
  }

  for (const ns of ['peertube-plugin-tessera', 'tessera']) {
    const nested = record[ns]
    if (nested && typeof nested === 'object') {
      return nested as TesseraPluginData
    }
  }

  return record as TesseraPluginData
}

function storageKey (field: keyof TesseraPluginData, videoId: number): string {
  return `${field}-${videoId}`
}

async function persistTesseraVideoData (
  storageManager: { storeData: (key: string, data: unknown) => Promise<unknown> },
  videoId: number,
  data: TesseraPluginData
): Promise<void> {
  if (data['tessera-wallet'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-wallet', videoId), data['tessera-wallet'].trim())
  }
  if (data['tessera-mode'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-mode', videoId), data['tessera-mode'])
  }
  if (data['tessera-rate'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-rate', videoId), data['tessera-rate'])
  }
  if (data['tessera-tip-amount'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-tip-amount', videoId), data['tessera-tip-amount'])
  }
}

async function loadTesseraVideoData (
  storageManager: { getData: <T = unknown>(key: string) => Promise<T | undefined> },
  videoId: number,
  pluginData?: unknown
): Promise<TesseraPluginData> {
  const fromRequest = extractTesseraPluginData(pluginData)
  const [wallet, mode, rate, tipAmount] = await Promise.all([
    storageManager.getData<string>(storageKey('tessera-wallet', videoId)),
    storageManager.getData<string>(storageKey('tessera-mode', videoId)),
    storageManager.getData<string>(storageKey('tessera-rate', videoId)),
    storageManager.getData<string>(storageKey('tessera-tip-amount', videoId)),
  ])

  return {
    'tessera-wallet': fromRequest['tessera-wallet'] || wallet,
    'tessera-mode': fromRequest['tessera-mode'] || mode,
    'tessera-rate': fromRequest['tessera-rate'] || rate,
    'tessera-tip-amount': fromRequest['tessera-tip-amount'] || tipAmount,
  }
}

function validateTesseraWallet (pluginData: unknown): string | null {
  const data = extractTesseraPluginData(pluginData)
  const mode = data['tessera-mode'] || 'pay-per-second'
  // Free mode (with optional tips) does not require a wallet or rate
  if (mode === 'free') return null

  const wallet = (data['tessera-wallet'] || '').trim()
  if (!wallet) {
    return 'Creator wallet address is required for pay-per-second monetization.'
  }
  if (!EVM_ADDRESS_RE.test(wallet)) {
    return 'Creator wallet must be a valid Arc Network address (0x…).'
  }
  return null
}

interface ViewerSession {
  expireTime: number
  lastAccessTime: number
  payload: any
  pendingAction?: 'stop' | null
}

const activeViewers = new Map<string, ViewerSession>()
const actionQueues = new Map<string, Promise<any>>()

const enqueueAction = async (userId: string, action: () => Promise<any>): Promise<any> => {
    const currentQueue = actionQueues.get(userId) || Promise.resolve()
    const newQueue = currentQueue.then(action, action)
    actionQueues.set(userId, newQueue)
    
    newQueue.finally(() => {
        if (actionQueues.get(userId) === newQueue) actionQueues.delete(userId)
    })
    
    return newQueue
}

export async function register (options: RegisterServerOptions) {
  const { registerSetting, settingsManager, getRouter, peertubeHelpers, registerHook, storageManager } = options

  // 5.2: Cache base URL to prevent abuse
  let cachedBaseUrl: string | null = null
  let baseUrlCacheTime = 0

  const getBaseUrl = async (): Promise<string | null> => {
    if (cachedBaseUrl && Date.now() - baseUrlCacheTime < 60000) {
       return cachedBaseUrl
    }
    const webhookUrl = await settingsManager.getSetting('webhook-url') as string
    if (!webhookUrl) return null
    try {
      cachedBaseUrl = new URL(webhookUrl).origin
      baseUrlCacheTime = Date.now()
      return cachedBaseUrl
    } catch {
      return null
    }
  }

  // 5.1: Rate limiting Map
  const pingRateLimits = new Map<string, number>()

  // 3.1: Helper to get MAX_CACHE_SIZE
  const getMaxActiveViewers = async (): Promise<number> => {
    const max = await settingsManager.getSetting('max-active-viewers') as string
    return parseInt(max, 10) || 10000
  }

  // Helper to send the signed webhook
  // 3.3: Return boolean to indicate success
  const sendWebhook = async (event: 'viewer_joined' | 'viewer_left', payloadData: any, maxRetries = 3): Promise<boolean> => {
    const webhookUrl = await settingsManager.getSetting('webhook-url') as string
    const webhookSecret = await settingsManager.getSetting('webhook-secret') as string

    if (!webhookUrl || !webhookSecret) {
      peertubeHelpers.logger.warn('[tessera] Webhook not sent: Plugin configuration missing.')
      return false
    }

    const timestamp = Date.now()
    const nonce = crypto.randomBytes(16).toString('hex')
    const payload = JSON.stringify({ event, timestamp, nonce, ...payloadData })
    const signature = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex')

    for (let i = 0; i < maxRetries; i++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-PeerTube-Signature': signature
          },
          body: payload,
          signal: controller.signal
        })
        clearTimeout(timeout)
        
        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Rejected: ${response.status} ${errorText}`)
        }

        peertubeHelpers.logger.info(`[tessera] Webhook '${event}' sent for user ${payloadData.userId}.`)
        return true
      } catch (err) {
        if (i === maxRetries - 1) {
          peertubeHelpers.logger.error(`[tessera] Error sending webhook after ${maxRetries} attempts: ${err}`)
          return false
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
    return false
  }

  // Global checker for inactive viewers
  setInterval(() => {
    const now = Date.now()
    for (const [userId, session] of activeViewers.entries()) {
      if (now > session.expireTime && session.pendingAction !== 'stop') {
        // 3.4: Fix ghost sessions (await viewer_left before deletion)
        // Add a small buffer to expireTime to avoid spamming retries every 5s if sidecar is down.
        // We temporarily bump the expireTime to avoid multiple concurrent requests.
        session.pendingAction = 'stop'
        session.expireTime = now + 15000 
        
        sendWebhook('viewer_left', session.payload).then(success => {
           if (success) {
             activeViewers.delete(userId)
           } else {
             session.pendingAction = null
           }
        })
      }
    }

    // Clean up rate limits
    for (const [userId, lastPing] of pingRateLimits.entries()) {
      if (now - lastPing > 60000) {
        pingRateLimits.delete(userId)
      }
    }
  }, 5000)

  // 1. Register settings for Tessera integration
  await registerSetting({
    name: 'tessera-base-url',
    label: 'Tessera Base URL',
    type: 'input',
    descriptionHTML: 'The public URL of your Tessera backend (e.g. https://tessera.try-tessera.xyz)',
    default: '',
    private: false
  })

  await registerSetting({
    name: 'webhook-url',
    label: 'Tessera Webhook URL',
    type: 'input',
    descriptionHTML: 'The URL to send events (e.g. https://your-tessera.com/api/connectors/peertube/webhook)',
    default: '',
    private: true
  })

  await registerSetting({
    name: 'webhook-secret',
    label: 'Tessera Webhook Secret',
    type: 'input',
    descriptionHTML: 'The secret used to sign HMAC SHA-256 requests',
    default: '',
    private: true
  })

  await registerSetting({
    name: 'max-active-viewers',
    label: 'Max Active Viewers',
    type: 'input',
    descriptionHTML: 'Maximum number of concurrent active viewers allowed in memory to prevent exhaustion.',
    default: '10000',
    private: false
  })

  await registerSetting({
    name: 'admin-wallet-address',
    label: 'Admin Wallet (Arc Network)',
    type: 'input',
    descriptionHTML: 'Platform admin wallet address for receiving commission. Private key goes in Tessera .env.',
    default: '',
    private: false
  })


  const rejectUploadIfWalletInvalid = (result: any, params?: any) => {
    // Some hooks might pass req inside params
    const req = params?.req
    const pluginData = req?.body?.pluginData || req?.body?.pluginDataString
    
    const error = validateTesseraWallet(pluginData)
    if (error) {
      peertubeHelpers.logger.warn(`[tessera] Upload rejected: ${error}`)
      return {
        allowed: false,
        errorMessage: error
      }
    }
    return result || { allowed: true }
  }

  registerHook({
    target: 'filter:api.video.upload.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.pre-import-url.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.pre-import-torrent.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.post-import-url.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.post-import-torrent.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  const syncTesseraVideoData = async (video: { id?: number }, req?: { body?: { pluginData?: unknown; pluginDataString?: unknown } }) => {
    if (!video?.id) return
    const pluginData = req?.body?.pluginData || req?.body?.pluginDataString
    const data = extractTesseraPluginData(pluginData)
    if (data['tessera-wallet'] !== undefined || data['tessera-mode'] !== undefined || data['tessera-rate'] !== undefined || data['tessera-tip-amount'] !== undefined) {
      await persistTesseraVideoData(storageManager, video.id, data)
    }
  }

  registerHook({
    target: 'action:api.video.uploaded',
    handler: (({ video, req }: { video?: { id?: number }; req?: { body?: { pluginData?: unknown } } }) => {
      return syncTesseraVideoData(video || {}, req)
    }) as () => unknown
  })

  registerHook({
    target: 'action:api.video.updated',
    handler: (({ video, req }: { video?: { id?: number }; req?: { body?: { pluginData?: unknown } } }) => {
      return syncTesseraVideoData(video || {}, req)
    }) as () => unknown
  })

  registerHook({
    target: 'filter:api.video.get.result',
    handler: (async (video: { id?: number; pluginData?: Record<string, unknown> }) => {
      if (!video?.id) return video

      const fromApi = extractTesseraPluginData(video.pluginData)
      if (fromApi['tessera-wallet'] || fromApi['tessera-mode'] || fromApi['tessera-rate'] || fromApi['tessera-tip-amount']) {
        await persistTesseraVideoData(storageManager, video.id, fromApi)
      }

      const stored = await loadTesseraVideoData(storageManager, video.id, video.pluginData)
      if (stored['tessera-wallet'] || stored['tessera-mode'] || stored['tessera-rate'] || stored['tessera-tip-amount']) {
        if (!video.pluginData) video.pluginData = {}
        if (stored['tessera-wallet']) video.pluginData['tessera-wallet'] = stored['tessera-wallet']
        if (stored['tessera-mode']) video.pluginData['tessera-mode'] = stored['tessera-mode']
        if (stored['tessera-rate']) video.pluginData['tessera-rate'] = stored['tessera-rate']
        if (stored['tessera-tip-amount']) video.pluginData['tessera-tip-amount'] = stored['tessera-tip-amount']
      }

      return video
    }) as () => unknown
  })

  // 2. Set up internal router
  const router = getRouter()

  // Endpoint for the client script to retrieve the base URL
  router.get('/base-url', async (req: any, res: any) => {
    let baseUrl = await getBaseUrl()
    if (!baseUrl) {
      return res.status(404).json({ error: 'Plugin not fully configured' })
    }
    if (baseUrl.includes('host.docker.internal')) {
      baseUrl = baseUrl.replace('host.docker.internal', 'localhost')
    }
    res.json({ baseUrl })
  })

  // Endpoint to serve pluginData to the client (since frontend doesn't receive it in the watch hook)
  router.get('/video/:id/tessera-data', async (req: any, res: any) => {
    const videoId = req.params.id
    try {
      const video = await peertubeHelpers.videos.loadByIdOrUUID(videoId) as { id?: number; pluginData?: unknown }
      if (!video?.id) return res.status(404).json({ error: 'Video not found' })

      const data = await loadTesseraVideoData(storageManager, video.id, video.pluginData)
      res.json({
        wallet: data['tessera-wallet'] || null,
        mode: data['tessera-mode'] || null,
        rate: data['tessera-rate'] || null,
        tipAmount: data['tessera-tip-amount'] || null,
      })
    } catch (err) {
      peertubeHelpers.logger.warn(`[tessera] Error fetching video data for ${videoId}: ${err}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Endpoint for the frontend to fetch the configured admin wallet (for the admin panel)
  router.get('/admin/wallet', async (req: any, res: any) => {
    const wallet = await settingsManager.getSetting('admin-wallet-address') as string;
    res.json({ wallet: wallet || null });
  })

  // Proxy endpoint to fetch the platform admin's balance from the sidecar
  router.get('/admin/balance', async (req: any, res: any) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || user.role !== 0) {
        return res.status(401).json({ error: 'Unauthorized: Admin only' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const secret = await settingsManager.getSetting('webhook-secret') as string
      const response = await fetch(`${baseUrl}/api/connectors/peertube/seller/balance`, {
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Proxy endpoint to trigger platform admin withdrawal on the sidecar
  router.post('/admin/withdraw', async (req: any, res: any) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || user.role !== 0) {
        return res.status(401).json({ error: 'Unauthorized: Admin only' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const secret = await settingsManager.getSetting('webhook-secret') as string
      const response = await fetch(`${baseUrl}/api/connectors/peertube/seller/withdraw`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Ping route handler
  router.post('/ping', async (req: any, res: any) => {
    // 5.3 Runtime type validation
    if (!req.body || typeof req.body !== 'object') {
       return res.status(400).json({ error: 'Invalid request body' })
    }
    const { action, videoId, videoUrl, sessionId } = req.body

    if (typeof videoId !== 'string' || !videoId) {
       return res.status(400).json({ error: 'Missing or invalid videoId' })
    }
    if (typeof videoUrl !== 'string') {
       return res.status(400).json({ error: 'Missing or invalid videoUrl' })
    }
    if (action !== 'start' && action !== 'stop' && action !== 'ping') {
       return res.status(400).json({ error: 'Invalid action' })
    }
    // sessionId is set by paywall.js in the browser's localStorage (arc_cashier_user_id)
    if (typeof sessionId !== 'string' || !sessionId || !sessionId.startsWith('arc_')) {
       return res.status(400).json({ error: 'Missing or invalid sessionId' })
    }

    // No PeerTube authentication required. Identity is provided by the paywall's sessionId.

    let channelId = ''
    let channelName = ''
    let views = 0
    let likes = 0
    let duration = 0
    let accountName = ''
    let tesseraMode = 'pay-per-second'
    let tesseraRate = ''
    let tesseraWallet = ''

    try {
      const video = await peertubeHelpers.videos.loadByIdOrUUID(videoId) as any
      if (video) {
        if (video.VideoChannel) {
          channelId = video.VideoChannel.name || video.VideoChannel.id.toString()
          channelName = video.VideoChannel.displayName || channelId
        }
        views = video.views || 0
        likes = video.likes || 0
        duration = video.duration || 0
        if (video.Account) {
          accountName = video.Account.name || video.Account.displayName || ''
        }
        if (video.id) {
          const myData = await loadTesseraVideoData(storageManager, video.id, video.pluginData)
          if (myData['tessera-mode']) tesseraMode = myData['tessera-mode']
          if (myData['tessera-rate']) tesseraRate = myData['tessera-rate']
          if (myData['tessera-wallet']) tesseraWallet = myData['tessera-wallet']
        }
      }
    } catch {
      peertubeHelpers.logger.warn(`[tessera] Could not load video metadata for ${videoId}`)
    }



    // 5.1: Rate limit check (1 req per 2s per session)
    if (action !== 'stop') {
        const lastPing = pingRateLimits.get(sessionId)
        if (lastPing && Date.now() - lastPing < 2000) {
           return res.status(429).json({ error: 'Too many requests' })
        }
        pingRateLimits.set(sessionId, Date.now())
    }

    const webhookSecret = (await settingsManager.getSetting('webhook-secret')) as string
    if (!webhookSecret) {
      peertubeHelpers.logger.error('[tessera] webhook-secret not configured. Refusing to process ping.')
      return res.status(503).json({ error: 'Plugin not configured' })
    }
    // Use the paywall's sessionId directly — must match what paywall.js sends to /register-session
    const userId = sessionId
    const instanceUrl = peertubeHelpers.config.getWebserverUrl()

    // Video metadata loading was moved above auth check

    const ratePerSecond = tesseraRate || '0.001'

    const payloadData = {
      userId,
      videoId,
      videoUrl,
      channelId,
      channelName,
      accountName,
      views,
      likes,
      duration,
      tesseraMode,
      ratePerSecond,
      creatorAddress: tesseraWallet || undefined,
      creatorWallet: tesseraWallet || undefined,
      instanceUrl,
      timestamp: new Date().toISOString()
    }

    await enqueueAction(userId, async () => {
      if (action === 'start' || action === 'ping') {
        if (!activeViewers.has(userId)) {
          // SYNCHRONOUSLY add to activeViewers to prevent race conditions with 'stop'
          activeViewers.set(userId, {
            expireTime: Date.now() + TIMEOUT_MS,
            lastAccessTime: Date.now(),
            payload: payloadData
          })

          // Enforce Cache Limit via LRU
          const maxSize = await getMaxActiveViewers()
          if (activeViewers.size > maxSize) {
            const entries = [...activeViewers.entries()]
            entries.sort((a, b) => a[1].lastAccessTime - b[1].lastAccessTime)
            const lruKey = entries[0][0]
            
            if (lruKey) {
               const sessionToEvict = activeViewers.get(lruKey)
               activeViewers.delete(lruKey)
               if (sessionToEvict) {
                  sendWebhook('viewer_left', sessionToEvict.payload).catch(() => {})
               }
            }
          }

          const success = await sendWebhook('viewer_joined', payloadData)
          if (!success) {
             activeViewers.delete(userId)
             res.status(502).json({ error: 'Failed to notify payment sidecar' })
             return
          }
        } else {
          // Update expiration time
          const session = activeViewers.get(userId)
          if (session) {
            session.expireTime = Date.now() + TIMEOUT_MS
            session.lastAccessTime = Date.now()
            session.payload = payloadData
          }
        }

      } else if (action === 'stop') {
        const session = activeViewers.get(userId)
        if (session) {
          session.pendingAction = 'stop'
          // Send webhook BEFORE deleting to avoid ghost sessions
          const success = await sendWebhook('viewer_left', payloadData)
          const currentSession = activeViewers.get(userId)
          if (currentSession) {
             currentSession.pendingAction = null
             if (success) {
                activeViewers.delete(userId)
             } else {
                res.status(502).json({ error: 'Failed to stop session webhook' })
                return
             }
          }
        }
      }
    })

    if (!res.headersSent) {
      // If the video is free, tell the client to stop pinging and show the tip button
      if (tesseraMode === 'free') {
        const tesseraTipAmount = (await loadTesseraVideoData(storageManager, videoId as any, undefined))['tessera-tip-amount'] || '0.10'
        res.json({ success: true, tesseraMode, free: true, tipAmount: tesseraTipAmount, creatorWallet: tesseraWallet || null })
      } else {
        res.json({ success: true, tesseraMode, ratePerSecond })
      }
    }
  })
}

export async function unregister () {
  // Cleanup logic if needed
}
