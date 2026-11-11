const { desktopCapturer } = require('electron');

class StealthService {
  constructor() {
    this.isScreenShareActive = false;
    this.captureCheckInterval = null;
    this.callbacks = [];
    this.enhancedStealthEnabled = true; // Always enabled by default
  }

  // Monitor for screen sharing/recording activity.
  //
  // Deliberately a no-op. This used to run checkScreenCapture() on a 5-second
  // interval for the life of the process. desktopCapturer.getSources() is not
  // cheap — it round-trips through the GPU process and enumerates every display
  // — so it added a periodic main-process stall that showed up as UI stutter and
  // occasional "not responding" on slower machines.
  //
  // It also never told us anything: getSources() returns the screens that COULD
  // be captured, not the ones being captured, so `sources.length > 0` is true on
  // every call and the state never changes after the first tick. The protection
  // that actually works is setContentProtection(true) in applyEnhancedStealth(),
  // which is unaffected by this.
  //
  // checkScreenCapture() is kept below so a real detector can be wired in here
  // later without changing any call sites.
  startMonitoring() {
    // no-op
  }

  stopMonitoring() {
    if (this.captureCheckInterval) {
      clearInterval(this.captureCheckInterval);
      this.captureCheckInterval = null;
    }
  }

  async checkScreenCapture() {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      });

      // Check if there are any active screen capture sources
      const wasActive = this.isScreenShareActive;
      this.isScreenShareActive = sources.length > 0;

      if (wasActive !== this.isScreenShareActive) {
        this.notifyCallbacks(this.isScreenShareActive);
      }
    } catch (error) {
      console.error('Screen capture detection error:', error);
    }
  }

  onScreenShareChange(callback) {
    this.callbacks.push(callback);
  }

  notifyCallbacks(isActive) {
    this.callbacks.forEach(callback => {
      try {
        callback(isActive);
      } catch (error) {
        console.error('Callback error:', error);
      }
    });
  }

  // Advanced stealth positioning
  getStealthPosition() {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();

    // Find the display with the most available space
    let bestDisplay = displays[0];
    let maxArea = 0;

    displays.forEach(display => {
      const area = display.workAreaSize.width * display.workAreaSize.height;
      if (area > maxArea) {
        maxArea = area;
        bestDisplay = display;
      }
    });

    // Position at edge of screen where it's less likely to be captured
    const { bounds, workAreaSize } = bestDisplay;
    return {
      x: bounds.x + workAreaSize.width - 850,
      y: bounds.y + workAreaSize.height - 650
    };
  }

  // Check if window is in a screen capture region
  isWindowInCaptureRegion(windowBounds) {
    // This is a simplified check - in a real implementation,
    // you'd need to check against known capture regions
    return false;
  }

  // Generate alternative window properties for stealth
  getStealthWindowProperties() {
    return {
      opacity: 0.01,
      skipTaskbar: true,
      frame: false,
      show: false,
      focusable: false,
      alwaysOnTop: true,
      level: 'screen-saver'
    };
  }

  // Apply enhanced stealth protection using proven techniques (always active by default)
  applyEnhancedStealth(window) {
    if (!window) return;

    try {
      // Enhanced screen capture resistance - your proven techniques
      window.setContentProtection(true);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true
      });
      window.setAlwaysOnTop(true, "screen-saver", 1);

      this.enhancedStealthEnabled = true;
      console.log('Enhanced stealth protection applied automatically');
      return true;
    } catch (error) {
      console.error('Error applying enhanced stealth:', error);
      return false;
    }
  }

  // Initialize enhanced stealth automatically for a window
  initializeAutoStealth(window) {
    if (!window) return;

    // Apply enhanced stealth immediately
    this.applyEnhancedStealth(window);

    // Ensure stealth remains active
    window.on('focus', () => {
      if (this.enhancedStealthEnabled) {
        this.applyEnhancedStealth(window);
      }
    });

    console.log('Auto-stealth initialized - window is hidden from screen capture by default');
  }

  // Remove stealth protection
  removeEnhancedStealth(window) {
    if (!window) return;

    try {
      window.setContentProtection(false);
      window.setAlwaysOnTop(false);

      console.log('Enhanced stealth protection removed');
    } catch (error) {
      console.error('Error removing enhanced stealth:', error);
    }
  }
}

module.exports = StealthService;
