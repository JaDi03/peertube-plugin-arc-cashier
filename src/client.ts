export async function register (_options: any) {
  // 1. Fetch Arc-Cashier Base URL from plugin router
  let baseUrl: string
  try {
    const response = await fetch('/plugins/arc-cashier/router/base-url')
    const data = await response.json()
    if (data.baseUrl) {
      baseUrl = data.baseUrl
    } else {
      console.warn('[arc-cashier] Missing base URL configuration.')
      return
    }
  } catch (err) {
    console.error('[arc-cashier] Failed to fetch base URL:', err)
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
  `
  document.head.appendChild(style)

  // 2. Inject Arc-Cashier paywall assets dynamically
  const cssLink = document.createElement('link')
  cssLink.rel = 'stylesheet'
  cssLink.href = `${baseUrl}/peertube-assets/paywall.css`
  document.head.appendChild(cssLink)

  const script = document.createElement('script')
  script.src = `${baseUrl}/peertube-assets/paywall.js`
  document.head.appendChild(script)

  // 3. Helper to get videoId from URL
  function getCurrentVideoId(): string | null {
    const match = window.location.pathname.match(/\/w\/([a-zA-Z0-9_-]+)/)
    if (match) return match[1]
    const watchMatch = window.location.pathname.match(/\/watch\/([a-zA-Z0-9_-]+)/)
    if (watchMatch) return watchMatch[1]
    return null
  }

  // 4. Ping Mechanism
  const PING_INTERVAL_MS = 15000 // 15 seconds
  let pingInterval: number | undefined
  let abortController: AbortController | null = null

  const sendPing = async (action: 'start' | 'stop' | 'ping') => {
      const videoId = getCurrentVideoId()
      const videoUrl = window.location.href

      try {
          await fetch('/plugins/arc-cashier/router/ping', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action, videoId, videoUrl })
          })
      } catch (err) {
          console.error('[arc-cashier] Failed to send ping:', err)
      }
  }

  // 5. Hook into video player events for SPA navigation
  let currentVideo: HTMLVideoElement | null = null

  const attachVideoListeners = (video: HTMLVideoElement) => {
    // 4.1: Avoid memory leaks with AbortController for event listeners
    if (abortController) {
       abortController.abort()
    }
    abortController = new AbortController()
    const signal = abortController.signal

    video.addEventListener('play', () => {
       if (pingInterval) clearInterval(pingInterval)
       sendPing('start')
       pingInterval = window.setInterval(() => sendPing('ping'), PING_INTERVAL_MS)
    }, { signal })

    // 4.2: Handle `pause` and `ended` events
    video.addEventListener('pause', () => {
       if (pingInterval) clearInterval(pingInterval)
       pingInterval = undefined
       sendPing('stop')
    }, { signal })

    video.addEventListener('ended', () => {
       if (pingInterval) clearInterval(pingInterval)
       pingInterval = undefined
       sendPing('stop')
    }, { signal })
  }

  // Fallback DOM polling to detect video element creation
  setInterval(() => {
    const isWatchPage = window.location.pathname.includes('/watch') || window.location.pathname.includes('/w/')
    
    // Toggle the hide class based on URL
    if (!isWatchPage) {
       document.body.classList.add('arc-hide-paywall')
    } else {
       document.body.classList.remove('arc-hide-paywall')
    }

    const video = document.querySelector('video')
    
    // Video appeared (User navigated TO a video page)
    if (video && video !== currentVideo) {
      currentVideo = video
      attachVideoListeners(video)
      
      // If video is already playing when we find it
      if (!video.paused && !video.ended) {
         if (pingInterval) clearInterval(pingInterval)
         sendPing('start')
         pingInterval = window.setInterval(() => sendPing('ping'), PING_INTERVAL_MS)
      }
    }

    // Video disappeared (User navigated AWAY from video page to dashboard)
    if (!video && currentVideo) {
      currentVideo = null

      // Clean up listeners
      if (abortController) {
         abortController.abort()
         abortController = null
      }

      // Stop billing pings immediately
      if (pingInterval) {
        clearInterval(pingInterval)
        pingInterval = undefined
      }
      sendPing('stop')
    }
  }, 1000)
}
