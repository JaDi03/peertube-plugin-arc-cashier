import { RegisterClientOptions } from '@peertube/peertube-types/client'

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const ARC_CHAIN_ID = '0x4cef52'

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] | unknown }) => Promise<unknown>
    }
  }
}

function extractTesseraPluginData (pluginData: unknown): Record<string, string> {
  if (!pluginData) return {}
  let pData: unknown = pluginData
  if (typeof pData === 'string') {
    try { pData = JSON.parse(pData) } catch { return {} }
  }
  if (typeof pData !== 'object' || pData === null) return {}

  const record = pData as Record<string, unknown>
  if (typeof record['tessera-wallet'] === 'string') {
    return record as Record<string, string>
  }

  for (const ns of ['peertube-plugin-tessera', 'tessera']) {
    const nested = record[ns]
    if (nested && typeof nested === 'object') {
      return nested as Record<string, string>
    }
  }

  return record as Record<string, string>
}

function readWalletFromVideo (video: { pluginData?: unknown } | null | undefined): string | null {
  const wallet = extractTesseraPluginData(video?.pluginData)['tessera-wallet']?.trim()
  return wallet || null
}



export async function register (options: RegisterClientOptions) {
  const { peertubeHelpers, registerHook, registerVideoField } = options

  const getPluginField = (formValues: any, fieldName: string) => {
    if (!formValues) return undefined
    if (formValues[fieldName] !== undefined) return formValues[fieldName]
    const pData = formValues.pluginData
    if (!pData) return undefined
    const ours = pData['peertube-plugin-tessera']
    if (ours && ours[fieldName] !== undefined) return ours[fieldName]
    return undefined
  }

  const validateWalletField = async ({ formValues, value }: { formValues?: any, value?: string }) => {
    const mode = getPluginField(formValues, 'tessera-mode') || 'pay-per-second'
    if (mode === 'tips') return { error: false }

    const wallet = (value || getPluginField(formValues, 'tessera-wallet') || '').trim()
    if (!wallet) {
      return { error: true, text: 'Creator wallet is required for pay-per-second mode.' }
    }
    if (!EVM_ADDRESS_RE.test(wallet)) {
      return { error: true, text: 'Enter a valid Arc Network address (0x + 40 hex chars).' }
    }
    return { error: false }
  }

  // 1. Register custom fields in video upload/edit form IMMEDIATELY (synchronously)
  // This must happen before any await to avoid race conditions with PeerTube's form rendering
  if (typeof registerVideoField === 'function') {
      const modeField = {
        name: 'tessera-mode',
        label: 'Tessera Monetization Mode',
        descriptionHTML: 'Choose how viewers pay for this video.',
        type: 'select' as const,
        options: [
            { value: 'pay-per-second', label: '⚡ Pay-per-second' },
            { value: 'tips', label: '💝 Tips (free to watch) - SOON' },
        ],
        default: 'pay-per-second'
      }
      registerVideoField(modeField, { type: 'upload' })
      registerVideoField(modeField, { type: 'update' })

      const rateField = {
        name: 'tessera-rate',
        label: 'Rate per second (USDC)',
        type: 'input' as const,
        default: '0.0001',
        descriptionHTML: 'Only applies to pay-per-second mode.'
      }
      registerVideoField(rateField, { type: 'upload' })
      registerVideoField(rateField, { type: 'update' })

      const walletField = {
        name: 'tessera-wallet',
        label: 'Creator Wallet Address (Arc Network)',
        type: 'input' as const,
        descriptionHTML: 'Your public wallet address. You will receive USDC earnings on the Arc Network and withdraw via MetaMask.',
        error: validateWalletField
      }
      registerVideoField(walletField, { type: 'upload' })
      registerVideoField(walletField, { type: 'update' })
  }

  // 2. Fetch Tessera Base URL from plugin router
  let baseUrl: string
  try {
    const pluginRoute = peertubeHelpers.getBaseRouterRoute()
    const response = await fetch(`${pluginRoute}/base-url`)
    const data = await response.json()
    if (data.baseUrl) {
      baseUrl = data.baseUrl
    } else {
      console.warn('[tessera] Missing base URL configuration.')
      return
    }
  } catch (err) {
    console.error('[tessera] Failed to fetch base URL:', err)
    return
  }

  // Inject SPA styles to prevent paywall from blocking the dashboard
  const style = document.createElement('style')
  style.innerHTML = `
    body.arc-hide-paywall {
       overflow: auto !important;
    }
    body.arc-hide-paywall #arc-paywall-overlay,
    body.arc-hide-paywall #arc-session-manager {
       display: none !important;
    }
    body.arc-locked.arc-hide-paywall > * {
       filter: none !important;
       pointer-events: auto !important;
       user-select: auto !important;
    }
    /* Hide paywall overlay visually while owner is being resolved.
       paywall.bundle.js still loads and tracks state but cannot
       flicker the modal or stall HLS buffering during this window. */
    body.arc-resolving-owner #arc-paywall-overlay,
    body.arc-resolving-owner #arc-session-manager {
       opacity: 0 !important;
       pointer-events: none !important;
       transition: opacity 0.15s ease !important;
    }
  `
  document.head.appendChild(style)

  let currentVideoId: string | null = null
  let currentVideoOwner: string | null = null
  let currentCreatorWallet: string | null = null
  let creatorPanelEl: HTMLElement | null = null
  let pendingOwnerCheck = false
  let lastPathname = window.location.pathname
  // True after a new video loads — tells the first ping response to call
  // arcResetVideoSession (resets per-video counter) instead of arcSetRate (rate-only)
  let videoJustChanged = false

  const isVideoOwner = (): boolean => {
    if (!peertubeHelpers.isLoggedIn()) return false
    const user = peertubeHelpers.getUser()
    if (!user?.username || !currentVideoOwner) return false
    return user.username.toLowerCase() === currentVideoOwner.toLowerCase()
  }

  const checkPageVisibility = () => {
      const isWatchPage = window.location.pathname.includes('/watch') || window.location.pathname.includes('/w/')
      const hideWhileResolvingOwner = isWatchPage
        && peertubeHelpers.isLoggedIn()
        && (pendingOwnerCheck || currentVideoOwner === null)

      if (!isWatchPage || isVideoOwner() || hideWhileResolvingOwner) {
         document.body.classList.add('arc-hide-paywall')
         document.body.classList.remove('arc-locked')
      } else {
         document.body.classList.remove('arc-hide-paywall')
      }

  }

  const prefetchVideoOwner = async () => {
    const isWatchPage = window.location.pathname.includes('/watch') || window.location.pathname.includes('/w/')
    if (!isWatchPage || !peertubeHelpers.isLoggedIn()) return

    const match = window.location.pathname.match(/\/(?:watch|w)\/([^/?#]+)/)
    if (!match?.[1]) return

    pendingOwnerCheck = true
    checkPageVisibility()

    try {
      const res = await fetch(`/api/v1/videos/${encodeURIComponent(match[1])}`)
      if (res.ok) {
        const data = await res.json()
        currentVideoOwner = data.account?.name || data.channel?.ownerAccount?.name || null
        currentVideoId = data.uuid || data.id?.toString() || match[1]
      }
    } catch {
      // ignore prefetch errors; hook will resolve owner later
    } finally {
      pendingOwnerCheck = false
      document.body.classList.remove('arc-resolving-owner')
      checkPageVisibility()
      renderCreatorPanel()
    }
  }
  // Hide overlay immediately before any network call resolves owner.
  // Removed in prefetchVideoOwner() once we know if user is owner or not.
  document.body.classList.add('arc-resolving-owner')
  checkPageVisibility()
  void prefetchVideoOwner()

  window.addEventListener('popstate', () => {
    void prefetchVideoOwner()
  })

  // Prevent paywall.js from forcefully pausing the video for the owner
  const observer = new MutationObserver(() => {
    if (isVideoOwner() && document.body.classList.contains('arc-locked')) {
      document.body.classList.remove('arc-locked')
    }
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })

  // 3. Inject Tessera paywall assets dynamically
  const cssLink = document.createElement('link')
  cssLink.rel = 'stylesheet'
  cssLink.href = `${baseUrl}/peertube-assets/paywall.css`
  document.head.appendChild(cssLink)

  const script = document.createElement('script')
  // Cache-bust so browsers pick up rebuilt paywall.bundle.js from Tessera backend
  script.src = `${baseUrl}/peertube-assets/paywall.bundle.js?v=1.1.1-media-sync`
  let pendingMediaPlaying: boolean | null = null
  script.onload = () => {
    if (pendingMediaPlaying !== null) {
      setMediaPlaying(pendingMediaPlaying)
      pendingMediaPlaying = null
    }
  }
  document.head.appendChild(script)



  const ensureArcNetwork = async (): Promise<void> => {
    if (!window.ethereum) throw new Error('MetaMask not detected')
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: ARC_CHAIN_ID }]
      })
    } catch (err: any) {
      if (err?.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: ARC_CHAIN_ID,
            chainName: 'Arc Testnet',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            rpcUrls: ['https://rpc.testnet.arc.network']
          }]
        })
      } else {
        throw err
      }
    }
  }

  const connectCreatorWallet = async (expectedWallet: string): Promise<string> => {
    if (!window.ethereum) throw new Error('Install MetaMask to withdraw earnings.')
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[]
    const connected = accounts[0]
    if (!connected) throw new Error('No MetaMask account selected.')
    if (connected.toLowerCase() !== expectedWallet.toLowerCase()) {
      throw new Error(`Connect the wallet configured for this video (${expectedWallet}).`)
    }
    await ensureArcNetwork()
    return connected
  }

  const updateCreatorPanelBalance = async (wallet: string) => {
    if (!creatorPanelEl) return
    const balanceEl = creatorPanelEl.querySelector('[data-tessera-balance]') as HTMLElement | null
    if (balanceEl) balanceEl.textContent = 'Loading…'
    try {
      const res = await fetch(`${baseUrl}/api/core/creator/balance?address=${encodeURIComponent(wallet)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Balance fetch failed')
      if (balanceEl) {
        const withdrawable = Number(data.gatewayWithdrawable ?? data.gatewayAvailable ?? 0)
        balanceEl.textContent = `$${withdrawable.toFixed(4)} USDC`
      }
    } catch (err: any) {
      if (balanceEl) balanceEl.textContent = err?.message || 'Error'
    }
  }

  const withdrawCreatorEarnings = async (wallet: string) => {
    const connectedWallet = await connectCreatorWallet(wallet)

    const prepareRes = await fetch(`${baseUrl}/api/core/creator/prepare-withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: connectedWallet })
    })
    const prepareData = await prepareRes.json()
    if (!prepareRes.ok) throw new Error(prepareData.error || 'Could not prepare withdrawal')
    if (prepareData.status === 'no_funds') {
      peertubeHelpers.notifier.info('No withdrawable balance in Gateway yet.')
      return
    }

    const signature = await window.ethereum!.request({
      method: 'eth_signTypedData_v4',
      params: [connectedWallet, JSON.stringify(prepareData.typedData)]
    }) as string

    const completeRes = await fetch(`${baseUrl}/api/core/creator/complete-withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: connectedWallet,
        burnIntent: prepareData.burnIntent,
        signature
      })
    })
    const completeData = await completeRes.json()
    if (!completeRes.ok) throw new Error(completeData.error || 'Withdraw attestation failed')

    completeData.txRequest.from = connectedWallet
    const txHash = await window.ethereum!.request({
      method: 'eth_sendTransaction',
      params: [completeData.txRequest]
    }) as string

    peertubeHelpers.notifier.success(`Withdrawal submitted! Tx: ${txHash.slice(0, 10)}…`)
    await updateCreatorPanelBalance(wallet)
  }

  const renderCreatorPanel = () => {
    const isWatchPage = window.location.pathname.includes('/watch') || window.location.pathname.includes('/w/')
    const wallet = currentCreatorWallet?.trim()
    const isOwner = isVideoOwner()

    if (!isWatchPage || !wallet || !isOwner) {
      if (creatorPanelEl) {
        creatorPanelEl.remove()
        creatorPanelEl = null
      }
      return
    }

    if (creatorPanelEl) {
      const walletEl = creatorPanelEl.querySelector('.tessera-wallet')
      if (walletEl && walletEl.textContent !== wallet) {
        creatorPanelEl.remove()
        creatorPanelEl = null
      } else {
        return
      }
    }

    creatorPanelEl = document.createElement('div')
    creatorPanelEl.id = 'tessera-creator-panel'
    creatorPanelEl.innerHTML = `
      <style>
        #tessera-creator-panel {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 10050;
          background: rgba(17, 24, 39, 0.95);
          color: #f7fafc;
          border: 1px solid rgba(99, 179, 237, 0.35);
          border-radius: 12px;
          padding: 14px 16px;
          min-width: 240px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.35);
          font-family: system-ui, -apple-system, sans-serif;
        }
        #tessera-creator-panel h4 {
          margin: 0 0 8px;
          font-size: 13px;
          font-weight: 600;
          color: #90cdf4;
        }
        #tessera-creator-panel .tessera-wallet {
          font-size: 10px;
          color: #a0aec0;
          word-break: break-all;
          margin-bottom: 10px;
        }
        #tessera-creator-panel .tessera-balance {
          font-size: 18px;
          font-weight: 700;
          margin-bottom: 12px;
        }
        #tessera-creator-panel button {
          width: 100%;
          margin-top: 6px;
          padding: 8px 10px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }
        #tessera-creator-panel .btn-balance {
          background: #2b6cb0;
          color: white;
        }
        #tessera-creator-panel .btn-withdraw {
          background: #38a169;
          color: white;
        }
        #tessera-creator-panel button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      </style>
      <h4>Tessera Earnings</h4>
      <div class="tessera-wallet">${wallet}</div>
      <div class="tessera-balance" data-tessera-balance>—</div>
      <button type="button" class="btn-balance" data-action="balance">Check Balance</button>
      <button type="button" class="btn-withdraw" data-action="withdraw">Withdraw Earnings</button>
    `

    creatorPanelEl.querySelector('[data-action="balance"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      try {
        await updateCreatorPanelBalance(wallet)
      } catch (err: any) {
        peertubeHelpers.notifier.error(err?.message || 'Balance check failed')
      } finally {
        btn.disabled = false
      }
    })

    creatorPanelEl.querySelector('[data-action="withdraw"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      try {
        await withdrawCreatorEarnings(wallet)
      } catch (err: any) {
        peertubeHelpers.notifier.error(err?.message || 'Withdraw failed')
      } finally {
        btn.disabled = false
      }
    })

    document.body.appendChild(creatorPanelEl)
    void updateCreatorPanelBalance(wallet)
  }

  // Returns the tessera rate for the given video (from pluginData or server), or null.
  const loadTesseraDataForVideo = async (video: { pluginData?: unknown } | null | undefined, videoId: string | null): Promise<{ wallet: string | null, rate: string | null }> => {
    currentCreatorWallet = readWalletFromVideo(video)

    if (!videoId) {
      renderCreatorPanel()
      return { wallet: currentCreatorWallet, rate: null }
    }

    let rate: string | null = null
    try {
      const pluginRoute = peertubeHelpers.getBaseRouterRoute()
      const res = await fetch(`${pluginRoute}/video/${videoId}/tessera-data`)
      const data = await res.json()
      if (res.ok) {
        if (data.wallet) currentCreatorWallet = data.wallet
        if (data.rate) rate = data.rate
      }
    } catch (err) {
      console.error('[tessera] Failed to fetch tessera data:', err)
    }

    renderCreatorPanel()
    return { wallet: currentCreatorWallet, rate }
  }

  registerHook({
    target: 'action:video-watch.video.loaded',
    handler: async (params: any) => {
      if (params && params.video) {
        currentVideoId = params.video.uuid || params.video.id?.toString() || null
        currentVideoOwner = params.video.account?.name || params.video.channel?.ownerAccount?.name || null

        // Owner is now known — remove the resolving guard so the overlay
        // fades in for regular users (checkPageVisibility keeps it hidden for owners)
        document.body.classList.remove('arc-resolving-owner')
        checkPageVisibility()

        const { rate } = await loadTesseraDataForVideo(params.video, currentVideoId)

        // Reset session manager display immediately using the video's rate.
        // This is done HERE (not in the ping handler) to avoid the 429 race condition:
        // the first ping after a video change is frequently rate-limited and never
        // returns ratePerSecond, leaving the old rate stuck on screen.
        if ((window as any).arcResetVideoSession) {
          const rateNum = rate ? parseFloat(rate) : null
          ;(window as any).arcResetVideoSession(rateNum ?? undefined)
          console.log(`[tessera] arcResetVideoSession called with rate=${rate ?? 'default'}`)
        }
        // Keep the flag so the ping handler can also update the rate if it arrives
        videoJustChanged = true
      }
    }
  })

  function getCurrentVideoId(): string | null {
    return currentVideoId
  }

  // Helper: read the sessionId generated by paywall.js (stored in localStorage)
  // This must match the userId the paywall sends to /register-session in Tessera.
  const getPaywallUserId = (): string | null => {
      try {
          return localStorage.getItem('arc_cashier_user_id')
      } catch {
          return null
      }
  }

  const isPaywallUnlocked = (): boolean => {
      try { return !document.body.classList.contains('arc-locked') }
      catch { return false }
  }

  // 4. Ping Mechanism
  const PING_INTERVAL_MS = 15000 // 15 seconds
  let pingInterval: number | undefined
  let abortController: AbortController | null = null
  let pendingPing: Promise<any> | null = null

  const sendPing = async (action: 'start' | 'stop' | 'ping'): Promise<void> => {
      if (action !== 'stop' && !isPaywallUnlocked()) return

      const videoId = getCurrentVideoId()
      const videoUrl = window.location.href
      const sessionId = getPaywallUserId()

      // Do not ping if the paywall has not yet generated a session ID.
      // The paywall.js creates arc_cashier_user_id in localStorage on init.
      if (!sessionId) {
          return
      }

      if (pendingPing) {
          try { await pendingPing } catch { /* ignore */ }
      }

      pendingPing = (async () => {
          try {
              const pluginRoute = peertubeHelpers.getBaseRouterRoute()
              const response = await fetch(`${pluginRoute}/ping`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action, videoId, videoUrl, sessionId })
              })
              if (!response.ok) {
                  if (response.status === 429) {
                      console.warn('[tessera] Rate limited. Skipping this ping.')
                  } else {
                      console.warn(`[tessera] Ping failed with status: ${response.status}`)
                  }
              } else {
                  const data = await response.json()
                  if (data.tesseraMode) {
                      document.body.setAttribute('data-tessera-mode', data.tesseraMode)
                  }
                  if (data.ratePerSecond) {
                      if (videoJustChanged && (window as any).arcResetVideoSession) {
                          // New video: reset per-video cost counter and update rate
                          ;(window as any).arcResetVideoSession(data.ratePerSecond)
                          videoJustChanged = false
                      } else if ((window as any).arcSetRate) {
                          // Same video: just keep rate in sync
                          ;(window as any).arcSetRate(data.ratePerSecond)
                      }
                  }
              }
          } catch (err) {
              console.error('[tessera] Failed to send ping:', err)
          } finally {
              pendingPing = null
          }
      })()

      await pendingPing
  }

  // 5. Hook into video player events for SPA navigation
  let currentVideo: HTMLVideoElement | null = null
  let isCleaningUp = false
  let hasStarted = false

  const setMediaPlaying = (isPlaying: boolean) => {
      if (typeof window !== 'undefined' && (window as any).arcSetMediaPlaying) {
          (window as any).arcSetMediaPlaying(isPlaying)
      } else {
          pendingMediaPlaying = isPlaying
      }
  }

  const cleanupVideoState = async () => {
      if (isCleaningUp) return
      isCleaningUp = true
      hasStarted = false
      setMediaPlaying(false)
      if (pingInterval) {
          clearInterval(pingInterval)
          pingInterval = undefined
      }
      await sendPing('stop')
      if (abortController) {
          abortController.abort()
          abortController = null
      }
      currentVideo = null
      isCleaningUp = false
  }

  const attachVideoListeners = (video: HTMLVideoElement) => {
    console.log('[tessera] attachVideoListeners called for video:', video)
    if (abortController) {
        abortController.abort()
    }
    abortController = new AbortController()
    const { signal } = abortController

    // Take manual control over Tessera's visual paywall clock
    if (typeof window !== 'undefined') {
        (window as any).arcManualMediaControl = true;
    }

    // 4.1: Handle `play` event — UI clock sync is separate from ping dedup (hasStarted)
    video.addEventListener('play', () => {
       console.log('[tessera] PLAY event detected. isPaywallUnlocked?', isPaywallUnlocked())
       if (!isPaywallUnlocked()) return

       setMediaPlaying(true)
       if (hasStarted) return

       hasStarted = true
       if (pingInterval) clearInterval(pingInterval)
       sendPing('start')
       pingInterval = window.setInterval(() => sendPing('ping'), PING_INTERVAL_MS)
    }, { signal })

    // 4.2: Handle `pause` and `ended` events
    video.addEventListener('pause', () => {
       console.log('[tessera] PAUSE event detected.')
       hasStarted = false
       setMediaPlaying(false)
       if (pingInterval) clearInterval(pingInterval)
       pingInterval = undefined
       sendPing('stop')
    }, { signal })

    video.addEventListener('ended', () => {
       console.log('[tessera] ENDED event detected.')
       hasStarted = false
       setMediaPlaying(false)
       if (pingInterval) clearInterval(pingInterval)
       pingInterval = undefined
       sendPing('stop')
    }, { signal })
  }

  // Fallback DOM polling to detect video element creation
  setInterval(async () => {
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname
      currentVideoOwner = null
      void prefetchVideoOwner()
    }

    checkPageVisibility()

    // Specifically target the main Video.js player to avoid grabbing thumbnail preview videos
    const video = document.querySelector('.vjs-tech, .video-js video, video-player video') as HTMLVideoElement | null
    
    // Video appeared or changed (User navigated to a new video page)
    if (video && video !== currentVideo) {
      console.log('[tessera] Found new video element:', video)
      
      // If we had a previous video playing, clean up its interval and stop billing
      if (currentVideo) {
         console.log('[tessera] Cleaning up previous video state.')
         await cleanupVideoState()
         return
      }

      currentVideo = video
      attachVideoListeners(video)
      
      // If video is already playing when we find it
      if (!video.paused && !video.ended) {
         console.log('[tessera] Video is already playing upon discovery! Sending start.')
         if (!hasStarted && isPaywallUnlocked()) {
             hasStarted = true
             setMediaPlaying(true)
             if (pingInterval) clearInterval(pingInterval)
             sendPing('start')
             pingInterval = window.setInterval(() => sendPing('ping'), PING_INTERVAL_MS)
         }
      } else {
         console.log('[tessera] Video discovered in paused/ended state.')
      }
    }

    // Video disappeared (User navigated AWAY from video page to dashboard)
    if (!video && currentVideo) {
      await cleanupVideoState()
    }
  }, 1000)
}
