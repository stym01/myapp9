const { screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

class ScreenshotService {
  constructor(tempPath) {
    this.tempDir = tempPath || path.join(require('electron').app.getPath('userData'), 'electron-app-screenshots');
    this.ensureTempDir();
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async captureScreen() {
    return new Promise((resolve, reject) => {
      try {
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;

        // Cap the captured resolution to speed up the capture + PNG encode and
        // shrink the payload. This is the dominant source of the delay between
        // pressing the screenshot shortcut and the UI updating: encoding a full
        // 2K/4K frame to PNG costs hundreds of ms and produces a multi-MB image.
        // Vision models (Claude, Gemini) downscale images internally anyway, so
        // capturing above ~1920px on the longest edge adds latency with no
        // quality benefit. Aspect ratio is preserved so nothing is distorted.
        const MAX_EDGE = 1920;
        const longest = Math.max(width, height);
        const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
        const captureWidth = Math.max(1, Math.round(width * scale));
        const captureHeight = Math.max(1, Math.round(height * scale));

        // Use desktopCapturer for better cross-platform support
        const { desktopCapturer } = require('electron');

        desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: captureWidth, height: captureHeight }
        }).then(sources => {
          if (sources.length > 0) {
            const screenshot = sources[0].thumbnail;
            const base64Data = screenshot.toPNG().toString('base64');
            resolve(base64Data);
          } else {
            reject(new Error('No screen sources found'));
          }
        }).catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  saveScreenshot(base64Data, filename = 'screenshot.png') {
    const filepath = path.join(this.tempDir, filename);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filepath, buffer);
    return filepath;
  }
}

module.exports = ScreenshotService;
