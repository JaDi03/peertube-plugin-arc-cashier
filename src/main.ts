import * as crypto from 'crypto'

const TIMEOUT_MS = 30000

interface ViewerSession {
  expireTime: number
  payload: any
}

const activeViewers = new Map<string, ViewerSession>()

export async function register (options: any) {
  const { registerSetting, settingsManager, getRouter, peertubeHelpers } = options

  // Helper to get base URL from webhook URL
  const getBaseUrl = async (): Promise<string | null> => {
    const webhookUrl = await settingsManager.getSetting('webhook-url') as string
    if (!webhookUrl) return null
    try {
      return new URL(webhookUrl).origin
    } catch {
      return null
    }
  }

  // Helper to send the signed webhook
  const sendWebhook = async (event: 'viewer_joined' | 'viewer_left', payloadData: any) => {
    const webhookUrl = await settingsManager.getSetting('webhook-url') as string
    const webhookSecret = await settingsManager.getSetting('webhook-secret') as string

    if (!webhookUrl || !webhookSecret) {
      peertubeHelpers.logger.warn('[arc-cashier] Webhook not sent: Plugin configuration missing.')
      return
    }

    const payload = JSON.stringify({ event, ...payloadData })
    const signature = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex')

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PeerTube-Signature': signature
        },
        body: payload
      })
      peertubeHelpers.logger.info(`[arc-cashier] Webhook '${event}' sent for user ${payloadData.userId}.`)
    } catch (err) {
      peertubeHelpers.logger.error(`[arc-cashier] Error sending webhook: ${err}`)
    }
  }

  // Global checker for inactive viewers
  setInterval(() => {
    const now = Date.now()
    for (const [userId, session] of activeViewers.entries()) {
      if (now > session.expireTime) {
        activeViewers.delete(userId)
        sendWebhook('viewer_left', session.payload).catch(console.error)
      }
    }
  }, 5000)

  // 1. Register settings for Arc-Cashier integration
  await registerSetting({
    name: 'webhook-url',
    label: 'Arc-Cashier Webhook URL',
    type: 'input',
    descriptionHTML: 'The URL to send events (e.g. https://your-arc-cashier.com/api/connectors/peertube/webhook)',
    default: '',
    private: true
  })

  await registerSetting({
    name: 'webhook-secret',
    label: 'Arc-Cashier Webhook Secret',
    type: 'input',
    descriptionHTML: 'The secret used to sign HMAC SHA-256 requests',
    default: '',
    private: true
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
    const { action, videoId, videoUrl } = req.body as { action: 'start' | 'stop' | 'ping', videoId: string, videoUrl: string }

    if (!videoId) {
       return res.status(400).json({ error: 'Missing videoId' })
    }

    let authUser: any = null
    try {
      authUser = await peertubeHelpers.user.getAuthUser(res)
    } catch (err) {
      peertubeHelpers.logger.error(`[arc-cashier] Error getting auth user: ${err}`)
    }

    if (!authUser) {
      return res.status(401).json({ error: 'Authentication required for Arc-Cashier payments' })
    }

    const webhookSecret = (await settingsManager.getSetting('webhook-secret')) as string || 'default_salt'
    const userId = crypto.createHmac('sha256', webhookSecret).update(`pt_user_${authUser.id}`).digest('hex').substring(0, 16)
    const instanceUrl = peertubeHelpers.config.getWebserverUrl()

    let channelId = ''
    let channelName = ''
    try {
      // In PeerTube v6+, video object includes the channel if loaded via loadByIdOrUUID
      const video = await peertubeHelpers.videos.loadByIdOrUUID(videoId)
      if (video && (video as any).VideoChannel) {
        channelId = (video as any).VideoChannel.name || (video as any).VideoChannel.id.toString()
        channelName = (video as any).VideoChannel.displayName || channelId
      }
    } catch {
      peertubeHelpers.logger.warn(`[arc-cashier] Could not load video metadata for ${videoId}`)
    }

    const payloadData = {
      userId,
      userDisplayName: authUser.username,
      videoId,
      videoUrl,
      channelId,
      channelName,
      instanceUrl,
      timestamp: new Date().toISOString()
    }

    if (action === 'start' || action === 'ping') {
      if (!activeViewers.has(userId)) {
        await sendWebhook('viewer_joined', payloadData)
      }

      // Update expiration time
      activeViewers.set(userId, {
        expireTime: Date.now() + TIMEOUT_MS,
        payload: payloadData
      })

    } else if (action === 'stop') {
      if (activeViewers.has(userId)) {
        activeViewers.delete(userId)
        await sendWebhook('viewer_left', payloadData)
      }
    }

    res.json({ success: true })
  })
}

export async function unregister () {
  // Cleanup logic if needed
}
