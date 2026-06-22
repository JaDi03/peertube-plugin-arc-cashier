import * as crypto from 'crypto'
import { RegisterServerOptions } from '@peertube/peertube-types'

const TIMEOUT_MS = 30000

interface ViewerSession {
  expireTime: number
  lastAccessTime: number
  payload: any
}

const activeViewers = new Map<string, ViewerSession>()

export async function register (options: RegisterServerOptions) {
  const { registerSetting, settingsManager, getRouter, peertubeHelpers } = options

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
      if (now > session.expireTime) {
        // 3.4: Fix ghost sessions (await viewer_left before deletion)
        // Add a small buffer to expireTime to avoid spamming retries every 5s if sidecar is down.
        // We temporarily bump the expireTime to avoid multiple concurrent requests.
        session.expireTime = now + 15000 
        
        sendWebhook('viewer_left', session.payload).then(success => {
           if (success) {
             activeViewers.delete(userId)
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

  // Ping route handler
  router.post('/ping', async (req: any, res: any) => {
    // 5.3 Runtime type validation
    if (!req.body || typeof req.body !== 'object') {
       return res.status(400).json({ error: 'Invalid request body' })
    }
    const { action, videoId, videoUrl } = req.body

    if (typeof videoId !== 'string' || !videoId) {
       return res.status(400).json({ error: 'Missing or invalid videoId' })
    }
    if (typeof videoUrl !== 'string') {
       return res.status(400).json({ error: 'Missing or invalid videoUrl' })
    }
    if (action !== 'start' && action !== 'stop' && action !== 'ping') {
       return res.status(400).json({ error: 'Invalid action' })
    }

    let authUser: any = null
    try {
      authUser = await peertubeHelpers.user.getAuthUser(res)
    } catch {
      // Ignored
    }

    if (!authUser) {
      return res.status(401).json({ error: 'Authentication required for Tessera payments' })
    }

    // 5.1: Rate limit check (1 req per 5s)
    const rateLimitKey = authUser.id.toString()
    const lastPing = pingRateLimits.get(rateLimitKey)
    if (lastPing && Date.now() - lastPing < 5000) {
       return res.status(429).json({ error: 'Too many requests' })
    }
    pingRateLimits.set(rateLimitKey, Date.now())

    const webhookSecret = (await settingsManager.getSetting('webhook-secret')) as string
    if (!webhookSecret) {
      peertubeHelpers.logger.error('[tessera] webhook-secret not configured. Refusing to generate userId.')
      return res.status(503).json({ error: 'Plugin not configured' })
    }
    const userId = crypto.createHmac('sha256', webhookSecret).update(`pt_user_${authUser.id}`).digest('hex').substring(0, 16)
    const instanceUrl = peertubeHelpers.config.getWebserverUrl()

    let channelId = ''
    let channelName = ''
    let views = 0
    let likes = 0
    let duration = 0
    let accountName = ''
    let tesseraMode = 'pay-per-second'
    let tesseraRate = ''

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
          let pData = video.pluginData;
          if (typeof pData === 'string') {
              try { pData = JSON.parse(pData) } catch { /* ignore parse error */ }
          }
          if (pData) {
              const myData = pData['peertube-plugin-tessera'] || pData;
              if (myData['tessera-mode']) tesseraMode = myData['tessera-mode']
              if (myData['tessera-rate']) tesseraRate = myData['tessera-rate']
          }
        }
      }
    } catch {
      peertubeHelpers.logger.warn(`[tessera] Could not load video metadata for ${videoId}`)
    }

    const globalRate = (await settingsManager.getSetting('base-rate-per-second')) as string || '0.0001'
    const ratePerSecond = tesseraRate || globalRate

    const payloadData = {
      userId,
      userDisplayName: authUser.username,
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
      instanceUrl,
      timestamp: new Date().toISOString()
    }

    if (action === 'start' || action === 'ping') {
      if (!activeViewers.has(userId)) {
        // 3.2: Prevent race condition by awaiting webhook before adding to map
        const success = await sendWebhook('viewer_joined', payloadData)
        if (!success) {
           return res.status(502).json({ error: 'Failed to notify payment sidecar' })
        }

        // 3.1: Enforce Cache Limit via LRU
        const maxSize = await getMaxActiveViewers()
        if (activeViewers.size >= maxSize) {
          const entries = [...activeViewers.entries()]
          entries.sort((a, b) => a[1].lastAccessTime - b[1].lastAccessTime)
          const lruKey = entries[0][0]
          
          if (lruKey) {
             const sessionToEvict = activeViewers.get(lruKey)
             activeViewers.delete(lruKey)
             // Best-effort cleanup webhook
             if (sessionToEvict) {
                sendWebhook('viewer_left', sessionToEvict.payload).catch(() => {})
             }
          }
        }
      }

      // Update expiration time
      activeViewers.set(userId, {
        expireTime: Date.now() + TIMEOUT_MS,
        lastAccessTime: Date.now(),
        payload: payloadData
      })

    } else if (action === 'stop') {
      if (activeViewers.has(userId)) {
        // 3.4: Await webhook before local deletion
        const success = await sendWebhook('viewer_left', payloadData)
        if (success) {
           activeViewers.delete(userId)
        } else {
           return res.status(502).json({ error: 'Failed to stop session' })
        }
      }
    }

    res.json({ success: true, tesseraMode, ratePerSecond })
  })
}

export async function unregister () {
  // Cleanup logic if needed
}
