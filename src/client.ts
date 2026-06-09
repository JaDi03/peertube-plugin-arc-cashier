export async function register (_options: any) {
  // 1. Fetch Arc-Cashier Base URL from plugin router
  let baseUrl: string
  try {
    const response = await fetch('/plugins/peertube-plugin-arc-cashier/router/base-url')
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

  // 2. Inject Arc-Cashier paywall assets dynamically
  const cssLink = document.createElement('link')
  cssLink.rel = 'stylesheet'
  cssLink.href = `${baseUrl}/peertube-assets/paywall.css`
  document.head.appendChild(cssLink)

  const script = document.createElement('script')
  script.src = `${baseUrl}/peertube-assets/paywall.js`
  document.head.appendChild(script)

  // 3. Generate or retrieve userId
  let userId = localStorage.getItem('arc_cashier_user_id')
  if (!userId) {
     userId = 'user_' + Math.random().toString(36).substring(2, 15)
     localStorage.setItem('arc_cashier_user_id', userId)
  }

  // 4. Ping Mechanism
  const PING_INTERVAL_MS = 15000 // 15 seconds
  let pingInterval: number | undefined

  const sendPing = async (action: 'start' | 'stop' | 'ping') => {
      try {
          await fetch('/plugins/peertube-plugin-arc-cashier/router/ping', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action, userId })
          })
      } catch (err) {
          console.error('[arc-cashier] Failed to send ping:', err)
      }
  }

  // 5. Hook into video player events
  const checkVideoInterval = setInterval(() => {
    const video = document.querySelector('video')
    if (video) {
      clearInterval(checkVideoInterval)
      
      video.addEventListener('play', () => {
         sendPing('start')
         if (pingInterval) clearInterval(pingInterval)
         pingInterval = window.setInterval(() => sendPing('ping'), PING_INTERVAL_MS)
      })
      
      video.addEventListener('pause', () => {
         if (pingInterval) clearInterval(pingInterval)
         sendPing('stop')
      })
      
      video.addEventListener('ended', () => {
         if (pingInterval) clearInterval(pingInterval)
         sendPing('stop')
      })
    }
  }, 1000)
}
