const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { app } = require('electron');

class LocalStorageService {
  constructor() {
    // Base directory for saved data.
    //
    // This deliberately does NOT live in the user's Documents folder. Documents
    // is protected by Windows Defender's Controlled Folder Access (ransomware
    // protection), which is on by default on many machines: it blocks writes
    // from unsigned executables, and because the writes below used to be
    // synchronous, a blocked write stalled the Electron main thread and froze
    // the entire app until Windows force-closed it as unresponsive.
    // userData is not a protected location.
    this.baseDir = path.join(app.getPath('userData'), 'Solvro-Saves');
    this.ensureBaseDir();
  }

  ensureBaseDir() {
    // Never fatal: saveSession() recreates the tree with { recursive: true }
    // and reports failure through its return value.
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
        console.log(`Created base directory: ${this.baseDir}`);
      }
    } catch (error) {
      console.error(`Could not create base directory: ${error.message}`);
    }
  }

  // Generate folder name with current date and time
  generateFolderName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  }

  // Save session data (screenshots + response) for coding and interview modes.
  // Every filesystem call is async: this runs on the main process, so a slow or
  // blocked write must never stall the event loop.
  async saveSession(queue, response, mode, additionalText = '') {
    try {
      const folderName = this.generateFolderName();
      const sessionDir = path.join(this.baseDir, folderName);

      // Create session directory
      await fsp.mkdir(sessionDir, { recursive: true });
      console.log(`Created session directory: ${sessionDir}`);

      // Save screenshots
      const screenshotsDir = path.join(sessionDir, 'screenshots');
      await fsp.mkdir(screenshotsDir, { recursive: true });

      for (let index = 0; index < queue.length; index++) {
        const screenshot = queue[index];
        const filename = `screenshot_${index + 1}.png`;
        const filepath = path.join(screenshotsDir, filename);
        const buffer = Buffer.from(screenshot.image, 'base64');
        await fsp.writeFile(filepath, buffer);
        console.log(`Saved screenshot: ${filename}`);
      }

      // Save response as markdown file
      const responseFilepath = path.join(sessionDir, 'response.md');
      let responseContent = '# AI Response\n\n';
      responseContent += `**Date:** ${new Date().toLocaleString()}\n\n`;
      responseContent += `**Mode:** ${mode.charAt(0).toUpperCase() + mode.slice(1)}\n\n`;
      responseContent += `**Language:** ${queue.length > 0 ? queue[0].language : 'N/A'}\n\n`;
      responseContent += `**Screenshots Analyzed:** ${queue.length}\n\n`;

      if (additionalText && additionalText.trim() !== '') {
        responseContent += `**Additional Context:**\n${additionalText}\n\n`;
      }

      responseContent += `---\n\n`;
      responseContent += `## Response\n\n${response}\n`;

      await fsp.writeFile(responseFilepath, responseContent, 'utf8');
      console.log(`Saved response: response.md`);

      // Save metadata as JSON
      const metadataFilepath = path.join(sessionDir, 'metadata.json');
      const metadata = {
        timestamp: new Date().toISOString(),
        mode: mode,
        language: queue.length > 0 ? queue[0].language : 'N/A',
        screenshotCount: queue.length,
        additionalText: additionalText,
        folderName: folderName
      };
      await fsp.writeFile(metadataFilepath, JSON.stringify(metadata, null, 2), 'utf8');
      console.log(`Saved metadata: metadata.json`);

      console.log(`✓ ${mode.charAt(0).toUpperCase() + mode.slice(1)} session saved successfully to: ${sessionDir}`);

      return {
        success: true,
        path: sessionDir,
        folderName: folderName
      };
    } catch (error) {
      console.error(`Error saving ${mode} session: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get the base directory path
  getBaseDirectory() {
    return this.baseDir;
  }

  // List all saved sessions
  async listSessions() {
    try {
      const entries = await fsp.readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
        .reverse(); // Most recent first
    } catch (error) {
      console.error(`Error listing sessions: ${error.message}`);
      return [];
    }
  }
}

module.exports = LocalStorageService;
