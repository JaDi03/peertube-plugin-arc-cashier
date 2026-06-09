import * as crypto from 'crypto'

const TIMEOUT_MS = 30000
const activeViewers = new Map<string, number>()

export async function register (options: any) {
  const { registerSetting, settingsManager, getRouter, peertubeHelpers } = options

  // Global checker for inactive viewers
  setInterval(() => {
    const now = Date.now()
    for (const [userId, expireTime] of activeViewers.entries()) {
      if (now > expireTime) {
        activeViewers.delete(userId)
        sendWebhook('viewer_left', userId).catch(console.error)
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

  // In-memory map to detect when a viewer drops off without sending 'stop'

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

  // Endpoint for the client script to retrieve the base URL
  router.get('/base-url', async (req: any, res: any) => {
    let baseUrl = await getBaseUrl()
    if (!baseUrl) {
      return res.status(404).json({ error: 'Plugin not fully configured' })
    }
    // Fix for Docker environments where backend uses host.docker.internal but frontend needs localhost
    if (baseUrl.includes('host.docker.internal')) {
      baseUrl = baseUrl.replace('host.docker.internal', 'localhost')
    }
    res.json({ baseUrl })
  })

  // Helper to send the signed webhook
  const sendWebhook = async (event: 'viewer_joined' | 'viewer_left', userId: string) => {
    const webhookUrl = await settingsManager.getSetting('webhook-url') as string
    const webhookSecret = await settingsManager.getSetting('webhook-secret') as string

    if (!webhookUrl || !webhookSecret) {
      peertubeHelpers.logger.warn('[arc-cashier] Webhook not sent: Plugin configuration missing.')
      return
    }

    const payload = JSON.stringify({ event, userId })
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
      peertubeHelpers.logger.info(`[arc-cashier] Webhook '${event}' sent for user ${userId}.`)
    } catch (err) {
      peertubeHelpers.logger.error(`[arc-cashier] Error sending webhook: ${err}`)
    }
  }

  // Ping route handler
  router.post('/ping', async (req: any, res: any) => {
    const { action, userId } = req.body as { action: 'start' | 'stop' | 'ping', userId: string }

    if (!userId) {
       res.status(400).json({ error: 'Missing userId' })
       return
    }

    if (action === 'start' || action === 'ping') {
      if (!activeViewers.has(userId)) {
        await sendWebhook('viewer_joined', userId)
      }

      // Update expiration time
      activeViewers.set(userId, Date.now() + TIMEOUT_MS)

    } else if (action === 'stop') {
      if (activeViewers.has(userId)) {
        activeViewers.delete(userId)
        await sendWebhook('viewer_left', userId)
      }
    }

    res.json({ success: true })
  })
}

export async function unregister () {
  // Cleanup logic if needed
}
