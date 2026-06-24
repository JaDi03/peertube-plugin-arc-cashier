import * as crypto from 'crypto'
import { RegisterServerOptions } from '@peertube/peertube-types'

const TIMEOUT_MS = 30000
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

interface TesseraPluginData {
  'tessera-mode'?: string
  'tessera-rate'?: string
  'tessera-wallet'?: string
}

function extractTesseraPluginData (pluginData: unknown): TesseraPluginData {
  if (!pluginData) return {}
  let pData = pluginData
  if (typeof pData === 'string') {
    try { pData = JSON.parse(pData) } catch { return {} }
  }
  if (typeof pData !== 'object' || pData === null) return {}
  const record = pData as Record<string, TesseraPluginData>
  return record['peertube-plugin-tessera'] || record
}

function validateTesseraWallet (pluginData: unknown): string | null {
  const data = extractTesseraPluginData(pluginData)
  const mode = data['tessera-mode'] || 'pay-per-second'
  if (mode === 'tips') return null

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
  const { registerSetting, settingsManager, getRouter, peertubeHelpers, registerHook } = options

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
    name: 'base-rate-per-second',
    label: 'Base Rate Per Second',
    type: 'input',
    descriptionHTML: 'Default Tessera payment rate per second for videos without explicit pricing (e.g. 0.0001)',
    default: '0.0001',
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
      const video = await peertubeHelpers.videos.loadByIdOrUUID(videoId) as any
      if (!video) return res.status(404).json({ error: 'Video not found' })
      let wallet = null
      if (video.pluginData) {
         const myData = extractTesseraPluginData(video.pluginData)
         wallet = myData['tessera-wallet'] || null
      }
      res.json({ wallet })
    } catch (err) {
      peertubeHelpers.logger.warn(`[tessera] Error fetching video data for ${videoId}: ${err}`)
      res.status(500).json({ error: 'Internal server error' })
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
        if (video.pluginData) {
          const myData = extractTesseraPluginData(video.pluginData)
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

    const globalRate = (await settingsManager.getSetting('base-rate-per-second')) as string || '0.0001'
    const ratePerSecond = tesseraRate || globalRate

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
      res.json({ success: true, tesseraMode, ratePerSecond })
    }
  })
}

export async function unregister () {
  // Cleanup logic if needed
}
