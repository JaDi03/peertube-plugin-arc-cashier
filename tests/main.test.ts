import { describe, it, expect, vi } from 'vitest'
import { register } from '../src/main'

describe('PeerTube Plugin Tessera - Server', () => {
  it('should register settings and ping router', async () => {
    // Mock the settings manager
    const settingsManager = {
      getSetting: vi.fn().mockResolvedValue('test-value')
    }
    
    // Mock the options passed by PeerTube
    const options = {
      registerSetting: vi.fn(),
      settingsManager,
      getRouter: vi.fn(() => ({
        get: vi.fn(),
        post: vi.fn()
      })),
      peertubeHelpers: {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn()
        }
      }
    }
    
    await register(options)
    
    // Verify that the webhook settings were registered
    expect(options.registerSetting).toHaveBeenCalledTimes(5)
    expect(options.registerSetting).toHaveBeenCalledWith(expect.objectContaining({ name: 'tessera-base-url' }))
    expect(options.registerSetting).toHaveBeenCalledWith(expect.objectContaining({ name: 'webhook-url' }))
    expect(options.registerSetting).toHaveBeenCalledWith(expect.objectContaining({ name: 'webhook-secret' }))
    expect(options.registerSetting).toHaveBeenCalledWith(expect.objectContaining({ name: 'max-active-viewers' }))
    expect(options.registerSetting).toHaveBeenCalledWith(expect.objectContaining({ name: 'base-rate-per-second' }))
    
    // Verify the router was created
    expect(options.getRouter).toHaveBeenCalled()
    
    // Verify endpoints
    const mockRouter = options.getRouter.mock.results[0].value
    expect(mockRouter.get).toHaveBeenCalledWith('/base-url', expect.any(Function))
    expect(mockRouter.post).toHaveBeenCalledWith('/ping', expect.any(Function))
  })
})
